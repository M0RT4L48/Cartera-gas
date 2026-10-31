'use strict';
// Pruebas de integracion (usa una COPIA temporal de la BD; no toca data/cartera.db)
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert');
const { spawn } = require('node:child_process');
const src = path.join(__dirname, '..', 'data', 'cartera.db');
const tmp = path.join(os.tmpdir(), `cartera_test_${process.pid}.db`);
fs.copyFileSync(src, tmp);
process.env.DB_PATH = tmp; process.env.ADMIN_PASSWORD = 'Inicial123';
(async () => {
const L = require('./lib'); const { server } = require('./index');
await L.ready;
await L.q.run("UPDATE usuarios SET pass_hash=?, must_change=1 WHERE usuario='admin'", L.hashPassword('Inicial123'));
assert.equal(await L.sembrarAdmin(), null, 'La contraseña configurada del administrador no se devuelve para imprimirla en logs');
const XLSX = process.env.XLSX_PRUEBA || '/mnt/user-data/uploads/Gas_App.xlsx';

let base, ok = 0, testBackup = null;
const jar = {};
async function call(who, method, url, body, raw) {
  const r = await fetch(base + url, { method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('sid=;')) delete jar[who];
  else if (sc && sc.startsWith('sid=')) jar[who] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
const t = async (nombre, fn) => { try { await fn(); ok++; console.log('  ✔', nombre); } catch (e) { console.log('  ✘', nombre, '\n    ', e.message); process.exitCode = 1; } };
const enc = encodeURIComponent;

server.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log('Pruebas de Gas_App Financiero');
  await t('API sin sesión devuelve 401', async () => assert.equal((await call('x', 'GET', '/api/dashboard')).status, 401));
  await t('login incorrecto devuelve 401', async () => assert.equal((await call('a', 'POST', '/api/login', { usuario: 'admin', password: 'mal' })).status, 401));
  await t('login admin correcto', async () => assert.equal((await call('a', 'POST', '/api/login', { usuario: 'admin', password: 'Inicial123' })).status, 200));
  await t('cambio de contraseña obligatorio bloquea la API', async () => assert.equal((await call('a', 'GET', '/api/dashboard')).status, 403));
  await t('contraseña débil rechazada', async () => assert.equal((await call('a', 'POST', '/api/cambiar-password', { actual: 'Inicial123', nueva: 'abc' })).status, 400));
  await t('cambio de contraseña', async () => assert.equal((await call('a', 'POST', '/api/cambiar-password', { actual: 'Inicial123', nueva: 'NuevaClave2026' })).status, 200));

  let bancoId, bancoHistoricoId, metodoPagoId, metodoPagoPrueba;
  await t('catálogo de bancos: valores iniciales y operaciones admin', async () => {
    const r = await call('a', 'GET', '/api/catalogos');
    bancoId = r.data.bancos.find((b) => b.nombre === 'BBVA').id;
    assert.equal(r.data.bancos.length, 3);
    assert.ok(['Banco Azteca', 'BBVA', 'Santander'].every((nombre) => r.data.bancos.some((b) => b.nombre === nombre)));
    const alta = await call('a', 'POST', '/api/bancos', { nombre: 'Banco Prueba' });
    assert.equal(alta.status, 201, JSON.stringify(alta.data));
    assert.equal((await call('a', 'POST', '/api/bancos', { nombre: 'banco prueba' })).status, 409);
    assert.equal((await call('a', 'PUT', '/api/bancos/' + alta.data.id, { nombre: 'Banco Prueba Editado' })).status, 200);
    bancoHistoricoId = alta.data.id;
    assert.ok((await call('a', 'GET', '/api/bancos')).data.rows.some((b) => b.nombre === 'Banco Prueba Editado'));
  });
  await t('catálogo de métodos de pago: valores iniciales y CRUD admin', async () => {
    const r = await call('a', 'GET', '/api/catalogos');
    assert.equal(r.data.metodos_pago.length, 6);
    assert.ok(r.data.metodos_pago.some((m) => m.nombre === 'Transferencia SPEI' && m.requiere_banco === 1));
    const alta = await call('a', 'POST', '/api/metodos-pago', { nombre: 'Método de Prueba' });
    assert.equal(alta.status, 201, JSON.stringify(alta.data));
    assert.equal((await call('a', 'POST', '/api/metodos-pago', { nombre: 'método de prueba' })).status, 409);
    const editar = await call('a', 'PUT', '/api/metodos-pago/' + alta.data.id, { nombre: 'Método Integrado', requiere_banco: '1' });
    assert.equal(editar.status, 200, JSON.stringify(editar.data));
    assert.equal(editar.data.requiere_banco, 1);
    metodoPagoId = alta.data.id;
    metodoPagoPrueba = editar.data.nombre;
    assert.ok((await call('a', 'GET', '/api/metodos-pago')).data.rows.some((m) => m.nombre === metodoPagoPrueba && m.requiere_banco === 1));
  });

  let dash;
  await t('KPIs: cifras del modelo', async () => {
    const r = await call('a', 'GET', '/api/dashboard?corte=2026-10-13'); assert.equal(r.status, 200); dash = r.data;
    assert.equal(Math.round(dash.kpis.facturada), 10045656);
    assert.equal(Math.round(dash.kpis.por_facturar), 2351614);
    assert.equal(Math.round(dash.kpis.saldo_a_favor), 815111);
    assert.equal(dash.kpis.facturas_abiertas, 766);
    assert.equal(Math.round(dash.aging.reduce((a, x) => a + x.monto, 0)), 10045656);
    assert.equal(Math.round(dash.kpis.vencida + dash.kpis.por_vencer), Math.round(dash.kpis.facturada));
  });
  await t('facturas: filtros, paginación, CSV e inyección SQL', async () => {
    const r = await call('a', 'GET', '/api/facturas?corte=2026-10-13&estado=vencidas&size=20');
    assert.ok(r.data.rows.length === 20 && r.data.rows.every((f) => f.dias_vencido > 0 && f.saldo > 0));
    assert.ok((await call('a', 'GET', '/api/facturas?corte=2026-10-13&estado=abiertas&formato=csv')).data.includes('Saldo'));
    assert.equal((await call('a', 'GET', '/api/facturas?q=%27%20OR%201%3D1%20--&estado=todas')).data.total, 0);
    assert.ok((await call('a', 'GET', '/api/facturas?estado=todas&campo=vencimiento&anio=2026&mes=9')).data.total > 0);
  });
  await t('CSV neutraliza valores que pueden ejecutarse como fórmula', async () => {
    const r = await call('a', 'POST', '/api/clientes', {
      cliente: '=1+1', estacion_id: 1, no_cliente: 'CSV-FORMULA-TEST',
    });
    try {
      assert.equal(r.status, 201, JSON.stringify(r.data));
      const csvResult = await call('a', 'GET', '/api/clientes?formato=csv&q=CSV-FORMULA-TEST');
      assert.equal(csvResult.status, 200);
      assert.ok(csvResult.data.includes("'=1+1"));
    } finally {
      if (r.data.k_cliente) {
        await L.tx(async () => {
          for (const table of ['credito', 'cliente_extra', 'dim_cliente']) await L.q.run(`DELETE FROM ${table} WHERE k_cliente=?`, r.data.k_cliente);
        });
      }
    }
  });
  await t('clientes, detalle y lista para selectores', async () => {
    const r = await call('a', 'GET', '/api/clientes?corte=2026-10-13&filtro=excedido'); assert.equal(r.data.total, dash.kpis.excedidos);
    const d = await call('a', 'GET', '/api/cliente?corte=2026-10-13&k=' + enc(r.data.rows[0].k_cliente)); assert.equal(d.data.cliente.riesgo, 'EXCEDIDO');
    assert.equal((await call('a', 'GET', '/api/clientes-lista')).data.rows.length, 330);
    assert.equal((await call('a', 'GET', '/api/clientes-lista?con_facturas=1&corte=2026-10-13')).data.rows.length, dash.kpis.clientes_con_saldo);
  });
  await t('endpoints de lectura responden', async () => {
    for (const u of ['/api/debito', '/api/debito/movimientos', '/api/por-facturar', '/api/alertas', '/api/catalogos', '/api/pagos', '/api/gestiones'])
      assert.equal((await call('a', 'GET', u)).status, 200, u);
  });

  // ---- pagos: individual y FIFO por lote ----
  const cliPagos = (await call('a', 'GET', '/api/clientes?corte=2026-10-13&filtro=vencido&size=200')).data.rows.find((c) => c.n_fact >= 3 && c.saldo_fact < 1e6);
  const detalle = async () => (await call('a', 'GET', '/api/cliente?corte=2026-10-13&k=' + enc(cliPagos.k_cliente))).data;
  let facs;
  await t('pago individual reduce saldo y KPI; anular lo restablece', async () => {
    facs = (await detalle()).abiertas; const f = facs[0];
    const r = await call('a', 'POST', '/api/pagos', { k_cliente: cliPagos.k_cliente, estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 100, fecha: '2026-10-20', metodo: metodoPagoPrueba, banco_id: bancoId, corte: '2026-10-13' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok((await call('a', 'GET', '/api/pagos')).data.rows.some((p) => p.metodo === metodoPagoPrueba && p.banco === 'BBVA'));
    assert.equal((await call('a', 'POST', '/api/pagos', { k_cliente: cliPagos.k_cliente, estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 1, fecha: '2026-10-20', metodo: 'Método No Configurado', corte: '2026-10-13' })).status, 400);
    assert.equal(Math.round(dash.kpis.facturada - (await call('a', 'GET', '/api/dashboard?corte=2026-10-13')).data.kpis.facturada), 100);
    assert.equal((await call('a', 'DELETE', '/api/pagos/' + r.data.ids[0])).status, 200);
    assert.equal(Math.round((await call('a', 'GET', '/api/dashboard?corte=2026-10-13')).data.kpis.facturada), 10045656);
  });
  await t('eliminar método no borra el nombre histórico del pago', async () => {
    assert.equal((await call('a', 'DELETE', '/api/metodos-pago/' + metodoPagoId)).status, 200);
    assert.ok(!(await call('a', 'GET', '/api/metodos-pago')).data.rows.some((m) => m.id === metodoPagoId));
    assert.ok((await call('a', 'GET', '/api/pagos')).data.rows.some((p) => p.metodo === metodoPagoPrueba));
  });
  await t('pagos: validaciones (excedente, fecha futura, vacío, duplicado)', async () => {
    const f = facs[0]; const b = { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Efectivo' };
    const deudaActual = (await detalle()).abiertas.reduce((sum, factura) => sum + factura.saldo, 0);
    const pagoExcedido = await call('a', 'POST', '/api/pagos/lote', { ...b, monto: deudaActual + 1, aplicaciones: [], corte: '2026-10-13' });
    assert.equal(pagoExcedido.status, 400);
    assert.match(pagoExcedido.data.error, /No se puede exceder la deuda actual/);
    assert.equal((await call('a', 'POST', '/api/pagos', { ...b, metodo: 'Cheque', estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 1 })).status, 400);
    assert.equal((await call('a', 'POST', '/api/pagos', { ...b, estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 1e9 })).status, 400);
    assert.equal((await call('a', 'POST', '/api/pagos', { ...b, fecha: '2099-01-01', estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 1 })).status, 400);
    assert.equal((await call('a', 'POST', '/api/pagos/lote', { ...b, aplicaciones: [] })).status, 400);
    assert.equal((await call('a', 'POST', '/api/pagos/lote', { ...b, aplicaciones: [{ no_factura: f.no_factura, estacion_id: f.estacion_id, monto: 1 }, { no_factura: f.no_factura, estacion_id: f.estacion_id, monto: 1 }] })).status, 400);
  });
  await t('pago sin aplicación guarda el monto total y conserva el sobrante como no aplicado', async () => {
    const f = facs[0]; const total = 275.5;
    assert.equal((await call('a', 'POST', '/api/pagos/lote', { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Transferencia SPEI', monto: total, aplicaciones: [] })).status, 400);
    const r = await call('a', 'POST', '/api/pagos/lote', { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Transferencia SPEI', banco_id: bancoHistoricoId, referencia: 'SIN-APLICAR', corte: '2026-10-13', monto: total, aplicaciones: [] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.total, total);
    assert.ok(r.data.ids.some((id) => (Number(id) > 0)));
    const listado = await call('a', 'GET', '/api/pagos?q=SIN-APLICAR');
    assert.equal(listado.status, 200);
    assert.ok(listado.data.rows.some((p) => p.sin_aplicar === 1 && p.monto === total));
    assert.ok((await detalle()).pagos.some((p) => p.sin_aplicar === 1 && p.referencia === 'SIN-APLICAR'));
    assert.equal((await call('a', 'GET', '/api/pagos?q=SIN-APLICAR')).data.rows.find((p) => p.referencia === 'SIN-APLICAR').banco, 'Banco Prueba Editado');
    assert.equal((await call('a', 'DELETE', '/api/bancos/' + bancoHistoricoId)).status, 200);
    assert.equal((await call('a', 'DELETE', '/api/bancos/' + bancoHistoricoId)).status, 404);
    assert.equal((await call('a', 'GET', '/api/pagos?q=SIN-APLICAR')).data.rows.find((p) => p.referencia === 'SIN-APLICAR').banco, 'Banco Prueba Editado');
    for (const id of r.data.ids) await call('a', 'DELETE', '/api/pagos/' + id);
  });
  await t('pago parcial guarda la aplicación y el restante como no aplicado', async () => {
    const f = facs[0]; const total = 350; const aplicado = Math.min(f.saldo, 180);
    const r = await call('a', 'POST', '/api/pagos/lote', { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Transferencia SPEI', banco_id: bancoId, referencia: 'PARCIAL', corte: '2026-10-13', monto: total,
      aplicaciones: [{ no_factura: f.no_factura, estacion_id: f.estacion_id, monto: aplicado }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.aplicado, aplicado);
    assert.ok(r.data.sin_aplicar > 0);
    assert.ok((await call('a', 'GET', '/api/pagos?q=PARCIAL')).data.rows.some((p) => p.sin_aplicar === 1));
    for (const id of r.data.ids) await call('a', 'DELETE', '/api/pagos/' + id);
  });
  await t('pago FIFO por lote: liquida las más antiguas y reparte el resto', async () => {
    const f = facs; const a1 = f[0].saldo, a2 = Math.round(f[1].saldo / 2 * 100) / 100;
    const r = await call('a', 'POST', '/api/pagos/lote', { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Transferencia SPEI', banco_id: bancoId, referencia: 'SPEI-1', corte: '2026-10-13',
      aplicaciones: [{ no_factura: f[0].no_factura, estacion_id: f[0].estacion_id, monto: a1 }, { no_factura: f[1].no_factura, estacion_id: f[1].estacion_id, monto: a2 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.ids.length, 2);
    const d = await detalle(); assert.ok(!d.abiertas.find((x) => x.no_factura === f[0].no_factura && x.estacion_id === f[0].estacion_id));
    assert.equal(d.pagos.filter((p) => p.referencia === 'SPEI-1').length, 2);
    const fd = await call('a', 'GET', '/api/factura?' + new URLSearchParams({
      k: cliPagos.k_cliente, est: f[0].estacion_id, no: f[0].no_factura,
    }));
    assert.ok(fd.data.pagos.some((p) => p.referencia === 'SPEI-1' && p.banco === 'BBVA'));
    assert.ok(Math.abs((dash.kpis.facturada - (await call('a', 'GET', '/api/dashboard?corte=2026-10-13')).data.kpis.facturada) - (a1 + a2)) < 0.01);
    for (const id of r.data.ids) await call('a', 'DELETE', '/api/pagos/' + id);
  });
  await t('estado de cuenta: incluye movimientos y filtra fechas con saldo inicial', async () => {
    const alta = await call('a', 'POST', '/api/clientes', { cliente: `Estado Cuenta ${process.pid}`, estacion_id: 1, limite: 0, dias: 0 });
    assert.equal(alta.status, 201, JSON.stringify(alta.data));
    const k = alta.data.k_cliente;
    const despacho = await call('a', 'POST', '/api/por-facturar', {
      k_cliente: k, importe: 75, fecha_despacho: '2026-10-20', despacho: 'DESPACHO-ESTADO-CTA',
    });
    assert.equal(despacho.status, 201, JSON.stringify(despacho.data));
    const factura = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: k, no_factura: 'FACTURA-ESTADO-CTA', importe: 250, fecha_factura: '2026-10-22',
    });
    assert.equal(factura.status, 201, JSON.stringify(factura.data));
    const recarga = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: k, tipo: 'ABONO', monto: 300, fecha: '2026-10-21', folio: 'RECARGA-ESTADO-CTA',
      banco_id: bancoId, metodo: 'Transferencia SPEI',
    });
    assert.equal(recarga.status, 201, JSON.stringify(recarga.data));
    const pago = await call('a', 'POST', '/api/pagos', {
      k_cliente: k, estacion_id: 1, no_factura: 'FACTURA-ESTADO-CTA', monto: 100, fecha: '2026-10-22', metodo: 'Efectivo',
    });
    assert.equal(pago.status, 201, JSON.stringify(pago.data));
    const consumo = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: k, tipo: 'CONSUMO', monto: 50, fecha: '2026-10-23', folio: 'CONSUMO-ESTADO-CTA',
    });
    assert.equal(consumo.status, 201, JSON.stringify(consumo.data));

    const ruta = '/api/cliente/estado-cuenta?k=' + enc(k);
    const completo = await call('a', 'GET', ruta);
    assert.equal(completo.status, 200);
    for (const movimiento of ['DESPACHO-ESTADO-CTA', 'FACTURA-ESTADO-CTA', 'Pago CxC', 'RECARGA-ESTADO-CTA', 'CONSUMO-ESTADO-CTA'])
      assert.ok(completo.data.includes(movimiento), `No aparece ${movimiento} en el CSV`);

    const periodo = await call('a', 'GET', ruta + '&desde=2026-10-22&hasta=2026-10-22');
    assert.equal(periodo.status, 200);
    assert.ok(periodo.data.includes('Saldo al inicio del período'));
    assert.ok(periodo.data.includes('FACTURA-ESTADO-CTA') && periodo.data.includes('Pago CxC'));
    assert.ok(!periodo.data.includes('DESPACHO-ESTADO-CTA') && !periodo.data.includes('RECARGA-ESTADO-CTA') && !periodo.data.includes('CONSUMO-ESTADO-CTA'));
    assert.equal((await call('a', 'GET', ruta + '&desde=2026-10-23&hasta=2026-10-22')).status, 400);
    assert.ok((await call('a', 'GET', '/api/bitacora')).data.rows.some((row) => row.accion === 'EXPORT' && row.detalle.includes(`estado_cuenta ${k}`)));

    await L.q.run('DELETE FROM pagos WHERE k_cliente=?', k);
    await L.q.run('DELETE FROM fact_cxc_app WHERE k_cliente=?', k);
    await L.q.run('DELETE FROM debito_app WHERE k_cliente=?', k);
    await L.q.run('DELETE FROM fact_cxc_app WHERE id=?', despacho.data.id);
    await L.q.run('DELETE FROM credito WHERE k_cliente=?', k);
    await L.q.run('DELETE FROM cliente_extra WHERE k_cliente=?', k);
    await L.q.run('DELETE FROM dim_cliente WHERE k_cliente=?', k);
  });
  await t('prepago CxC consume solo lo aplicado y conserva el remanente', async () => {
    const factura = (await detalle()).abiertas[0];
    const abono = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: cliPagos.k_cliente, tipo: 'ABONO', monto: 500, fecha: '2026-10-20', folio: 'PREPAGO-CXC-TEST',
      banco_id: bancoId, metodo: 'Transferencia SPEI',
    });
    assert.equal(abono.status, 201, JSON.stringify(abono.data));
    const basePago = { k_cliente: cliPagos.k_cliente, fecha: '2026-10-20', metodo: 'Prepago', monto: 150, desde_prepago: 150, corte: '2026-10-13' };
    const incompleto = await call('a', 'POST', '/api/pagos/lote', { ...basePago, aplicaciones: [{ no_factura: factura.no_factura, estacion_id: factura.estacion_id, monto: 100 }] });
    assert.equal(incompleto.status, 400);
    assert.equal((await call('a', 'GET', '/api/prepago/saldo?k=' + enc(cliPagos.k_cliente))).data.saldo_prepago, 500);
    const r = await call('a', 'POST', '/api/pagos/lote', { ...basePago, referencia: 'APLICA-PREPAGO', aplicaciones: [{ no_factura: factura.no_factura, estacion_id: factura.estacion_id, monto: 150 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.aplicado, 150);
    assert.equal(r.data.sin_aplicar, 0);
    assert.equal(r.data.prepago_saldo_anterior, 500);
    assert.equal(r.data.prepago_saldo_remanente, 350);
    assert.equal((await call('a', 'GET', '/api/prepago/saldo?k=' + enc(cliPagos.k_cliente))).data.saldo_prepago, 350);
    assert.ok(!(await call('a', 'GET', '/api/pagos?q=APLICA-PREPAGO')).data.rows.some((p) => p.sin_aplicar === 1));
    const bitacora = (await call('a', 'GET', '/api/bitacora')).data.rows.find((row) => row.accion === 'PAGO' && row.detalle.includes('prepago_aplicado:$150.00'));
    assert.ok(bitacora && bitacora.usuario === 'admin' && bitacora.detalle.includes('fecha:2026-10-20') && bitacora.detalle.includes('prepago_remanente:$350.00'));
    for (const id of r.data.ids) await call('a', 'DELETE', '/api/pagos/' + id);
    assert.equal((await call('a', 'DELETE', '/api/debito/movimientos/' + r.data.prepago_debito_id)).status, 200);
    assert.equal((await call('a', 'DELETE', '/api/debito/movimientos/' + abono.data.id)).status, 200);
  });

  // ---- debito prepago ----
  const favor = (await call('a', 'GET', '/api/debito?signo=favor')).data.rows[0];
  await t('débito: abono y consumo actualizan saldo, KPI y movimientos', async () => {
    const s0 = favor.saldo;
    const abono = { k_cliente: favor.k_cliente, tipo: 'ABONO', monto: 500, fecha: '2026-10-20', folio: 'TKT-1' };
    assert.equal((await call('a', 'POST', '/api/debito/movimientos', abono)).status, 400);
    assert.equal((await call('a', 'POST', '/api/debito/movimientos', { ...abono, banco_id: 999999 })).status, 400);
    assert.equal((await call('a', 'POST', '/api/debito/movimientos', { ...abono, banco_id: bancoId })).status, 400);
    assert.equal((await call('a', 'POST', '/api/debito/movimientos', { ...abono, banco_id: bancoId, metodo: 'Método inválido' })).status, 400);
    const a = await call('a', 'POST', '/api/debito/movimientos', { ...abono, banco_id: bancoId, metodo: 'Transferencia SPEI' });
    assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(Math.round(a.data.saldo_nuevo), Math.round(s0 + 500));
    const c = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: favor.k_cliente, tipo: 'CONSUMO', monto: 200, fecha: '2026-10-20', folio: 'TKT-2',
      banco_id: bancoId, metodo: 'Transferencia SPEI',
    });
    assert.equal(Math.round(c.data.saldo_nuevo), Math.round(s0 + 300));
    assert.equal(Math.round((await call('a', 'GET', '/api/dashboard')).data.kpis.saldo_a_favor), Math.round(dash.kpis.saldo_a_favor + 300));
    const mv = (await call('a', 'GET', '/api/debito/movimientos?k=' + enc(favor.k_cliente))).data.rows;
    assert.ok(mv.some((m) => m.folio === 'TKT-1' && m.origen === 'app' && m.metodo === 'Transferencia SPEI' && m.banco === 'BBVA'));
    assert.ok(mv.some((m) => m.folio === 'TKT-2' && m.origen === 'app' && m.metodo === 'Transferencia SPEI' && m.banco === 'BBVA'));
    const detalleDebito = (await call('a', 'GET', '/api/cliente?k=' + enc(favor.k_cliente))).data.debito;
    assert.ok(detalleDebito.some((m) => m.folio === 'TKT-1' && m.metodo === 'Transferencia SPEI' && m.banco === 'BBVA'));
    assert.ok(detalleDebito.some((m) => m.folio === 'TKT-2' && m.metodo === 'Transferencia SPEI' && m.banco === 'BBVA'));
    assert.equal((await call('a', 'DELETE', '/api/debito/movimientos/' + a.data.id)).status, 200);
    assert.equal((await call('a', 'DELETE', '/api/debito/movimientos/' + c.data.id)).status, 200);
    assert.equal(Math.round((await call('a', 'GET', '/api/debito?signo=favor')).data.rows.find((x) => x.k_cliente === favor.k_cliente).saldo), Math.round(s0));
  });
  await t('débito: consumo mayor al saldo avisa; validaciones', async () => {
    const r = await call('a', 'POST', '/api/debito/movimientos', { k_cliente: favor.k_cliente, tipo: 'CONSUMO', monto: favor.saldo + 1000, fecha: '2026-10-20', folio: 'X' });
    assert.equal(r.status, 201); assert.ok(r.data.advertencia); await call('a', 'DELETE', '/api/debito/movimientos/' + r.data.id);
    for (const b of [{ tipo: 'CONSUMO', monto: 0, fecha: '2026-10-20', folio: 'a' }, { tipo: 'OTRO', monto: 5, fecha: '2026-10-20', folio: 'a' }, { tipo: 'CONSUMO', monto: 5, fecha: '2026-10-20', folio: '' }, { tipo: 'CONSUMO', monto: 5, fecha: '2099-01-01', folio: 'a' }])
      assert.equal((await call('a', 'POST', '/api/debito/movimientos', { k_cliente: favor.k_cliente, ...b })).status, 400);
    assert.equal((await call('a', 'DELETE', '/api/debito/movimientos/5')).status, 404);
  });

  // ---- catalogo / credito / gestiones ----
  await t('catálogo: alta de cliente, duplicado, RFC inválido y crédito', async () => {
    const r = await call('a', 'POST', '/api/clientes', { cliente: 'Cliente Prueba SA', estacion_id: 1, no_cliente: 'P-1', rfc: 'abc010203xy1', limite: 50000, dias: 15, email: 'contacto@prueba.mx', telefono: '555-1234' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    let d = (await call('a', 'GET', '/api/cliente?k=' + enc(r.data.k_cliente))).data.cliente; assert.equal(d.limite, 50000); assert.equal(d.dias_credito, 15); assert.equal(d.rfc, 'ABC010203XY1');
    assert.equal(d.email, 'contacto@prueba.mx'); assert.equal(d.telefono, '555-1234');
    assert.equal((await call('a', 'POST', '/api/clientes', { cliente: 'Cliente Prueba SA', estacion_id: 1 })).status, 409);
    assert.equal((await call('a', 'POST', '/api/clientes', { cliente: 'Otro', estacion_id: 1, rfc: '123' })).status, 400);
    assert.equal((await call('a', 'POST', '/api/clientes', { cliente: 'Correo Inválido', estacion_id: 1, email: 'correo-mal' })).status, 400);
    const facturaCambioEstacion = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: r.data.k_cliente, no_factura: 'FACTURA-MOVIMIENTO-ESTACION', importe: 50, fecha_factura: '2026-10-20',
    });
    assert.equal(facturaCambioEstacion.status, 201, JSON.stringify(facturaCambioEstacion.data));
    assert.equal((await call('a', 'PUT', '/api/clientes', {
      k_cliente: r.data.k_cliente, cliente: 'Cliente Prueba SA Actualizado', estacion_id: 2, no_cliente: 'P-2',
      rfc: 'abc010203xy1', limite: 75000, dias: 18, email: 'actualizado@prueba.mx', telefono: '555-9876',
    })).status, 200);
    d = (await call('a', 'GET', '/api/cliente?k=' + enc(r.data.k_cliente))).data.cliente;
    assert.equal(d.cliente, 'Cliente Prueba SA Actualizado'); assert.equal(d.estacion_id, 2);
    assert.equal(d.limite, 75000); assert.equal(d.dias_credito, 18);
    assert.equal(d.email, 'actualizado@prueba.mx'); assert.equal(d.telefono, '555-9876');
    assert.equal((await call('a', 'GET', '/api/facturas?q=FACTURA-MOVIMIENTO-ESTACION&estado=todas')).data.rows[0].estacion_id, 2);
    assert.equal((await call('a', 'GET', '/api/clientes?estacion=2&q=Cliente Prueba SA Actualizado')).data.total, 1);
    assert.equal((await call('a', 'GET', '/api/clientes?q=ABC010203')).data.total, 1);
    assert.equal((await call('a', 'PUT', '/api/credito', { k_cliente: r.data.k_cliente, limite: 123456, dias: 21, rfc: '' })).status, 200);
    assert.equal((await call('a', 'GET', '/api/cliente?k=' + enc(r.data.k_cliente))).data.cliente.limite, 123456);
    assert.equal((await call('a', 'GET', '/api/cliente?k=' + enc(r.data.k_cliente))).data.cliente.email, 'actualizado@prueba.mx');
    assert.equal((await call('a', 'PUT', '/api/credito', { k_cliente: r.data.k_cliente, limite: -5, dias: 1 })).status, 400);
    await L.q.run('DELETE FROM fact_cxc_app WHERE id=?', facturaCambioEstacion.data.id);
  });
  await t('gestión con promesa genera alerta', async () => {
    assert.equal((await call('a', 'POST', '/api/gestiones', { k_cliente: cliPagos.k_cliente, tipo: 'Llamada', resultado: 'Promesa de pago', fecha: '2026-10-10', promesa_fecha: '2026-10-12', promesa_monto: 500, notas: 'prueba' })).status, 201);
    assert.ok((await call('a', 'GET', '/api/alertas?corte=2026-10-13')).data.promesas.length >= 1);
    assert.equal((await call('a', 'POST', '/api/gestiones', { k_cliente: cliPagos.k_cliente, tipo: 'Llamada', resultado: 'Promesa de pago' })).status, 400);
  });

  // ---- usuarios y permisos ----
  let temp, id;
  await t('crear gestor de estación; cambia su contraseña y entra', async () => {
    const r = await call('a', 'POST', '/api/usuarios', { usuario: 'gestor1', nombre: 'Gestor Uno', rol: 'gestor', estacion_id: 1 }); assert.equal(r.status, 201); temp = r.data.password_temporal; id = r.data.id;
    assert.equal((await call('a', 'POST', '/api/usuarios', { usuario: 'gestor1', nombre: 'x', rol: 'gestor' })).status, 409);
    assert.equal((await call('g', 'POST', '/api/login', { usuario: 'gestor1', password: temp })).status, 200);
    assert.equal((await call('g', 'GET', '/api/dashboard')).status, 403);
    assert.equal((await call('g', 'POST', '/api/cambiar-password', { actual: temp, nueva: 'Gestor2026x' })).status, 200);
    assert.equal((await call('g', 'GET', '/api/dashboard')).status, 200);
  });
  await t('gestor: opera solo en su estación y no administra usuarios ni carga', async () => {
    const d = (await call('g', 'GET', '/api/dashboard?corte=2026-10-13&estacion=2')).data; assert.equal(d.por_estacion.length, 1); assert.equal(d.por_estacion[0].id, 1);
    assert.ok((await call('g', 'GET', '/api/clientes?size=200')).data.rows.every((c) => c.estacion_id === 1));
    assert.ok((await call('g', 'GET', '/api/clientes-lista')).data.rows.every((c) => c.estacion_id === 1));
    const otro = (await call('a', 'GET', '/api/clientes?estacion=2&size=10')).data.rows[0];
    assert.equal((await call('g', 'GET', '/api/cliente?k=' + enc(otro.k_cliente))).status, 403);
    assert.equal((await call('g', 'PUT', '/api/clientes', { k_cliente: otro.k_cliente, cliente: otro.cliente, estacion_id: 1, limite: 1, dias: 1 })).status, 403);
    assert.equal((await call('g', 'POST', '/api/debito/movimientos', { k_cliente: otro.k_cliente, tipo: 'ABONO', monto: 1, fecha: '2026-10-20', folio: 'z' })).status, 403);
    assert.equal((await call('g', 'POST', '/api/cartera/facturas', { k_cliente: otro.k_cliente, no_factura: 'FUERA-ESTACION', importe: 1, fecha_factura: '2026-10-20' })).status, 403);
    assert.equal((await call('g', 'PUT', '/api/credito', { k_cliente: otro.k_cliente, limite: 1, dias: 1 })).status, 403);
    const nuevo = await call('g', 'POST', '/api/clientes', { cliente: 'Cliente del gestor', estacion_id: 2, limite: 0, dias: 0 }); assert.equal(nuevo.status, 201); assert.ok(nuevo.data.k_cliente.startsWith((await call('a', 'GET', '/api/catalogos')).data.estaciones.find((e) => e.id === 1).nombre));
    assert.equal((await call('g', 'GET', '/api/usuarios')).status, 403);
    assert.equal((await call('g', 'POST', '/api/bancos', { nombre: 'Banco No Autorizado' })).status, 403);
    assert.equal((await call('g', 'POST', '/api/metodos-pago', { nombre: 'Método No Autorizado' })).status, 403);
    assert.ok((await call('g', 'GET', '/api/metodos-pago')).data.rows.length > 0);
    assert.equal((await call('g', 'POST', '/api/carga', null, Buffer.from('PK'))).status, 403);
  });
  await t('rol consulta: solo lectura', async () => {
    const r = await call('a', 'POST', '/api/usuarios', { usuario: 'lector', nombre: 'Lector', rol: 'consulta' }); const tp = r.data.password_temporal;
    await call('l', 'POST', '/api/login', { usuario: 'lector', password: tp }); await call('l', 'POST', '/api/cambiar-password', { actual: tp, nueva: 'Lector2026x' });
    assert.equal((await call('l', 'GET', '/api/dashboard')).status, 200);
    assert.equal((await call('l', 'POST', '/api/pagos', { k_cliente: cliPagos.k_cliente })).status, 403);
    assert.equal((await call('l', 'POST', '/api/debito/movimientos', { k_cliente: cliPagos.k_cliente })).status, 403);
    assert.equal((await call('l', 'POST', '/api/clientes', { cliente: 'x' })).status, 403);
    assert.equal((await call('l', 'PUT', '/api/bancos/1', { nombre: 'Banco No Autorizado' })).status, 403);
  });
  await t('supervisor: permisos específicos y asignación múltiple de estaciones', async () => {
    const relaciones = await L.q.all('PRAGMA foreign_key_list(usuario_estaciones)');
    assert.ok(relaciones.some((relacion) => relacion.table === 'usuarios' && relacion.from === 'usuario_id'));
    assert.ok(relaciones.some((relacion) => relacion.table === 'dim_estacion' && relacion.from === 'estacion_id'));
    const estaciones = (await call('a', 'GET', '/api/catalogos')).data.estaciones.map((station) => station.id);
    assert.ok(estaciones.length >= 2, 'Se requieren dos estaciones para probar la asignación múltiple');
    await assert.rejects(L.q.run('INSERT INTO usuario_estaciones(usuario_id, estacion_id) VALUES (?, ?)', 2147483647, estaciones[0]));
    const asignadas = estaciones.slice(0, 2);
    const supervisorAlta = await call('a', 'POST', '/api/usuarios', {
      usuario: 'supervisor1', nombre: 'Supervisor Uno', rol: 'supervisor',
      todas_estaciones: false, estaciones: asignadas,
    });
    assert.equal(supervisorAlta.status, 201, JSON.stringify(supervisorAlta.data));
    const relacionesAlta = await L.q.all('SELECT estacion_id FROM usuario_estaciones WHERE usuario_id=? ORDER BY estacion_id', supervisorAlta.data.id);
    assert.deepEqual(relacionesAlta.map((relacion) => relacion.estacion_id), [...asignadas].sort((a, b) => a - b));
    const supervisor = (await call('a', 'GET', '/api/usuarios')).data.rows.find((row) => row.usuario === 'supervisor1');
    assert.deepEqual(supervisor.estaciones.map((station) => station.id), asignadas);
    assert.equal((await call('a', 'PUT', '/api/usuarios/' + supervisor.id, {
      rol: 'supervisor', activo: true, todas_estaciones: false, estaciones: [asignadas[1], asignadas[0]],
    })).status, 200);
    const relacionesEditadas = await L.q.all('SELECT estacion_id FROM usuario_estaciones WHERE usuario_id=? ORDER BY estacion_id', supervisor.id);
    assert.deepEqual(relacionesEditadas.map((relacion) => relacion.estacion_id), [...asignadas].sort((a, b) => a - b));
    const editado = (await call('a', 'GET', '/api/usuarios')).data.rows.find((row) => row.id === supervisor.id);
    assert.deepEqual(editado.estaciones.map((station) => station.id), asignadas);
    assert.equal((await call('a', 'POST', '/api/usuarios', {
      usuario: 'supervisorvacio', nombre: 'Supervisor Inválido', rol: 'supervisor',
      todas_estaciones: false, estaciones: [],
    })).status, 400);
    assert.equal((await call('a', 'POST', '/api/usuarios', {
      usuario: 'supervisorinvalido', nombre: 'Supervisor Inválido', rol: 'supervisor',
      todas_estaciones: false, estaciones: [asignadas[0], -1],
    })).status, 400);
    const all = await call('a', 'POST', '/api/usuarios', {
      usuario: 'supervisorall', nombre: 'Supervisor Todas', rol: 'supervisor', todas_estaciones: true, estaciones: [],
    });
    assert.equal(all.status, 201, JSON.stringify(all.data));
    const allListed = (await call('a', 'GET', '/api/usuarios')).data.rows.find((row) => row.usuario === 'supervisorall');
    assert.deepEqual(allListed.estaciones, []);

    const login = await call('s', 'POST', '/api/login', { usuario: 'supervisor1', password: supervisorAlta.data.password_temporal });
    assert.equal(login.status, 200);
    assert.equal((await call('s', 'POST', '/api/cambiar-password', {
      actual: supervisorAlta.data.password_temporal, nueva: 'Supervisor2026x',
    })).status, 200);
    const profile = (await call('s', 'GET', '/api/me')).data;
    for (const permission of ['anular_prepago', 'editar_despacho', 'anular_pago']) assert.ok(profile.permisos.includes(permission));
    for (const permission of ['pagos', 'debito', 'facturas', 'usuarios']) assert.ok(!profile.permisos.includes(permission));
    assert.equal((await call('s', 'GET', '/api/usuarios')).status, 403);
    assert.equal((await call('s', 'POST', '/api/pagos', { k_cliente: cliPagos.k_cliente })).status, 403);
    assert.equal((await call('s', 'POST', '/api/debito/movimientos', { k_cliente: cliPagos.k_cliente })).status, 403);

    const k = (await call('a', 'POST', '/api/clientes', {
      cliente: `Cliente Supervisor ${process.pid}`, estacion_id: asignadas[0], limite: 0, dias: 0,
    })).data.k_cliente;
    const pendiente = await call('a', 'POST', '/api/por-facturar', {
      k_cliente: k, importe: 80, fecha_despacho: '2026-10-25', despacho: `DESP-SUP-${process.pid}`,
    });
    assert.equal(pendiente.status, 201, JSON.stringify(pendiente.data));
    const edicionDespacho = await call('s', 'PUT', '/api/por-facturar/' + (2000000000 + pendiente.data.id), {
      fecha_despacho: '2026-10-26', despacho: `DESP-SUP-${process.pid}`, grupo: 'SUPERVISOR', monto: 95,
    });
    assert.equal(edicionDespacho.status, 200, JSON.stringify(edicionDespacho.data));

    const abono = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: k, tipo: 'ABONO', monto: 100, fecha: '2026-10-25', folio: `ABONO-SUP-${process.pid}`, metodo: 'Efectivo',
    });
    assert.equal(abono.status, 201, JSON.stringify(abono.data));
    assert.equal((await call('s', 'DELETE', '/api/debito/movimientos/' + abono.data.id)).status, 200);
    const consumo = await call('a', 'POST', '/api/debito/movimientos', {
      k_cliente: k, tipo: 'CONSUMO', monto: 20, fecha: '2026-10-25', folio: `CONSUMO-SUP-${process.pid}`,
    });
    assert.equal(consumo.status, 201, JSON.stringify(consumo.data));
    assert.equal((await call('s', 'DELETE', '/api/debito/movimientos/' + consumo.data.id)).status, 403);

    const factura = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: k, no_factura: `FAC-SUP-${process.pid}`, importe: 200, fecha_factura: '2026-10-25',
    });
    assert.equal(factura.status, 201, JSON.stringify(factura.data));
    const pago = await call('a', 'POST', '/api/pagos', {
      k_cliente: k, estacion_id: asignadas[0], no_factura: factura.data.no_factura,
      monto: 50, fecha: '2026-10-26', metodo: 'Efectivo',
    });
    assert.equal(pago.status, 201, JSON.stringify(pago.data));
    assert.equal((await call('s', 'DELETE', '/api/pagos/' + pago.data.ids[0])).status, 200);
    const bitacora = (await call('a', 'GET', '/api/bitacora')).data.rows;
    assert.ok(bitacora.some((row) => row.usuario === 'supervisor1' && row.accion === 'DEBITO_ANULADO'));
    assert.ok(bitacora.some((row) => row.usuario === 'supervisor1' && row.accion === 'PAGO_ANULADO'));
    assert.ok(bitacora.some((row) => row.usuario === 'supervisor1' && row.accion === 'DESPACHO_EDITA'));
    const estacionesNoAsignadas = estaciones.filter((stationId) => !asignadas.includes(stationId));
    if (estacionesNoAsignadas.length) {
      const otro = (await call('a', 'POST', '/api/clientes', {
        cliente: `Cliente Supervisor Fuera ${process.pid}`, estacion_id: estacionesNoAsignadas[0], limite: 0, dias: 0,
      }));
      const fuera = await call('a', 'POST', '/api/por-facturar', {
        k_cliente: otro.data.k_cliente, importe: 15, fecha_despacho: '2026-10-25', despacho: `DESP-FUERA-${process.pid}`,
      });
      assert.equal((await call('s', 'PUT', '/api/por-facturar/' + (2000000000 + fuera.data.id), {
        fecha_despacho: '2026-10-26', despacho: `DESP-FUERA-${process.pid}`, grupo: '', monto: 20,
      })).status, 403);
    }
  });
  await t('desactivar usuario cierra su sesión; no se puede dejar sin admin', async () => {
    assert.equal((await call('a', 'PUT', '/api/usuarios/' + id, { activo: false })).status, 200);
    assert.equal((await call('g', 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call('a', 'PUT', '/api/usuarios/' + (await call('a', 'GET', '/api/me')).data.id, { rol: 'consulta' })).status, 400);
  });
  await t('bloqueo tras 5 intentos fallidos', async () => {
    await call('a', 'POST', '/api/usuarios', { usuario: 'bloqueo', nombre: 'B', rol: 'consulta' });
    for (let i = 0; i < 5; i++) await call('b', 'POST', '/api/login', { usuario: 'bloqueo', password: 'x' });
    assert.equal((await call('b', 'POST', '/api/login', { usuario: 'bloqueo', password: 'x' })).status, 429);
  });
  await t('estáticos y ruta segura', async () => {
    assert.equal((await call('x', 'GET', '/')).status, 200);
    assert.equal((await call('x', 'GET', '/..%2f..%2fetc/passwd')).status, 404);
    assert.equal((await call('x', 'GET', '/server/lib.js')).status, 404);
  });

  // ---- carga de Excel (ejecuta el ETL real de Python) ----
  await t('carga: rechaza archivos no Excel', async () => assert.equal((await call('a', 'POST', '/api/carga', null, Buffer.from('esto no es un excel'))).status, 400));
  await t('por facturar: protege la carga y rechaza archivos con firma inválida', async () => {
    assert.equal((await call('x', 'POST', '/api/por-facturar/carga', null, Buffer.from('no es xlsx'))).status, 401);
    assert.equal((await call('a', 'POST', '/api/por-facturar/carga', null, Buffer.from('no es xlsx'))).status, 400);
  });
  if (process.env.POR_FACTURAR_XLSX && fs.existsSync(process.env.POR_FACTURAR_XLSX)) {
    await t('por facturar: importa Layout Consumo en la copia temporal', async () => {
      const antes = (await call('a', 'GET', '/api/por-facturar')).data;
      const maxId = (await L.q.get('SELECT COALESCE(MAX(id),0) id FROM fact_cxc_app')).id;
      const r = await call('a', 'POST', '/api/por-facturar/carga', null, fs.readFileSync(process.env.POR_FACTURAR_XLSX));
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.importados, 12);
      assert.ok(Math.abs(r.data.total - 8078.09) < 0.01);
      const despues = (await call('a', 'GET', '/api/por-facturar')).data;
      assert.equal(despues.total_despachos, antes.total_despachos + 12);
      assert.ok(Math.abs(despues.total_monto - antes.total_monto - 8078.09) < 0.01);
      assert.ok((await call('a', 'GET', '/api/bitacora')).data.rows.some((row) => row.accion === 'POR_FACTURAR_CARGA' && row.usuario === 'admin'));
      const nuevos = await L.q.all('SELECT id FROM fact_cxc_app WHERE id>?', maxId);
      assert.equal(nuevos.length, 12);
      await L.q.run('DELETE FROM fact_cxc_app WHERE id>?', maxId);
    });
  }
  await t('carga: valida modo y módulos parciales', async () => {
    assert.equal((await call('a', 'POST', '/api/carga?modo=otro', null, Buffer.from('PK'))).status, 400);
    assert.equal((await call('a', 'POST', '/api/carga?modo=parcial', null, Buffer.from('PK'))).status, 400);
    assert.equal((await call('a', 'POST', '/api/carga?modo=parcial&modulos=desconocido', null, Buffer.from('PK'))).status, 400);
  });
  if (fs.existsSync(XLSX)) {
    await t('carga parcial de Excel: reemplaza módulos y conserva pagos, débito, clientes, crédito y usuarios', async () => {
      // dejamos datos de la app: pago, movimiento de débito y crédito editado
      const f = (await detalle()).abiertas[0];
      await call('a', 'POST', '/api/pagos', { k_cliente: cliPagos.k_cliente, estacion_id: f.estacion_id, no_factura: f.no_factura, monto: 50, fecha: '2026-10-20', metodo: 'Efectivo', corte: '2026-10-13' });
      await call('a', 'POST', '/api/debito/movimientos', { k_cliente: favor.k_cliente, tipo: 'ABONO', monto: 777, fecha: '2026-10-20', folio: 'KEEP', banco_id: bancoId, metodo: 'Efectivo' });
      const facturaPreservada = await call('a', 'POST', '/api/cartera/facturas', {
        k_cliente: cliPagos.k_cliente, no_factura: 'KEEP-FACTURA', importe: 777, fecha_factura: '2026-10-12', fecha_vencimiento: '2026-10-30',
      });
      assert.equal(facturaPreservada.status, 201);
      const antes = (await call('a', 'GET', '/api/dashboard?corte=2026-10-13')).data.kpis;
      const r = await call('a', 'POST', '/api/carga?modo=parcial&modulos=clientes_credito,cxc,debito', null, fs.readFileSync(XLSX));
      assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.resumen.startsWith('OK'));
      testBackup = path.join(__dirname, '..', 'respaldos', r.data.respaldo);
      const d = (await call('a', 'GET', '/api/dashboard?corte=2026-10-13')).data.kpis;
      assert.equal(Math.round(d.facturada), 10045656 + 777);                 // pago conciliado; factura manual conservada
      assert.equal((await call('a', 'GET', '/api/facturas?q=KEEP-FACTURA&estado=todas')).data.rows[0].saldo, 777);
      assert.equal(Math.round(d.saldo_a_favor), Math.round(dash.kpis.saldo_a_favor));  // el abono conciliado ya no suma doble
      assert.ok(antes.facturada < d.facturada);
      const pagos = (await call('a', 'GET', '/api/pagos')).data.rows; assert.ok(pagos.length > 0 && pagos.every((p) => p.conciliado === 1));
      assert.equal((await call('a', 'GET', '/api/clientes-lista')).data.rows.length, 332);   // 330 + 2 clientes creados en la app
      assert.equal((await call('a', 'GET', '/api/cliente?k=' + enc((await call('a', 'GET', '/api/clientes?q=Cliente Prueba')).data.rows[0].k_cliente))).data.cliente.limite, 123456);
      assert.ok((await call('a', 'GET', '/api/usuarios')).data.rows.length >= 4);
      assert.equal((await call('a', 'GET', '/api/catalogos')).data.estaciones.length, 2);
      await L.q.run('DELETE FROM fact_cxc_app WHERE id=?', facturaPreservada.data.id);
    });
  }

  await t('facturas manuales: cálculo por días de crédito, guardado y validaciones', async () => {
    const body = { no_factura: 'PRUEBA-MANUAL-EXIST', importe: 123.45, fecha_factura: '2026-10-20' };
    const existente = await call('a', 'POST', '/api/cartera/facturas', { ...body, k_cliente: cliPagos.k_cliente });
    assert.equal(existente.status, 201, JSON.stringify(existente.data));
    const datosExistente = (await call('a', 'GET', '/api/cliente?k=' + enc(cliPagos.k_cliente))).data.cliente;
    const vencimientoExistente = new Date('2026-10-20T00:00:00Z');
    vencimientoExistente.setUTCDate(vencimientoExistente.getUTCDate() + datosExistente.dias_credito);
    assert.equal(existente.data.fecha_vencimiento, vencimientoExistente.toISOString().slice(0, 10));
    const facExistente = (await call('a', 'GET', '/api/facturas?q=PRUEBA-MANUAL-EXIST&estado=todas')).data.rows[0];
    assert.equal(facExistente.importe, 123.45); assert.equal(facExistente.saldo, 123.45);
    assert.equal(facExistente.fecha_vencimiento, existente.data.fecha_vencimiento);
    assert.equal((await call('a', 'GET', '/api/cartera/facturas/' + existente.data.id)).status, 200);
    const edicion = await call('a', 'PUT', '/api/cartera/facturas/' + existente.data.id, {
      no_factura: 'PRUEBA-MANUAL-EDIT', importe: 150, fecha_factura: '2026-10-21',
    });
    assert.equal(edicion.status, 200, JSON.stringify(edicion.data));
    const lecturaEditada = await call('a', 'GET', '/api/cartera/facturas/' + existente.data.id);
    assert.equal(lecturaEditada.data.no_factura, 'PRUEBA-MANUAL-EDIT', JSON.stringify(lecturaEditada.data));
    const consultaEditada = await call('a', 'GET', '/api/facturas?q=PRUEBA-MANUAL-EDIT&estado=todas');
    assert.ok(consultaEditada.data.rows.length, JSON.stringify(consultaEditada));
    const facEditada = consultaEditada.data.rows[0];
    assert.equal(facEditada.importe, 150);
    assert.equal(facEditada.fecha_vencimiento, edicion.data.fecha_vencimiento);
    const nueva = await call('a', 'POST', '/api/clientes', {
      cliente: 'Cliente Recalculo Vencimiento', estacion_id: 1, no_cliente: 'V-TEST', limite: 5000, dias: 15,
    });
    assert.equal(nueva.status, 201, JSON.stringify(nueva.data));
    const facturaRecalculo = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: nueva.data.k_cliente, no_factura: 'FACTURA-RECALCULO', importe: 200, fecha_factura: '2026-10-20',
    });
    assert.equal(facturaRecalculo.status, 201, JSON.stringify(facturaRecalculo.data));
    const consultaAntesRecalculo = await call('a', 'GET', '/api/facturas?k=' + enc(nueva.data.k_cliente) + '&estado=todas&corte=2026-11-10');
    assert.equal(consultaAntesRecalculo.data.rows[0].fecha_vencimiento, '2026-11-04');
    assert.equal(consultaAntesRecalculo.data.rows[0].dias_vencido, 6);
    const cambioDias = await call('a', 'PUT', '/api/credito', { k_cliente: nueva.data.k_cliente, limite: 5000, dias: 30 });
    assert.equal(cambioDias.status, 200, JSON.stringify(cambioDias.data));
    const consultaDespuesRecalculo = await call('a', 'GET', '/api/facturas?k=' + enc(nueva.data.k_cliente) + '&estado=todas&corte=2026-11-10');
    assert.equal(consultaDespuesRecalculo.data.rows[0].fecha_vencimiento, '2026-11-19');
    assert.equal(consultaDespuesRecalculo.data.rows[0].dias_vencido, -9);
    assert.equal(consultaDespuesRecalculo.data.rows[0].estado, 'POR VENCER');
    const detalleRecalculo = await call('a', 'GET', '/api/factura?k=' + enc(nueva.data.k_cliente) + '&est=1&no=FACTURA-RECALCULO&corte=2026-11-10');
    assert.equal(detalleRecalculo.data.factura.fecha_vencimiento, '2026-11-19');
    assert.equal(detalleRecalculo.data.despachos[0].fecha_vencimiento, '2026-11-19');
    assert.equal((await call('l', 'PUT', '/api/cartera/facturas/' + existente.data.id, {
      no_factura: 'NO-AUTORIZADA', importe: 150, fecha_factura: '2026-10-21',
    })).status, 403);
    assert.equal((await call('a', 'POST', '/api/cartera/facturas', {
      ...body, no_factura: 'PRUEBA-MANUAL-EDIT', k_cliente: cliPagos.k_cliente,
    })).status, 409);
    assert.equal((await call('a', 'PUT', '/api/cartera/facturas/' + existente.data.id, {
      no_factura: 'PRUEBA-MANUAL-EDIT', importe: 0, fecha_factura: '2026-10-21',
    })).status, 400);
    assert.equal((await call('a', 'POST', '/api/cartera/facturas', { ...body, k_cliente: cliPagos.k_cliente, fecha_factura: '2099-01-01' })).status, 400);
    const pagoManual = await call('a', 'POST', '/api/pagos', {
      k_cliente: cliPagos.k_cliente, estacion_id: facExistente.estacion_id, no_factura: 'PRUEBA-MANUAL-EDIT',
      monto: 23.45, fecha: '2026-10-20', metodo: 'Efectivo',
    });
    assert.equal(pagoManual.status, 201);
    assert.equal((await call('a', 'GET', '/api/facturas?q=PRUEBA-MANUAL-EDIT&estado=todas')).data.rows[0].saldo, 126.55);
    assert.equal((await call('a', 'PUT', '/api/cartera/facturas/' + existente.data.id, {
      no_factura: 'PRUEBA-MANUAL-EDIT', importe: 20, fecha_factura: '2026-10-21',
    })).status, 400);
    assert.equal((await call('a', 'PUT', '/api/cartera/facturas/' + existente.data.id, {
      no_factura: 'CAMBIO-CON-PAGO', importe: 150, fecha_factura: '2026-10-21',
    })).status, 400);

    const altaCliente = await call('a', 'POST', '/api/clientes', {
      cliente: 'Cliente Factura Manual', estacion_id: 1, no_cliente: 'F-TEST', limite: 5000, dias: 15,
    });
    assert.equal(altaCliente.status, 201, JSON.stringify(altaCliente.data));
    const pendiente1 = await call('a', 'POST', '/api/por-facturar', {
      k_cliente: altaCliente.data.k_cliente, importe: 80.25, fecha_despacho: '2026-10-22', despacho: 'DESPACHO-1',
    });
    const pendiente2 = await call('a', 'POST', '/api/por-facturar', {
      k_cliente: altaCliente.data.k_cliente, importe: 120, fecha_despacho: '2026-10-23', despacho: 'DESPACHO-2',
    });
    assert.equal(pendiente1.status, 201, JSON.stringify(pendiente1.data));
    assert.equal(pendiente2.status, 201, JSON.stringify(pendiente2.data));
    const listaPendientes = await call('a', 'GET', '/api/por-facturar?k=' + enc(altaCliente.data.k_cliente));
    assert.equal(listaPendientes.data.rows[0].despachos, 2);
    assert.equal(listaPendientes.data.rows[0].items.length, 2);
    const despachoEditar = listaPendientes.data.rows[0].items.find((item) => item.origen === 'app' && item.despacho === 'DESPACHO-1');
    const cambiosDespacho = { fecha_despacho: '2026-10-24', despacho: 'DESPACHO-EDITADO', grupo: 'GRUPO-EDITADO', monto: 95.25 };
    assert.equal((await call('l', 'PUT', '/api/por-facturar/' + despachoEditar.id, cambiosDespacho)).status, 403);
    assert.equal((await call('a', 'PUT', '/api/por-facturar/' + despachoEditar.id, {
      ...cambiosDespacho, despacho: 'DESPACHO-2',
    })).status, 409);
    assert.equal((await call('a', 'PUT', '/api/por-facturar/' + despachoEditar.id, {
      ...cambiosDespacho, fecha_despacho: '2099-01-01',
    })).status, 400);
    const editDespachoResp = await call('a', 'PUT', '/api/por-facturar/' + despachoEditar.id, cambiosDespacho);
    assert.equal(editDespachoResp.status, 200, JSON.stringify(editDespachoResp.data));
    const listaEditada = await call('a', 'GET', '/api/por-facturar?k=' + enc(altaCliente.data.k_cliente));
    const despachoEditado = listaEditada.data.rows[0].items.find((item) => item.id === despachoEditar.id);
    assert.equal(despachoEditado.fecha_despacho, cambiosDespacho.fecha_despacho);
    assert.equal(despachoEditado.despacho, cambiosDespacho.despacho);
    assert.equal(despachoEditado.grupo, cambiosDespacho.grupo);
    assert.equal(despachoEditado.monto, cambiosDespacho.monto);
    const idDespachoExcel = 1900000000 + (process.pid % 10000000);
    await L.q.run(`INSERT INTO fact_cxc(id,fecha_despacho,despacho,importe,abono,k_cliente,estacion_id,estatus,grupo)
      VALUES (?,?,?,?,?,?,?,?,?)`, idDespachoExcel, '2026-10-25', 'DESPACHO-EXCEL', 37, 5,
    altaCliente.data.k_cliente, 1, 'POR FACTURAR', 'GRUPO-EXCEL');
    try {
      const excelEdit = await call('a', 'PUT', '/api/por-facturar/' + idDespachoExcel, {
        fecha_despacho: '2026-10-26', despacho: 'DESPACHO-EXCEL-EDITADO', grupo: 'GRUPO-EXCEL-EDITADO', monto: 42,
      });
      assert.equal(excelEdit.status, 200, JSON.stringify(excelEdit.data));
      assert.equal(excelEdit.data.importe, 47);
      assert.equal((await L.q.get('SELECT importe,abono FROM fact_cxc WHERE id=?', idDespachoExcel)).importe, 47);
      const audit = await L.q.get("SELECT detalle FROM bitacora WHERE accion='DESPACHO_EDITA' AND detalle LIKE ?", `%#${idDespachoExcel}%`);
      assert.ok(audit && audit.detalle.includes('DESPACHO-EXCEL-EDITADO'));
    } finally { await L.q.run('DELETE FROM fact_cxc WHERE id=?', idDespachoExcel); }
    const sinSeleccion = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: altaCliente.data.k_cliente, no_factura: 'SIN-SELECCION', fecha_factura: '2026-10-27', facturar_por_facturar: true, ids: [],
    });
    assert.equal(sinSeleccion.status, 400);
    const despachoFacturado = await call('a', 'POST', '/api/cartera/facturas', {
      k_cliente: altaCliente.data.k_cliente, no_factura: 'FACTURA-SELECCION', fecha_factura: '2026-10-27',
      facturar_por_facturar: true, ids: [despachoEditar.id],
    });
    assert.equal(despachoFacturado.status, 201, JSON.stringify(despachoFacturado.data));
    assert.equal(despachoFacturado.data.importe, 95.25);
    assert.equal(despachoFacturado.data.actualizados, 1);
    const restante = await call('a', 'GET', '/api/por-facturar?k=' + enc(altaCliente.data.k_cliente));
    assert.equal(restante.data.rows[0].despachos, 1);
    assert.equal(restante.data.rows[0].monto, 120);
    assert.equal(restante.data.rows[0].items[0].despacho, 'DESPACHO-2');
    assert.ok((await call('a', 'GET', '/api/facturas?q=FACTURA-SELECCION&estado=todas')).data.rows.length);
    const nuevo = await call('a', 'POST', '/api/cartera/facturas', {
      ...body, no_factura: 'PRUEBA-MANUAL-NUEVO', k_cliente: altaCliente.data.k_cliente,
    });
    assert.equal(nuevo.status, 201, JSON.stringify(nuevo.data));
    assert.equal(nuevo.data.fecha_vencimiento, '2026-11-04');
    const clienteNuevo = (await call('a', 'GET', '/api/cliente?k=' + enc(altaCliente.data.k_cliente))).data;
    assert.equal(clienteNuevo.cliente.saldo_total, 123.45 + 95.25 + 120);
    assert.equal((await call('l', 'POST', '/api/cartera/facturas', { ...body, k_cliente: cliPagos.k_cliente })).status, 403);
    for (const id of [existente.data.id, nuevo.data.id, pendiente1.data.id, pendiente2.data.id, facturaRecalculo.data.id]) await L.q.run('DELETE FROM fact_cxc_app WHERE id=?', id);
    await L.q.run('DELETE FROM pagos WHERE no_factura=? AND k_cliente=?', 'PRUEBA-MANUAL-EDIT', cliPagos.k_cliente);
    await L.q.run('DELETE FROM cliente_extra WHERE k_cliente=?', nueva.data.k_cliente);
    await L.q.run('DELETE FROM credito WHERE k_cliente=?', nueva.data.k_cliente);
    await L.q.run('DELETE FROM dim_cliente WHERE k_cliente=?', nueva.data.k_cliente);
    await L.q.run('DELETE FROM cliente_extra WHERE k_cliente=?', altaCliente.data.k_cliente);
    await L.q.run('DELETE FROM credito WHERE k_cliente=?', altaCliente.data.k_cliente);
    await L.q.run('DELETE FROM dim_cliente WHERE k_cliente=?', altaCliente.data.k_cliente);
  });

  console.log(`\n${ok} pruebas correctas${process.exitCode ? ' (con fallas)' : ''}`);
  await new Promise((resolve) => server.close(resolve));
  await L.client.close();
  const archivosTemporales = ['', '-wal', '-shm', ...(testBackup ? [testBackup] : [])]
    .map((s) => s === '' || s === '-wal' || s === '-shm' ? tmp + s : s);
  if (process.platform === 'win32') {
    const cleanup = `const fs=require('node:fs');const parent=${process.pid};const files=${JSON.stringify(archivosTemporales)};function remove(){try{process.kill(parent,0);setTimeout(remove,100);return}catch{}for(const file of files)fs.rmSync(file,{force:true})}remove()`;
    const child = spawn(process.execPath, ['-e', cleanup], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } else {
    for (const file of archivosTemporales) fs.rmSync(file, { force: true });
  }
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
