'use strict';
// Consultas analiticas de cartera (CxC), debito y credito
const { q, esFecha, entero, HttpError } = require('./lib');

const EPS = 0.005;
const RANGOS = ['No Vencido', '1-15 días', '16-30 días', '31-60 días', '61-90 días', '91-120 días', 'Más de 120 días'];

const corteDefault = async () => (await q.get("SELECT valor FROM meta WHERE clave='fecha_corte'") || {}).valor || new Date().toISOString().slice(0, 10);
const corteValido = async (c) => (esFecha(c) ? c : await corteDefault());

function FACTURAS() {
  return `(SELECT k_cliente, estacion_id, no_factura, MIN(fecha_factura) fecha_factura,
      MIN(fecha_vencimiento) fecha_vencimiento, MIN(primer_despacho) primer_despacho,
      MAX(ultimo_despacho) ultimo_despacho, SUM(despachos) despachos, SUM(importe) importe,
      SUM(abono) abono, MAX(abierta) abierta, MIN(editable) editable, MIN(app_id) app_id
    FROM (
      SELECT f.k_cliente, f.estacion_id, f.no_factura, MIN(f.fecha_factura) fecha_factura,
        MIN(f.fecha_vencimiento) fecha_vencimiento, MIN(f.fecha_despacho) primer_despacho,
        MAX(f.fecha_despacho) ultimo_despacho, COUNT(*) despachos, SUM(f.importe) importe, SUM(f.abono) abono,
        MAX(CASE WHEN f.estatus IN ('POR PAGAR','ABONADO') THEN 1 ELSE 0 END) abierta, 0 editable, NULL app_id
      FROM fact_cxc f WHERE f.no_factura IS NOT NULL
        AND f.estatus NOT IN ('POR FACTURAR','CANCELADO','CANCELADA')
      GROUP BY f.k_cliente, f.estacion_id, f.no_factura
      UNION ALL
      SELECT k_cliente, estacion_id, no_factura, MIN(fecha_factura), MIN(fecha_vencimiento),
        MIN(fecha_despacho), MAX(fecha_despacho), COUNT(*), SUM(importe), SUM(abono),
        MAX(CASE WHEN estatus IN ('POR PAGAR','ABONADO') THEN 1 ELSE 0 END),
        MIN(CASE WHEN facturada_desde_pendiente=1 THEN 0 ELSE 1 END), MIN(id)
      FROM fact_cxc_app WHERE no_factura IS NOT NULL
        AND estatus NOT IN ('POR FACTURAR','CANCELADO','CANCELADA')
      GROUP BY k_cliente, estacion_id, no_factura
    ) f GROUP BY k_cliente, estacion_id, no_factura)`;
}

// Facturas con saldo neto de pagos capturados en la app y dias vencido a la fecha de corte
function FAC(corte) {
  return `(SELECT f.k_cliente, f.estacion_id, f.no_factura, f.fecha_factura,
      CASE WHEN f.fecha_factura IS NOT NULL
        THEN date(f.fecha_factura, printf('%+d days', COALESCE(cr.dias,0)))
        ELSE f.fecha_vencimiento END AS fecha_vencimiento,
      f.primer_despacho, f.ultimo_despacho, f.despachos, f.importe, f.abono, f.abierta, f.editable, f.app_id,
      COALESCE(p.pagos,0) AS pagos_app,
      COALESCE(a.aplicaciones,0) AS aplicaciones_anticipo,
      CASE WHEN f.abierta=1 THEN MAX(f.importe-f.abono-COALESCE(p.pagos,0)-COALESCE(a.aplicaciones,0),0) ELSE 0 END AS saldo,
      CASE WHEN f.fecha_factura IS NULL AND f.fecha_vencimiento IS NULL THEN 0
           ELSE CAST(julianday('${corte}')-julianday(CASE WHEN f.fecha_factura IS NOT NULL
             THEN date(f.fecha_factura, printf('%+d days', COALESCE(cr.dias,0)))
             ELSE f.fecha_vencimiento END) AS INTEGER) END AS dias_vencido
    FROM ${FACTURAS()} f
    LEFT JOIN credito cr ON cr.k_cliente=f.k_cliente
    LEFT JOIN (SELECT k_cliente,estacion_id,no_factura,SUM(monto) pagos FROM pagos
               WHERE anulado=0 AND conciliado=0 AND sin_aplicar=0 GROUP BY 1,2,3) p
      ON p.k_cliente=f.k_cliente AND p.estacion_id=f.estacion_id AND p.no_factura=f.no_factura
    LEFT JOIN (SELECT k_cliente,estacion_id,no_factura,SUM(importe_aplicado) aplicaciones
               FROM aplicaciones_factura_anticipo WHERE estado='APLICADA' GROUP BY 1,2,3) a
      ON a.k_cliente=f.k_cliente AND a.estacion_id=f.estacion_id AND a.no_factura=f.no_factura)`;
}
const RANGO_SQL = (col = 'f.dias_vencido') => `CASE WHEN ${col}<=0 THEN 'No Vencido' WHEN ${col}<=15 THEN '1-15 días'
  WHEN ${col}<=30 THEN '16-30 días' WHEN ${col}<=60 THEN '31-60 días' WHEN ${col}<=90 THEN '61-90 días'
  WHEN ${col}<=120 THEN '91-120 días' ELSE 'Más de 120 días' END`;
const ESTADO_SQL = `CASE WHEN f.saldo<=${EPS} THEN 'PAGADA' WHEN f.fecha_vencimiento IS NULL THEN 'SIN VENCIMIENTO'
  WHEN f.dias_vencido>0 THEN 'VENCIDA' WHEN f.abono+f.pagos_app+f.aplicaciones_anticipo>0 THEN 'ABONADA' ELSE 'POR VENCER' END`;

