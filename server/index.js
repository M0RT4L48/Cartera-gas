'use strict';
// Servidor HTTP de Gas_App Financiero (Node >= 22.13, sin dependencias externas)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const L = require('./lib');
const Q = require('./queries');
const { q, tx, can, ROLES, HttpError } = L;

function estacionesAsignadas(user) {
  const ids = Array.isArray(user && user.estaciones) ? user.estaciones.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length) return ids;
  if (user && Number.isInteger(user.estacion_id) && user.estacion_id > 0) return [user.estacion_id];
  return [];
}
async function parseEstaciones(body) {
  const tieneTodas = Object.prototype.hasOwnProperty.call(body, 'todas_estaciones');
  if (tieneTodas && (body.todas_estaciones === true || body.todas_estaciones === 1 || body.todas_estaciones === 'true' || body.todas_estaciones === '1')) return [];
  const raw = Array.isArray(body.estaciones)
    ? body.estaciones
    : body.estaciones == null || body.estaciones === '' ? [] : [body.estaciones];
  if (tieneTodas && raw.length === 0) throw new HttpError(400, 'Selecciona al menos una estación o marca “Todas las estaciones”');
  const arr = raw.length ? raw : (body.estacion_id == null ? [] : [body.estacion_id]);
  const ids = [...new Set(arr.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, 'La lista contiene una estación inválida');
  for (const id of ids) {
    if (!await q.get('SELECT 1 FROM dim_estacion WHERE id=?', id)) throw new HttpError(400, 'Estación inválida');
  }
  return ids;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC = path.join(L.ROOT, 'public');
const MAX_XLSX = 150 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------- helpers ----------
const send = (res, status, body, headers = {}) => {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(raw ? body : JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Solicitud demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const ip = (req) => req.socket.remoteAddress;
const csvCell = (v) => {
  if (v == null) return '';
  const raw = String(v);
  const safe = typeof v === 'string' && /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
function csv(res, nombre, cols, rows) {
  const body = '\ufeff' + cols.map((c) => csvCell(c[1])).join(',') + '\r\n' + rows.map((r) => cols.map((c) => csvCell(r[c[0]])).join(',')).join('\r\n');
  send(res, 200, Buffer.from(body, 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nombre}"` });
}
const exigir = (user, permiso) => { if (!can(user, permiso)) throw new HttpError(403, 'No tienes permiso para esta acción'); };
const exigirAlguno = (user, ...permisos) => { if (!permisos.some((permiso) => can(user, permiso))) throw new HttpError(403, 'No tienes permiso para esta acción'); };
const txt = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const modosCargaCliente = ['Vales débito', 'Vales crédito', 'Flotilla débito', 'Flotilla crédito', 'Código de barras', 'Firma autorizada', 'Cupón de carga'];
const modosCargaAnteriores = {
  'Vales debito': 'Vales débito',
  'Vales Credito': 'Vales crédito',
  'Flotilla debito': 'Flotilla débito',
  'Flotilla Credito': 'Flotilla crédito',
};
const normalizarModoCarga = (valor) => modosCargaAnteriores[valor] || valor;
const redondea = (n) => Math.round(n * 100) / 100;
function datosFacturaAnticipo(body) {
  const folio = txt(body.folio, 80);
  const serie = txt(body.serie, 30) || null;
  const uuid = txt(body.uuid_fiscal, 36).toUpperCase() || null;
  const fecha = txt(body.fecha_factura, 10);
  const importe = redondea(L.num(body.importe_original, -1));
  const moneda = txt(body.moneda, 3).toUpperCase() || 'MXN';
  const cambio = body.tipo_cambio == null || body.tipo_cambio === '' ? (moneda === 'MXN' ? 1 : null) : redondea(L.num(body.tipo_cambio, -1));
  if (!folio) throw new HttpError(400, 'El folio de la Factura de Anticipo es obligatorio');
  if (uuid && !/^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(uuid)) {
    throw new HttpError(400, 'El UUID fiscal no tiene un formato válido');
  }
  if (!L.esFecha(fecha) || fecha > L.hoyISO()) throw new HttpError(400, 'La fecha de factura es inválida o futura');
  if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe original debe ser mayor a cero y no exceder $1,000,000,000');
  if (!/^[A-Z]{3}$/.test(moneda)) throw new HttpError(400, 'La moneda debe ser un código ISO de tres letras');
  if (moneda === 'MXN') {
    if (cambio != null && cambio !== 1) throw new HttpError(400, 'El tipo de cambio de MXN debe ser 1');
  } else if (!(cambio > 0) || cambio > 1e9) {
    throw new HttpError(400, 'Indica un tipo de cambio mayor a cero para una moneda distinta de MXN');
  }
  return {
    serie, folio, uuid, fecha, importe, moneda, cambio,
    referencia: txt(body.referencia, 100) || null,
    observaciones: txt(body.observaciones, 1000) || null,
  };
}
const requiereBanco = (v) => v === true || v === 1 || v === '1' || v === 'on';

function alcance(user, query) {
  const ids = estacionesAsignadas(user);
  if (query.get('estacion') === 'todas') return { est: null, estaciones: ids.length ? ids : null };
  if (ids.length) {
    const e = Number(query.get('estacion'));
    if (Number.isInteger(e) && e > 0 && ids.includes(e)) return { est: e, estaciones: null };
    return { est: ids[0], estaciones: null };
  }
  const e = Number(query.get('estacion'));
  return { est: Number.isInteger(e) && e > 0 ? e : null, estaciones: null };
}
function filtrarEstaciones(scope, columna, wh, pr) {
  if (Array.isArray(scope.estaciones)) {
    if (scope.estaciones.length) {
      wh.push(`${columna} IN (${scope.estaciones.map(() => '?').join(',')})`);
      pr.push(...scope.estaciones);
    } else wh.push('1=0');
  } else if (scope.est) {
    wh.push(`${columna}=?`);
    pr.push(scope.est);
  }
}
async function verificaCliente(user, k) {
  const c = await q.get('SELECT k_cliente, estacion_id FROM dim_cliente WHERE k_cliente=?', k);
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  const ids = estacionesAsignadas(user);
  if (ids.length && !ids.includes(c.estacion_id)) throw new HttpError(403, 'Cliente fuera de tu estación');
  return c;
}
const params = async (query, user) => {
  const p = Object.fromEntries(query.entries()), scope = alcance(user, query);
  p.corte = await Q.corteValido(p.corte);
  p.est = scope.est;
  p.estaciones = scope.estaciones;
  return p;
};

// ---------- login con bloqueo ----------
const MAX_INTENTOS = 5, BLOQUEO_MIN = 15;
async function login(body, req, res) {
  const usuario = txt(body.usuario, 60), pw = String(body.password || '');
  const u = await q.get('SELECT * FROM usuarios WHERE usuario=?', usuario);
  const fallo = async () => { await L.bitacora(null, 'LOGIN_FALLIDO', usuario, ip(req)); throw new HttpError(401, 'Usuario o contraseña incorrectos'); };
  if (!u || !u.activo) { L.verifyPassword(pw, 'scrypt$00$00'); return await fallo(); }
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) throw new HttpError(429, 'Cuenta bloqueada temporalmente por intentos fallidos. Intenta más tarde.');
  if (!L.verifyPassword(pw, u.pass_hash)) {
    const n = u.intentos + 1;
    if (n >= MAX_INTENTOS) await q.run('UPDATE usuarios SET intentos=0, bloqueado_hasta=? WHERE id=?', new Date(Date.now() + BLOQUEO_MIN * 60e3).toISOString(), u.id);
    else await q.run('UPDATE usuarios SET intentos=? WHERE id=?', n, u.id);
    return await fallo();
  }
  await q.run("UPDATE usuarios SET intentos=0, bloqueado_hasta=NULL, ultimo_login=datetime('now') WHERE id=?", u.id);
  const { token } = await L.crearSesion(u.id);
  await L.bitacora(u, 'LOGIN', null, ip(req));
  send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${L.SESION_HORAS * 3600}${COOKIE_SECURE ? '; Secure' : ''}` });
}
const perfil = (u) => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, email: u.email, rol: u.rol, rol_etiqueta: ROLES[u.rol].etiqueta,
  estacion_id: u.estacion_id, estaciones: Array.isArray(u.estaciones) ? u.estaciones : estacionesAsignadas(u), must_change: !!u.must_change, permisos: ROLES[u.rol].permisos });

// ---------- carga de Excel (binario -> python ETL) ----------
let importando = false;
function recibirXlsx(req, dest) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (!len) return reject(new HttpError(400, 'Archivo vacío'));
    if (len > MAX_XLSX) return reject(new HttpError(413, 'El archivo excede 150 MB'));
    let size = 0; const out = fs.createWriteStream(dest); let cortado = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_XLSX && !cortado) { cortado = true; out.destroy(); req.destroy(); reject(new HttpError(413, 'El archivo excede 150 MB')); } });
    req.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject); req.on('error', reject);
  });
}
async function correrEtl(archivo, { modo, modulos }) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const stagePath = L.remote ? path.join(os.tmpdir(), `cartera-import-${process.pid}-${Date.now()}.db`) : L.DB_PATH;
  let stage;
  try {
    if (L.remote) {
      stage = new DatabaseSync(stagePath);
      stage.exec(fs.readFileSync(path.join(L.ROOT, 'server', 'schema.sql'), 'utf8'));
      await L.exportarTursoASqlite(stage);
      stage.close();
      stage = null;
    }
    const resumen = await new Promise((resolve, reject) => {
    const args = [path.join(L.ROOT, 'etl', 'importar_excel.py'), archivo, '--db', stagePath, '--mode', modo === 'parcial' ? 'partial' : 'full'];
    if (modo === 'parcial') args.push('--modules', modulos.join(','));
    const p = spawn(py, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new HttpError(500, `No se pudo ejecutar Python (${py}): ${e.message}. Instala Python con pandas y openpyxl o define la variable PYTHON.`)));
    p.on('close', (code) => (code === 0 ? resolve(out.trim().split('\n').pop()) : reject(new HttpError(422, (err.trim().split('\n').pop() || 'Error al procesar el Excel')))));
  });
    if (L.remote) {
      stage = new DatabaseSync(stagePath);
      await L.importarSqliteAlmacenado(stage);
    }
    return resumen;
  } finally {
    if (stage) stage.close();
    if (L.remote) fs.rmSync(stagePath, { force: true });
  }
}
function leerLayoutPorFacturar(archivo) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const args = [path.join(L.ROOT, 'etl', 'leer_por_facturar.py'), archivo];
    const p = spawn(py, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new HttpError(500, `No se pudo ejecutar Python (${py}): ${e.message}. Instala Python con pandas y openpyxl o define la variable PYTHON.`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new HttpError(422, err.trim() || 'No se pudo leer el layout de despachos'));
      try { resolve(JSON.parse(out)); }
      catch { reject(new HttpError(422, 'El lector devolvió datos inválidos para el layout')); }
    });
  });
}
async function cargaPorFacturar(req, res, user) {
  exigir(user, 'facturas');
  if (importando) throw new HttpError(409, 'Ya hay una importación en curso');
  importando = true;
  const tmpDir = path.join(L.ROOT, 'tmp'); fs.mkdirSync(tmpDir, { recursive: true });
  const archivo = path.join(tmpDir, `por_facturar_${Date.now()}.xlsx`);
  try {
    const size = await recibirXlsx(req, archivo);
    const fd = fs.openSync(archivo, 'r'), firma = Buffer.alloc(2);
    fs.readSync(fd, firma, 0, 2, 0); fs.closeSync(fd);
    if (firma.toString('latin1') !== 'PK') throw new HttpError(400, 'El archivo no es un Excel .xlsx válido');
    const registros = await leerLayoutPorFacturar(archivo);
    const importados = await tx(async () => {
      const clientes = await q.all('SELECT k_cliente,cliente,estacion_id FROM dim_cliente');
      const porNombre = new Map();
      for (const cliente of clientes) {
        const clave = String(cliente.cliente || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
        const opciones = porNombre.get(clave) || [];
        opciones.push(cliente);
        porNombre.set(clave, opciones);
      }
      const productos = new Map((await q.all('SELECT nombre FROM productos'))
        .map((producto) => [String(producto.nombre).normalize('NFKC').trim().toLocaleLowerCase('es-MX'), producto.nombre]));
      const despachosExistentes = new Set((await q.all('SELECT despacho FROM v_cxc WHERE despacho IS NOT NULL'))
        .map((row) => String(row.despacho).normalize('NFKC').trim().toLocaleLowerCase('es-MX')));
      const estaciones = estacionesAsignadas(user);
      const errores = [], preparados = [], vistos = new Set();
      for (const row of registros) {
        const prefijo = `Fila ${row.fila}:`;
        const claveCliente = String(row.cliente || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
        const matches = porNombre.get(claveCliente) || [];
        if (!matches.length) {
          errores.push(`${prefijo} el cliente "${row.cliente}" no está registrado.`);
          continue;
        }
        if (matches.length > 1) {
          errores.push(`${prefijo} el cliente "${row.cliente}" es ambiguo; hay más de un registro en el catálogo.`);
          continue;
        }
        const cliente = matches[0];
        if (estaciones.length && !estaciones.includes(cliente.estacion_id)) {
          errores.push(`${prefijo} el cliente "${row.cliente}" está fuera de tus estaciones asignadas.`);
          continue;
        }
        const claveProducto = String(row.producto || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
        if (claveProducto && !productos.has(claveProducto)) {
          errores.push(`${prefijo} el producto "${row.producto}" no está registrado en el catálogo.`);
          continue;
        }
        const claveDespacho = String(row.despacho || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
        if (vistos.has(claveDespacho) || despachosExistentes.has(claveDespacho)) {
          errores.push(`${prefijo} el despacho "${row.despacho}" está duplicado en el archivo o ya fue registrado.`);
          continue;
        }
        vistos.add(claveDespacho);
        preparados.push({ ...row, producto: productos.get(claveProducto) || null, cliente });
      }
      if (errores.length) throw new HttpError(422, errores.slice(0, 100).join('\n'));
      const ids = [];
      for (let offset = 0; offset < preparados.length; offset += 250) {
        const lote = preparados.slice(offset, offset + 250).map((row) => ({
          sql: `INSERT INTO fact_cxc_app
            (fecha_despacho,despacho,importe,abono,k_cliente,estacion_id,estatus,producto,grupo,fecha_factura,no_factura,fecha_pago,fecha_vencimiento,usuario_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [row.fecha_despacho, row.despacho, row.importe, row.abono, row.cliente.k_cliente, row.cliente.estacion_id,
            'POR FACTURAR', row.producto, row.grupo || null, row.fecha_factura || row.fecha_despacho,
            row.no_factura || `PEND-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`, row.fecha_pago, null, user.id],
        }));
        const resultados = await q.batch(lote);
        ids.push(...resultados.map((resultado) => Number(resultado.lastInsertRowid || 0)));
      }
      const total = redondea(preparados.reduce((sum, row) => sum + row.importe - row.abono, 0));
      await L.bitacora(user, 'POR_FACTURAR_CARGA', `${preparados.length} despacho(s) · $${total.toFixed(2)} · ${Math.round(size / 1024)} KB`, ip(req));
      return { ids, total };
    });
    return send(res, 201, { ok: true, importados: importados.ids.length, total: importados.total });
  } finally { importando = false; fs.rm(archivo, { force: true }, () => {}); }
}
async function cargaExcel(req, res, user, query) {
  exigir(user, 'carga');
  const modo = query.get('modo') || 'completa';
  if (!['completa', 'parcial'].includes(modo)) throw new HttpError(400, 'Modo de carga inválido');
  const permitidos = new Set(['clientes_credito', 'cxc', 'debito']);
  const modulos = [...new Set((query.get('modulos') || '').split(',').filter(Boolean))];
  if (modo === 'parcial' && (!modulos.length || modulos.some((modulo) => !permitidos.has(modulo)))) {
    throw new HttpError(400, 'Selecciona al menos un módulo parcial válido');
  }
  if (importando) throw new HttpError(409, 'Ya hay una importación en curso');
  importando = true;
  const tmpDir = path.join(L.ROOT, 'tmp'); fs.mkdirSync(tmpDir, { recursive: true });
  const archivo = path.join(tmpDir, `carga_${Date.now()}.xlsx`);
  try {
    const size = await recibirXlsx(req, archivo);
    const fd = fs.openSync(archivo, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd);
    if (b.toString('latin1') !== 'PK') throw new HttpError(400, 'El archivo no es un Excel .xlsx válido');
    const respaldo = await L.respaldar();
    const resumen = await correrEtl(archivo, { modo, modulos });
    const passwordTemporal = modo === 'completa' ? await L.sembrarAdmin() : null;
    await L.bitacora(user, modo === 'completa' ? 'CARGA_COMPLETA' : 'CARGA_PARCIAL',
      `${resumen} (${Math.round(size / 1024)} KB)`, ip(req));
    const cookieSecure = COOKIE_SECURE ? '; Secure' : '';
    const headers = modo === 'completa'
      ? { 'Set-Cookie': `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure}` }
      : {};
    send(res, 200, { ok: true, modo, resumen, respaldo: path.basename(respaldo),
      ...(modo === 'completa' ? { password_temporal: passwordTemporal, password_configurada: Boolean(process.env.ADMIN_PASSWORD) } : {}),
      catalogos: await Q.catalogos() }, headers);
  } finally { importando = false; fs.rm(archivo, { force: true }, () => {}); }
}

