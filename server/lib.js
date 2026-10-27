'use strict';
// Utilidades, base de datos y autenticacion (sin dependencias externas)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'cartera.db');

// ---------------- Base de datos ----------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
if (!db.prepare('PRAGMA table_info(pagos)').all().some((column) => column.name === 'sin_aplicar')) {
  db.exec('ALTER TABLE pagos ADD COLUMN sin_aplicar INTEGER NOT NULL DEFAULT 0');
}
for (const [table, column, definition] of [
  ['pagos', 'banco_id', 'INTEGER'],
  ['pagos', 'banco', 'TEXT'],
  ['debito_app', 'metodo', 'TEXT'],
  ['debito_app', 'banco_id', 'INTEGER'],
  ['debito_app', 'banco', 'TEXT'],
  ['cliente_extra', 'email', 'TEXT'],
  ['cliente_extra', 'telefono', 'TEXT'],
  ['cliente_extra', 'editado_app', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};
const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ---------------- Roles y permisos ----------------
const ROLES = {
  admin:    { etiqueta: 'Administrador General', permisos: ['ver', 'pagos', 'gestiones', 'credito', 'clientes', 'facturas', 'debito', 'usuarios', 'bitacora', 'carga', 'export'] },
  gestor:   { etiqueta: 'Gestor de Estación',    permisos: ['ver', 'pagos', 'gestiones', 'credito', 'clientes', 'facturas', 'debito', 'export'] },
  consulta: { etiqueta: 'Consulta',              permisos: ['ver', 'export'] },
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

function estacionesUsuario(usuario) {
  const ids = [];
  const push = (id) => { const n = Number(id); if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n); };
  if (usuario) push(usuario.estacion_id);
  const rows = usuario && usuario.id != null ? q.all('SELECT estacion_id FROM usuario_estaciones WHERE usuario_id=? ORDER BY estacion_id', usuario.id) : [];
  rows.forEach((r) => push(r.estacion_id));
  return ids;
}

// ---------------- Sesiones ----------------
const SESION_HORAS = Number(process.env.SESION_HORAS || 10);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + SESION_HORAS * 3600e3).toISOString();
  q.run('INSERT INTO sesiones(token_hash,usuario_id,expira) VALUES (?,?,?)', sha(token), usuarioId, expira);
  return { token, expira };
}
function usuarioDeToken(token) {
  if (!token) return null;
  const s = q.get('SELECT * FROM sesiones WHERE token_hash=?', sha(token));
  if (!s) return null;
  if (new Date(s.expira) < new Date()) { q.run('DELETE FROM sesiones WHERE token_hash=?', s.token_hash); return null; }
  const u = q.get('SELECT id,usuario,nombre,email,rol,estacion_id,activo,must_change FROM usuarios WHERE id=?', s.usuario_id);
  if (!u || !u.activo) return null;
  u.estaciones = estacionesUsuario(u);
  u.estacion_id = u.estaciones.length === 1 ? u.estaciones[0] : (u.estaciones.length ? null : u.estacion_id || null);
  return u;
}
const cerrarSesion = (token) => token && q.run('DELETE FROM sesiones WHERE token_hash=?', sha(token));
const limpiarSesiones = () => q.run('DELETE FROM sesiones WHERE expira < ?', new Date().toISOString());

// ---------------- Bitacora ----------------
function bitacora(user, accion, detalle, ip) {
  q.run('INSERT INTO bitacora(usuario,accion,detalle,ip) VALUES (?,?,?,?)',
    user ? user.usuario : null, accion, detalle == null ? null : String(detalle).slice(0, 500), ip || null);
}

// ---------------- Respaldo ----------------
function respaldar() {
  const dir = path.join(ROOT, 'respaldos'); fs.mkdirSync(dir, { recursive: true });
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  const dest = path.join(dir, `cartera_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.db`);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  files.slice(0, Math.max(0, files.length - 30)).forEach((f) => fs.rmSync(path.join(dir, f)));
  return dest;
}

// ---------------- Usuario inicial ----------------
function sembrarAdmin() {
  if (q.get('SELECT COUNT(*) n FROM usuarios').n > 0) return null;
  const configurada = Boolean(process.env.ADMIN_PASSWORD);
  const pw = process.env.ADMIN_PASSWORD || passwordTemporal();
  q.run("INSERT INTO usuarios(usuario,nombre,rol,must_change,pass_hash) VALUES ('admin','Administrador','admin',1,?)", hashPassword(pw));
  bitacora(null, 'SEMBRADO', 'Usuario admin creado');
  return configurada ? null : pw;
}

// ---------------- Helpers ----------------
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const entero = (v, d, min, max) => Math.min(max, Math.max(min, Math.trunc(num(v, d))));
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

module.exports = {
  ROOT, DB_PATH, db, q, tx, ROLES, can, hashPassword, verifyPassword, passwordDebil, passwordTemporal, respaldar,
  crearSesion, usuarioDeToken, estacionesUsuario, cerrarSesion, limpiarSesiones, SESION_HORAS, bitacora, sembrarAdmin,
  esFecha, hoyISO, num, entero, HttpError,
};