// Resumen por cliente: cartera, vencido, por facturar, limite, debito
function CLIENTES(corte) {
  return `(SELECT c.k_cliente, c.cliente, c.no_cliente, ce.rfc AS rfc, ce.email AS email, ce.telefono AS telefono,
      ce.modo_carga AS modo_carga, c.estacion_id, e.nombre AS estacion,
      COALESCE(cr.limite,0) AS limite, COALESCE(cr.dias,0) AS dias_credito, cr.origen AS credito_origen,
      COALESCE(fa.saldo_fact,0) AS saldo_fact, COALESCE(fa.vencido,0) AS vencido, COALESCE(fa.n_fact,0) AS n_fact,
      COALESCE(fa.max_dias,0) AS max_dias, COALESCE(pf.por_facturar,0) AS por_facturar,
      COALESCE(pf.n_pf,0) AS n_pf, COALESCE(de.saldo_favor,0) AS saldo_favor,
      COALESCE(aa.saldo_anticipo,0) AS saldo_anticipo,
      COALESCE(fa.saldo_fact,0)+COALESCE(pf.por_facturar,0) AS saldo_total
    FROM dim_cliente c
    JOIN dim_estacion e ON e.id=c.estacion_id
    LEFT JOIN credito cr ON cr.k_cliente=c.k_cliente
    LEFT JOIN cliente_extra ce ON ce.k_cliente=c.k_cliente
    LEFT JOIN (SELECT k_cliente, SUM(saldo) saldo_fact,
                 SUM(CASE WHEN dias_vencido>0 THEN saldo ELSE 0 END) vencido,
                 SUM(CASE WHEN saldo>${EPS} THEN 1 ELSE 0 END) n_fact,
                 MAX(CASE WHEN saldo>${EPS} THEN dias_vencido END) max_dias
               FROM ${FAC(corte)} WHERE abierta=1 GROUP BY k_cliente) fa ON fa.k_cliente=c.k_cliente
    LEFT JOIN (SELECT k_cliente, SUM(importe-abono) por_facturar, COUNT(*) n_pf FROM v_cxc
               WHERE estatus='POR FACTURAR' AND importe-abono<>0 GROUP BY k_cliente) pf ON pf.k_cliente=c.k_cliente
    LEFT JOIN (SELECT k_cliente, SUM(abono)-SUM(importe) saldo_favor FROM v_debito GROUP BY k_cliente) de
      ON de.k_cliente=c.k_cliente
    LEFT JOIN (SELECT k_cliente, SUM(saldo_disponible) saldo_anticipo FROM facturas_anticipo
               WHERE estado IN ('ABIERTA','PARCIALMENTE_APLICADA') GROUP BY k_cliente) aa
      ON aa.k_cliente=c.k_cliente)`;
}
const RIESGO = (t = 'x') => `CASE WHEN ${t}.limite>0 AND ${t}.saldo_total>${t}.limite THEN 'EXCEDIDO'
  WHEN ${t}.limite=0 AND ${t}.saldo_total>${EPS} THEN 'SIN LÍMITE' ELSE 'OK' END`;
const likeEsc = (s) => `%${String(s).replace(/[%_\\]/g, (m) => '\\' + m)}%`;

// ---------------- Catalogos ----------------
async function catalogos() {
  return {
    estaciones: await q.all('SELECT id,nombre FROM dim_estacion ORDER BY nombre'),
    bancos: await q.all('SELECT id,nombre FROM bancos ORDER BY nombre'),
    metodos_pago: await q.all('SELECT id,nombre,requiere_banco FROM metodos_pago ORDER BY nombre'),
    productos: await q.all('SELECT id,nombre FROM productos ORDER BY nombre'),
    fecha_corte: await corteDefault(),
    fuente: (await q.get("SELECT valor FROM meta WHERE clave='fuente'") || {}).valor || null,
    importado_en: (await q.get("SELECT valor FROM meta WHERE clave='importado_en'") || {}).valor || null,
    anios: (await q.all(`SELECT DISTINCT t.anio FROM ${FACTURAS()} f JOIN dim_tiempo t ON t.fecha=f.fecha_factura ORDER BY 1 DESC`)).map((r) => r.anio),
    meses: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
    rangos: RANGOS,
  };
}
// Lista ligera de clientes (selectores)
function filtrarEstaciones(columna, p, wh, pr) {
  if (Array.isArray(p.estaciones)) {
    if (p.estaciones.length) {
      wh.push(`${columna} IN (${p.estaciones.map(() => '?').join(',')})`);
      pr.push(...p.estaciones);
    } else wh.push('1=0');
  } else if (p.est) {
    wh.push(`${columna}=?`);
    pr.push(p.est);
  }
}
async function listaClientes({ est, estaciones, conFacturas, corte }) {
  const wh = [], pr = [];
  filtrarEstaciones('c.estacion_id', { est, estaciones }, wh, pr);
  if (conFacturas) wh.push(`c.k_cliente IN (SELECT k_cliente FROM ${FAC(corte)} f WHERE f.abierta=1 AND f.saldo>${EPS})`);
  return await q.all(`SELECT c.k_cliente, c.cliente, c.estacion_id, e.nombre estacion, COALESCE(cr.dias,0) dias_credito
    FROM dim_cliente c JOIN dim_estacion e ON e.id=c.estacion_id LEFT JOIN credito cr ON cr.k_cliente=c.k_cliente
    ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY c.cliente`, ...pr);
}