// ---------- API ----------
async function api(req, res, url) {
  await L.ready;
  const m = req.method, p = url.pathname, query = url.searchParams;
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido');
  }
  if (p === '/api/login' && m === 'POST') return await login(await readBody(req), req, res);

  const token = cookies(req).sid;
  const user = await L.usuarioDeToken(token);
  if (!user) throw new HttpError(401, 'Sesión no válida');

  if (p === '/api/logout' && m === 'POST') {
    await L.cerrarSesion(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, perfil(user));
  if (p === '/api/cambiar-password' && m === 'POST') {
    const b = await readBody(req);
    const row = await q.get('SELECT pass_hash FROM usuarios WHERE id=?', user.id);
    if (!L.verifyPassword(String(b.actual || ''), row.pass_hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
    const err = L.passwordDebil(b.nueva); if (err) throw new HttpError(400, err);
    if (b.nueva === b.actual) throw new HttpError(400, 'La nueva contraseña debe ser distinta');
    await q.run('UPDATE usuarios SET pass_hash=?, must_change=0 WHERE id=?', L.hashPassword(b.nueva), user.id);
    await q.run('DELETE FROM sesiones WHERE usuario_id=? AND token_hash<>?', user.id, crypto.createHash('sha256').update(token).digest('hex'));
    await L.bitacora(user, 'CAMBIO_PASSWORD', null, ip(req));
    return send(res, 200, { ok: true });
  }
  if (user.must_change) throw new HttpError(403, 'Debes cambiar tu contraseña para continuar');

  // ================= LECTURA =================
  if (m === 'GET') {
    exigir(user, 'ver');
    if (p === '/api/catalogos') {
      const c = await Q.catalogos();
      const ids = estacionesAsignadas(user);
      if (ids.length) c.estaciones = c.estaciones.filter((e) => ids.includes(e.id));
      return send(res, 200, { ...c, roles: ROLES });
    }
    if (p === '/api/bancos') return send(res, 200, { rows: await q.all('SELECT id,nombre FROM bancos ORDER BY nombre') });
    if (p === '/api/metodos-pago') return send(res, 200, { rows: await q.all('SELECT id,nombre,requiere_banco FROM metodos_pago ORDER BY nombre') });
    if (p === '/api/productos') return send(res, 200, { rows: await q.all('SELECT id,nombre FROM productos ORDER BY nombre') });
    if (p === '/api/dashboard') return send(res, 200, await Q.dashboard(await params(query, user)));
    if (p === '/api/alertas') return send(res, 200, await Q.alertas(await params(query, user)));
    if (p === '/api/clientes-lista') {
      const pr = await params(query, user);
      return send(res, 200, { rows: await Q.listaClientes({ est: pr.est, estaciones: pr.estaciones, conFacturas: pr.con_facturas === '1', corte: pr.corte }) });
    }
    if (p === '/api/facturas') {
      const pr = await params(query, user);
      if (pr.formato === 'csv') {
        exigir(user, 'export');
        const r = await Q.facturas({ ...pr, todo: true });
        await L.bitacora(user, 'EXPORT', `facturas ${r.total}`, ip(req));
        return csv(res, 'facturas.csv', [['estacion', 'Estación'], ['cliente', 'Cliente'], ['no_factura', 'Factura'], ['fecha_factura', 'Fecha factura'],
          ['fecha_vencimiento', 'Vencimiento'], ['dias_vencido', 'Días vencido'], ['rango', 'Rango'], ['estado', 'Estado'], ['importe', 'Importe'],
          ['abono', 'Abono'], ['pagos_app', 'Pagos capturados'], ['saldo', 'Saldo']], r.rows);
      }
      return send(res, 200, await Q.facturas(pr));
    }
    if (p === '/api/factura') {
      await verificaCliente(user, query.get('k'));
      return send(res, 200, await Q.facturaDetalle({ corte: await Q.corteValido(query.get('corte')), k: query.get('k'), est: Number(query.get('est')), no: query.get('no') }));
    }
    if (p === '/api/facturas-anticipo') {
      exigir(user, 'anticipos_ver');
      return send(res, 200, await Q.facturasAnticipo(await params(query, user)));
    }
    const anticipoIdMatch = p.match(/^\/api\/facturas-anticipo\/(\d+)$/);
    if (anticipoIdMatch) {
      exigir(user, 'anticipos_ver');
      const factura = await Q.facturaAnticipoDetalle(Number(anticipoIdMatch[1]));
      await verificaCliente(user, factura.k_cliente);
      return send(res, 200, factura);
    }
    if (p === '/api/aplicaciones-anticipo/opciones') {
      exigir(user, 'aplicaciones_anticipo_ver');
      const k = query.get('k');
      await verificaCliente(user, k);
      return send(res, 200, await Q.opcionesAplicacionAnticipo({ k, corte: await Q.corteValido(query.get('corte')) }));
    }
    if (p === '/api/aplicaciones-anticipo') {
      exigir(user, 'aplicaciones_anticipo_ver');
      return send(res, 200, await Q.aplicacionesAnticipo(await params(query, user)));
    }
    const facturaIdMatch = p.match(/^\/api\/cartera\/facturas\/(\d+)$/);
    if (facturaIdMatch) {
      const factura = await q.get(`SELECT f.*, c.cliente, e.nombre estacion
        FROM fact_cxc_app f JOIN dim_cliente c ON c.k_cliente=f.k_cliente
        JOIN dim_estacion e ON e.id=f.estacion_id WHERE f.id=?`, Number(facturaIdMatch[1]));
      if (!factura) throw new HttpError(404, 'Factura capturada en la aplicación no encontrada');
      await verificaCliente(user, factura.k_cliente);
      return send(res, 200, factura);
    }
    if (p === '/api/prepago/saldo') {
      const k = query.get('k');
      await verificaCliente(user, k);
      const saldo = await Q.saldoDebito(k);
      return send(res, 200, { k_cliente: k, saldo_prepago: redondea(Math.max(0, saldo)) });
    }
    if (p === '/api/clientes') {
      const pr = await params(query, user);
      if (pr.formato === 'csv') {
        exigir(user, 'export');
        const r = await Q.clientes({ ...pr, todo: true });
        await L.bitacora(user, 'EXPORT', `clientes ${r.total}`, ip(req));
        return csv(res, 'clientes.csv', [['estacion', 'Estación'], ['cliente', 'Cliente'], ['no_cliente', 'No. cliente'], ['rfc', 'RFC'], ['email', 'Correo electrónico'], ['telefono', 'Teléfono'], ['modo_carga', 'Modo de carga'], ['limite', 'Límite de crédito'],
          ['dias_credito', 'Días de crédito'], ['saldo_fact', 'Saldo facturado'], ['vencido', 'Vencido'], ['por_facturar', 'Por facturar'],
          ['saldo_total', 'Saldo total'], ['disponible', 'Disponible'], ['max_dias', 'Máx. días vencido'], ['saldo_anticipo', 'Saldo disponible de anticipos'], ['riesgo', 'Riesgo']], r.rows);
      }
      return send(res, 200, await Q.clientes(pr));
    }
    if (p === '/api/cliente/estado-cuenta') {
      exigir(user, 'export');
      const k = query.get('k');
      await verificaCliente(user, k);
      const estadoCuenta = await Q.estadoCuenta({ k, corte: await Q.corteValido() });
      const cliente = await q.get('SELECT cliente FROM dim_cliente WHERE k_cliente=?', k);
      await L.bitacora(user, 'EXPORT', `estado_cuenta ${k} · ${estadoCuenta.rows.length} documento(s)`, ip(req));
      if (query.get('formato') !== 'csv') {
        return send(res, 200, {
          cliente: cliente.cliente,
          resumen: estadoCuenta.resumen,
          rows: estadoCuenta.rows,
          jerarquia: estadoCuenta.jerarquia,
        });
      }
      const nombre = k.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cliente';
      const resumenRows = [
        { tipo_documento: 'Resumen', concepto: 'Cartera pendiente', saldo_pendiente: estadoCuenta.resumen.cartera_pendiente, naturaleza: 'Por Cobrar' },
        { tipo_documento: 'Resumen', concepto: 'Despachos pendientes de facturar', saldo_pendiente: estadoCuenta.resumen.despachos_pendientes, naturaleza: 'Pendiente de Facturar' },
        { tipo_documento: 'Resumen', concepto: 'Anticipos disponibles', saldo_pendiente: estadoCuenta.resumen.anticipos_disponibles, naturaleza: 'A Favor' },
        { tipo_documento: 'Resumen', concepto: 'Posición neta del cliente', saldo_pendiente: estadoCuenta.resumen.posicion_neta, naturaleza: 'Cartera + despachos - anticipos' },
      ];
      const filasJerarquia = [];
      const aplanarJerarquia = (nodos, padre = '') => {
        for (const nodo of nodos) {
          filasJerarquia.push({
            fecha: nodo.fecha,
            tipo_documento: nodo.tipo_documento,
            folio: nodo.folio,
            concepto: nodo.concepto,
            fecha_vencimiento: nodo.fecha_vencimiento,
            importe_original: nodo.importe_original,
            importe_aplicado: nodo.importe_aplicado,
            saldo_pendiente: nodo.saldo_pendiente,
            naturaleza: nodo.naturaleza,
            estatus: nodo.estatus,
            moneda: nodo.moneda,
            tipo_cambio: nodo.tipo_cambio,
            equivalente_mxn: nodo.equivalente_mxn,
            nivel: nodo.nivel,
            documento_padre: padre,
            validacion: (nodo.validaciones || []).map((validacion) => validacion.mensaje).join(' | '),
          });
          aplanarJerarquia(nodo.hijos || [], nodo.folio);
        }
      };
      aplanarJerarquia(estadoCuenta.jerarquia);
      return csv(res, `estado_cuenta_${nombre}.csv`, [
        ['fecha', 'Fecha'], ['tipo_documento', 'Tipo de Documento'], ['folio', 'Serie/Folio'],
        ['concepto', 'Concepto'], ['fecha_vencimiento', 'Fecha de vencimiento'], ['importe_original', 'Importe Original'],
        ['saldo_pendiente', 'Saldo Pendiente'], ['naturaleza', 'Naturaleza'], ['estatus', 'Estatus'], ['moneda', 'Moneda'],
        ['tipo_cambio', 'Tipo de cambio'], ['equivalente_mxn', 'Saldo equivalente MXN'],
        ['importe_aplicado', 'Importe Aplicado'],
        ['nivel', 'Nivel'], ['documento_padre', 'Documento padre'], ['validacion', 'Validación'],
      ], [...resumenRows, ...filasJerarquia]);
    }
    if (p === '/api/cliente') { const k = query.get('k'); await verificaCliente(user, k); return send(res, 200, await Q.clienteDetalle({ corte: await Q.corteValido(query.get('corte')), k })); }
    if (p === '/api/por-facturar') return send(res, 200, await Q.porFacturar(await params(query, user)));
    if (p === '/api/debito') return send(res, 200, await Q.debitoResumen(await params(query, user)));
    if (p === '/api/debito/movimientos') { const pr = await params(query, user); if (pr.k) await verificaCliente(user, pr.k); return send(res, 200, await Q.debitoMovs(pr)); }
    if (p === '/api/pagos') {
      const wh = [], pr = [];
      filtrarEstaciones(alcance(user, query), 'p.estacion_id', wh, pr);
      if (query.get('q')) { wh.push('(c.cliente LIKE ? OR p.no_factura LIKE ? OR p.referencia LIKE ?)'); const l = `%${query.get('q')}%`; pr.push(l, l, l); }
      return send(res, 200, { rows: await q.all(`SELECT p.id, p.k_cliente, c.cliente, e.nombre estacion, p.no_factura, p.sin_aplicar, p.fecha, p.monto, p.metodo, COALESCE(p.banco,b.nombre) banco, p.referencia, p.notas,
          p.conciliado, p.anulado, p.desde_prepago,
          CASE WHEN EXISTS (SELECT 1 FROM debito_app d WHERE d.k_cliente=p.k_cliente AND d.folio='REVERSA-PAGO-'||p.id) THEN 1 ELSE 0 END prepago_devuelto,
          p.creado, u.nombre usuario FROM pagos p JOIN dim_cliente c ON c.k_cliente=p.k_cliente
          JOIN dim_estacion e ON e.id=p.estacion_id LEFT JOIN usuarios u ON u.id=p.usuario_id LEFT JOIN bancos b ON b.id=p.banco_id
          ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 500`, ...pr) });
    }
    if (p === '/api/gestiones') {
      const wh = [], pr = [];
      filtrarEstaciones(alcance(user, query), 'c.estacion_id', wh, pr);
      const estado = query.get('estado'); if (estado) { wh.push('g.estado=?'); pr.push(estado); }
      if (query.get('q')) { wh.push('c.cliente LIKE ?'); pr.push(`%${query.get('q')}%`); }
      return send(res, 200, { rows: await q.all(`SELECT g.*, c.cliente, e.nombre estacion, u.nombre usuario FROM gestiones g JOIN dim_cliente c ON c.k_cliente=g.k_cliente
          JOIN dim_estacion e ON e.id=c.estacion_id LEFT JOIN usuarios u ON u.id=g.usuario_id
          ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY (g.estado='Abierta') DESC, COALESCE(g.promesa_fecha,'9999') ASC, g.id DESC LIMIT 500`, ...pr) });
    }
    if (p === '/api/usuarios') {
      exigir(user, 'usuarios');
      const rows = await q.all(`SELECT u.id,u.usuario,u.nombre,u.email,u.rol,u.estacion_id,u.activo,u.ultimo_login,u.creado,
          e.id AS asignacion_estacion_id,e.nombre AS asignacion_estacion_nombre
        FROM usuarios u
        LEFT JOIN usuario_estaciones ue ON ue.usuario_id=u.id
        LEFT JOIN dim_estacion e ON e.id=COALESCE(ue.estacion_id,
          CASE WHEN NOT EXISTS (SELECT 1 FROM usuario_estaciones ue2 WHERE ue2.usuario_id=u.id) THEN u.estacion_id END)
        ORDER BY u.usuario,e.nombre`);
      const usuarios = new Map();
      for (const row of rows) {
        let usuario = usuarios.get(row.id);
        if (!usuario) {
          usuario = {
            id: row.id, usuario: row.usuario, nombre: row.nombre, email: row.email, rol: row.rol,
            estacion_id: row.estacion_id, activo: row.activo, ultimo_login: row.ultimo_login, creado: row.creado,
            estaciones: [],
          };
          usuarios.set(row.id, usuario);
        }
        if (row.asignacion_estacion_id != null) {
          usuario.estaciones.push({ id: row.asignacion_estacion_id, nombre: row.asignacion_estacion_nombre });
        }
      }
      const resultado = [...usuarios.values()].map((usuario) => ({
        ...usuario,
        estacion: usuario.estaciones[0]?.nombre || 'Todas',
      }));
      return send(res, 200, { rows: resultado });
    }
    if (p === '/api/bitacora') { exigir(user, 'bitacora'); return send(res, 200, { rows: await q.all('SELECT * FROM bitacora ORDER BY id DESC LIMIT 300') }); }
  }

  // ================= ESCRITURA =================
  let mt;
  if (m === 'POST' && p === '/api/carga') return await cargaExcel(req, res, user, query);
  if (m === 'POST' && p === '/api/por-facturar/carga')   if (m === 'POST' && p === '/api/por-facturar/carga') return await cargaPorFacturar(req, res, user);

  if (m === 'PUT' && p === '/api/catalogos/nombre-empresa') {
    if (user.rol !== 'admin') throw new HttpError(403, 'Solo el administrador puede modificar el nombre de la empresa');
    const b = await readBody(req), nombre = txt(b.nombre, 150);
    if (!nombre) throw new HttpError(400, 'El nombre de la empresa es obligatorio');
    const anterior = (await q.get("SELECT valor FROM meta WHERE clave='nombre_empresa'") || {}).valor || '';
    await q.run(`INSERT INTO meta(clave,valor) VALUES ('nombre_empresa',?)
      ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor`, nombre);
    await L.bitacora(user, 'NOMBRE_EMPRESA_EDITA', `${anterior || '(vacío)'} -> ${nombre}`, ip(req));
    return send(res, 200, { ok: true, nombre });
  }
  if (m === 'DELETE' && p === '/api/catalogos/nombre-empresa') {
    if (user.rol !== 'admin') throw new HttpError(403, 'Solo el administrador puede eliminar el nombre de la empresa');
    const actual = await q.get("SELECT valor FROM meta WHERE clave='nombre_empresa'");
    if (!actual) throw new HttpError(404, 'No hay un nombre de empresa configurado');
    await q.run("DELETE FROM meta WHERE clave='nombre_empresa'");
    await L.bitacora(user, 'NOMBRE_EMPRESA_BAJA', actual.valor, ip(req));
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/bancos') {
    exigir(user, 'usuarios');
    const b = await readBody(req);
    const nombre = txt(b.nombre, 80);
    if (!nombre) throw new HttpError(400, 'El nombre del banco es obligatorio');
    if (await q.get('SELECT 1 FROM bancos WHERE nombre=? COLLATE NOCASE', nombre)) throw new HttpError(409, 'Ese banco ya existe');
    const result = await q.run('INSERT INTO bancos(nombre) VALUES (?)', nombre);
    await L.bitacora(user, 'BANCO_ALTA', nombre, ip(req));
    return send(res, 201, { ok: true, id: Number(result.lastInsertRowid), nombre });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/bancos\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), b = await readBody(req), nombre = txt(b.nombre, 80);
    if (!await q.get('SELECT id FROM bancos WHERE id=?', id)) throw new HttpError(404, 'Banco no encontrado');
    if (!nombre) throw new HttpError(400, 'El nombre del banco es obligatorio');
    if (await q.get('SELECT 1 FROM bancos WHERE nombre=? COLLATE NOCASE AND id<>?', nombre, id)) throw new HttpError(409, 'Ese banco ya existe');
    await q.run('UPDATE bancos SET nombre=? WHERE id=?', nombre, id);
    await L.bitacora(user, 'BANCO_EDITA', `#${id} ${nombre}`, ip(req));
    return send(res, 200, { ok: true, id, nombre });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/bancos\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), banco = await q.get('SELECT id,nombre FROM bancos WHERE id=?', id);
    if (!banco) throw new HttpError(404, 'Banco no encontrado');
    await tx(async () => {
      await q.run('UPDATE pagos SET banco_id=NULL WHERE banco_id=?', id);
      await q.run('UPDATE debito_app SET banco_id=NULL WHERE banco_id=?', id);
      await q.run('DELETE FROM bancos WHERE id=?', id);
    });
    await L.bitacora(user, 'BANCO_BAJA', `${banco.nombre} (#${id})`, ip(req));
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/metodos-pago') {
    exigir(user, 'usuarios');
    const b = await readBody(req), nombre = txt(b.nombre, 40);
    if (!nombre) throw new HttpError(400, 'El nombre del método de pago es obligatorio');
    if (await q.get('SELECT 1 FROM metodos_pago WHERE nombre=? COLLATE NOCASE', nombre)) throw new HttpError(409, 'Ese método de pago ya existe');
    const requiere = requiereBanco(b.requiere_banco) ? 1 : 0;
    const result = await q.run('INSERT INTO metodos_pago(nombre,requiere_banco) VALUES (?,?)', nombre, requiere);
    await L.bitacora(user, 'METODO_PAGO_ALTA', `${nombre} · requiere banco: ${requiere ? 'sí' : 'no'}`, ip(req));
    return send(res, 201, { ok: true, id: Number(result.lastInsertRowid), nombre, requiere_banco: requiere });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/metodos-pago\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), b = await readBody(req), nombre = txt(b.nombre, 40);
    if (!await q.get('SELECT id FROM metodos_pago WHERE id=?', id)) throw new HttpError(404, 'Método de pago no encontrado');
    if (!nombre) throw new HttpError(400, 'El nombre del método de pago es obligatorio');
    if (await q.get('SELECT 1 FROM metodos_pago WHERE nombre=? COLLATE NOCASE AND id<>?', nombre, id)) throw new HttpError(409, 'Ese método de pago ya existe');
    const requiere = requiereBanco(b.requiere_banco) ? 1 : 0;
    await q.run('UPDATE metodos_pago SET nombre=?, requiere_banco=? WHERE id=?', nombre, requiere, id);
    await L.bitacora(user, 'METODO_PAGO_EDITA', `#${id} ${nombre} · requiere banco: ${requiere ? 'sí' : 'no'}`, ip(req));
    return send(res, 200, { ok: true, id, nombre, requiere_banco: requiere });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/metodos-pago\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), metodo = await q.get('SELECT id,nombre FROM metodos_pago WHERE id=?', id);
    if (!metodo) throw new HttpError(404, 'Método de pago no encontrado');
    if ((await q.get('SELECT COUNT(*) n FROM metodos_pago')).n <= 1) throw new HttpError(400, 'Debe quedar al menos un método de pago disponible');
    await q.run('DELETE FROM metodos_pago WHERE id=?', id);
    await L.bitacora(user, 'METODO_PAGO_BAJA', `${metodo.nombre} (#${id})`, ip(req));
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/productos') {
    exigir(user, 'usuarios');
    const b = await readBody(req), nombre = txt(b.nombre, 80);
    if (!nombre) throw new HttpError(400, 'El nombre del producto es obligatorio');
    if (await q.get('SELECT 1 FROM productos WHERE nombre=? COLLATE NOCASE', nombre)) throw new HttpError(409, 'Ese producto ya existe');
    const result = await q.run('INSERT INTO productos(nombre) VALUES (?)', nombre);
    await L.bitacora(user, 'PRODUCTO_ALTA', nombre, ip(req));
    return send(res, 201, { ok: true, id: Number(result.lastInsertRowid), nombre });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/productos\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), b = await readBody(req), nombre = txt(b.nombre, 80);
    const producto = await q.get('SELECT id,nombre FROM productos WHERE id=?', id);
    if (!producto) throw new HttpError(404, 'Producto no encontrado');
    if (!nombre) throw new HttpError(400, 'El nombre del producto es obligatorio');
    if (await q.get('SELECT 1 FROM productos WHERE nombre=? COLLATE NOCASE AND id<>?', nombre, id)) throw new HttpError(409, 'Ese producto ya existe');
    await tx(async () => {
      await q.run('UPDATE fact_cxc SET producto=? WHERE producto=?', nombre, producto.nombre);
      await q.run('UPDATE fact_cxc_app SET producto=? WHERE producto=?', nombre, producto.nombre);
      await q.run('UPDATE productos SET nombre=? WHERE id=?', nombre, id);
    });
    await L.bitacora(user, 'PRODUCTO_EDITA', `#${id} ${producto.nombre}->${nombre}`, ip(req));
    return send(res, 200, { ok: true, id, nombre });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/productos\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]), producto = await q.get('SELECT id,nombre FROM productos WHERE id=?', id);
    if (!producto) throw new HttpError(404, 'Producto no encontrado');
    if (await q.get('SELECT 1 FROM fact_cxc WHERE producto=? UNION ALL SELECT 1 FROM fact_cxc_app WHERE producto=? LIMIT 1', producto.nombre, producto.nombre)) {
      throw new HttpError(409, 'No se puede eliminar un producto asignado a despachos');
    }
    await q.run('DELETE FROM productos WHERE id=?', id);
    await L.bitacora(user, 'PRODUCTO_BAJA', `${producto.nombre} (#${id})`, ip(req));
    return send(res, 200, { ok: true });
  }

  if (m === 'PUT' && (mt = p.match(/^\/api\/por-facturar\/(\d+)$/))) {
    if (!can(user, 'facturas') && !can(user, 'editar_despacho')) throw new HttpError(403, 'No tienes permiso para esta acción');
    const id = Number(mt[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Identificador de despacho inválido');
    const despachoActual = await q.get(`SELECT id,origen,k_cliente,estacion_id,fecha_despacho,despacho,producto,grupo,importe,abono,estatus
      FROM v_cxc WHERE id=?`, id);
    if (!despachoActual || despachoActual.estatus !== 'POR FACTURAR' || despachoActual.importe - despachoActual.abono <= 0) {
      throw new HttpError(404, 'El despacho no existe o ya no está pendiente de facturar');
    }
    await verificaCliente(user, despachoActual.k_cliente);
    const body = await readBody(req);
    const fechaDespacho = txt(body.fecha_despacho, 10);
    if (!L.esFecha(fechaDespacho) || fechaDespacho > L.hoyISO()) {
      throw new HttpError(400, 'La fecha de despacho es inválida o futura');
    }
    const despacho = txt(body.despacho, 80) || null;
    let producto = txt(body.producto, 120) || null;
    const grupo = txt(body.grupo, 60) || null;
    const montoPendiente = redondea(L.num(body.monto, -1));
    const importe = redondea(montoPendiente + Number(despachoActual.abono || 0));
    if (!(montoPendiente > 0) || importe > 1e9) {
      throw new HttpError(400, 'El pendiente debe ser mayor a cero y el importe total no exceder $1,000,000,000');
    }
    if (producto) {
      const productoCatalogo = await q.get('SELECT nombre FROM productos WHERE nombre=? COLLATE NOCASE', producto);
      if (!productoCatalogo) throw new HttpError(400, 'Selecciona un producto válido del catálogo');
      producto = productoCatalogo.nombre;
    }
    const normalizaDespacho = (valor) => String(valor || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
    if (despacho && normalizaDespacho(despacho) !== normalizaDespacho(despachoActual.despacho)) {
      const existentes = await q.all('SELECT id,despacho FROM v_cxc WHERE despacho IS NOT NULL');
      const clave = normalizaDespacho(despacho);
      if (existentes.some((row) => row.id !== id && normalizaDespacho(row.despacho) === clave)) {
        throw new HttpError(409, 'Ya existe otro despacho con ese nombre');
      }
    }
    const tabla = despachoActual.origen === 'app' ? 'fact_cxc_app' : 'fact_cxc';
    const idInterno = despachoActual.origen === 'app' ? id - 2000000000 : id;
    const resultado = await q.run(`UPDATE ${tabla}
      SET fecha_despacho=?, despacho=?, producto=?, grupo=?, importe=?
      WHERE id=? AND estatus='POR FACTURAR' AND importe-abono>0`,
    fechaDespacho, despacho, producto, grupo, importe, idInterno);
    if (resultado.changes !== 1) throw new HttpError(409, 'El despacho cambió o dejó de estar pendiente; vuelve a cargar la lista');
    await L.bitacora(user, 'DESPACHO_EDITA',
      `${despachoActual.k_cliente} despacho #${id}: fecha ${despachoActual.fecha_despacho}->${fechaDespacho}, despacho ${despachoActual.despacho || ''}->${despacho || ''}, producto ${despachoActual.producto || ''}->${producto || ''}, grupo ${despachoActual.grupo || ''}->${grupo || ''}, pendiente ${redondea(despachoActual.importe - despachoActual.abono)}->${montoPendiente}`,
      ip(req));
    return send(res, 200, {
      ok: true, id, fecha_despacho: fechaDespacho, despacho, producto, grupo,
      importe, abono: Number(despachoActual.abono || 0), monto: montoPendiente,
    });
  }

  if (m === 'POST' && p === '/api/por-facturar') {
    exigirAlguno(user, 'facturas', 'despachos_crear');
    const b = await readBody(req);
    const cliente = await verificaCliente(user, txt(b.k_cliente, 200));
    const fechaDespacho = txt(b.fecha_despacho, 10) || L.hoyISO();
    const importe = redondea(L.num(b.importe, -1));
    if (!L.esFecha(fechaDespacho) || fechaDespacho > L.hoyISO()) throw new HttpError(400, 'La fecha de despacho es inválida o futura');
    if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe debe ser mayor a cero y no exceder $1,000,000,000');
    const despacho = txt(b.despacho, 80) || 'PENDIENTE';
    let producto = txt(b.producto, 120) || null;
    if (producto) {
      const productoCatalogo = await q.get('SELECT nombre FROM productos WHERE nombre=? COLLATE NOCASE', producto);
      if (!productoCatalogo) throw new HttpError(400, 'Selecciona un producto válido del catálogo');
      producto = productoCatalogo.nombre;
    }
    const noFactura = `POR-FACTURAR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await q.run(`INSERT INTO fact_cxc_app(fecha_despacho,despacho,producto,importe,abono,k_cliente,estacion_id,estatus,grupo,fecha_factura,no_factura,fecha_vencimiento,usuario_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, fechaDespacho, despacho, producto, importe, 0, cliente.k_cliente, cliente.estacion_id, 'POR FACTURAR',
      txt(b.grupo, 60) || 'PENDIENTE', fechaDespacho, noFactura, null, user.id);
    await L.bitacora(user, 'POR_FACTURAR_ALTA', `${cliente.k_cliente} $${importe} ${noFactura}`, ip(req));
    return send(res, 201, { ok: true, id: Number(r.lastInsertRowid), k_cliente: cliente.k_cliente, fecha_despacho: fechaDespacho, despacho, producto, importe, no_factura: noFactura });
  }

  // ----- pagos CxC -----
  if (m === 'POST' && (p === '/api/pagos' || p === '/api/pagos/lote')) {
    exigirAlguno(user, 'pagos', 'pagos_crear');
    const b = await readBody(req);
    await verificaCliente(user, b.k_cliente);
    if (!L.esFecha(b.fecha)) throw new HttpError(400, 'Fecha inválida');
    if (b.fecha > L.hoyISO()) throw new HttpError(400, 'La fecha de pago no puede ser futura');
    const metodoInput = txt(b.metodo, 40) || 'Transferencia SPEI';
    const esPrepagoDirecto = redondea(L.num(b.desde_prepago, 0)) > 0;
    if (esPrepagoDirecto || /^prepago$/i.test(metodoInput)) {
      throw new HttpError(410, 'El prepago fue reemplazado. Registra la Factura de Anticipo y su aplicación desde sus pantallas.');
    }
    const metodo = esPrepagoDirecto && metodoInput === 'Prepago'
      ? { nombre: 'Prepago', requiere_banco: 0 }
      : await q.get('SELECT nombre,requiere_banco FROM metodos_pago WHERE nombre=? COLLATE NOCASE', metodoInput);
    if (!metodo) throw new HttpError(400, 'Método de pago inválido');
    const metodoNombre = metodo.nombre;
    const metodoConBanco = !esPrepagoDirecto && !!metodo.requiere_banco;
    const bancoId = esPrepagoDirecto ? null : (b.banco_id == null || b.banco_id === '' ? null : Number(b.banco_id));
    const banco = bancoId == null ? null : await q.get('SELECT id,nombre FROM bancos WHERE id=?', bancoId);
    if (metodoConBanco && !banco) throw new HttpError(400, `Selecciona un banco para el método ${metodoNombre}`);
    if (bancoId != null && !banco) throw new HttpError(400, 'Banco inválido');
    const corte = await Q.corteValido(b.corte);
    const total = redondea(Number.isFinite(Number(b.monto)) ? Number(b.monto) : (Number.isFinite(Number(b.total)) ? Number(b.total) : 0));
    const apl = p === '/api/pagos/lote' ? (Array.isArray(b.aplicaciones) ? b.aplicaciones : []) : [{ no_factura: b.no_factura, estacion_id: b.estacion_id, monto: b.monto }];
    const items = apl.map((a) => ({ no: String(a.no_factura || ''), est: Number(a.estacion_id), monto: redondea(L.num(a.monto)) })).filter((a) => a.monto > 0);
    if (items.length && new Set(items.map((a) => a.est + '|' + a.no)).size !== items.length) throw new HttpError(400, 'Factura repetida en la aplicación');
    if (!items.length && !(total > 0)) throw new HttpError(400, 'Indica un monto mayor a cero o una aplicación válida');
    const totalAplicado = redondea(items.reduce((s, a) => s + a.monto, 0));
    if (total > 0 && totalAplicado > total + Q.EPS) throw new HttpError(400, 'La suma aplicada supera el monto total del pago');
    // --- prepago ---
    const desdePrepagoInput = redondea(L.num(b.desde_prepago, 0));
    if (desdePrepagoInput > 0 && items.length === 0) throw new HttpError(400, 'Indica al menos una factura a la que aplicar el prepago');
    if (desdePrepagoInput > 0 && (Math.abs(total - desdePrepagoInput) > Q.EPS || Math.abs(totalAplicado - desdePrepagoInput) > Q.EPS)) {
      throw new HttpError(400, 'Distribuye exactamente el monto de prepago solicitado entre las facturas');
    }
    let saldoPrepagoDisponible = 0;
    const ids = await tx(async () => {
      const deudaActual = redondea((await q.get(`SELECT COALESCE(SUM(saldo),0) AS saldo FROM ${Q.FAC(corte)} WHERE k_cliente=? AND abierta=1`, b.k_cliente)).saldo);
      const montoSolicitado = total > 0 ? total : totalAplicado;
      if (montoSolicitado > deudaActual + Q.EPS) {
        throw new HttpError(400, `No se puede exceder la deuda actual ($${deudaActual.toFixed(2)})`);
      }
      if (desdePrepagoInput > 0) {
        saldoPrepagoDisponible = redondea(Math.max(0, await Q.saldoDebito(b.k_cliente)));
        if (desdePrepagoInput > saldoPrepagoDisponible + Q.EPS) {
          throw new HttpError(400, `El monto de prepago solicitado ($${desdePrepagoInput.toFixed(2)}) excede el saldo disponible ($${saldoPrepagoDisponible.toFixed(2)})`);
        }
      }
      const resIds = [];
      for (const a of items) {
        const d = await q.get(`SELECT f.saldo FROM ${Q.FAC(corte)} f WHERE f.k_cliente=? AND f.estacion_id=? AND f.no_factura=?`, b.k_cliente, a.est, a.no);
        if (!d) throw new HttpError(404, `Factura ${a.no} no encontrada`);
        if (d.saldo <= Q.EPS) throw new HttpError(400, `La factura ${a.no} ya está liquidada`);
        if (a.monto > d.saldo + Q.EPS) throw new HttpError(400, `El monto de la factura ${a.no} excede su saldo (${d.saldo.toFixed(2)})`);
        const esPrepago = desdePrepagoInput > 0 ? 1 : 0;
        resIds.push(Number((await q.run(`INSERT INTO pagos(k_cliente,estacion_id,no_factura,fecha,monto,metodo,referencia,notas,usuario_id,banco_id,banco,desde_prepago)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          b.k_cliente, a.est, a.no, b.fecha, a.monto, metodoNombre, txt(b.referencia, 80), txt(b.notas, 300), user.id, bancoId, banco ? banco.nombre : null, esPrepago)).lastInsertRowid));
      }
      // Registrar consumo en débito si se usó prepago
      if (desdePrepagoInput > 0) {
        const cli = await q.get('SELECT estacion_id FROM dim_cliente WHERE k_cliente=?', b.k_cliente);
        const folioPrep = `PREPAGO-CXC-${b.no_factura || items.map((i) => i.no).join(',')}`;
        const rPrep = await q.run(`INSERT INTO debito_app(fecha,folio,tipo,importe,abono,k_cliente,estacion_id,usuario_id,metodo,banco_id,banco)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          b.fecha, folioPrep.slice(0, 60), 'CONSUMO', desdePrepagoInput, 0,
          b.k_cliente, cli.estacion_id, user.id, 'Aplicación a CxC', null, null);
        const prepagoRefId = Number(rPrep.lastInsertRowid);
        for (const pagoId of resIds) {
          await q.run('UPDATE pagos SET prepago_ref_id=? WHERE id=?', prepagoRefId, pagoId);
        }
        resIds.prepago_debito_id = 1000000000 + prepagoRefId;
      }
      const saldoSinAplicar = total > 0 ? redondea(total - totalAplicado) : 0;
      if (saldoSinAplicar > Q.EPS) {
        const noFactura = txt(b.no_factura, 80) || 'SIN APLICAR';
        resIds.push(Number((await q.run(`INSERT INTO pagos(k_cliente,estacion_id,no_factura,fecha,monto,metodo,referencia,notas,usuario_id,sin_aplicar,banco_id,banco)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
          b.k_cliente, Number(b.estacion_id) || (await q.get('SELECT estacion_id FROM dim_cliente WHERE k_cliente=?', b.k_cliente)).estacion_id, noFactura, b.fecha, saldoSinAplicar, metodoNombre,
          txt(b.referencia, 80), txt(b.notas, 300) || 'Cobro guardado sin aplicación a factura', user.id, bancoId, banco ? banco.nombre : null)).lastInsertRowid));
      }
      return resIds;
    });
    const totalGuardado = redondea(items.reduce((s, a) => s + a.monto, 0) + (total > 0 ? Math.max(0, total - totalAplicado) : 0));
    const saldoRemanente = desdePrepagoInput > 0 ? redondea(Math.max(0, saldoPrepagoDisponible - desdePrepagoInput)) : 0;
    const prepagoTag = desdePrepagoInput > 0 ? ` fecha:${b.fecha} prepago_aplicado:$${desdePrepagoInput.toFixed(2)} prepago_remanente:$${saldoRemanente.toFixed(2)}` : '';
    await L.bitacora(user, 'PAGO', `${ids.length} movimiento(s) $${totalGuardado} ${b.k_cliente} ref:${txt(b.referencia, 40)}${prepagoTag}`, ip(req));
    return send(res, 201, {
      ok: true,
      ids,
      total: totalGuardado,
      aplicado: redondea(totalAplicado),
      sin_aplicar: total > 0 ? redondea(Math.max(0, total - totalAplicado)) : 0,
      desde_prepago: redondea(desdePrepagoInput),
      prepago_saldo_anterior: redondea(saldoPrepagoDisponible),
      prepago_saldo_remanente: saldoRemanente,
      prepago_debito_id: ids.prepago_debito_id || null,
      fecha: b.fecha,
      cliente: b.k_cliente,
      referencia: txt(b.referencia, 80),
      metodo: metodoNombre,
      facturas: items,
    });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/pagos\/(\d+)$/))) {
    if (!can(user, 'pagos') && !can(user, 'anular_pago')) throw new HttpError(403, 'No tienes permiso para esta acción');
    const pg = await q.get('SELECT * FROM pagos WHERE id=?', Number(mt[1]));
    if (!pg) throw new HttpError(404, 'Pago no encontrado');
    const idsPg = estacionesAsignadas(user);
    if (idsPg.length && !idsPg.includes(pg.estacion_id)) throw new HttpError(403, 'Fuera de tu estación');
    if (pg.usuario_id !== user.id && user.rol !== 'admin' && !can(user, 'anular_pago')) throw new HttpError(403, 'Solo el administrador o quien lo capturó puede anularlo');
    const resultado = await tx(async () => {
      const actual = await q.get('SELECT * FROM pagos WHERE id=?', pg.id);
      if (!actual) throw new HttpError(404, 'Pago no encontrado');
      if (actual.conciliado) throw new HttpError(400, 'El pago ya fue conciliado con el Excel y no puede anularse');
      const yaAnulado = Boolean(actual.anulado);
      if (yaAnulado && !actual.desde_prepago) throw new HttpError(400, 'El pago ya fue anulado');
      let restaurado = 0;
      if (actual.desde_prepago) {
        const folioReversa = `REVERSA-PAGO-${actual.id}`;
        const reversaExistente = await q.get('SELECT id FROM debito_app WHERE k_cliente=? AND folio=?',
          actual.k_cliente, folioReversa);
        if (!reversaExistente) {
          let prepagoRefId = Number(actual.prepago_ref_id) || 0;
          if (!prepagoRefId) {
            const prefijo = 'PREPAGO-CXC-';
            const movimientos = await q.all(`SELECT id, folio, anulado FROM debito_app
              WHERE k_cliente=? AND fecha=? AND tipo='CONSUMO' AND folio LIKE ? ORDER BY id`,
            actual.k_cliente, actual.fecha, `${prefijo}%`);
            let coincidencias = movimientos.filter((movimiento) =>
              [movimiento.folio.slice(prefijo.length)].some((referencias) =>
                referencias === actual.no_factura || referencias.startsWith(`${actual.no_factura},`) ||
                referencias.endsWith(`,${actual.no_factura}`) || referencias.includes(`,${actual.no_factura},`)));
            if (coincidencias.length > 1) {
              const pagosVinculados = await q.all(`SELECT DISTINCT prepago_ref_id FROM pagos
                WHERE k_cliente=? AND fecha=? AND no_factura=? AND desde_prepago=1
                  AND prepago_ref_id IS NOT NULL AND id<>?`,
              actual.k_cliente, actual.fecha, actual.no_factura, actual.id);
              const referenciasConocidas = new Set(pagosVinculados.map((pago) => Number(pago.prepago_ref_id)));
              coincidencias = coincidencias.filter((movimiento) => !referenciasConocidas.has(Number(movimiento.id)));
            }
            const candidatos = coincidencias.length === 1 ? coincidencias : [];
            if (candidatos.length !== 1) {
              throw new HttpError(409, 'No se puede identificar de forma única el prepago aplicado a este pago; no se anuló para evitar alterar incorrectamente el saldo a favor.');
            }
            prepagoRefId = candidatos[0].id;
          }
          const consumo = await q.get('SELECT * FROM debito_app WHERE id=? AND k_cliente=?', prepagoRefId, actual.k_cliente);
          if (!consumo || consumo.tipo !== 'CONSUMO') throw new HttpError(409, 'No se encontró el movimiento de prepago relacionado; no se anuló el pago.');
          if (!actual.prepago_ref_id) {
            await q.run('UPDATE pagos SET prepago_ref_id=? WHERE id=?', prepagoRefId, actual.id);
          }
          if (!consumo.anulado) {
            await q.run(`INSERT INTO debito_app(fecha,folio,tipo,importe,abono,k_cliente,estacion_id,usuario_id,metodo)
              VALUES (?,?, 'RECARGA',0,?,?,?,?,?)`,
            L.hoyISO(), folioReversa, actual.monto, actual.k_cliente, consumo.estacion_id, user.id, 'Devolución de pago prepago');
            restaurado = redondea(actual.monto);
          } else if (!yaAnulado) {
            throw new HttpError(409, 'El consumo relacionado ya está anulado; no se anuló el pago para evitar alterar incorrectamente el saldo a favor.');
          }
        }
      }
      if (!yaAnulado) {
        const anulacion = await q.run('UPDATE pagos SET anulado=1 WHERE id=? AND anulado=0', actual.id);
        if (anulacion.changes !== 1) throw new HttpError(400, 'El pago ya fue anulado');
      }
      return { restaurado, yaAnulado };
    });
    if (!resultado.yaAnulado || resultado.restaurado) {
      await L.bitacora(user, 'PAGO_ANULADO', `#${pg.id} ${pg.no_factura} $${pg.monto}${resultado.restaurado ? ` prepago_devuelto:$${resultado.restaurado.toFixed(2)}` : ''}`, ip(req));
    }
    return send(res, 200, { ok: true, prepago_restaurado: resultado.restaurado, ya_anulado: resultado.yaAnulado });
  }

  if (m === 'POST' && p === '/api/cartera/facturas') {
    exigirAlguno(user, 'facturas', 'facturas_crear');
    const b = await readBody(req);
    const cliente = await verificaCliente(user, txt(b.k_cliente, 200));
    const noFactura = txt(b.no_factura, 80);
    const fechaFactura = txt(b.fecha_factura, 10);
    const facturarPendientes = !!b.facturar_por_facturar || !!b.emitir_factura || Array.isArray(b.ids) && b.ids.length > 0;
    if (facturarPendientes) {
      if (!noFactura) throw new HttpError(400, 'El número de factura es obligatorio');
      if (!L.esFecha(fechaFactura) || fechaFactura > L.hoyISO()) throw new HttpError(400, 'La fecha de factura es inválida o futura');
      const ids = Array.isArray(b.ids) ? b.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : [];
      if (!ids.length || new Set(ids).size !== ids.length) throw new HttpError(400, 'Selecciona uno o más despachos pendientes de facturar');
      const qsIds = ids.map(() => '?').join(',');
      const filas = await q.all(`SELECT id, origen, importe, abono, estatus FROM v_cxc WHERE id IN (${qsIds}) AND k_cliente=? AND estacion_id=? AND estatus='POR FACTURAR' AND importe-abono>0`,
        ...ids, cliente.k_cliente, cliente.estacion_id);
      if (!filas.length) throw new HttpError(400, 'No hay despachos por facturar para este cliente');
      if (filas.length !== ids.length) throw new HttpError(400, 'Los despachos seleccionados no coinciden con los pendientes de facturar');
      if (await q.get(`SELECT 1 FROM v_cxc WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND estatus IN ('POR PAGAR','ABONADO')
          UNION ALL SELECT 1 FROM fact_factura WHERE k_cliente=? AND estacion_id=? AND no_factura=? LIMIT 1`,
        cliente.k_cliente, cliente.estacion_id, noFactura, cliente.k_cliente, cliente.estacion_id, noFactura)) {
        throw new HttpError(409, 'Ya existe una factura con ese número para este cliente');
      }
      const suma = filas.reduce((s, f) => s + Math.max(0, Number(f.importe || 0) - Number(f.abono || 0)), 0);
      const diasCredito = (await q.get('SELECT COALESCE(dias,0) dias FROM credito WHERE k_cliente=?', cliente.k_cliente) || { dias: 0 }).dias;
      const vencimiento = new Date(`${fechaFactura}T00:00:00.000Z`);
      vencimiento.setUTCDate(vencimiento.getUTCDate() + diasCredito);
      const fechaVencimiento = vencimiento.toISOString().slice(0, 10);
      await tx(async () => {
        for (const fila of filas) {
          if (fila.origen === 'app') {
            const actualizado = await q.run(`UPDATE fact_cxc_app SET facturada_desde_pendiente=1,
                prev_fecha_factura=fecha_factura, prev_no_factura=no_factura, prev_fecha_vencimiento=fecha_vencimiento,
                estatus=?, fecha_factura=?, no_factura=?, fecha_vencimiento=? WHERE id=? AND estatus='POR FACTURAR' AND importe-abono>0`,
              'POR PAGAR', fechaFactura, noFactura, fechaVencimiento, fila.id - 2000000000);
            if (actualizado.changes !== 1) throw new HttpError(409, 'Uno o más despachos cambiaron; no se emitió la factura');
          } else {
            const actualizado = await q.run(`UPDATE fact_cxc SET facturada_desde_pendiente=1,
                prev_fecha_factura=fecha_factura, prev_no_factura=no_factura, prev_fecha_vencimiento=fecha_vencimiento,
                estatus=?, fecha_factura=?, no_factura=?, fecha_vencimiento=? WHERE id=? AND estatus='POR FACTURAR' AND importe-abono>0`,
              'POR PAGAR', fechaFactura, noFactura, fechaVencimiento, fila.id);
            if (actualizado.changes !== 1) throw new HttpError(409, 'Uno o más despachos cambiaron; no se emitió la factura');
          }
        }
      });
      await L.bitacora(user, 'FACTURA_EMITIDA', `${noFactura} $${suma.toFixed(2)} ${cliente.k_cliente} (${filas.length} despachos)`, ip(req));
      return send(res, 201, { ok: true, k_cliente: cliente.k_cliente, no_factura: noFactura, importe: redondea(suma), fecha_factura: fechaFactura, fecha_vencimiento: fechaVencimiento, actualizados: filas.length });
    }
    const importe = redondea(L.num(b.importe, -1));
    if (!noFactura) throw new HttpError(400, 'El número de factura es obligatorio');
    if (!L.esFecha(fechaFactura) || fechaFactura > L.hoyISO()) throw new HttpError(400, 'La fecha de factura es inválida o futura');
    if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe debe ser mayor a cero y no exceder $1,000,000,000');
    if (await q.get('SELECT 1 FROM v_cxc WHERE k_cliente=? AND estacion_id=? AND no_factura=?',
      cliente.k_cliente, cliente.estacion_id, noFactura)) {
      throw new HttpError(409, 'Ya existe una factura con ese número para este cliente');
    }
    const diasCredito = (await q.get('SELECT COALESCE(dias,0) dias FROM credito WHERE k_cliente=?', cliente.k_cliente) || { dias: 0 }).dias;
    const vencimiento = new Date(`${fechaFactura}T00:00:00.000Z`);
    vencimiento.setUTCDate(vencimiento.getUTCDate() + diasCredito);
    const fechaVencimiento = vencimiento.toISOString().slice(0, 10);
    const factura = await q.run(`INSERT INTO fact_cxc_app(fecha_despacho,despacho,importe,abono,k_cliente,estacion_id,estatus,fecha_factura,no_factura,fecha_vencimiento,usuario_id)
      VALUES (?,?,?,0,? ,?,'POR PAGAR',?,?,?,?)`,
      fechaFactura, noFactura, importe, cliente.k_cliente, cliente.estacion_id, fechaFactura, noFactura, fechaVencimiento, user.id);
    const facturaId = Number(factura.lastInsertRowid);
    await L.bitacora(user, 'FACTURA_ALTA', `${noFactura} $${importe} ${cliente.k_cliente}`, ip(req));
    return send(res, 201, { ok: true, id: facturaId, k_cliente: cliente.k_cliente, no_factura: noFactura, importe, fecha_vencimiento: fechaVencimiento });
  }
  if (m === 'POST' && p === '/api/cartera/facturas/anular-despachos') {
    exigir(user, 'facturas');
    const b = await readBody(req);
    const cliente = await verificaCliente(user, txt(b.k_cliente, 200));
    const noFactura = txt(b.no_factura, 80);
    const estacionId = Number(b.estacion_id);
    if (!noFactura || !Number.isInteger(estacionId) || estacionId !== cliente.estacion_id) {
      throw new HttpError(400, 'La factura seleccionada es inválida');
    }
    const resultado = await tx(async () => {
      const filas = await q.all(`SELECT id, origen FROM v_cxc
        WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND facturada_desde_pendiente=1
          AND estatus IN ('POR PAGAR','ABONADO')`, cliente.k_cliente, estacionId, noFactura);
      if (!filas.length) throw new HttpError(404, 'La factura no contiene despachos pendientes anulables');
      const totalFactura = await q.get(`SELECT COUNT(*) total FROM v_cxc
        WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND estatus<>'POR FACTURAR'`,
      cliente.k_cliente, estacionId, noFactura);
      if (Number(totalFactura.total) !== filas.length) {
        throw new HttpError(409, 'No se puede anular: la factura contiene movimientos que no se pueden restaurar');
      }
      if (await q.get('SELECT 1 FROM fact_factura WHERE k_cliente=? AND estacion_id=? AND no_factura=? LIMIT 1',
        cliente.k_cliente, estacionId, noFactura)) {
        throw new HttpError(409, 'No se puede anular: la factura también existe en el resumen importado de Excel');
      }
      if (await q.get('SELECT 1 FROM pagos WHERE k_cliente=? AND estacion_id=? AND no_factura=? LIMIT 1',
        cliente.k_cliente, estacionId, noFactura)) {
        throw new HttpError(409, 'No se puede anular la factura porque tiene pagos asociados');
      }
      if (await q.get(`SELECT 1 FROM aplicaciones_factura_anticipo WHERE k_cliente=? AND estacion_id=?
        AND no_factura=? AND estado='APLICADA' LIMIT 1`, cliente.k_cliente, estacionId, noFactura)) {
        throw new HttpError(409, 'Cancela las aplicaciones de anticipo antes de restaurar los despachos');
      }
      for (const fila of filas) {
        const tabla = fila.origen === 'app' ? 'fact_cxc_app' : 'fact_cxc';
        const id = fila.origen === 'app' ? fila.id - 2000000000 : fila.id;
        const actualizado = await q.run(`UPDATE ${tabla} SET estatus='POR FACTURAR', fecha_factura=prev_fecha_factura,
            no_factura=prev_no_factura, fecha_vencimiento=prev_fecha_vencimiento,
            facturada_desde_pendiente=0, prev_fecha_factura=NULL, prev_no_factura=NULL, prev_fecha_vencimiento=NULL
          WHERE id=? AND facturada_desde_pendiente=1 AND no_factura=? AND estatus IN ('POR PAGAR','ABONADO')`, id, noFactura);
        if (actualizado.changes !== 1) throw new HttpError(409, 'Uno o más despachos cambiaron; no se anuló la factura');
      }
      return { despachos: filas.length };
    });
    await L.bitacora(user, 'FACTURA_ANULADA', `${noFactura} ${cliente.k_cliente} (${resultado.despachos} despachos)`, ip(req));
    return send(res, 200, { ok: true, no_factura: noFactura, despachos: resultado.despachos });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/cartera\/facturas\/(\d+)$/))) {
    exigir(user, 'facturas');
    const b = await readBody(req);
    const id = Number(mt[1]);
    const factura = await q.get('SELECT * FROM fact_cxc_app WHERE id=?', id);
    if (!factura) throw new HttpError(404, 'Solo se pueden editar facturas registradas en la aplicación');
    if (factura.facturada_desde_pendiente) throw new HttpError(409, 'Los despachos asociados deben modificarse desde la pantalla Por Facturar');
    const idsFactura = estacionesAsignadas(user);
    if (idsFactura.length && !idsFactura.includes(factura.estacion_id)) throw new HttpError(403, 'Fuera de tu estación');
    const noFactura = txt(b.no_factura, 80);
    const fechaFactura = txt(b.fecha_factura, 10);
    const importe = redondea(L.num(b.importe, -1));
    if (!noFactura) throw new HttpError(400, 'El número de factura es obligatorio');
    if (!L.esFecha(fechaFactura) || fechaFactura > L.hoyISO()) throw new HttpError(400, 'La fecha de factura es inválida o futura');
    if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe debe ser mayor a cero y no exceder $1,000,000,000');
    if (await q.get(`SELECT 1 FROM v_cxc WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND NOT (origen='app' AND id=?)`,
      factura.k_cliente, factura.estacion_id, noFactura, 2000000000 + id)) {
      throw new HttpError(409, 'Ya existe otra factura con ese número para este cliente');
    }
    const pagos = await q.get('SELECT COALESCE(SUM(monto),0) monto, COUNT(*) n FROM pagos WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND anulado=0',
      factura.k_cliente, factura.estacion_id, factura.no_factura);
    if (await q.get(`SELECT 1 FROM aplicaciones_factura_anticipo WHERE k_cliente=? AND estacion_id=?
      AND no_factura=? AND estado='APLICADA' LIMIT 1`, factura.k_cliente, factura.estacion_id, factura.no_factura)) {
      throw new HttpError(409, 'Cancela las aplicaciones de anticipo antes de editar la factura');
    }
    if (importe + Q.EPS < factura.abono + pagos.monto) {
      throw new HttpError(400, `El importe no puede ser menor a los abonos y pagos registrados (${redondea(factura.abono + pagos.monto).toFixed(2)})`);
    }
    if (noFactura !== factura.no_factura && pagos.n) {
      throw new HttpError(400, 'No se puede cambiar el número de factura porque ya tiene pagos registrados');
    }
    const diasCredito = (await q.get('SELECT COALESCE(dias,0) dias FROM credito WHERE k_cliente=?', factura.k_cliente) || { dias: 0 }).dias;
    const vencimiento = new Date(`${fechaFactura}T00:00:00.000Z`);
    vencimiento.setUTCDate(vencimiento.getUTCDate() + diasCredito);
    const fechaVencimiento = vencimiento.toISOString().slice(0, 10);
    await q.run('UPDATE fact_cxc_app SET no_factura=?, despacho=?, importe=?, fecha_despacho=?, fecha_factura=?, fecha_vencimiento=? WHERE id=?',
      noFactura, noFactura, importe, fechaFactura, fechaFactura, fechaVencimiento, id);
    await L.bitacora(user, 'FACTURA_EDITAR', `#${id} factura ${factura.no_factura}->${noFactura}, importe ${factura.importe}->${importe}`, ip(req));
    return send(res, 200, { ok: true, id, no_factura: noFactura, importe, fecha_vencimiento: fechaVencimiento });
  }

  // ----- facturas de anticipo y sus aplicaciones -----
  if (m === 'POST' && p === '/api/facturas-anticipo') {
    exigir(user, 'anticipos_crear');
    const b = await readBody(req);
    const cliente = await verificaCliente(user, txt(b.k_cliente, 200));
    const datos = datosFacturaAnticipo(b);
    const duplicada = await q.get(`SELECT id FROM facturas_anticipo
      WHERE k_cliente=? AND COALESCE(serie,'')=? AND folio=? COLLATE NOCASE`,
    cliente.k_cliente, datos.serie || '', datos.folio);
    if (duplicada) throw new HttpError(409, 'Ya existe una Factura de Anticipo con ese folio para el cliente');
    if (datos.uuid && await q.get('SELECT id FROM facturas_anticipo WHERE uuid_fiscal=? COLLATE NOCASE', datos.uuid)) {
      throw new HttpError(409, 'El UUID fiscal ya está registrado');
    }
    let id;
    await tx(async () => {
      const r = await q.run(`INSERT INTO facturas_anticipo
        (k_cliente,serie,folio,uuid_fiscal,fecha_factura,importe_original,importe_aplicado,saldo_disponible,
         moneda,tipo_cambio,referencia,observaciones,estado,created_by)
        VALUES (?,?,?,?,?,?,0,?,?,?,?,?,'ABIERTA',?)`,
      cliente.k_cliente, datos.serie, datos.folio, datos.uuid, datos.fecha, datos.importe, datos.importe,
      datos.moneda, datos.cambio, datos.referencia, datos.observaciones, user.usuario);
      id = Number(r.lastInsertRowid);
      await L.bitacora(user, 'ANTICIPO_ALTA', `#${id} ${cliente.k_cliente} ${datos.serie || ''}-${datos.folio} $${datos.importe} ${datos.moneda}`, ip(req));
    });
    return send(res, 201, { ok: true, id, saldo_disponible: datos.importe, estado: 'ABIERTA' });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/facturas-anticipo\/(\d+)$/))) {
    exigir(user, 'anticipos_editar');
    const id = Number(mt[1]), b = await readBody(req), datos = datosFacturaAnticipo(b);
    const existente = await q.get('SELECT * FROM facturas_anticipo WHERE id=?', id);
    if (!existente) throw new HttpError(404, 'Factura de Anticipo no encontrada');
    await verificaCliente(user, existente.k_cliente);
    if (existente.estado === 'CANCELADA') throw new HttpError(409, 'No se puede editar una Factura de Anticipo cancelada');
    if (Number(existente.importe_aplicado) > Q.EPS ||
        await q.get('SELECT 1 FROM aplicaciones_factura_anticipo WHERE factura_anticipo_id=? LIMIT 1', id)) {
      throw new HttpError(409, 'No se puede editar una Factura de Anticipo que tiene aplicaciones; conserva su historial');
    }
    const duplicada = await q.get(`SELECT id FROM facturas_anticipo WHERE id<>? AND k_cliente=?
      AND COALESCE(serie,'')=? AND folio=? COLLATE NOCASE`, id, existente.k_cliente, datos.serie || '', datos.folio);
    if (duplicada) throw new HttpError(409, 'Ya existe una Factura de Anticipo con ese folio para el cliente');
    if (datos.uuid && await q.get('SELECT id FROM facturas_anticipo WHERE id<>? AND uuid_fiscal=? COLLATE NOCASE', id, datos.uuid)) {
      throw new HttpError(409, 'El UUID fiscal ya está registrado');
    }
    await tx(async () => {
      await q.run(`UPDATE facturas_anticipo SET serie=?,folio=?,uuid_fiscal=?,fecha_factura=?,importe_original=?,
        importe_aplicado=0,saldo_disponible=?,moneda=?,tipo_cambio=?,referencia=?,observaciones=?,estado='ABIERTA',
        updated_at=datetime('now'),updated_by=? WHERE id=? AND estado<>'CANCELADA' AND importe_aplicado=0`,
      datos.serie, datos.folio, datos.uuid, datos.fecha, datos.importe, datos.importe, datos.moneda, datos.cambio,
      datos.referencia, datos.observaciones, user.usuario, id);
      await L.bitacora(user, 'ANTICIPO_EDITAR', `#${id} ${existente.folio}->${datos.folio}; importe ${existente.importe_original}->${datos.importe}`, ip(req));
    });
    return send(res, 200, { ok: true, id, saldo_disponible: datos.importe, estado: 'ABIERTA' });
  }
  if (m === 'POST' && (mt = p.match(/^\/api\/facturas-anticipo\/(\d+)\/cancelar$/))) {
    exigir(user, 'anticipos_cancelar');
    const id = Number(mt[1]), b = await readBody(req), motivo = txt(b.motivo, 500);
    if (!motivo) throw new HttpError(400, 'Indica el motivo de cancelación');
    const resultado = await tx(async () => {
      const factura = await q.get('SELECT * FROM facturas_anticipo WHERE id=?', id);
      if (!factura) throw new HttpError(404, 'Factura de Anticipo no encontrada');
      await verificaCliente(user, factura.k_cliente);
      if (factura.estado === 'CANCELADA') throw new HttpError(409, 'La Factura de Anticipo ya está cancelada');
      if (await q.get(`SELECT 1 FROM aplicaciones_factura_anticipo
        WHERE factura_anticipo_id=? AND estado='APLICADA' LIMIT 1`, id)) {
        throw new HttpError(409, 'Cancela primero las aplicaciones activas de esta Factura de Anticipo');
      }
      await q.run(`UPDATE facturas_anticipo SET estado='CANCELADA',fecha_cancelacion=datetime('now'),
        motivo_cancelacion=?,updated_at=datetime('now'),updated_by=? WHERE id=? AND estado<>'CANCELADA'`,
      motivo, user.usuario, id);
      await L.bitacora(user, 'ANTICIPO_CANCELAR', `#${id} saldo ${factura.saldo_disponible}; motivo:${motivo}`, ip(req));
      return { saldo_disponible: factura.saldo_disponible };
    });
    return send(res, 200, { ok: true, saldo_disponible: resultado.saldo_disponible, estado: 'CANCELADA' });
  }
  if (m === 'POST' && p === '/api/aplicaciones-anticipo') {
    exigir(user, 'aplicaciones_anticipo_crear');
    const b = await readBody(req), k = txt(b.k_cliente, 200), idAnticipo = Number(b.factura_anticipo_id);
    const estacionId = Number(b.estacion_id), noFactura = txt(b.no_factura, 80);
    const fecha = txt(b.fecha_aplicacion, 10), importe = redondea(L.num(b.importe_aplicado, -1));
    const idempotencia = txt(b.idempotencia, 100);
    const referencia = txt(b.referencia, 100) || null, observaciones = txt(b.observaciones, 1000) || null;
    const cliente = await verificaCliente(user, k);
    if (!Number.isSafeInteger(idAnticipo) || idAnticipo <= 0) throw new HttpError(400, 'Selecciona una Factura de Anticipo válida');
    if (!Number.isInteger(estacionId) || estacionId !== cliente.estacion_id || !noFactura) throw new HttpError(400, 'Selecciona una factura existente del cliente');
    if (!L.esFecha(fecha) || fecha > L.hoyISO()) throw new HttpError(400, 'La fecha de aplicación es inválida o futura');
    if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe a aplicar debe ser mayor a cero');
    if (!/^[A-Za-z0-9._:-]{16,100}$/.test(idempotencia)) throw new HttpError(400, 'Clave de idempotencia inválida');
    const previo = await q.get('SELECT id,factura_anticipo_id,k_cliente,estacion_id,no_factura,importe_aplicado,estado FROM aplicaciones_factura_anticipo WHERE idempotencia=?', idempotencia);
    if (previo) {
      if (previo.factura_anticipo_id === idAnticipo && previo.k_cliente === k && previo.estacion_id === estacionId &&
          previo.no_factura === noFactura && Number(previo.importe_aplicado) === importe) {
        return send(res, 200, { ok: true, repetida: true, id: previo.id, estado: previo.estado });
      }
      throw new HttpError(409, 'La clave de idempotencia ya se utilizó para otra aplicación');
    }
    const corte = await Q.corteValido(b.corte);
    const resultado = await tx(async () => {
      const existente = await q.get(`SELECT id,factura_anticipo_id,k_cliente,estacion_id,no_factura,importe_aplicado,estado
        FROM aplicaciones_factura_anticipo WHERE idempotencia=?`, idempotencia);
      if (existente) {
        if (existente.factura_anticipo_id === idAnticipo && existente.k_cliente === k &&
            existente.estacion_id === estacionId && existente.no_factura === noFactura &&
            Number(existente.importe_aplicado) === importe) {
          return { repetida: true, id: existente.id, estado: existente.estado };
        }
        throw new HttpError(409, 'La clave de idempotencia ya se utilizó para otra aplicación');
      }
      const anticipo = await q.get('SELECT * FROM facturas_anticipo WHERE id=?', idAnticipo);
      if (!anticipo) throw new HttpError(404, 'Factura de Anticipo no encontrada');
      if (anticipo.k_cliente !== k) throw new HttpError(400, 'La Factura de Anticipo no pertenece al cliente seleccionado');
      if (anticipo.estado === 'CANCELADA') throw new HttpError(400, 'La Factura de Anticipo está cancelada');
      if (anticipo.estado === 'CERRADA' || Number(anticipo.saldo_disponible) <= Q.EPS) throw new HttpError(400, 'La Factura de Anticipo está cerrada o no tiene saldo disponible');
      if (anticipo.moneda !== 'MXN') throw new HttpError(400, 'Las facturas existentes no registran moneda; solo se pueden aplicar anticipos MXN');
      const factura = await q.get(`SELECT abierta,saldo FROM ${Q.FAC(corte)}
        WHERE k_cliente=? AND estacion_id=? AND no_factura=?`, k, estacionId, noFactura);
      if (!factura) throw new HttpError(404, 'Factura de despacho no encontrada');
      if (!factura.abierta || Number(factura.saldo) <= Q.EPS) throw new HttpError(400, 'La factura de despacho está cancelada, cerrada o sin saldo pendiente');
      if (importe > Number(anticipo.saldo_disponible) + Q.EPS) throw new HttpError(400, 'El importe excede el saldo disponible de la Factura de Anticipo');
      if (importe > Number(factura.saldo) + Q.EPS) throw new HttpError(400, `El importe excede el saldo pendiente de la factura (${Number(factura.saldo).toFixed(2)})`);
      const r = await q.run(`INSERT INTO aplicaciones_factura_anticipo
        (idempotencia,k_cliente,factura_anticipo_id,estacion_id,no_factura,fecha_aplicacion,importe_aplicado,
         moneda,tipo_cambio,estado,referencia,observaciones,created_by)
        VALUES (?,?,?,?,?,?,?,'MXN',1,'APLICADA',?,?,?)`,
      idempotencia, k, idAnticipo, estacionId, noFactura, fecha, importe, referencia, observaciones, user.usuario);
      const aplicacionId = Number(r.lastInsertRowid);
      const saldoAplicado = await q.run(`UPDATE facturas_anticipo
        SET importe_aplicado=ROUND(importe_aplicado+?,2),saldo_disponible=ROUND(saldo_disponible-?,2),
          estado=CASE WHEN ROUND(saldo_disponible-?,2)<=? THEN 'CERRADA' ELSE 'PARCIALMENTE_APLICADA' END,
          updated_at=datetime('now'),updated_by=?
        WHERE id=? AND k_cliente=? AND estado IN ('ABIERTA','PARCIALMENTE_APLICADA') AND moneda='MXN' AND saldo_disponible>=?`,
      importe, importe, importe, Q.EPS, user.usuario, idAnticipo, k, importe);
      if (saldoAplicado.changes !== 1) throw new HttpError(409, 'El saldo del anticipo cambió; actualiza la pantalla e intenta de nuevo');
      const updated = await q.get('SELECT importe_aplicado,saldo_disponible,estado FROM facturas_anticipo WHERE id=?', idAnticipo);
      await L.bitacora(user, 'APLICACION_ANTICIPO_ALTA',
        `AP-${aplicacionId} anticipo #${idAnticipo} factura ${noFactura}; saldo ${anticipo.saldo_disponible}->${updated.saldo_disponible}; aplicado $${importe}`, ip(req));
      return { id: aplicacionId, ...updated };
    });
    return send(res, resultado.repetida ? 200 : 201, { ok: true, ...resultado });
  }
  if (m === 'POST' && (mt = p.match(/^\/api\/aplicaciones-anticipo\/(\d+)\/cancelar$/))) {
    exigir(user, 'aplicaciones_anticipo_cancelar');
    const id = Number(mt[1]), b = await readBody(req), motivo = txt(b.motivo, 500);
    if (!motivo) throw new HttpError(400, 'Indica el motivo de cancelación');
    const resultado = await tx(async () => {
      const aplicacion = await q.get('SELECT * FROM aplicaciones_factura_anticipo WHERE id=?', id);
      if (!aplicacion) throw new HttpError(404, 'Aplicación de Anticipo no encontrada');
      await verificaCliente(user, aplicacion.k_cliente);
      if (aplicacion.estado !== 'APLICADA') throw new HttpError(409, 'La aplicación ya está cancelada');
      const anticipo = await q.get('SELECT * FROM facturas_anticipo WHERE id=?', aplicacion.factura_anticipo_id);
      if (!anticipo || anticipo.estado === 'CANCELADA') throw new HttpError(409, 'No se puede restituir el saldo de una factura cancelada');
      const importe = Number(aplicacion.importe_aplicado);
      const nuevoAplicado = redondea(Number(anticipo.importe_aplicado) - importe);
      const nuevoSaldo = redondea(Number(anticipo.saldo_disponible) + importe);
      if (nuevoAplicado < -Q.EPS || nuevoSaldo > Number(anticipo.importe_original) + Q.EPS) {
        throw new HttpError(409, 'Los saldos del anticipo son inconsistentes; no se canceló la aplicación');
      }
      const cambiaAnticipo = await q.run(`UPDATE facturas_anticipo SET importe_aplicado=?,saldo_disponible=?,
        estado=CASE WHEN ?<=? THEN 'ABIERTA' ELSE 'PARCIALMENTE_APLICADA' END,
        updated_at=datetime('now'),updated_by=? WHERE id=? AND estado<>'CANCELADA' AND importe_aplicado>=?`,
      Math.max(0, nuevoAplicado), Math.min(Number(anticipo.importe_original), nuevoSaldo), Math.max(0, nuevoAplicado), Q.EPS, user.usuario,
      anticipo.id, importe);
      if (cambiaAnticipo.changes !== 1) throw new HttpError(409, 'El saldo del anticipo cambió; no se canceló la aplicación');
      const cambiaAplicacion = await q.run(`UPDATE aplicaciones_factura_anticipo SET estado='CANCELADA',
        fecha_cancelacion=datetime('now'),motivo_cancelacion=?,updated_at=datetime('now'),updated_by=?
        WHERE id=? AND estado='APLICADA'`, motivo, user.usuario, id);
      if (cambiaAplicacion.changes !== 1) throw new HttpError(409, 'La aplicación cambió; no se canceló');
      const actualizado = await q.get('SELECT importe_aplicado,saldo_disponible,estado FROM facturas_anticipo WHERE id=?', anticipo.id);
      await L.bitacora(user, 'APLICACION_ANTICIPO_CANCELAR',
        `AP-${id} anticipo #${anticipo.id} saldo ${anticipo.saldo_disponible}->${actualizado.saldo_disponible}; motivo:${motivo}`, ip(req));
      return { ...actualizado };
    });
    return send(res, 200, { ok: true, ...resultado });
  }

  // El módulo anterior se conserva solo como histórico; no acepta nuevos movimientos.
  if (m === 'DELETE' && /^\/api\/debito\/movimientos\/\d+$/.test(p) && ['capturista', 'pagos'].includes(user.rol)) {
    throw new HttpError(403, 'Este rol solo puede registrar movimientos y no puede anularlos');
  }
  if ((m === 'POST' || m === 'DELETE') && (p === '/api/debito/movimientos' || /^\/api\/debito\/movimientos\/\d+$/.test(p))) {
    throw new HttpError(410, 'Prepago fue reemplazado por Facturas de Anticipo y Aplicaciones de Anticipo');
  }

  // ----- debito prepago historico -----
  if (m === 'POST' && p === '/api/debito/movimientos') {
    exigir(user, 'debito');
    const b = await readBody(req);
    const cli = await verificaCliente(user, b.k_cliente);
    const tipo = b.tipo === 'ABONO' || b.tipo === 'RECARGA' ? 'RECARGA' : b.tipo === 'CONSUMO' ? 'CONSUMO' : null;
    if (!tipo) throw new HttpError(400, 'Tipo de operación inválido');
    const monto = redondea(L.num(b.monto));
    if (!(monto > 0)) throw new HttpError(400, 'El monto debe ser mayor a cero');
    if (!L.esFecha(b.fecha)) throw new HttpError(400, 'Fecha inválida');
    if (b.fecha > L.hoyISO()) throw new HttpError(400, 'La fecha no puede ser futura');
    const folio = txt(b.folio, 60);
    if (!folio) throw new HttpError(400, 'El folio o referencia es obligatorio');
    const metodoInput = txt(b.metodo, 40);
    const bancoId = b.banco_id == null || b.banco_id === '' ? null : Number(b.banco_id);
    let banco = null;
    let metodoNombre = null;
    if (tipo === 'RECARGA' || metodoInput) {
      const metodoRow = await q.get('SELECT nombre,requiere_banco FROM metodos_pago WHERE nombre=? COLLATE NOCASE', metodoInput);
      if (!metodoRow) throw new HttpError(400, 'Selecciona un método de pago válido');
      metodoNombre = metodoRow.nombre;
      const esEfectivo = /^efectivo$/i.test(metodoNombre);
      const requiereBancoDebito = !esEfectivo && Boolean(metodoRow.requiere_banco || /cheque|tarjeta|transferencia/i.test(metodoNombre));
      if (requiereBancoDebito) {
        if (!Number.isInteger(bancoId) || bancoId <= 0) throw new HttpError(400, `Selecciona un banco para el método ${metodoNombre}`);
        banco = (await q.get('SELECT nombre FROM bancos WHERE id=?', bancoId))?.nombre;
        if (!banco) throw new HttpError(400, 'Banco inválido');
      } else if (Number.isInteger(bancoId) && bancoId > 0) {
        banco = (await q.get('SELECT nombre FROM bancos WHERE id=?', bancoId))?.nombre;
        if (!banco) throw new HttpError(400, 'Banco inválido');
      }
    }
    const antes = await Q.saldoDebito(b.k_cliente);
    const r = await q.run(`INSERT INTO debito_app(fecha,folio,tipo,importe,abono,k_cliente,estacion_id,usuario_id,metodo,banco_id,banco)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      b.fecha, folio, tipo, tipo === 'CONSUMO' ? monto : 0, tipo === 'RECARGA' ? monto : 0,
      b.k_cliente, cli.estacion_id, user.id, metodoNombre, bancoId, banco || null);
    const saldo = redondea(antes + (tipo === 'RECARGA' ? monto : -monto));
    await L.bitacora(user, 'DEBITO', `${tipo} $${monto} ${b.k_cliente} folio:${folio}`, ip(req));
    return send(res, 201, { ok: true, id: 1000000000 + Number(r.lastInsertRowid), saldo_anterior: redondea(antes), saldo_nuevo: saldo, advertencia: saldo < 0 ? 'El consumo supera el saldo disponible; el saldo del cliente quedó negativo.' : null });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/debito\/movimientos\/(\d+)$/))) {
    if (!can(user, 'debito') && !can(user, 'anular_prepago')) throw new HttpError(403, 'No tienes permiso para esta acción');
    const id = Number(mt[1]) - 1000000000;
    const mv = id > 0 ? await q.get('SELECT * FROM debito_app WHERE id=? AND anulado=0 AND conciliado=0', id) : null;
    if (!mv) throw new HttpError(404, 'Solo pueden anularse movimientos capturados en la aplicación y vigentes');
    if (mv.tipo === 'CONSUMO' && String(mv.folio || '').startsWith('PREPAGO-CXC-')) {
      throw new HttpError(400, 'Este consumo está relacionado con pagos de CxC; anula esos pagos desde Cobranza para devolver el prepago correctamente.');
    }
    if (String(mv.folio || '').startsWith('REVERSA-PAGO-')) {
      throw new HttpError(400, 'Esta devolución está ligada a la anulación de un pago y no puede anularse por separado.');
    }
    if (!can(user, 'debito') && mv.tipo !== 'RECARGA') throw new HttpError(403, 'Supervisor solo puede anular recargas de prepago');
    const idsMv = estacionesAsignadas(user);
    if (idsMv.length && !idsMv.includes(mv.estacion_id)) throw new HttpError(403, 'Fuera de tu estación');
    if (mv.usuario_id !== user.id && user.rol !== 'admin' && !can(user, 'anular_prepago')) throw new HttpError(403, 'Solo el administrador o quien lo capturó puede anularlo');
    await q.run('UPDATE debito_app SET anulado=1 WHERE id=?', id);
    await L.bitacora(user, 'DEBITO_ANULADO', `#${id} ${mv.tipo} $${mv.importe || mv.abono} ${mv.k_cliente}`, ip(req));
    return send(res, 200, { ok: true });
  }

  // ----- catalogo de clientes y credito -----
  if (m === 'POST' && p === '/api/clientes') {
    exigir(user, 'clientes');
    const b = await readBody(req);
    const nombre = txt(b.cliente, 150);
    if (!nombre) throw new HttpError(400, 'El nombre del cliente es obligatorio');
    const idsCliente = estacionesAsignadas(user);
    const estId = idsCliente.length ? (Number(b.estacion_id) && idsCliente.includes(Number(b.estacion_id)) ? Number(b.estacion_id) : idsCliente[0]) : Number(b.estacion_id);
    const est = await q.get('SELECT id,nombre FROM dim_estacion WHERE id=?', estId);
    if (!est) throw new HttpError(400, 'Selecciona una estación válida');
    if (idsCliente.length && !idsCliente.includes(est.id)) throw new HttpError(403, 'Estación fuera de tu alcance');
    const rfc = txt(b.rfc, 13).toUpperCase();
    if (rfc && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) throw new HttpError(400, 'RFC con formato inválido');
    const email = txt(b.email, 254).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo electrónico inválido');
    const telefono = txt(b.telefono, 40);
    const modoCarga = normalizarModoCarga(txt(b.modo_carga, 40)) || null;
    if (modoCarga && !modosCargaCliente.includes(modoCarga)) throw new HttpError(400, 'Modo de carga inválido');
    const limite = L.num(b.limite, 0), dias = Math.trunc(L.num(b.dias, 0));
    if (limite < 0 || limite > 1e9) throw new HttpError(400, 'Límite inválido');
    if (dias < 0 || dias > 365) throw new HttpError(400, 'Días de crédito inválidos (0-365)');
    const k = `${est.nombre}_${nombre}`;
    if (await q.get('SELECT 1 FROM dim_cliente WHERE k_cliente=?', k)) throw new HttpError(409, 'Ya existe un cliente con ese nombre en la estación');
    const nc = txt(b.no_cliente, 30) || null;
    await tx(async () => {
      await q.run('INSERT INTO dim_cliente(k_cliente,cliente,estacion_id,no_cliente) VALUES (?,?,?,?)', k, nombre, est.id, nc);
      await q.run('INSERT INTO cliente_extra(k_cliente,rfc,creado_app,cliente,estacion_id,no_cliente,email,telefono,modo_carga) VALUES (?,?,1,?,?,?,?,?,?)',
        k, rfc || null, nombre, est.id, nc, email || null, telefono || null, modoCarga);
      await q.run("INSERT INTO credito(k_cliente,limite,dias,origen,actualizado_por,actualizado) VALUES (?,?,?,'app',?,datetime('now'))", k, limite, dias, user.usuario);
    });
    await L.bitacora(user, 'CLIENTE_ALTA', `${k} límite ${limite} días ${dias}`, ip(req));
    return send(res, 201, { ok: true, k_cliente: k });
  }
  if (m === 'PUT' && p === '/api/clientes') {
    exigir(user, 'clientes');
    const b = await readBody(req);
    const k = txt(b.k_cliente, 200);
    const anterior = await verificaCliente(user, k);
    const nombre = txt(b.cliente, 150);
    if (!nombre) throw new HttpError(400, 'El nombre del cliente es obligatorio');
    const idsCliente = estacionesAsignadas(user);
    const estacionId = Number(b.estacion_id);
    if (!Number.isInteger(estacionId) || estacionId <= 0) throw new HttpError(400, 'Selecciona una estación válida');
    const estacion = await q.get('SELECT id,nombre FROM dim_estacion WHERE id=?', estacionId);
    if (!estacion) throw new HttpError(400, 'Selecciona una estación válida');
    if (idsCliente.length && !idsCliente.includes(estacionId)) throw new HttpError(403, 'Estación fuera de tu alcance');
    if (await q.get('SELECT 1 FROM dim_cliente WHERE estacion_id=? AND cliente=? COLLATE NOCASE AND k_cliente<>?', estacionId, nombre, k)) {
      throw new HttpError(409, 'Ya existe un cliente con ese nombre en la estación');
    }
    const noCliente = txt(b.no_cliente, 30) || null;
    const rfc = txt(b.rfc, 13).toUpperCase();
    if (rfc && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) throw new HttpError(400, 'RFC con formato inválido');
    const email = txt(b.email, 254).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo electrónico inválido');
    const telefono = txt(b.telefono, 40);
    const modoCarga = normalizarModoCarga(b.modo_carga === undefined
      ? (await q.get('SELECT modo_carga FROM cliente_extra WHERE k_cliente=?', k) || {}).modo_carga || null
      : txt(b.modo_carga, 40) || null);
    if (modoCarga && !modosCargaCliente.includes(modoCarga)) throw new HttpError(400, 'Modo de carga inválido');
    const limite = L.num(b.limite, -1), dias = Math.trunc(L.num(b.dias, -1));
    if (limite < 0 || limite > 1e9) throw new HttpError(400, 'Límite inválido');
    if (dias < 0 || dias > 365) throw new HttpError(400, 'Días de crédito inválidos (0-365)');
    await tx(async () => {
      await q.run('UPDATE dim_cliente SET cliente=?,estacion_id=?,no_cliente=? WHERE k_cliente=?', nombre, estacionId, noCliente, k);
      for (const table of ['fact_cxc', 'fact_factura', 'fact_debito', 'pagos', 'debito_app', 'fact_cxc_app', 'aplicaciones_factura_anticipo']) {
        await q.run(`UPDATE ${table} SET estacion_id=? WHERE k_cliente=?`, estacionId, k);
      }
      await q.run(`INSERT INTO cliente_extra(k_cliente,rfc,cliente,estacion_id,no_cliente,email,telefono,modo_carga,editado_app)
        VALUES (?,?,?,?,?,?,?,?,1)
        ON CONFLICT(k_cliente) DO UPDATE SET rfc=excluded.rfc,cliente=excluded.cliente,estacion_id=excluded.estacion_id,
          no_cliente=excluded.no_cliente,email=excluded.email,telefono=excluded.telefono,modo_carga=excluded.modo_carga,editado_app=1`,
      k, rfc || null, nombre, estacionId, noCliente, email || null, telefono || null, modoCarga);
      await q.run(`INSERT INTO credito(k_cliente,limite,dias,origen,actualizado_por,actualizado)
        VALUES (?,?,?,'app',?,datetime('now'))
        ON CONFLICT(k_cliente) DO UPDATE SET limite=excluded.limite,dias=excluded.dias,origen='app',
          actualizado_por=excluded.actualizado_por,actualizado=excluded.actualizado`, k, limite, dias, user.usuario);
    });
    await L.bitacora(user, 'CLIENTE_EDITA', `${k}: ${anterior.estacion_id}->${estacionId}, nombre=${nombre}`, ip(req));
    return send(res, 200, { ok: true, k_cliente: k });
  }
  if (m === 'PUT' && p === '/api/credito') {
    exigir(user, 'credito');
    const b = await readBody(req);
    await verificaCliente(user, b.k_cliente);
    const limite = L.num(b.limite, -1), dias = Math.trunc(L.num(b.dias, -1));
    if (limite < 0 || limite > 1e9) throw new HttpError(400, 'Límite inválido');
    if (dias < 0 || dias > 365) throw new HttpError(400, 'Días de crédito inválidos (0-365)');
    const antes = await q.get('SELECT limite,dias FROM credito WHERE k_cliente=?', b.k_cliente) || { limite: 0, dias: 0 };
    await tx(async () => {
      await q.run(`INSERT INTO credito(k_cliente,limite,dias,origen,actualizado_por,actualizado) VALUES (?,?,?,'app',?,datetime('now'))
             ON CONFLICT(k_cliente) DO UPDATE SET limite=excluded.limite, dias=excluded.dias, origen='app',
             actualizado_por=excluded.actualizado_por, actualizado=excluded.actualizado`, b.k_cliente, limite, dias, user.usuario);
      if (b.rfc !== undefined) {
        const rfc = txt(b.rfc, 13).toUpperCase();
        if (rfc && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) throw new HttpError(400, 'RFC con formato inválido');
        await q.run('INSERT INTO cliente_extra(k_cliente,rfc) VALUES (?,?) ON CONFLICT(k_cliente) DO UPDATE SET rfc=excluded.rfc', b.k_cliente, rfc || null);
      }
    });
    await L.bitacora(user, 'CREDITO', `${b.k_cliente}: límite ${antes.limite}->${limite}, días ${antes.dias}->${dias}`, ip(req));
    return send(res, 200, { ok: true });
  }

  // ----- gestiones de cobranza -----
  if (m === 'POST' && p === '/api/gestiones') {
    exigir(user, 'gestiones');
    const b = await readBody(req);
    await verificaCliente(user, b.k_cliente);
    const tipo = txt(b.tipo, 30), resultado = txt(b.resultado, 40);
    if (!['Llamada', 'WhatsApp', 'Correo', 'Visita', 'Otro'].includes(tipo)) throw new HttpError(400, 'Tipo inválido');
    if (!['Contactado', 'Sin respuesta', 'Promesa de pago', 'Disputa', 'Otro'].includes(resultado)) throw new HttpError(400, 'Resultado inválido');
    const fecha = L.esFecha(b.fecha) ? b.fecha : L.hoyISO();
    let pf = null, pm = null;
    if (resultado === 'Promesa de pago') {
      if (!L.esFecha(b.promesa_fecha)) throw new HttpError(400, 'Indica la fecha de promesa de pago');
      pf = b.promesa_fecha; pm = L.num(b.promesa_monto) > 0 ? L.num(b.promesa_monto) : null;
    }
    const r = await q.run(`INSERT INTO gestiones(k_cliente,fecha,tipo,resultado,notas,promesa_fecha,promesa_monto,usuario_id) VALUES (?,?,?,?,?,?,?,?)`,
      b.k_cliente, fecha, tipo, resultado, txt(b.notas, 500), pf, pm, user.id);
    await L.bitacora(user, 'GESTION', `#${r.lastInsertRowid} ${resultado} ${b.k_cliente}`, ip(req));
    return send(res, 201, { ok: true, id: Number(r.lastInsertRowid) });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/gestiones\/(\d+)$/))) {
    exigir(user, 'gestiones');
    const b = await readBody(req);
    const g = await q.get('SELECT g.*, c.estacion_id FROM gestiones g JOIN dim_cliente c ON c.k_cliente=g.k_cliente WHERE g.id=?', Number(mt[1]));
    if (!g) throw new HttpError(404, 'Gestión no encontrada');
    const idsG = estacionesAsignadas(user);
    if (idsG.length && !idsG.includes(g.estacion_id)) throw new HttpError(403, 'Fuera de tu estación');
    if (!['Abierta', 'Cumplida', 'Incumplida', 'Cerrada'].includes(b.estado)) throw new HttpError(400, 'Estado inválido');
    await q.run('UPDATE gestiones SET estado=? WHERE id=?', b.estado, g.id);
    await L.bitacora(user, 'GESTION_ESTADO', `#${g.id} -> ${b.estado}`, ip(req));
    return send(res, 200, { ok: true });
  }

  // ----- usuarios (admin) -----
  if (p === '/api/usuarios' && m === 'POST') {
    exigir(user, 'usuarios');
    const b = await readBody(req);
    const usuario = txt(b.usuario, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new HttpError(400, 'Usuario: 3-40 caracteres (letras minúsculas, números, . _ -)');
    if (!txt(b.nombre)) throw new HttpError(400, 'El nombre es obligatorio');
    if (!ROLES[b.rol]) throw new HttpError(400, 'Rol inválido');
    if (await q.get('SELECT 1 FROM usuarios WHERE usuario=?', usuario)) throw new HttpError(409, 'Ese usuario ya existe');
    const estaciones = await parseEstaciones(b);
    const est = estaciones[0] || null;
    const temporal = L.passwordTemporal();
    let r;
    await tx(async () => {
      r = await q.run('INSERT INTO usuarios(usuario,nombre,email,rol,estacion_id,must_change,pass_hash) VALUES (?,?,?,?,?,1,?)',
        usuario, txt(b.nombre, 100), txt(b.email, 120) || null, b.rol, est, L.hashPassword(temporal));
      for (const stationId of estaciones) {
        await q.run('INSERT INTO usuario_estaciones(usuario_id, estacion_id) VALUES (?, ?)', Number(r.lastInsertRowid), stationId);
      }
    });
    await L.bitacora(user, 'USUARIO_ALTA', `${usuario} (${b.rol}) estaciones=${estaciones.join(',') || 'todas'}`, ip(req));
    return send(res, 201, { ok: true, id: Number(r.lastInsertRowid), password_temporal: temporal });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/usuarios\/(\d+)$/))) {
    exigir(user, 'usuarios');
    const id = Number(mt[1]); const b = await readBody(req);
    const u = await q.get('SELECT * FROM usuarios WHERE id=?', id);
    if (!u) throw new HttpError(404, 'Usuario no encontrado');
    const rol = b.rol || u.rol, activo = b.activo === undefined ? u.activo : (b.activo ? 1 : 0);
    if (!ROLES[rol]) throw new HttpError(400, 'Rol inválido');
    const era = u.rol === 'admin' && u.activo, seguira = rol === 'admin' && activo;
    if (era && !seguira && (await q.get("SELECT COUNT(*) n FROM usuarios WHERE rol='admin' AND activo=1 AND id<>?", id)).n === 0)
      throw new HttpError(400, 'Debe existir al menos un administrador activo');
    if (id === user.id && !activo) throw new HttpError(400, 'No puedes desactivar tu propio usuario');
    const estaciones = b.estaciones === undefined ? estacionesAsignadas(u) : await parseEstaciones(b);
    const est = estaciones[0] || null;
    await tx(async () => {
      await q.run('UPDATE usuarios SET nombre=?, email=?, rol=?, estacion_id=?, activo=? WHERE id=?',
        txt(b.nombre, 100) || u.nombre, b.email === undefined ? u.email : (txt(b.email, 120) || null), rol, est, activo, id);
      await q.run('DELETE FROM usuario_estaciones WHERE usuario_id=?', id);
      for (const stationId of estaciones) {
        await q.run('INSERT INTO usuario_estaciones(usuario_id, estacion_id) VALUES (?, ?)', id, stationId);
      }
    });
    if (!activo) await q.run('DELETE FROM sesiones WHERE usuario_id=?', id);
    await L.bitacora(user, 'USUARIO_EDITA', `${u.usuario}: rol=${rol} activo=${activo} estaciones=${estaciones.join(',') || 'todas'}`, ip(req));
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && (mt = p.match(/^\/api\/usuarios\/(\d+)\/reset$/))) {
    exigir(user, 'usuarios');
    const u = await q.get('SELECT * FROM usuarios WHERE id=?', Number(mt[1]));
    if (!u) throw new HttpError(404, 'Usuario no encontrado');
    const temporal = L.passwordTemporal();
    await q.run('UPDATE usuarios SET pass_hash=?, must_change=1, intentos=0, bloqueado_hasta=NULL WHERE id=?', L.hashPassword(temporal), u.id);
    await q.run('DELETE FROM sesiones WHERE usuario_id=?', u.id);
    await L.bitacora(user, 'USUARIO_RESET', u.usuario, ip(req));
    return send(res, 200, { ok: true, password_temporal: temporal });
  }
  throw new HttpError(404, 'Ruta no encontrada');
}

// ---------- estaticos ----------
function estatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'No encontrado');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    return estatico(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('[ERROR]', req.method, req.url, e);
    return send(res, 500, { error: 'Error interno del servidor' });
  }
});
server.requestTimeout = 0; server.headersTimeout = 30000;

if (require.main === module) {
  L.ready.then(async () => {
    const pw = await L.sembrarAdmin();
    await L.limpiarSesiones();
    setInterval(() => L.limpiarSesiones().catch((error) => console.error('[SESIONES]', error)), 3600e3).unref();
    server.listen(PORT, HOST, () => {
      console.log(`\n  Gas_App Financiero  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`  Base de datos: ${L.remote ? 'Turso' : L.DB_PATH}`);
      if (pw) {
        console.log('\n  ============ PRIMER ARRANQUE ============');
        console.log('  Usuario : admin');
        console.log(`  Contraseña temporal : ${pw}`);
        console.log('  (se te pedirá cambiarla al iniciar sesión; no se volverá a mostrar)');
        console.log('  =========================================\n');
      }
    });
  }).catch((error) => {
    console.error('[DATABASE_INIT]', error);
    process.exitCode = 1;
  });
}
module.exports = { server };
