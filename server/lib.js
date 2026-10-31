'use strict';
// Utilidades, base de datos y autenticacion (sin dependencias externas)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'cartera.db');
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
if (Boolean(tursoUrl) !== Boolean(tursoToken)) {
  throw new Error('TURSO_DATABASE_URL y TURSO_AUTH_TOKEN deben configurarse juntos.');
}
const remote = Boolean(tursoUrl);

// ---------------- Base de datos ----------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const client = createClient(remote
  ? { url: tursoUrl, authToken: tursoToken }
  : { url: pathToFileURL(DB_PATH).href });
const transactionContext = new AsyncLocalStorage();
const MIGRATIONS = [
  ['pagos', 'sin_aplicar', 'INTEGER NOT NULL DEFAULT 0'],
  ['pagos', 'banco_id', 'INTEGER'],
  ['pagos', 'banco', 'TEXT'],
  ['debito_app', 'metodo', 'TEXT'],
  ['debito_app', 'banco_id', 'INTEGER'],
  ['debito_app', 'banco', 'TEXT'],
  ['cliente_extra', 'email', 'TEXT'],
  ['cliente_extra', 'telefono', 'TEXT'],
  ['cliente_extra', 'editado_app', 'INTEGER NOT NULL DEFAULT 0'],
  ['pagos', 'desde_prepago', 'INTEGER NOT NULL DEFAULT 0'],
  ['pagos', 'prepago_ref_id', 'INTEGER'],
];

const q = {
  all: async (sql, ...args) => {
    const result = await (transactionContext.getStore() || client).execute({ sql, args });
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column, row[column]])));
  },
  get: async (sql, ...args) => (await q.all(sql, ...args))[0],
  run: async (sql, ...args) => {
    const result = await (transactionContext.getStore() || client).execute({ sql, args });
    return { changes: Number(result.rowsAffected), lastInsertRowid: Number(result.lastInsertRowid || 0) };
  },
  batch: async (statements) => (transactionContext.getStore() || client).batch(statements),
};
const tx = async (fn) => {
  const transaction = await client.transaction('write');
  try {
    const result = await transactionContext.run(transaction, fn);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
};

const ready = (async () => {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.executeMultiple(schema.replace(/^\s*PRAGMA foreign_keys\s*=\s*OFF;\s*$/im, ''));
  await client.execute('PRAGMA foreign_keys = ON');
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = await q.all(`PRAGMA table_info(${table})`);
    if (!columns.some((entry) => entry.name === column)) {
      await q.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  const referenciasEstaciones = await q.all('PRAGMA foreign_key_list(usuario_estaciones)');
  if (!referenciasEstaciones.some((referencia) => referencia.table === 'usuarios' && referencia.from === 'usuario_id') ||
      !referenciasEstaciones.some((referencia) => referencia.table === 'dim_estacion' && referencia.from === 'estacion_id')) {
    const invalidas = await q.get(`SELECT COUNT(*) AS cantidad FROM usuario_estaciones ue
      LEFT JOIN usuarios u ON u.id=ue.usuario_id
      LEFT JOIN dim_estacion e ON e.id=ue.estacion_id
      WHERE u.id IS NULL OR e.id IS NULL`);
    if (Number(invalidas.cantidad) > 0) throw new Error('No se puede migrar usuario_estaciones: existen asignaciones huérfanas.');
    await tx(async () => {
      await q.run(`CREATE TABLE usuario_estaciones_migracion (
        usuario_id INTEGER NOT NULL,
        estacion_id INTEGER NOT NULL,
        PRIMARY KEY (usuario_id, estacion_id),
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        FOREIGN KEY (estacion_id) REFERENCES dim_estacion(id) ON DELETE CASCADE
      )`);
      await q.run('INSERT INTO usuario_estaciones_migracion(usuario_id, estacion_id) SELECT usuario_id, estacion_id FROM usuario_estaciones');
      await q.run('DROP TABLE usuario_estaciones');
      await q.run('ALTER TABLE usuario_estaciones_migracion RENAME TO usuario_estaciones');
    });
  }
  await q.run("UPDATE metodos_pago SET requiere_banco=1 WHERE nombre='Tarjeta'");
})();

// ---------------- Roles y permisos ----------------
const ROLES = {
  admin:      { etiqueta: 'Administrador General', permisos: ['ver', 'pagos', 'gestiones', 'credito', 'clientes', 'facturas', 'debito', 'usuarios', 'bitacora', 'carga', 'export', 'anular_prepago', 'editar_despacho', 'anular_pago'] },
  gestor:     { etiqueta: 'Gestor de Estación',    permisos: ['ver', 'pagos', 'gestiones', 'credito', 'clientes', 'facturas', 'debito', 'export'] },
  supervisor: { etiqueta: 'Supervisor',            permisos: ['ver', 'anular_prepago', 'editar_despacho', 'anular_pago'] },
  consulta:   { etiqueta: 'Consulta',              permisos: ['ver', 'export'] },
};
const can = (user, permiso) => !!user && !!ROLES[user.rol] && ROLES[user.rol].permisos.includes(permiso);

// ---------------- Passwords (scrypt) ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}
function passwordDebil(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'La contraseña debe incluir letras y números.';
  return null;
}
function passwordTemporal() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(10)) s += abc[b % abc.length];
  return s + '7a';
}

async function estacionesUsuario(usuario) {
  const ids = [];
  const push = (id) => { const n = Number(id); if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n); };
  if (usuario) push(usuario.estacion_id);
  const rows = usuario && usuario.id != null ? await q.all('SELECT estacion_id FROM usuario_estaciones WHERE usuario_id=? ORDER BY estacion_id', usuario.id) : [];
  rows.forEach((r) => push(r.estacion_id));
  return ids;
}