// ---------------- Dashboard / KPIs ----------------
async function dashboard({ corte, est, estaciones }) {
  const F = FAC(corte);
  const estacionesId = Array.isArray(estaciones) ? estaciones : est ? [est] : null;
  const estacionesSql = (columna, conector = 'AND') => {
    if (!estacionesId) return '';
    return estacionesId.length
      ? ` ${conector} ${columna} IN (${estacionesId.map(() => '?').join(',')})`
      : ` ${conector} 1=0`;
  };
  const ew = estacionesSql('f.estacion_id');
  const ep = estacionesId || [];

  const k = await q.get(`SELECT COALESCE(SUM(saldo),0) facturada,
      COALESCE(SUM(CASE WHEN dias_vencido>0 THEN saldo END),0) vencida,
      COALESCE(SUM(CASE WHEN dias_vencido<=0 THEN saldo END),0) por_vencer,
      COALESCE(SUM(CASE WHEN dias_vencido>60 THEN saldo END),0) mayor_60,
      SUM(CASE WHEN saldo>${EPS} THEN 1 ELSE 0 END) facturas, COUNT(DISTINCT CASE WHEN saldo>${EPS} THEN k_cliente END) clientes
    FROM ${F} f WHERE f.abierta=1${ew}`, ...ep);
  const pf = await q.get(`SELECT COALESCE(SUM(importe-abono),0) monto, COUNT(*) n FROM v_cxc f WHERE estatus='POR FACTURAR'${ew}`, ...ep);
  const fav = await q.get(`SELECT COALESCE(SUM(a.saldo_disponible),0) a_favor,
      COUNT(DISTINCT a.k_cliente) n FROM facturas_anticipo a
      JOIN dim_cliente c ON c.k_cliente=a.k_cliente
      WHERE a.estado IN ('ABIERTA','PARCIALMENTE_APLICADA')${estacionesSql('c.estacion_id')}`, ...ep);
  const riesgo = await q.get(`SELECT
      SUM(CASE WHEN x.limite>0 AND x.saldo_total>x.limite THEN 1 ELSE 0 END) excedidos,
      COALESCE(SUM(CASE WHEN x.limite>0 AND x.saldo_total>x.limite THEN x.saldo_total-x.limite ELSE 0 END),0) exceso_monto,
      SUM(CASE WHEN x.limite=0 AND x.saldo_total>${EPS} THEN 1 ELSE 0 END) sin_limite
    FROM ${CLIENTES(corte)} x${estacionesSql('x.estacion_id', 'WHERE')}`, ...ep);

  const aging = await q.all(`SELECT ${RANGO_SQL()} rango, COALESCE(SUM(saldo),0) monto, COUNT(*) facturas
    FROM ${F} f WHERE f.abierta=1 AND f.saldo>${EPS}${ew} GROUP BY 1`, ...ep);
  const am = Object.fromEntries(aging.map((a) => [a.rango, a]));
  const agingOut = RANGOS.map((r) => ({ rango: r, monto: (am[r] || {}).monto || 0, facturas: (am[r] || {}).facturas || 0 }));

  const ini = new Date(corte + 'T00:00:00Z'); ini.setUTCDate(1); ini.setUTCMonth(ini.getUTCMonth() - 11);
  const desde = ini.toISOString().slice(0, 10);
  const fact = await q.all(`SELECT substr(fecha_factura,1,7) m, SUM(importe) v FROM v_cxc f
      WHERE no_factura IS NOT NULL AND estatus<>'POR FACTURAR' AND fecha_factura>=? AND fecha_factura<=?${ew} GROUP BY 1`, desde, corte, ...ep);
  const cob = await q.all(`SELECT substr(fecha_pago,1,7) m, SUM(abono) v FROM v_cxc f
      WHERE fecha_pago>=? AND fecha_pago<=?${ew} GROUP BY 1`, desde, corte, ...ep);
  const cobApp = await q.all(`SELECT substr(fecha,1,7) m, SUM(monto) v FROM (
      SELECT fecha, monto, estacion_id FROM pagos WHERE anulado=0 AND conciliado=0
      UNION ALL
      SELECT fecha_aplicacion, importe_aplicado, estacion_id FROM aplicaciones_factura_anticipo WHERE estado='APLICADA'
    ) f WHERE fecha>=? AND fecha<=?${ew} GROUP BY 1`, desde, corte, ...ep);
  const tendencia = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(ini); d.setUTCMonth(ini.getUTCMonth() + i);
    const m = d.toISOString().slice(0, 7);
    tendencia.push({ mes: m, facturado: (fact.find((x) => x.m === m) || {}).v || 0,
      cobrado: ((cob.find((x) => x.m === m) || {}).v || 0) + ((cobApp.find((x) => x.m === m) || {}).v || 0) });
  }
  const prom = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(g.promesa_monto),0) monto FROM gestiones g JOIN dim_cliente c ON c.k_cliente=g.k_cliente
      WHERE g.estado='Abierta' AND g.promesa_fecha IS NOT NULL AND g.promesa_fecha<=?${estacionesSql('c.estacion_id')}`, corte, ...ep);
  const porEstacion = await q.all(`SELECT e.id, e.nombre estacion, COALESCE(SUM(f.saldo),0) facturada,
      COALESCE(SUM(CASE WHEN f.dias_vencido>0 THEN f.saldo END),0) vencida
    FROM dim_estacion e LEFT JOIN ${F} f ON f.estacion_id=e.id AND f.abierta=1 ${estacionesSql('e.id', 'WHERE')} GROUP BY e.id ORDER BY e.nombre`, ...ep);
  const pfEst = Object.fromEntries((await q.all(`SELECT estacion_id, SUM(importe-abono) m FROM v_cxc WHERE estatus='POR FACTURAR' GROUP BY 1`)).map((r) => [r.estacion_id, r.m]));
  porEstacion.forEach((r) => { r.por_facturar = pfEst[r.id] || 0; });

  return {
    corte,
    kpis: {
      cartera_total: k.facturada + pf.monto, facturada: k.facturada, vencida: k.vencida, por_vencer: k.por_vencer, mayor_60: k.mayor_60,
      pct_vencida: k.facturada > 0 ? k.vencida / k.facturada : 0, por_facturar: pf.monto, despachos_por_facturar: pf.n,
      facturas_abiertas: k.facturas, clientes_con_saldo: k.clientes, saldo_a_favor: fav.a_favor, clientes_a_favor: fav.n,
      excedidos: riesgo.excedidos || 0, exceso_monto: riesgo.exceso_monto, sin_limite: riesgo.sin_limite || 0,
      promesas_vencidas: prom.n, promesas_monto: prom.monto,
    },
    aging: agingOut, por_estacion: porEstacion, tendencia,
  };
}

// ---------------- Facturas ----------------
const CAMPOS_FECHA = { factura: 'fecha_factura', vencimiento: 'fecha_vencimiento', despacho: 'ultimo_despacho' };
const ORDEN_FAC = { saldo: 'f.saldo', dias: 'f.dias_vencido', importe: 'f.importe', fecha_factura: 'f.fecha_factura',
  vencimiento: 'f.fecha_vencimiento', cliente: 'c.cliente', factura: 'f.no_factura' };
const PUEDE_ANULAR_DESPACHOS = (alias = 'f') => `CASE WHEN
  EXISTS (SELECT 1 FROM v_cxc d WHERE d.k_cliente=${alias}.k_cliente AND d.estacion_id=${alias}.estacion_id
    AND d.no_factura=${alias}.no_factura AND d.facturada_desde_pendiente=1 AND d.estatus IN ('POR PAGAR','ABONADO'))
  AND NOT EXISTS (SELECT 1 FROM v_cxc d WHERE d.k_cliente=${alias}.k_cliente AND d.estacion_id=${alias}.estacion_id
    AND d.no_factura=${alias}.no_factura AND (d.facturada_desde_pendiente<>1 OR d.estatus NOT IN ('POR PAGAR','ABONADO')))
  AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.k_cliente=${alias}.k_cliente AND p.estacion_id=${alias}.estacion_id
    AND p.no_factura=${alias}.no_factura)
  AND NOT EXISTS (SELECT 1 FROM aplicaciones_factura_anticipo a WHERE a.k_cliente=${alias}.k_cliente
    AND a.estacion_id=${alias}.estacion_id AND a.no_factura=${alias}.no_factura AND a.estado='APLICADA')
  AND NOT EXISTS (SELECT 1 FROM fact_factura x WHERE x.k_cliente=${alias}.k_cliente AND x.estacion_id=${alias}.estacion_id
    AND x.no_factura=${alias}.no_factura)
  THEN 1 ELSE 0 END`;
function filtrosFacturas(p, wh, pr) {
  filtrarEstaciones('f.estacion_id', p, wh, pr);
  if (p.k) { wh.push('f.k_cliente=?'); pr.push(p.k); }
  if (p.q) { wh.push("(c.cliente LIKE ? ESCAPE '\\' OR f.no_factura LIKE ? ESCAPE '\\')"); pr.push(likeEsc(p.q), likeEsc(p.q)); }
  const estado = p.estado || 'abiertas';
  if (estado === 'abiertas') wh.push(`f.saldo>${EPS}`);
  else if (estado === 'vencidas') wh.push(`f.saldo>${EPS} AND f.dias_vencido>0`);
  else if (estado === 'porvencer') wh.push(`f.saldo>${EPS} AND f.dias_vencido<=0`);
  else if (estado === 'pagadas') wh.push(`f.saldo<=${EPS}`);
  if (p.rango && RANGOS.includes(p.rango)) { wh.push(`f.saldo>${EPS} AND ${RANGO_SQL()}=?`); pr.push(p.rango); }
  const col = CAMPOS_FECHA[p.campo] || 'fecha_factura';
  if (esFecha(p.desde)) { wh.push(`f.${col}>=?`); pr.push(p.desde); }
  if (esFecha(p.hasta)) { wh.push(`f.${col}<=?`); pr.push(p.hasta); }
  return col;
}
async function facturas(p) {
  const wh = [], pr = [];
  const col = filtrosFacturas(p, wh, pr);
  const joinT = p.anio || p.mes ? `JOIN dim_tiempo t ON t.fecha=f.${col}` : '';
  if (p.anio) { wh.push('t.anio=?'); pr.push(entero(p.anio, 0, 2000, 2100)); }
  if (p.mes) { wh.push('t.mes=?'); pr.push(entero(p.mes, 0, 1, 12)); }
  const from = `FROM ${FAC(p.corte)} f JOIN dim_cliente c ON c.k_cliente=f.k_cliente JOIN dim_estacion e ON e.id=f.estacion_id ${joinT}
    ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}`;
  const orden = (ORDEN_FAC[p.sort] || 'f.saldo') + (p.dir === 'asc' ? ' ASC' : ' DESC') + ', f.no_factura';
  const size = p.todo ? 50000 : entero(p.size, 50, 10, 200);
  const page = entero(p.page, 1, 1, 100000);
  const tot = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(f.saldo),0) saldo, COALESCE(SUM(f.importe),0) importe ${from}`, ...pr);
  const rows = await q.all(`SELECT f.k_cliente, f.estacion_id, e.nombre estacion, c.cliente, f.no_factura, f.fecha_factura, f.fecha_vencimiento,
      f.ultimo_despacho, f.despachos, f.importe, f.abono, f.pagos_app, f.aplicaciones_anticipo, f.saldo, f.dias_vencido,
      ${ESTADO_SQL} estado, CASE WHEN f.saldo>${EPS} THEN ${RANGO_SQL()} ELSE NULL END rango,
      ${PUEDE_ANULAR_DESPACHOS()} puede_anular_despachos
    ${from} ORDER BY ${orden} LIMIT ? OFFSET ?`, ...pr, size, (page - 1) * size);
  return { total: tot.n, suma_saldo: tot.saldo, suma_importe: tot.importe, page, size, rows };
}
async function facturaDetalle({ corte, k, est, no }) {
  const f = await q.get(`SELECT f.*, c.cliente, e.nombre estacion, ${ESTADO_SQL} estado, ${RANGO_SQL()} rango
    FROM ${FAC(corte)} f JOIN dim_cliente c ON c.k_cliente=f.k_cliente JOIN dim_estacion e ON e.id=f.estacion_id
    WHERE f.k_cliente=? AND f.estacion_id=? AND f.no_factura=?`, k, est, no);
  if (!f) throw new HttpError(404, 'Factura no encontrada');
  const puedeAnular = await q.get(`SELECT ${PUEDE_ANULAR_DESPACHOS('f')} puede_anular
    FROM (SELECT ? k_cliente, ? estacion_id, ? no_factura) f`, k, est, no);
  f.puede_anular_despachos = Number(puedeAnular.puede_anular);
  f.aplicaciones_anticipo_historial = await q.all(`SELECT a.id, a.factura_anticipo_id, a.fecha_aplicacion, a.importe_aplicado,
      a.estado, a.referencia, a.motivo_cancelacion, x.serie, x.folio,
      COALESCE((SELECT nombre FROM usuarios WHERE usuario=a.created_by),
        (SELECT nombre FROM usuarios WHERE CAST(id AS TEXT)=a.created_by), a.created_by, '') usuario
    FROM aplicaciones_factura_anticipo a
    JOIN facturas_anticipo x ON x.id=a.factura_anticipo_id
    WHERE a.k_cliente=? AND a.estacion_id=? AND a.no_factura=?
    ORDER BY a.id DESC`, k, est, no);
  const despachos = await q.all(`SELECT f.id, f.fecha_despacho, f.despacho, f.producto, f.importe, f.abono, f.estatus, f.grupo, f.fecha_pago,
      CASE WHEN f.fecha_factura IS NOT NULL
        THEN date(f.fecha_factura, printf('%+d days', COALESCE(cr.dias,0)))
        ELSE f.fecha_vencimiento END AS fecha_vencimiento
    FROM v_cxc f LEFT JOIN credito cr ON cr.k_cliente=f.k_cliente
    WHERE f.k_cliente=? AND f.estacion_id=? AND f.no_factura=? ORDER BY f.fecha_despacho, f.id LIMIT 500`, k, est, no);
  const pagos = await q.all(`SELECT p.id, p.fecha, p.monto, p.metodo, COALESCE(p.banco,b.nombre) banco, p.referencia, p.notas,
      p.conciliado, p.anulado, p.desde_prepago,
      CASE WHEN EXISTS (SELECT 1 FROM debito_app d WHERE d.k_cliente=p.k_cliente AND d.folio='REVERSA-PAGO-'||p.id) THEN 1 ELSE 0 END prepago_devuelto,
      p.creado, u.nombre usuario
    FROM pagos p LEFT JOIN usuarios u ON u.id=p.usuario_id LEFT JOIN bancos b ON b.id=p.banco_id
    WHERE p.k_cliente=? AND p.estacion_id=? AND p.no_factura=? ORDER BY p.id DESC`, k, est, no);
  return { factura: f, despachos, pagos };
}

