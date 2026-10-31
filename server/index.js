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
  const raw = Array.isArray(body.estaciones) ? body.estaciones : [];
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
const txt = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const redondea = (n) => Math.round(n * 100) / 100;
const requiereBanco = (v) => v === true || v === 1 || v === '1' || v === 'on';

function alcance(user, query) {
  const ids = estacionesAsignadas(user);
  if (ids.length) {
    const e = Number(query.get('estacion'));
    if (Number.isInteger(e) && e > 0 && ids.includes(e)) return e;
    return ids[0];
  }
  const e = Number(query.get('estacion'));
  return Number.isInteger(e) && e > 0 ? e : null;
}
async function verificaCliente(user, k) {
  const c = await q.get('SELECT k_cliente, estacion_id FROM dim_cliente WHERE k_cliente=?', k);
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  const ids = estacionesAsignadas(user);
  if (ids.length && !ids.includes(c.estacion_id)) throw new HttpError(403, 'Cliente fuera de tu estación');
  return c;
}
const params = async (query, user) => { const p = Object.fromEntries(query.entries()); p.corte = await Q.corteValido(p.corte); p.est = alcance(user, query); return p; };

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
        const claveDespacho = String(row.despacho || '').normalize('NFKC').trim().toLocaleLowerCase('es-MX');
        if (vistos.has(claveDespacho) || despachosExistentes.has(claveDespacho)) {
          errores.push(`${prefijo} el despacho "${row.despacho}" está duplicado en el archivo o ya fue registrado.`);
          continue;
        }
        vistos.add(claveDespacho);
        preparados.push({ ...row, cliente });
      }
      if (errores.length) throw new HttpError(422, errores.slice(0, 100).join('\n'));
      const ids = [];
      for (let offset = 0; offset < preparados.length; offset += 250) {
        const lote = preparados.slice(offset, offset + 250).map((row) => ({
          sql: `INSERT INTO fact_cxc_app
            (fecha_despacho,despacho,importe,abono,k_cliente,estacion_id,estatus,grupo,fecha_factura,no_factura,fecha_pago,fecha_vencimiento,usuario_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [row.fecha_despacho, row.despacho, row.importe, row.abono, row.cliente.k_cliente, row.cliente.estacion_id,
            'POR FACTURAR', row.grupo || null, row.fecha_factura || row.fecha_despacho,
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
    if (p === '/api/dashboard') return send(res, 200, await Q.dashboard(await params(query, user)));
    if (p === '/api/alertas') return send(res, 200, await Q.alertas(await params(query, user)));
    if (p === '/api/clientes-lista') {
      const pr = await params(query, user);
      return send(res, 200, { rows: await Q.listaClientes({ est: pr.est, conFacturas: pr.con_facturas === '1', corte: pr.corte }) });
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
        return csv(res, 'clientes.csv', [['estacion', 'Estación'], ['cliente', 'Cliente'], ['no_cliente', 'No. cliente'], ['rfc', 'RFC'], ['email', 'Correo electrónico'], ['telefono', 'Teléfono'], ['limite', 'Límite de crédito'],
          ['dias_credito', 'Días de crédito'], ['saldo_fact', 'Saldo facturado'], ['vencido', 'Vencido'], ['por_facturar', 'Por facturar'],
          ['saldo_total', 'Saldo total'], ['disponible', 'Disponible'], ['max_dias', 'Máx. días vencido'], ['saldo_favor', 'Saldo a favor (débito)'], ['riesgo', 'Riesgo']], r.rows);
      }
      return send(res, 200, await Q.clientes(pr));
    }
    if (p === '/api/cliente/estado-cuenta') {
      exigir(user, 'export');
      const k = query.get('k');
      await verificaCliente(user, k);
      const desde = query.get('desde') || '';
      const hasta = query.get('hasta') || '';
      if (desde && !L.esFecha(desde)) throw new HttpError(400, 'La fecha inicial es inválida');
      if (hasta && !L.esFecha(hasta)) throw new HttpError(400, 'La fecha final es inválida');
      if (desde && hasta && desde > hasta) throw new HttpError(400, 'La fecha inicial no puede ser posterior a la fecha final');
      const rows = await Q.estadoCuenta({ k, desde, hasta });
      const cliente = await q.get('SELECT cliente FROM dim_cliente WHERE k_cliente=?', k);
      await L.bitacora(user, 'EXPORT', `estado_cuenta ${k} ${desde || 'inicio'}-${hasta || 'hoy'} · ${rows.length} movimiento(s)`, ip(req));
      const nombre = k.replace(/[^a-zA-Z0-9_-]/g, '_') || 'cliente';
      return csv(res, `estado_cuenta_${nombre}.csv`, [
        ['fecha', 'Fecha'], ['tipo', 'Tipo de movimiento'], ['referencia', 'Referencia'], ['despacho', 'Despacho'],
        ['factura', 'Factura'], ['grupo', 'Grupo'], ['concepto', 'Detalle'], ['cargo_cxc', 'Cargo CxC'],
        ['abono_cxc', 'Abono CxC'], ['abono_prepago', 'Abono prepago'], ['consumo_prepago', 'Consumo prepago'],
        ['importe_referencia', 'Importe de referencia'], ['saldo_cxc', 'Saldo CxC'], ['saldo_prepago', 'Saldo prepago'],
        ['estado', 'Estado'], ['origen', 'Origen'], ['usuario', 'Usuario'],
      ], rows);
    }
    if (p === '/api/cliente') { const k = query.get('k'); await verificaCliente(user, k); return send(res, 200, await Q.clienteDetalle({ corte: await Q.corteValido(query.get('corte')), k })); }
    if (p === '/api/por-facturar') return send(res, 200, await Q.porFacturar(await params(query, user)));
    if (p === '/api/debito') return send(res, 200, await Q.debitoResumen(await params(query, user)));
    if (p === '/api/debito/movimientos') { const pr = await params(query, user); if (pr.k) await verificaCliente(user, pr.k); return send(res, 200, await Q.debitoMovs(pr)); }
    if (p === '/api/pagos') {
      const wh = [], pr = [];
      const e = alcance(user, query); if (e) { wh.push('p.estacion_id=?'); pr.push(e); }
      if (query.get('q')) { wh.push('(c.cliente LIKE ? OR p.no_factura LIKE ? OR p.referencia LIKE ?)'); const l = `%${query.get('q')}%`; pr.push(l, l, l); }
      return send(res, 200, { rows: await q.all(`SELECT p.id, p.k_cliente, c.cliente, e.nombre estacion, p.no_factura, p.sin_aplicar, p.fecha, p.monto, p.metodo, COALESCE(p.banco,b.nombre) banco, p.referencia, p.notas,
          p.conciliado, p.anulado, p.creado, u.nombre usuario FROM pagos p JOIN dim_cliente c ON c.k_cliente=p.k_cliente
          JOIN dim_estacion e ON e.id=p.estacion_id LEFT JOIN usuarios u ON u.id=p.usuario_id LEFT JOIN bancos b ON b.id=p.banco_id
          ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 500`, ...pr) });
    }
    if (p === '/api/gestiones') {
      const wh = [], pr = [];
      const e = alcance(user, query); if (e) { wh.push('c.estacion_id=?'); pr.push(e); }
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

  if (m === 'PUT' && (mt = p.match(/^\/api\/por-facturar\/(\d+)$/))) {
    if (!can(user, 'facturas') && !can(user, 'editar_despacho')) throw new HttpError(403, 'No tienes permiso para esta acción');
    const id = Number(mt[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Identificador de despacho inválido');
    const despachoActual = await q.get(`SELECT id,origen,k_cliente,estacion_id,fecha_despacho,despacho,grupo,importe,abono,estatus
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
    const grupo = txt(body.grupo, 60) || null;
    const montoPendiente = redondea(L.num(body.monto, -1));
    const importe = redondea(montoPendiente + Number(despachoActual.abono || 0));
    if (!(montoPendiente > 0) || importe > 1e9) {
      throw new HttpError(400, 'El pendiente debe ser mayor a cero y el importe total no exceder $1,000,000,000');
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
      SET fecha_despacho=?, despacho=?, grupo=?, importe=?
      WHERE id=? AND estatus='POR FACTURAR' AND importe-abono>0`,
    fechaDespacho, despacho, grupo, importe, idInterno);
    if (resultado.changes !== 1) throw new HttpError(409, 'El despacho cambió o dejó de estar pendiente; vuelve a cargar la lista');
    await L.bitacora(user, 'DESPACHO_EDITA',
      `${despachoActual.k_cliente} despacho #${id}: fecha ${despachoActual.fecha_despacho}->${fechaDespacho}, despacho ${despachoActual.despacho || ''}->${despacho || ''}, grupo ${despachoActual.grupo || ''}->${grupo || ''}, pendiente ${redondea(despachoActual.importe - despachoActual.abono)}->${montoPendiente}`,
      ip(req));
    return send(res, 200, {
      ok: true, id, fecha_despacho: fechaDespacho, despacho, grupo,
      importe, abono: Number(despachoActual.abono || 0), monto: montoPendiente,
    });
  }

  if (m === 'POST' && p === '/api/por-facturar') {
    exigir(user, 'facturas');
    const b = await readBody(req);
    const cliente = await verificaCliente(user, txt(b.k_cliente, 200));
    const fechaDespacho = txt(b.fecha_despacho, 10) || L.hoyISO();
    const importe = redondea(L.num(b.importe, -1));
    if (!L.esFecha(fechaDespacho) || fechaDespacho > L.hoyISO()) throw new HttpError(400, 'La fecha de despacho es inválida o futura');
    if (!(importe > 0) || importe > 1e9) throw new HttpError(400, 'El importe debe ser mayor a cero y no exceder $1,000,000,000');
    const despacho = txt(b.despacho, 80) || 'PENDIENTE';
    const noFactura = `POR-FACTURAR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await q.run(`INSERT INTO fact_cxc_app(fecha_despacho,despacho,importe,abono,k_cliente,estacion_id,estatus,grupo,fecha_factura,no_factura,fecha_vencimiento,usuario_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, fechaDespacho, despacho, importe, 0, cliente.k_cliente, cliente.estacion_id, 'POR FACTURAR',
      txt(b.grupo, 60) || 'PENDIENTE', fechaDespacho, noFactura, null, user.id);
    await L.bitacora(user, 'POR_FACTURAR_ALTA', `${cliente.k_cliente} $${importe} ${noFactura}`, ip(req));
    return send(res, 201, { ok: true, id: Number(r.lastInsertRowid), k_cliente: cliente.k_cliente, fecha_despacho: fechaDespacho, importe, no_factura: noFactura });
  }

  // ----- pagos CxC -----
  if (m === 'POST' && (p === '/api/pagos' || p === '/api/pagos/lote')) {
    exigir(user, 'pagos');
    const b = await readBody(req);
    await verificaCliente(user, b.k_cliente);
    if (!L.esFecha(b.fecha)) throw new HttpError(400, 'Fecha inválida');
    if (b.fecha > L.hoyISO()) throw new HttpError(400, 'La fecha de pago no puede ser futura');
    const metodoInput = txt(b.metodo, 40) || 'Transferencia SPEI';
    const esPrepagoDirecto = redondea(L.num(b.desde_prepago, 0)) > 0;
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
        resIds.prepago_debito_id = 1000000000 + Number(rPrep.lastInsertRowid);
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
    if (pg.conciliado) throw new HttpError(400, 'El pago ya fue conciliado con el Excel y no puede anularse');
    if (pg.usuario_id !== user.id && user.rol !== 'admin' && !can(user, 'anular_pago')) throw new HttpError(403, 'Solo el administrador o quien lo capturó puede anularlo');
    await q.run('UPDATE pagos SET anulado=1 WHERE id=?', pg.id);
    await L.bitacora(user, 'PAGO_ANULADO', `#${pg.id} ${pg.no_factura} $${pg.monto}`, ip(req));
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/cartera/facturas') {
    exigir(user, 'facturas');
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
      if (await q.get('SELECT 1 FROM v_cxc WHERE k_cliente=? AND estacion_id=? AND no_factura=? AND estatus IN (\'POR PAGAR\',\'ABONADO\')',
        cliente.k_cliente, cliente.estacion_id, noFactura)) {
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
            await q.run('UPDATE fact_cxc_app SET estatus=?, fecha_factura=?, no_factura=?, fecha_vencimiento=? WHERE id=?', 'POR PAGAR', fechaFactura, noFactura, fechaVencimiento, fila.id - 2000000000);
          } else {
            await q.run('UPDATE fact_cxc SET estatus=?, fecha_factura=?, no_factura=?, fecha_vencimiento=? WHERE id=?', 'POR PAGAR', fechaFactura, noFactura, fechaVencimiento, fila.id);
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
  if (m === 'PUT' && (mt = p.match(/^\/api\/cartera\/facturas\/(\d+)$/))) {
    exigir(user, 'facturas');
    const b = await readBody(req);
    const id = Number(mt[1]);
    const factura = await q.get('SELECT * FROM fact_cxc_app WHERE id=?', id);
    if (!factura) throw new HttpError(404, 'Solo se pueden editar facturas registradas en la aplicación');
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

  // ----- debito prepago -----
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
    const limite = L.num(b.limite, 0), dias = Math.trunc(L.num(b.dias, 0));
    if (limite < 0 || limite > 1e9) throw new HttpError(400, 'Límite inválido');
    if (dias < 0 || dias > 365) throw new HttpError(400, 'Días de crédito inválidos (0-365)');
    const k = `${est.nombre}_${nombre}`;
    if (await q.get('SELECT 1 FROM dim_cliente WHERE k_cliente=?', k)) throw new HttpError(409, 'Ya existe un cliente con ese nombre en la estación');
    const nc = txt(b.no_cliente, 30) || null;
    await tx(async () => {
      await q.run('INSERT INTO dim_cliente(k_cliente,cliente,estacion_id,no_cliente) VALUES (?,?,?,?)', k, nombre, est.id, nc);
      await q.run('INSERT INTO cliente_extra(k_cliente,rfc,creado_app,cliente,estacion_id,no_cliente,email,telefono) VALUES (?,?,1,?,?,?,?,?)',
        k, rfc || null, nombre, est.id, nc, email || null, telefono || null);
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
    const limite = L.num(b.limite, -1), dias = Math.trunc(L.num(b.dias, -1));
    if (limite < 0 || limite > 1e9) throw new HttpError(400, 'Límite inválido');
    if (dias < 0 || dias > 365) throw new HttpError(400, 'Días de crédito inválidos (0-365)');
    await tx(async () => {
      await q.run('UPDATE dim_cliente SET cliente=?,estacion_id=?,no_cliente=? WHERE k_cliente=?', nombre, estacionId, noCliente, k);
      for (const table of ['fact_cxc', 'fact_factura', 'fact_debito', 'pagos', 'debito_app', 'fact_cxc_app']) {
        await q.run(`UPDATE ${table} SET estacion_id=? WHERE k_cliente=?`, estacionId, k);
      }
      await q.run(`INSERT INTO cliente_extra(k_cliente,rfc,cliente,estacion_id,no_cliente,email,telefono,editado_app)
        VALUES (?,?,?,?,?,?,?,1)
        ON CONFLICT(k_cliente) DO UPDATE SET rfc=excluded.rfc,cliente=excluded.cliente,estacion_id=excluded.estacion_id,
          no_cliente=excluded.no_cliente,email=excluded.email,telefono=excluded.telefono,editado_app=1`,
      k, rfc || null, nombre, estacionId, noCliente, email || null, telefono || null);
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
      if (estaciones.length) {
        const inserts = estaciones.map((stationId) => `(${Number(r.lastInsertRowid)}, ${stationId})`).join(',');
        await q.run(`INSERT INTO usuario_estaciones(usuario_id, estacion_id) VALUES ${inserts}`);
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
      if (estaciones.length) await q.run('INSERT INTO usuario_estaciones(usuario_id, estacion_id) VALUES ' + estaciones.map((stationId) => `(${id}, ${stationId})`).join(',') );
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