// ---------------- Sesiones ----------------
const SESION_HORAS = Number(process.env.SESION_HORAS || 10);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + SESION_HORAS * 3600e3).toISOString();
  await q.run('INSERT INTO sesiones(token_hash,usuario_id,expira) VALUES (?,?,?)', sha(token), usuarioId, expira);
  return { token, expira };
}
async function usuarioDeToken(token) {
  if (!token) return null;
  const s = await q.get('SELECT * FROM sesiones WHERE token_hash=?', sha(token));
  if (!s) return null;
  if (new Date(s.expira) < new Date()) { await q.run('DELETE FROM sesiones WHERE token_hash=?', s.token_hash); return null; }
  const u = await q.get('SELECT id,usuario,nombre,email,rol,estacion_id,activo,must_change FROM usuarios WHERE id=?', s.usuario_id);
  if (!u || !u.activo) return null;
  u.estaciones = await estacionesUsuario(u);
  u.estacion_id = u.estaciones.length === 1 ? u.estaciones[0] : (u.estaciones.length ? null : u.estacion_id || null);
  return u;
}
const cerrarSesion = (token) => token ? q.run('DELETE FROM sesiones WHERE token_hash=?', sha(token)) : Promise.resolve();
const limpiarSesiones = () => q.run('DELETE FROM sesiones WHERE expira < ?', new Date().toISOString());

// ---------------- Bitacora ----------------
function bitacora(user, accion, detalle, ip) {
  return q.run('INSERT INTO bitacora(usuario,accion,detalle,ip) VALUES (?,?,?,?)',
    user ? user.usuario : null, accion, detalle == null ? null : String(detalle).slice(0, 500), ip || null);
}

// ---------------- Respaldo ----------------
async function respaldar() {
  const dir = path.join(ROOT, 'respaldos'); fs.mkdirSync(dir, { recursive: true });
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  const ext = remote ? 'json' : 'db';
  const dest = path.join(dir, `cartera_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.${ext}`);
  if (remote) {
    const tables = await q.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const snapshot = {};
    for (const { name } of tables) snapshot[name] = await q.all(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
    fs.writeFileSync(dest, JSON.stringify({ created_at: d.toISOString(), tables: snapshot }));
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const backup = new DatabaseSync(DB_PATH);
    try { backup.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); }
    finally { backup.close(); }
  }
  const files = fs.readdirSync(dir).filter((f) => /^cartera_.*\.(db|json)$/.test(f)).sort();
  files.slice(0, Math.max(0, files.length - 30)).forEach((f) => fs.rmSync(path.join(dir, f)));
  return dest;
}

function quotedName(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function importarSqliteAlmacenado(sqlite) {
  if (!remote) throw new Error('La transferencia SQLite → Turso solo está disponible con TURSO_DATABASE_URL.');
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const transaction = await client.transaction('write');
  try {
    for (const table of tables) {
      const name = quotedName(table);
      await transaction.execute(`DELETE FROM ${name}`);
    }
    for (const table of tables) {
      const name = quotedName(table);
      const columns = sqlite.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
      if (!columns.length) continue;
      const placeholders = columns.map(() => '?').join(',');
      const insert = `INSERT INTO ${name} (${columns.map(quotedName).join(',')}) VALUES (${placeholders})`;
      const source = sqlite.prepare(`SELECT * FROM ${name}`).iterate();
      let statements = [];
      for (const row of source) {
        statements.push({ sql: insert, args: columns.map((column) => row[column]) });
        if (statements.length === 250) {
          await transaction.batch(statements);
          statements = [];
        }
      }
      if (statements.length) await transaction.batch(statements);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function exportarTursoASqlite(sqlite) {
  if (!remote) throw new Error('La transferencia Turso → SQLite requiere TURSO_DATABASE_URL.');
  const tables = await q.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const localTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
  for (const { name: table } of tables) {
    if (!localTables.has(table)) throw new Error(`La tabla remota "${table}" no existe en el esquema local.`);
    const name = quotedName(table);
    const columns = sqlite.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
    const insert = sqlite.prepare(`INSERT INTO ${name} (${columns.map(quotedName).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.prepare(`DELETE FROM ${name}`).run();
      for (let offset = 0; ; offset += 1000) {
        const rows = await q.all(`SELECT * FROM ${name} LIMIT ? OFFSET ?`, 1000, offset);
        for (const row of rows) insert.run(...columns.map((column) => row[column]));
        if (rows.length < 1000) break;
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

// ---------------- Usuario inicial ----------------
async function sembrarAdmin() {
  if ((await q.get('SELECT COUNT(*) n FROM usuarios')).n > 0) return null;
  const configurada = Boolean(process.env.ADMIN_PASSWORD);
  const pw = process.env.ADMIN_PASSWORD || passwordTemporal();
  await q.run("INSERT INTO usuarios(usuario,nombre,rol,must_change,pass_hash) VALUES ('admin','Administrador','admin',1,?)", hashPassword(pw));
  await bitacora(null, 'SEMBRADO', 'Usuario admin creado');
  return configurada ? null : pw;
}

// ---------------- Helpers ----------------
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const entero = (v, d, min, max) => Math.min(max, Math.max(min, Math.trunc(num(v, d))));
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

module.exports = {
  ROOT, DB_PATH, client, q, tx, ready, remote, ROLES, can, hashPassword, verifyPassword, passwordDebil, passwordTemporal, respaldar,
  importarSqliteAlmacenado, exportarTursoASqlite,
  crearSesion, usuarioDeToken, estacionesUsuario, cerrarSesion, limpiarSesiones, SESION_HORAS, bitacora, sembrarAdmin,
  esFecha, hoyISO, num, entero, HttpError,
};