// ---------------- Facturas y aplicaciones de anticipo ----------------
async function facturasAnticipo(p) {
  const wh = [], pr = [];
  filtrarEstaciones('c.estacion_id', p, wh, pr);
  if (p.k) { wh.push('a.k_cliente=?'); pr.push(p.k); }
  if (p.q) {
    wh.push("(c.cliente LIKE ? ESCAPE '\\' OR a.folio LIKE ? ESCAPE '\\' OR COALESCE(a.serie,'') LIKE ? ESCAPE '\\' OR COALESCE(a.uuid_fiscal,'') LIKE ? ESCAPE '\\')");
    pr.push(likeEsc(p.q), likeEsc(p.q), likeEsc(p.q), likeEsc(p.q));
  }
  if (['ABIERTA', 'PARCIALMENTE_APLICADA', 'CERRADA', 'CANCELADA'].includes(p.estado)) {
    wh.push('a.estado=?'); pr.push(p.estado);
  }
  if (esFecha(p.desde)) { wh.push('a.fecha_factura>=?'); pr.push(p.desde); }
  if (esFecha(p.hasta)) { wh.push('a.fecha_factura<=?'); pr.push(p.hasta); }
  const from = `FROM facturas_anticipo a JOIN dim_cliente c ON c.k_cliente=a.k_cliente
    JOIN dim_estacion e ON e.id=c.estacion_id ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}`;
  const page = entero(p.page, 1, 1, 100000), size = entero(p.size, 50, 10, 200);
  const tot = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN a.estado<>'CANCELADA' THEN a.saldo_disponible ELSE 0 END),0) saldo
    ${from}`, ...pr);
  const rows = await q.all(`SELECT a.*, c.cliente, e.nombre estacion
    ${from} ORDER BY a.fecha_factura DESC, a.id DESC LIMIT ? OFFSET ?`, ...pr, size, (page - 1) * size);
  return { total: tot.n, saldo_total: tot.saldo, page, size, rows };
}

async function facturaAnticipoDetalle(id) {
  const factura = await q.get(`SELECT a.*, c.cliente, c.estacion_id, e.nombre estacion, a.created_by creador
    FROM facturas_anticipo a JOIN dim_cliente c ON c.k_cliente=a.k_cliente
    JOIN dim_estacion e ON e.id=c.estacion_id WHERE a.id=?`, id);
  if (!factura) throw new HttpError(404, 'Factura de Anticipo no encontrada');
  factura.aplicaciones = await q.all(`SELECT a.*, x.serie, x.folio anticipo_folio, a.created_by usuario,
      (SELECT group_concat(COALESCE(despacho,'(sin folio)'), ', ')
        FROM v_cxc WHERE k_cliente=a.k_cliente AND estacion_id=a.estacion_id AND no_factura=a.no_factura) despachos
    FROM aplicaciones_factura_anticipo a JOIN facturas_anticipo x ON x.id=a.factura_anticipo_id
    WHERE a.factura_anticipo_id=? ORDER BY a.id DESC`, id);
  return factura;
}

async function opcionesAplicacionAnticipo({ k, corte }) {
  const anticipos = await q.all(`SELECT id, serie, folio, uuid_fiscal, fecha_factura, importe_original,
      importe_aplicado, saldo_disponible, moneda, tipo_cambio, estado
    FROM facturas_anticipo WHERE k_cliente=? AND estado IN ('ABIERTA','PARCIALMENTE_APLICADA')
      AND saldo_disponible>${EPS} AND moneda='MXN' ORDER BY fecha_factura, id`, k);
  const facturas = await q.all(`SELECT f.k_cliente, f.estacion_id, e.nombre estacion, f.no_factura, f.fecha_factura,
      f.importe, f.abono, f.pagos_app, f.aplicaciones_anticipo, f.saldo, f.despachos,
      (SELECT group_concat(COALESCE(despacho,'(sin folio)'), ', ')
        FROM v_cxc WHERE k_cliente=f.k_cliente AND estacion_id=f.estacion_id AND no_factura=f.no_factura) detalle_despachos
    FROM ${FAC(corte)} f JOIN dim_estacion e ON e.id=f.estacion_id
    WHERE f.k_cliente=? AND f.abierta=1 AND f.saldo>${EPS}
    ORDER BY COALESCE(f.fecha_vencimiento,f.fecha_factura,f.ultimo_despacho), f.no_factura`, k);
  return { anticipos, facturas };
}

async function aplicacionesAnticipo(p) {
  const wh = [], pr = [];
  filtrarEstaciones('a.estacion_id', p, wh, pr);
  if (p.k) { wh.push('a.k_cliente=?'); pr.push(p.k); }
  if (p.estado === 'APLICADA' || p.estado === 'CANCELADA') { wh.push('a.estado=?'); pr.push(p.estado); }
  if (p.q) {
    wh.push("(c.cliente LIKE ? ESCAPE '\\' OR a.no_factura LIKE ? ESCAPE '\\' OR f.folio LIKE ? ESCAPE '\\' OR COALESCE(f.serie,'') LIKE ? ESCAPE '\\')");
    pr.push(likeEsc(p.q), likeEsc(p.q), likeEsc(p.q), likeEsc(p.q));
  }
  const from = `FROM aplicaciones_factura_anticipo a
    JOIN dim_cliente c ON c.k_cliente=a.k_cliente
    JOIN facturas_anticipo f ON f.id=a.factura_anticipo_id
    JOIN dim_estacion e ON e.id=a.estacion_id
    ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}`;
  const page = entero(p.page, 1, 1, 100000), size = entero(p.size, 50, 10, 200);
  const tot = await q.get(`SELECT COUNT(*) n ${from}`, ...pr);
  const rows = await q.all(`SELECT a.*, c.cliente, e.nombre estacion, f.serie, f.folio anticipo_folio,
      a.no_factura factura_folio,
      COALESCE((SELECT nombre FROM usuarios WHERE usuario=a.created_by),
        (SELECT nombre FROM usuarios WHERE CAST(id AS TEXT)=a.created_by), a.created_by, '') usuario
    ${from} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...pr, size, (page - 1) * size);
  return { total: tot.n, page, size, rows };
}

// ---------------- Clientes ----------------
const ORDEN_CLI = {
  saldo: 'x.saldo_total', vencido: 'x.vencido', cliente: 'x.cliente', limite: 'x.limite', dias_credito: 'x.dias_credito',
  favor: 'x.saldo_anticipo', uso: '(CASE WHEN x.limite>0 THEN x.saldo_total/x.limite END)', por_facturar: 'x.por_facturar',
  no: 'x.no_cliente', estacion: 'x.estacion', email: 'x.email', telefono: 'x.telefono', modo_carga: 'x.modo_carga',
  riesgo: RIESGO('x'),
};
async function clientes(p) {
  const wh = [], pr = [];
  filtrarEstaciones('x.estacion_id', p, wh, pr);
  if (p.q) { wh.push("(x.cliente LIKE ? ESCAPE '\\' OR COALESCE(x.no_cliente,'') LIKE ? ESCAPE '\\' OR COALESCE(x.rfc,'') LIKE ? ESCAPE '\\')"); pr.push(likeEsc(p.q), likeEsc(p.q), likeEsc(p.q)); }
  if (p.filtro === 'saldo') wh.push(`x.saldo_total>${EPS}`);
  else if (p.filtro === 'vencido') wh.push(`x.vencido>${EPS}`);
  else if (p.filtro === 'excedido') wh.push(`x.limite>0 AND x.saldo_total>x.limite`);
  else if (p.filtro === 'sinlimite') wh.push(`x.limite=0 AND x.saldo_total>${EPS}`);
  else if (p.filtro === 'favor') wh.push(`x.saldo_anticipo>${EPS}`);
  const from = `FROM ${CLIENTES(p.corte)} x ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}`;
  const orden = (ORDEN_CLI[p.sort] || 'x.saldo_total') + (p.dir === 'asc' ? ' ASC' : ' DESC') + ', x.cliente';
  const size = p.todo ? 50000 : entero(p.size, 50, 10, 200);
  const page = entero(p.page, 1, 1, 100000);
  const tot = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(x.saldo_total),0) saldo, COALESCE(SUM(x.vencido),0) vencido ${from}`, ...pr);
  const rows = await q.all(`SELECT x.*, x.saldo_anticipo+x.limite-x.saldo_total disponible, CASE WHEN x.limite>0 THEN x.saldo_total/x.limite END uso, ${RIESGO('x')} riesgo
    ${from} ORDER BY ${orden} LIMIT ? OFFSET ?`, ...pr, size, (page - 1) * size);
  return { total: tot.n, suma_saldo: tot.saldo, suma_vencido: tot.vencido, page, size, rows };
}
async function clienteDetalle({ corte, k }) {
  const c = await q.get(`SELECT x.*, x.saldo_anticipo+x.limite-x.saldo_total disponible, CASE WHEN x.limite>0 THEN x.saldo_total/x.limite END uso,
      ${RIESGO('x')} riesgo FROM ${CLIENTES(corte)} x WHERE x.k_cliente=?`, k);
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  const cred = await q.get('SELECT origen, actualizado_por, actualizado FROM credito WHERE k_cliente=?', k) || {};
  const aging = await q.all(`SELECT ${RANGO_SQL()} rango, SUM(saldo) monto FROM ${FAC(corte)} f
    WHERE f.k_cliente=? AND f.abierta=1 AND f.saldo>${EPS} GROUP BY 1`, k);
  const am = Object.fromEntries(aging.map((a) => [a.rango, a.monto]));
  const abiertas = await q.all(`SELECT f.no_factura, f.fecha_factura, f.fecha_vencimiento, f.despachos, f.importe, f.abono, f.pagos_app, f.saldo,
      f.dias_vencido, f.estacion_id, ${ESTADO_SQL} estado, ${RANGO_SQL()} rango,
      ${PUEDE_ANULAR_DESPACHOS()} puede_anular_despachos FROM ${FAC(corte)} f
    WHERE f.k_cliente=? AND f.abierta=1 AND f.saldo>${EPS} ORDER BY COALESCE(f.fecha_vencimiento, f.fecha_factura, f.ultimo_despacho), f.no_factura`, k);
  const porFacturar = await q.all(`SELECT id, fecha_despacho, despacho, producto, importe, abono, grupo,
      CAST(julianday(?)-julianday(fecha_despacho) AS INTEGER) dias FROM v_cxc
    WHERE k_cliente=? AND estatus='POR FACTURAR' AND importe-abono<>0 ORDER BY fecha_despacho LIMIT 300`, corte, k);
  const debito = await q.all(`SELECT d.id, d.fecha, d.folio, d.tipo, d.importe, d.abono, d.grupo, d.origen,
      a.metodo,
      COALESCE(a.banco,b.nombre) banco
    FROM v_debito d LEFT JOIN debito_app a ON d.origen='app' AND d.id=1000000000+a.id
    LEFT JOIN bancos b ON b.id=a.banco_id WHERE d.k_cliente=?
    ORDER BY COALESCE(d.fecha,'') DESC, d.id DESC LIMIT 200`, k);
  const debRes = await q.get(`SELECT COALESCE(SUM(abono),0) recargas, COALESCE(SUM(importe),0) consumos FROM v_debito WHERE k_cliente=?`, k);
  const anticipos = await q.all(`SELECT id, serie, folio, uuid_fiscal, fecha_factura, importe_original, importe_aplicado,
      saldo_disponible, moneda, tipo_cambio, estado FROM facturas_anticipo WHERE k_cliente=? ORDER BY fecha_factura DESC, id DESC`, k);
  const aplicacionesAnticipo = await q.all(`SELECT a.id, a.factura_anticipo_id, a.estacion_id, a.no_factura,
      a.fecha_aplicacion, a.importe_aplicado, a.moneda, a.estado, a.referencia, a.motivo_cancelacion,
      a.fecha_cancelacion, f.serie, f.folio, e.nombre estacion,
      COALESCE((SELECT nombre FROM usuarios WHERE usuario=a.created_by),
        (SELECT nombre FROM usuarios WHERE CAST(id AS TEXT)=a.created_by), a.created_by, '') usuario
    FROM aplicaciones_factura_anticipo a
    JOIN facturas_anticipo f ON f.id=a.factura_anticipo_id
    JOIN dim_estacion e ON e.id=a.estacion_id
    WHERE a.k_cliente=? ORDER BY a.id DESC LIMIT 200`, k);
  const gestiones = await q.all(`SELECT g.*, u.nombre usuario FROM gestiones g LEFT JOIN usuarios u ON u.id=g.usuario_id
    WHERE g.k_cliente=? ORDER BY g.id DESC LIMIT 100`, k);
  const pagos = await q.all(`SELECT p.id, p.no_factura, p.sin_aplicar, p.fecha, p.monto, p.metodo, COALESCE(p.banco,b.nombre) banco,
      p.referencia, p.conciliado, p.anulado, p.desde_prepago,
      CASE WHEN EXISTS (SELECT 1 FROM debito_app d WHERE d.k_cliente=p.k_cliente AND d.folio='REVERSA-PAGO-'||p.id) THEN 1 ELSE 0 END prepago_devuelto,
      u.nombre usuario
    FROM pagos p LEFT JOIN usuarios u ON u.id=p.usuario_id LEFT JOIN bancos b ON b.id=p.banco_id
    WHERE p.k_cliente=? ORDER BY p.id DESC LIMIT 500`, k);
  const hist = (await q.all(`SELECT mes, SUM(facturado) facturado, SUM(cobrado) cobrado FROM (
      SELECT substr(fecha_factura,1,7) mes, SUM(importe) facturado, SUM(abono) cobrado FROM v_cxc
        WHERE k_cliente=? AND no_factura IS NOT NULL AND estatus<>'POR FACTURAR' AND fecha_factura IS NOT NULL GROUP BY 1
      UNION ALL
      SELECT substr(fecha,1,7), 0, SUM(monto) FROM pagos
        WHERE k_cliente=? AND anulado=0 AND conciliado=0 AND sin_aplicar=0 GROUP BY 1
      UNION ALL
      SELECT substr(fecha_aplicacion,1,7), 0, SUM(importe_aplicado) FROM aplicaciones_factura_anticipo
        WHERE k_cliente=? AND estado='APLICADA' GROUP BY 1
    ) movimientos GROUP BY mes ORDER BY mes DESC LIMIT 12`, k, k, k)).reverse();
  return {
    cliente: { ...c, credito_actualizado_por: cred.actualizado_por, credito_actualizado: cred.actualizado },
    aging: RANGOS.map((r) => ({ rango: r, monto: am[r] || 0 })),
    abiertas, por_facturar: porFacturar, anticipos, aplicaciones_anticipo_historial: aplicacionesAnticipo,
    debito, debito_resumen: { ...debRes, saldo: debRes.recargas - debRes.consumos },
    gestiones, pagos, historial: hist,
  };
}

// ---------------- Por facturar ----------------
async function porFacturar(p) {
  const wh = ["f.estatus='POR FACTURAR'", 'f.importe-f.abono>0'], pr = [];
  filtrarEstaciones('f.estacion_id', p, wh, pr);
  if (p.k) { wh.push('f.k_cliente=?'); pr.push(p.k); }
  if (p.q) { wh.push("c.cliente LIKE ? ESCAPE '\\'"); pr.push(likeEsc(p.q)); }
  const from = `FROM v_cxc f JOIN dim_cliente c ON c.k_cliente=f.k_cliente JOIN dim_estacion e ON e.id=f.estacion_id WHERE ${wh.join(' AND ')}`;
  const rows = await q.all(`SELECT f.k_cliente, c.cliente, e.nombre estacion, COUNT(*) despachos, SUM(f.importe-f.abono) monto,
      f.estacion_id,
      MIN(f.fecha_despacho) mas_antiguo, MAX(f.fecha_despacho) mas_reciente,
      CAST(julianday(?)-julianday(MIN(f.fecha_despacho)) AS INTEGER) dias_antiguedad
    ${from} GROUP BY f.k_cliente ORDER BY monto DESC LIMIT 500`, p.corte, ...pr);
  const tot = await q.get(`SELECT COALESCE(SUM(f.importe-f.abono),0) monto, COUNT(*) n ${from}`, ...pr);
  if (p.k && rows.length) {
    rows[0].items = await q.all(`SELECT f.id, f.fecha_despacho, f.despacho, f.producto, f.grupo, f.importe, f.abono,
        f.importe-f.abono AS monto, f.origen
      ${from} ORDER BY f.fecha_despacho, f.id`, ...pr);
  }
  return { total_monto: tot.monto, total_despachos: tot.n, rows };
}

// ---------------- Debito ----------------
async function debitoResumen(p) {
  const wh = [], pr = [];
  filtrarEstaciones('d.estacion_id', p, wh, pr);
  if (p.q) { wh.push("c.cliente LIKE ? ESCAPE '\\'"); pr.push(likeEsc(p.q)); }
  const having = p.signo === 'favor' ? `HAVING saldo>${EPS}` : p.signo === 'negativo' ? `HAVING saldo<-${EPS}` : '';
  const rows = await q.all(`SELECT d.k_cliente, c.cliente, e.nombre estacion, SUM(d.abono) recargas, SUM(d.importe) consumos,
      SUM(d.abono)-SUM(d.importe) saldo, COUNT(*) movimientos, MAX(d.fecha) ultimo_mov
    FROM v_debito d JOIN dim_cliente c ON c.k_cliente=d.k_cliente JOIN dim_estacion e ON e.id=d.estacion_id
    ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} GROUP BY d.k_cliente ${having} ORDER BY saldo DESC LIMIT 1000`, ...pr);
  const t = rows.reduce((a, r) => ({ recargas: a.recargas + r.recargas, consumos: a.consumos + r.consumos, saldo: a.saldo + r.saldo,
    a_favor: a.a_favor + (r.saldo > 0 ? r.saldo : 0), negativo: a.negativo + (r.saldo < 0 ? r.saldo : 0), clientes_favor: a.clientes_favor + (r.saldo > EPS ? 1 : 0) }),
    { recargas: 0, consumos: 0, saldo: 0, a_favor: 0, negativo: 0, clientes_favor: 0 });
  return { totales: t, rows };
}
async function debitoMovs(p) {
  const wh = [], pr = [];
  filtrarEstaciones('d.estacion_id', p, wh, pr);
  if (p.k) { wh.push('d.k_cliente=?'); pr.push(p.k); }
  if (p.tipo === 'RECARGA' || p.tipo === 'CONSUMO') { wh.push('d.tipo=?'); pr.push(p.tipo); }
  if (esFecha(p.desde)) { wh.push('d.fecha>=?'); pr.push(p.desde); }
  if (esFecha(p.hasta)) { wh.push('d.fecha<=?'); pr.push(p.hasta); }
  if (p.q) { wh.push("c.cliente LIKE ? ESCAPE '\\'"); pr.push(likeEsc(p.q)); }
  const from = `FROM v_debito d JOIN dim_cliente c ON c.k_cliente=d.k_cliente JOIN dim_estacion e ON e.id=d.estacion_id ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}`;
  const size = entero(p.size, 50, 10, 200), page = entero(p.page, 1, 1, 100000);
  const tot = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(d.abono),0) recargas, COALESCE(SUM(d.importe),0) consumos ${from}`, ...pr);
  const rows = await q.all(`SELECT d.id, d.origen, d.fecha, d.folio, d.tipo, d.importe, d.abono, d.grupo,
      a.metodo, COALESCE(a.banco,b.nombre) banco, c.cliente, d.k_cliente, e.nombre estacion
    ${from.replace('FROM v_debito d', 'FROM v_debito d LEFT JOIN debito_app a ON d.origen=\'app\' AND d.id=1000000000+a.id LEFT JOIN bancos b ON b.id=a.banco_id')}
    ORDER BY COALESCE(d.fecha,'') DESC, d.id DESC LIMIT ? OFFSET ?`, ...pr, size, (page - 1) * size);
  return { total: tot.n, recargas: tot.recargas, consumos: tot.consumos, page, size, rows };
}
const saldoDebito = async (k) => (await q.get('SELECT COALESCE(SUM(abono),0)-COALESCE(SUM(importe),0) s FROM v_debito WHERE k_cliente=?', k) || { s: 0 }).s;

// ---------------- Alertas ----------------
async function alertas({ corte, est, estaciones }) {
  const F = FAC(corte);
  const estacionesId = Array.isArray(estaciones) ? estaciones : est ? [est] : null;
  const estacionesSql = (columna) => {
    if (!estacionesId) return '';
    return estacionesId.length
      ? ` AND ${columna} IN (${estacionesId.map(() => '?').join(',')})`
      : ' AND 1=0';
  };
  const ew = estacionesSql('f.estacion_id');
  const ep = estacionesId || [];
  const cw = estacionesSql('x.estacion_id');
  const excedidos = await q.all(`SELECT k_cliente, cliente, estacion, limite, saldo_total, saldo_total-limite exceso, vencido
    FROM ${CLIENTES(corte)} x WHERE x.limite>0 AND x.saldo_total>x.limite${cw} ORDER BY exceso DESC LIMIT 100`, ...ep);
  const sinLimite = await q.all(`SELECT k_cliente, cliente, estacion, saldo_total, vencido FROM ${CLIENTES(corte)} x
    WHERE x.limite=0 AND x.saldo_total>${EPS}${cw} ORDER BY saldo_total DESC LIMIT 100`, ...ep);
  const base = `FROM ${F} f JOIN dim_cliente c ON c.k_cliente=f.k_cliente JOIN dim_estacion e ON e.id=f.estacion_id`;
  const cols = `f.k_cliente, c.cliente, e.nombre estacion, f.estacion_id, f.no_factura, f.fecha_vencimiento, f.saldo, f.dias_vencido`;
  const vencidas60 = await q.all(`SELECT ${cols} ${base} WHERE f.abierta=1 AND f.saldo>${EPS} AND f.dias_vencido>60${ew} ORDER BY f.saldo DESC LIMIT 100`, ...ep);
  const prox = await q.all(`SELECT ${cols} ${base} WHERE f.abierta=1 AND f.saldo>${EPS} AND f.dias_vencido<=0 AND f.dias_vencido>=-7${ew} ORDER BY f.fecha_vencimiento LIMIT 100`, ...ep);
  const sinVenc = await q.all(`SELECT f.k_cliente, c.cliente, e.nombre estacion, f.estacion_id, f.no_factura, f.fecha_factura, f.saldo ${base}
    WHERE f.abierta=1 AND f.saldo>${EPS} AND f.fecha_vencimiento IS NULL${ew} ORDER BY f.saldo DESC LIMIT 100`, ...ep);
  const promesas = await q.all(`SELECT g.id, g.k_cliente, c.cliente, g.promesa_fecha, g.promesa_monto, g.notas, e.nombre estacion
    FROM gestiones g JOIN dim_cliente c ON c.k_cliente=g.k_cliente JOIN dim_estacion e ON e.id=c.estacion_id
    WHERE g.estado='Abierta' AND g.promesa_fecha IS NOT NULL AND g.promesa_fecha<=?${estacionesSql('c.estacion_id')}
    ORDER BY g.promesa_fecha LIMIT 100`, corte, ...ep);
  const pf = await q.all(`SELECT f.k_cliente, c.cliente, e.nombre estacion, COUNT(*) despachos, SUM(f.importe-f.abono) monto,
      CAST(julianday(?)-julianday(MIN(f.fecha_despacho)) AS INTEGER) dias
    FROM v_cxc f JOIN dim_cliente c ON c.k_cliente=f.k_cliente JOIN dim_estacion e ON e.id=f.estacion_id
    WHERE f.estatus='POR FACTURAR' AND f.importe-f.abono<>0 AND f.fecha_despacho<=date(?, '-15 day')${ew}
    GROUP BY f.k_cliente ORDER BY monto DESC LIMIT 100`, corte, corte, ...ep);
  return { corte, excedidos, sin_limite: sinLimite, vencidas_60: vencidas60, proximas: prox, sin_vencimiento: sinVenc, promesas, por_facturar_antiguo: pf };
}

async function estadoCuenta({ k, corte }) {
  const rows = await q.all(`SELECT * FROM (
      SELECT f.fecha_factura fecha, 'Factura' tipo_documento, f.no_factura folio, '' uuid,
        'Factura con ' || f.despachos || ' despacho(s)' concepto, f.fecha_vencimiento,
        f.importe importe_original, f.saldo saldo_pendiente, 'Por Cobrar' naturaleza,
        CASE WHEN f.dias_vencido>0 THEN 'Vencida' ELSE 'Pendiente' END estatus, 'MXN' moneda,
        1 tipo_cambio, f.saldo equivalente_mxn
      FROM ${FAC(corte)} f
      WHERE f.k_cliente=? AND f.abierta=1 AND f.saldo>${EPS}
      UNION ALL
      SELECT a.fecha_factura, 'Factura de Anticipo',
        TRIM(COALESCE(a.serie || '-', '') || a.folio), COALESCE(a.uuid_fiscal, ''),
        COALESCE(NULLIF(a.referencia,''), NULLIF(a.observaciones,''), 'Factura de Anticipo'),
        NULL, a.importe_original, a.saldo_disponible, 'A Favor', a.estado, a.moneda,
        COALESCE(a.tipo_cambio,1), a.saldo_disponible*COALESCE(a.tipo_cambio,1)
      FROM facturas_anticipo a
      WHERE a.k_cliente=? AND a.estado IN ('ABIERTA','PARCIALMENTE_APLICADA')
        AND a.saldo_disponible>${EPS}
      UNION ALL
      SELECT f.fecha_despacho, 'Despacho pendiente de facturar',
        COALESCE(NULLIF(f.despacho,''), CAST(f.id AS TEXT)), '',
        COALESCE(NULLIF(f.producto,''), NULLIF(f.grupo,''), 'Consumo pendiente de facturar'),
        NULL, f.importe, f.importe-f.abono, 'Pendiente de Facturar', 'Pendiente de Facturar', 'MXN',
        1, f.importe-f.abono
      FROM v_cxc f
      WHERE f.k_cliente=? AND f.estatus='POR FACTURAR' AND f.fecha_despacho IS NOT NULL
        AND f.importe>0 AND f.importe-f.abono>${EPS}
    ) documentos
    ORDER BY fecha, tipo_documento, folio`, k, k, k);
  const redondeaCentavos = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
  const resumen = {
    cartera_pendiente: redondeaCentavos(rows.filter((r) => r.tipo_documento === 'Factura').reduce((s, r) => s + r.saldo_pendiente, 0)),
    despachos_pendientes: redondeaCentavos(rows.filter((r) => r.tipo_documento === 'Despacho pendiente de facturar').reduce((s, r) => s + r.saldo_pendiente, 0)),
    anticipos_disponibles: redondeaCentavos(rows.filter((r) => r.tipo_documento === 'Factura de Anticipo').reduce((s, r) => s + r.equivalente_mxn, 0)),
  };
  resumen.posicion_neta = redondeaCentavos(resumen.cartera_pendiente + resumen.despachos_pendientes - resumen.anticipos_disponibles);
  return { resumen, rows };
}

module.exports = { listaClientes, corteDefault, corteValido, catalogos, dashboard, facturas, facturaDetalle, facturasAnticipo,
  facturaAnticipoDetalle, opcionesAplicacionAnticipo, aplicacionesAnticipo, clientes, clienteDetalle,
  porFacturar, debitoResumen, debitoMovs, saldoDebito, alertas, estadoCuenta, FAC, EPS, RANGOS };
