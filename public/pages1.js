'use strict';
/* Cartera Activa (facturas), Catálogos de clientes, ficha de cliente, modales de factura/pago/crédito */
(() => {
  const { html, money, int, pct, fdate, fmes, corto, badge, diasCell, S, api, gp, can, toast, modal, closeModal,
    setView, loading, errorView, thSort, pager, bindFilters, opt, trendSVG, useBar, PALETA, qs, store, $, hoyLocal, clientePicker } = CG;

  const kpiMini = (l, v, s, cls = '') => html`<div class="kpi mini ${cls}"><span class="l">${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;

  // =============== CARTERA ACTIVA ===============
  const facDefault = () => ({ q: '', estado: 'abiertas', rango: '', campo: 'factura', anio: '', mes: '', desde: '', hasta: '', sort: 'saldo', dir: 'desc', page: 1, k: '' });
  CG.routes.cartera = async (args, query, keep) => {
    let clientes = [];
    if (can('facturas')) {
      try { clientes = await CG.clientesLista(false); } catch (e) { return errorView(e); }
    }
    const clientePick = clientePicker('fact-cliente', clientes, { placeholder: 'Escribe para buscar cliente…' });
    const st = { ...facDefault(), ...store.get('fac', {}) };
    if (!keep && query.estado) Object.assign(st, facDefault(), { estado: query.estado });
    if (!keep && query.k) Object.assign(st, facDefault(), { k: query.k, estado: 'abiertas' });
    const cat = S.cat;
    const d = (await S.dashP) || {};
    const maxA = Math.max(1, ...(d.aging || []).map((a) => a.monto));
    const load = async () => {
      store.set('fac', st);
      $('#tbl').innerHTML = '<div class="empty">Cargando…</div>';
      try {
        const r = await api('/api/facturas?' + qs(gp({ q: st.q, estado: st.estado, rango: st.rango, campo: st.campo, anio: st.anio, mes: st.mes, desde: st.desde, hasta: st.hasta, sort: st.sort, dir: st.dir, page: st.page, k: st.k })));
        $('#tbl').innerHTML = html`
          <div class="tablewrap"><table><thead><tr>
            ${thSort('Cliente', 'cliente', st)}<th>Estación</th>${thSort('Factura', 'factura', st)}${thSort('F. factura', 'fecha_factura', st)}${thSort('Vencimiento', 'vencimiento', st)}
            ${thSort('Días vencido', 'dias', st, 'n')}<th>Estado</th>${thSort('Importe', 'importe', st, 'n')}${thSort('Saldo', 'saldo', st, 'n')}<th></th></tr></thead>
            <tbody>${r.rows.length ? r.rows.map((f) => html`<tr class="click" data-act="factura" data-k="${f.k_cliente}" data-est="${f.estacion_id}" data-no="${f.no_factura}">
              <td class="wrap">${f.cliente}</td><td>${corto(f.estacion)}</td><td>${f.no_factura}</td><td>${fdate(f.fecha_factura)}</td><td>${fdate(f.fecha_vencimiento)}</td>
              <td class="n">${f.saldo > 0.005 ? diasCell(f.dias_vencido) : ''}</td><td>${badge(f.estado)}</td><td class="n">${money(f.importe)}</td><td class="n strong">${money(f.saldo)}</td>
              <td>${can('pagos') && f.saldo > 0.005 ? html`<button class="btn small" data-act="pago" data-k="${f.k_cliente}" data-est="${f.estacion_id}" data-no="${f.no_factura}">Pago</button>` : ''}</td></tr>`)
              : html`<tr><td colspan="10" class="empty">No hay facturas con estos filtros.</td></tr>`}</tbody>
            <tfoot><tr><td colspan="7">Totales de la selección</td><td class="n">${money(r.suma_importe)}</td><td class="n">${money(r.suma_saldo)}</td><td></td></tr></tfoot></table></div>
          ${pager(st, r.total, r.size)}`.s;
      } catch (e) { $('#tbl').innerHTML = html`<div class="note">${e.message}</div>`.s; }
    };
    setView(html`
      <div class="h"><h2>Cuentas por Cobrar</h2><p>Listado de facturas por cobrar al ${fdate(S.corte)}. Haz clic en un rango de antigüedad para filtrarlo.</p></div>
      ${can('facturas') ? html`<form id="formNuevaFactura" class="formcard" style="margin-bottom:20px">
        <h3>Registrar factura o saldo nuevo</h3>
        <div class="grid g3">
          <label>Cliente${clientePick.html}</label>
          <label>Factura<input name="no_factura" maxlength="80" required></label>
          <label>Importe ($)<input name="importe" type="number" min="0.01" max="1000000000" step="0.01" required></label>
          <label>Fecha de factura<input name="fecha_factura" type="date" max="${hoyLocal()}" value="${hoyLocal()}" required></label>
        </div>
        <div class="mut" id="factVencimiento" style="margin-top:8px">Selecciona cliente y fecha de factura para calcular el vencimiento según sus días de crédito.</div>
        <div class="err" id="facturaErr" style="margin-top:8px"></div>
        <button class="btn dark" type="submit" style="margin-top:12px">Guardar factura y saldo</button>
      </form>` : ''}
      <div class="grid g2" style="margin-bottom:20px">
        <div class="card"><h3>Antigüedad de saldos <small>importe y no. de facturas</small></h3>
          ${(d.aging || []).map((a, i) => html`<div class="hbar" data-act="rango" data-rango="${a.rango}" title="Filtrar facturas de este rango">
            <span>${a.rango}</span><span class="t"><span class="f" style="width:${(a.monto / maxA) * 100}%;background:${PALETA[i]}"></span></span>
            <span class="a">${money(a.monto)} <small>${int(a.facturas)}</small></span></div>`)}</div>
        <div class="card"><h3>Facturado vs cobrado <small>últimos 12 meses</small></h3>
          <div class="legend"><span><i style="background:#12239E"></i>Facturado</span><span><i style="background:#14B8A6"></i>Cobrado</span></div>
          ${d.tendencia ? trendSVG(d.tendencia) : ''}</div>
      </div>
      <div class="bar" id="filtros">
        <label>Buscar cliente o factura<input data-f="q" value="${st.q}" placeholder="Nombre o folio…" style="min-width:230px"></label>
        <label>Estado<select data-f="estado">${opt('abiertas', 'Abiertas (con saldo)', st.estado)}${opt('vencidas', 'Vencidas', st.estado)}${opt('porvencer', 'Por vencer', st.estado)}${opt('pagadas', 'Pagadas', st.estado)}${opt('todas', 'Todas', st.estado)}</select></label>
        <label>Rango de días<select data-f="rango"><option value="">Todos</option>${cat.rangos.map((r) => opt(r, r, st.rango))}</select></label>
        <label>Fecha por<select data-f="campo">${opt('factura', 'Facturación', st.campo)}${opt('vencimiento', 'Vencimiento', st.campo)}${opt('despacho', 'Despacho', st.campo)}</select></label>
        <label>Año<select data-f="anio"><option value="">Todos</option>${cat.anios.map((a) => opt(a, a, st.anio))}</select></label>
        <label>Mes<select data-f="mes"><option value="">Todos</option>${cat.meses.map((m, i) => opt(i + 1, m, st.mes))}</select></label>
        <label>Desde<input type="date" data-f="desde" value="${st.desde}"></label>
        <label>Hasta<input type="date" data-f="hasta" value="${st.hasta}"></label>
        <span class="sp"></span>
        ${st.k ? html`<button class="btn small" data-act="quitarCliente">Cliente filtrado ✕</button>` : ''}
        <button class="btn small" data-act="limpiarFac">Limpiar</button>
        ${can('export') ? html`<button class="btn dark" data-act="exportFac">⬇ CSV</button>` : ''}
      </div><div id="tbl"></div>`);
    const formFactura = $('#formNuevaFactura');
    if (formFactura) {
      const pickerInput = $('#fact-cliente');
      const fechaInput = formFactura.elements.namedItem('fecha_factura');
      const actualizarVencimiento = () => {
        const cliente = clientePick.resolver();
        const fecha = fechaInput.value;
        if (!cliente || !fecha) {
          $('#factVencimiento').textContent = 'Selecciona cliente y fecha de factura para calcular el vencimiento según sus días de crédito.';
          return;
        }
        const vencimiento = new Date(`${fecha}T00:00:00`);
        vencimiento.setDate(vencimiento.getDate() + cliente.dias_credito);
        const iso = `${vencimiento.getFullYear()}-${String(vencimiento.getMonth() + 1).padStart(2, '0')}-${String(vencimiento.getDate()).padStart(2, '0')}`;
        $('#factVencimiento').textContent = `Crédito: ${cliente.dias_credito} días · Vencimiento calculado: ${fdate(iso)}`;
      };
      pickerInput.addEventListener('input', actualizarVencimiento);
      pickerInput.addEventListener('change', actualizarVencimiento);
      fechaInput.addEventListener('change', actualizarVencimiento);
      formFactura.onsubmit = async (e) => {
        e.preventDefault();
        $('#facturaErr').textContent = '';
        const data = Object.fromEntries(new FormData(formFactura));
        const cliente = clientePick.resolver();
        if (!cliente) { $('#facturaErr').textContent = 'Selecciona un cliente de la lista.'; return; }
        const payload = { k_cliente: cliente.k_cliente, no_factura: data.no_factura, importe: data.importe, fecha_factura: data.fecha_factura };
        const btn = formFactura.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const result = await api('/api/cartera/facturas', { method: 'POST', body: payload });
          toast(`Factura registrada. Vence el ${fdate(result.fecha_vencimiento)}.`);
          formFactura.reset();
          actualizarVencimiento();
          await CG.refreshKpis();
          await CG.route(true);
        } catch (er) { $('#facturaErr').textContent = er.message; }
        finally { btn.disabled = false; }
      };
    }
    bindFilters($('#filtros'), st, load);
    $('#view').onclick = (e) => {
      const th = e.target.closest('th[data-sort]'); const pg = e.target.closest('[data-page]');
      if (th) { const k = th.dataset.sort; st.dir = st.sort === k && st.dir === 'desc' ? 'asc' : 'desc'; st.sort = k; st.page = 1; load(); }
      else if (pg && !pg.disabled) { st.page = Number(pg.dataset.page); load(); }
    };
    CG.acts.rango = (el) => { store.set('fac', { ...facDefault(), estado: 'abiertas', rango: el.dataset.rango }); if (location.hash.includes('?')) location.hash = '#/cartera'; else CG.route(true); };
    CG.acts.limpiarFac = () => { store.set('fac', facDefault()); if (location.hash.includes('?')) location.hash = '#/cartera'; else CG.route(true); };
    CG.acts.quitarCliente = () => { store.set('fac', { ...st, k: '', page: 1 }); if (location.hash.includes('?')) location.hash = '#/cartera'; else CG.route(true); };
    CG.acts.exportFac = () => { location.href = '/api/facturas?' + qs(gp({ q: st.q, estado: st.estado, rango: st.rango, campo: st.campo, anio: st.anio, mes: st.mes, desde: st.desde, hasta: st.hasta, sort: st.sort, dir: st.dir, k: st.k, formato: 'csv' })); };
    load();
  };

  // ---- detalle de factura ----
  CG.acts.factura = async (el) => {
    try {
      const d = await api('/api/factura?' + qs({ k: el.dataset.k, est: el.dataset.est, no: el.dataset.no, corte: S.corte }));
      const f = d.factura;
      modal(html`
        <h2>Factura ${f.no_factura} ${badge(f.estado)}</h2>
        <dl class="kv" style="margin-bottom:12px">
          <dt>Cliente</dt><dd><a href="#/cliente/${encodeURIComponent(f.k_cliente)}" data-act="cerrar">${f.cliente}</a></dd>
          <dt>Estación</dt><dd>${f.estacion}</dd>
          <dt>Factura / vencimiento</dt><dd>${fdate(f.fecha_factura) || '—'} / ${fdate(f.fecha_vencimiento) || '—'} ${f.saldo > 0.005 && f.fecha_vencimiento ? html`· ${diasCell(f.dias_vencido)} (${f.rango})` : ''}</dd>
          <dt>Importe / abonos Excel / pagos capturados</dt><dd>${money(f.importe, 2)} / ${money(f.abono, 2)} / ${money(f.pagos_app, 2)}</dd>
          <dt>Saldo pendiente</dt><dd class="${f.saldo > 0.005 ? 'neg' : 'pos'}">${money(f.saldo, 2)}</dd>
        </dl>
        ${can('facturas') && f.editable && f.app_id ? html`<div style="margin-bottom:12px">
          <button class="btn" data-act="editarFactura" data-id="${f.app_id}">Editar factura capturada</button></div>` : ''}
        ${can('pagos') && f.saldo > 0.005 ? html`<div style="margin-bottom:12px"><button class="btn accent" data-act="pago" data-k="${f.k_cliente}" data-est="${f.estacion_id}" data-no="${f.no_factura}">Registrar pago</button>
          <a class="btn" href="#/pagos?k=${encodeURIComponent(f.k_cliente)}" data-act="cerrar">Aplicar un cargo a varias facturas (FIFO)</a></div>` : ''}
        <h3 style="font-size:14px;margin:6px 0">Pagos capturados en la aplicación</h3>
        ${d.pagos.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Fecha</th><th>Método</th><th>Banco</th><th>Referencia</th><th class="n">Monto</th><th>Registró</th><th></th></tr></thead><tbody>
          ${d.pagos.map((p) => html`<tr><td>${fdate(p.fecha)}</td><td>${p.metodo}</td><td>${p.banco || ''}</td><td>${p.referencia}</td><td class="n">${money(p.monto, 2)}</td><td>${p.usuario}</td>
            <td>${p.anulado ? badge('Cerrada') : p.conciliado ? html`<span class="badge b-mut">Conciliado</span>` : (can('pagos') || can('anular_pago')) ? html`<button class="btn small danger" data-act="anularPago" data-id="${p.id}">Anular</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="mut">Sin pagos capturados.</div>`}
        <h3 style="font-size:14px;margin:14px 0 6px">Despachos incluidos (${d.despachos.length})</h3>
        <div class="tablewrap" style="max-height:300px"><table><thead><tr><th>Fecha</th><th>Despacho</th><th>Grupo</th><th>Estatus</th><th class="n">Importe</th><th class="n">Abono</th><th>Fecha pago</th></tr></thead><tbody>
          ${d.despachos.map((x) => html`<tr><td>${fdate(x.fecha_despacho)}</td><td>${x.despacho}</td><td>${x.grupo}</td><td>${x.estatus}</td><td class="n">${money(x.importe, 2)}</td><td class="n">${money(x.abono, 2)}</td><td>${fdate(x.fecha_pago)}</td></tr>`)}</tbody></table></div>
        <div class="actions"><button class="btn" data-act="cerrar">Cerrar</button></div>`, { wide: true });
    } catch (e) { toast(e.message, true); }
  };
  CG.acts.editarFactura = async (el) => {
    const id = Number(el.dataset.id);
    if (!Number.isSafeInteger(id) || id <= 0) { toast('Identificador de factura inválido', 'bad'); return; }
    try {
      const factura = await api('/api/cartera/facturas/' + id);
      modal(html`
        <h2>Editar factura ${factura.no_factura}</h2>
        <div class="note info" style="margin:10px 0">El vencimiento se recalcula con los días de crédito actuales del cliente. El importe no puede quedar por debajo de sus abonos y pagos.</div>
        <form id="formEditarFactura" class="form">
          <label>Número de factura<input name="no_factura" maxlength="80" value="${factura.no_factura}" required></label>
          <label>Importe ($)<input name="importe" type="number" min="0.01" max="1000000000" step="0.01" value="${factura.importe}" required></label>
          <label class="full">Fecha de factura<input name="fecha_factura" type="date" max="${hoyLocal()}" value="${factura.fecha_factura}" required></label>
          <div class="full err" id="editarFacturaErr"></div>
          <div class="full actions"><button type="button" class="btn" data-act="cerrar">Cancelar</button><button type="submit" class="btn dark">Guardar cambios</button></div>
        </form>`);
      $('#formEditarFactura').onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        $('#editarFacturaErr').textContent = '';
        try {
          const cambios = Object.fromEntries(new FormData(form));
          const r = await api('/api/cartera/facturas/' + id, { method: 'PUT', body: cambios });
          toast(`Factura actualizada. Vence el ${fdate(r.fecha_vencimiento)}.`);
          closeModal();
          await CG.refreshKpis();
          await CG.route(true);
        } catch (error) { $('#editarFacturaErr').textContent = error.message; }
        finally { btn.disabled = false; }
      };
    } catch (error) { toast(error.message, 'bad'); }
  };
  CG.acts.anularPago = async (el) => {
    if (!confirm('¿Anular este pago? El saldo de la factura se restablecerá.')) return;
    try { await api('/api/pagos/' + el.dataset.id, { method: 'DELETE' }); toast('Pago anulado'); closeModal(); CG.route(true); } catch (e) { toast(e.message, 'bad'); }
  };

  // ---- pago rapido a una factura ----
  CG.acts.pago = async (el, ev) => {
    ev.stopPropagation();
    try {
      const [d, prepData] = await Promise.all([
        api('/api/factura?' + qs({ k: el.dataset.k, est: el.dataset.est, no: el.dataset.no, corte: S.corte })),
        api('/api/prepago/saldo?' + qs({ k: el.dataset.k })).catch(() => ({ saldo_prepago: 0 })),
      ]);
      const f = d.factura;
      const saldoPrepago = prepData.saldo_prepago || 0;
      const tienePrepago = saldoPrepago > 0.005;
      modal(html`
        <h2>Registrar pago</h2>
        <div class="note info" style="margin-bottom:12px"><b>${f.cliente}</b> · Factura ${f.no_factura} · Saldo pendiente <b>${money(f.saldo, 2)}</b></div>
        <form id="formPago" class="form">
          <label id="pago-monto-wrap">Monto a abonar (MXN)<input name="monto" type="number" step="0.01" min="0.01" max="${f.saldo}" value="${f.saldo}" required></label>
          <label>Fecha de pago<input name="fecha" type="date" max="${hoyLocal()}" value="${hoyLocal()}" required></label>
          <label id="pago-metodo-wrap">Método<select name="metodo" id="pago-metodo" required><option value="">Selecciona un método…</option>${S.cat.metodos_pago.map((m) => opt(m.nombre, m.nombre))}</select></label>
          <label id="pago-banco-wrap" style="display:none">Banco<select name="banco_id" id="pago-banco"><option value="">Selecciona un banco…</option>${S.cat.bancos.map((b) => opt(b.id, b.nombre))}</select></label>
          <label>Referencia / rastreo<input name="referencia" maxlength="80"></label>
          <label class="full">Notas<textarea name="notas" rows="2" maxlength="300"></textarea></label>
          <div class="full" id="pago-prepago-wrap" style="border:1px solid ${tienePrepago ? '#14B8A6' : '#D1D5DB'};border-radius:8px;padding:10px 12px;background:${tienePrepago ? 'rgba(20,184,166,.12)' : '#F8FAFC'}">
            <label class="inline-check" style="font-weight:600;color:${tienePrepago ? 'var(--oktext)' : 'var(--txt)'}">
              <input type="checkbox" id="pago-usar-prepago" ${tienePrepago ? '' : 'disabled'}> Aplicar a saldo de prepago
            </label>
            ${tienePrepago
              ? html`<div style="margin-top:6px;font-size:13px;color:var(--oktext)">Saldo disponible: <b>${money(saldoPrepago, 2)}</b></div>
                     <div id="pago-prepago-monto-wrap" style="margin-top:8px;display:none">
                       <label style="font-size:13px">Monto a aplicar desde prepago (MXN)<input id="pago-prepago-monto" name="desde_prepago" type="number" step="0.01" min="0.01" max="${Math.min(saldoPrepago, f.saldo)}" value="${Math.min(saldoPrepago, f.saldo).toFixed(2)}" style="width:160px"></label>
                     </div>`
              : html`<div style="margin-top:4px;font-size:12px;color:var(--mut)">Cliente sin saldo de prepago</div>`}
          </div>
          <div class="full err" id="pagoErr" role="alert" aria-live="assertive"></div>
          <div class="full actions"><button type="button" class="btn" data-act="cerrar">Cancelar</button><button class="btn accent" type="submit">Aplicar pago</button></div>
        </form>`);
      const camposNormales = () => {
        const usandoPrepago = tienePrepago && $('#pago-usar-prepago').checked;
        ['#pago-monto-wrap', '#pago-metodo-wrap', '#pago-banco-wrap'].forEach((id) => {
          const el = $(id); if (el) el.style.display = usandoPrepago ? 'none' : '';
        });
        if (!usandoPrepago) {
          const metodoVal = ($('#pago-metodo').value || '').trim();
          const requiere = /^(cheque|tarjeta|transferencia)(?:\s|$)/i.test(metodoVal);
          $('#pago-banco-wrap').style.display = requiere ? '' : 'none';
          $('#pago-banco').required = requiere;
          if (!requiere) $('#pago-banco').value = '';
        } else {
          $('#pago-banco-wrap').style.display = 'none';
          $('#pago-banco').required = false;
          $('#pago-banco').value = '';
        }
        const montoInp = document.querySelector('[name=monto]');
        if (montoInp) montoInp.required = !usandoPrepago;
        const metodoSel = $('#pago-metodo');
        if (metodoSel) metodoSel.required = !usandoPrepago;
      };
      $('#pago-metodo').addEventListener('change', camposNormales);
      camposNormales();
      const validarMontoPago = () => {
        const usandoPrepago = tienePrepago && $('#pago-usar-prepago').checked;
        const monto = Number(usandoPrepago ? $('#pago-prepago-monto').value : $('#formPago').elements.monto.value);
        const limite = usandoPrepago ? saldoPrepago : f.saldo;
        const err = monto > f.saldo + 0.005
          ? `No se puede exceder la deuda actual (${money(f.saldo, 2)}).`
          : usandoPrepago && monto > saldoPrepago + 0.005
            ? `El monto excede el saldo de prepago disponible (${money(saldoPrepago, 2)}).`
            : '';
        $('#pagoErr').textContent = err;
        $('#formPago').querySelector('[type="submit"]').disabled = Boolean(err) || !(monto > 0) || monto > limite + 0.005;
        return !err && monto > 0 && monto <= limite + 0.005;
      };
      $('#formPago').elements.monto.addEventListener('input', validarMontoPago);
      if (tienePrepago) {
        $('#pago-usar-prepago').addEventListener('change', (ev2) => {
          const wrap = $('#pago-prepago-monto-wrap');
          const inp = $('#pago-prepago-monto');
          if (ev2.target.checked) {
            wrap.style.display = '';
            inp.required = true;
          } else {
            wrap.style.display = 'none';
            inp.required = false;
            inp.value = '';
          }
          camposNormales();
          validarMontoPago();
        });
        $('#pago-prepago-monto').addEventListener('input', validarMontoPago);
      }
      validarMontoPago();
      $('#formPago').onsubmit = async (e) => {
        e.preventDefault();
        if (!validarMontoPago()) return;
        const fd = Object.fromEntries(new FormData(e.target));
        const usarPrepago = tienePrepago && $('#pago-usar-prepago').checked;
        const montoPrep = usarPrepago ? Number(fd.desde_prepago || 0) : 0;
        if (usarPrepago && !(montoPrep > 0)) { $('#pagoErr').textContent = 'Indica un monto de prepago mayor a cero.'; return; }
        if (usarPrepago && montoPrep > saldoPrepago + 0.005) { $('#pagoErr').textContent = `El monto excede el saldo de prepago disponible (${money(saldoPrepago, 2)})`; return; }
        const body = { ...fd, k_cliente: f.k_cliente, estacion_id: f.estacion_id, no_factura: f.no_factura, corte: S.corte };
        if (usarPrepago) {
          // Al usar prepago: el monto es el del prepago, método interno
          body.monto = montoPrep;
          body.metodo = 'Prepago';
          body.banco_id = '';
          delete body.desde_prepago; // ya se envía como desde_prepago en el body real
          body.desde_prepago = montoPrep;
        } else {
          delete body.desde_prepago;
        }
        try {
          const res2 = await api('/api/pagos', { method: 'POST', body });
          const msgPrep = usarPrepago ? ` — Prepago aplicado: ${money(montoPrep, 2)}` : '';
          toast('Pago registrado' + msgPrep);
          closeModal();
          CG.route(true);
        } catch (er) { $('#pagoErr').textContent = er.message; }
      };
    } catch (e) { toast(e.message, 'bad'); }
  };

  // =============== CATÁLOGOS (clientes) ===============
  const cliDefault = () => ({ q: '', filtro: '', sort: 'cliente', dir: 'asc', page: 1 });
  CG.routes.catalogos = async ([vista] = []) => {
    const soloClientes = vista === 'clientes';
    const st = { ...cliDefault(), ...store.get('cli', {}) };
    const load = async () => {
      store.set('cli', st);
      $('#tbl').innerHTML = '<div class="empty">Cargando…</div>';
      try {
        const r = await api('/api/clientes?' + qs(gp({ ...st })));
        $('#tbl').innerHTML = html`
          <div class="tablewrap"><table><thead><tr>${thSort('No. cliente', 'no', st)}${thSort('Nombre', 'cliente', st)}<th>Estación</th><th>Correo electrónico</th><th>Teléfono</th>${thSort('Límite crédito', 'limite', st, 'n')}<th class="n">Días crédito</th>
            ${thSort('Saldo CxC', 'saldo', st, 'n')}${thSort('Vencido', 'vencido', st, 'n')}${thSort('Uso del límite', 'uso', st)}${thSort('Saldo prepago (Débito)', 'favor', st, 'n')}<th>Riesgo</th><th></th></tr></thead>
            <tbody>${r.rows.length ? r.rows.map((c) => html`<tr class="click" data-go="#/cliente/${encodeURIComponent(c.k_cliente)}"><td class="mut">${c.no_cliente || 'N/A'}</td>
              <td class="wrap"><b>${c.cliente}</b>${c.rfc ? html`<br><small class="mut">RFC: ${c.rfc}</small>` : ''}</td><td>${corto(c.estacion)}</td>
              <td class="wrap">${c.email || ''}</td><td>${c.telefono || ''}</td>
              <td class="n">${money(c.limite)}</td><td class="n">${c.dias_credito}</td><td class="n strong">${money(c.saldo_total)}</td><td class="n ${c.vencido > 0 ? 'neg' : ''}">${money(c.vencido)}</td>
              <td>${useBar(c.uso)}</td><td class="n ${c.saldo_favor > 0 ? 'pos strong' : c.saldo_favor < 0 ? 'neg' : ''}">${c.saldo_favor ? money(c.saldo_favor) : ''}</td>
              <td>${c.saldo_total > 0.005 || c.limite > 0 ? badge(c.riesgo) : ''}</td>
              <td>${can('clientes') ? html`<button class="btn small" data-act="editCliente" data-k="${c.k_cliente}" data-est="${c.estacion_id}" data-lim="${c.limite}" data-dias="${c.dias_credito}" data-rfc="${c.rfc || ''}" data-email="${c.email || ''}" data-telefono="${c.telefono || ''}" data-no="${c.no_cliente || ''}" data-nombre="${c.cliente}">Editar</button>` : ''}</td></tr>`)
              : html`<tr><td colspan="13" class="empty">Sin clientes para este filtro.</td></tr>`}</tbody>
            <tfoot><tr><td colspan="7">Totales de la selección</td><td class="n">${money(r.suma_saldo)}</td><td class="n">${money(r.suma_vencido)}</td><td colspan="4"></td></tr></tfoot></table></div>
          ${pager(st, r.total, r.size)}`.s;
      } catch (e) { $('#tbl').innerHTML = html`<div class="note">${e.message}</div>`.s; }
    };
    const estOpts = S.cat.estaciones;
    setView(html`
      <div class="h"><h2>${soloClientes ? 'Catálogo de clientes' : 'Gestión de catálogos'}</h2><p>${soloClientes ? 'Administra clientes, crédito y consulta sus saldos unificados de CxC y débito.' : 'Administra bancos y métodos de pago compartidos por los módulos financieros.'}</p></div>
      ${!soloClientes ? html`
      <div class="card" style="margin-bottom:18px"><h3>Catálogo de bancos</h3>
        ${can('usuarios') ? html`<form id="formBanco" class="inline-form" style="margin-bottom:12px">
          <label style="flex:1;min-width:220px">Nombre del banco<input name="nombre" maxlength="80" required></label>
          <button class="btn dark" type="submit">+ Agregar banco</button><div class="err" id="bancoErr" style="flex-basis:100%"></div></form>` : ''}
        <div class="tablewrap nomax"><table><thead><tr><th>Banco</th><th></th></tr></thead><tbody>
          ${S.cat.bancos.length ? S.cat.bancos.map((b) => html`<tr><td>${b.nombre}</td><td>${can('usuarios') ? html`<button class="btn small" data-act="editBanco" data-id="${b.id}" data-nombre="${b.nombre}">Editar</button> <button class="btn small danger" data-act="deleteBanco" data-id="${b.id}" data-nombre="${b.nombre}">Eliminar</button>` : ''}</td></tr>`) : html`<tr><td colspan="2" class="empty">No hay bancos registrados.</td></tr>`}
        </tbody></table></div>
      </div>
      <div class="card" style="margin-bottom:18px"><h3>Catálogo de métodos de pago</h3>
        <p class="mut">Los métodos se comparten entre Aplicación de Pagos y los abonos de Débito. La exigencia de banco aplica a pagos CxC; los abonos de Débito siempre solicitan banco.</p>
        ${can('usuarios') ? html`<form id="formMetodoPago" class="inline-form" style="margin-bottom:12px">
          <label style="flex:1;min-width:220px">Nombre del método<input name="nombre" maxlength="40" required></label>
          <label class="inline-check"><input name="requiere_banco" type="checkbox" value="1"> Requiere banco en pagos CxC</label>
          <button class="btn dark" type="submit">+ Agregar método</button><div class="err" id="metodoPagoErr" style="flex-basis:100%"></div></form>` : ''}
        <div class="tablewrap nomax"><table><thead><tr><th>Método de pago</th><th>Banco requerido en pagos CxC</th><th></th></tr></thead><tbody>
          ${S.cat.metodos_pago.length ? S.cat.metodos_pago.map((m) => html`<tr><td>${m.nombre}</td><td>${m.requiere_banco ? 'Sí' : 'No'}</td><td>${can('usuarios') ? html`<button class="btn small" data-act="editMetodoPago" data-id="${m.id}" data-nombre="${m.nombre}" data-requiere="${m.requiere_banco ? '1' : '0'}">Editar</button> <button class="btn small danger" data-act="deleteMetodoPago" data-id="${m.id}" data-nombre="${m.nombre}">Eliminar</button>` : ''}</td></tr>`) : html`<tr><td colspan="3" class="empty">No hay métodos de pago registrados.</td></tr>`}
        </tbody></table></div>
      </div>
      ` : ''}
      ${soloClientes ? html`<div class="h"><h3>Clientes</h3></div>
      ${can('clientes') ? html`<form id="formCli" class="inline-form">
        <label style="flex:1;min-width:220px">Nombre del cliente *<input name="cliente" required maxlength="150"></label>
        <label>Estación *<select name="estacion_id" ${S.user.estaciones && S.user.estaciones.length === 1 ? 'disabled' : ''}>${estOpts.map((e) => opt(e.id, corto(e.nombre), S.est || ''))}</select></label>
        <label style="width:120px">No. cliente<input name="no_cliente" maxlength="30"></label>
        <label style="width:150px">RFC<input name="rfc" maxlength="13" style="text-transform:uppercase"></label>
        <label style="width:130px">Límite ($)<input name="limite" type="number" min="0" step="0.01" placeholder="0.00"></label>
        <label style="width:110px">Días crédito<input name="dias" type="number" min="0" max="365" step="1" placeholder="15"></label>
        <label style="width:190px">Correo electrónico<input name="email" type="email" maxlength="254"></label>
        <label style="width:150px">Teléfono<input name="telefono" type="tel" maxlength="40"></label>
        <button class="btn dark" type="submit">+ Agregar cliente</button>
        <div class="err" id="cliErr" style="flex-basis:100%"></div></form>` : ''}
      <div class="bar" id="filtros">
        <label>Buscar<input data-f="q" value="${st.q}" placeholder="Nombre, número o RFC…" style="min-width:240px"></label>
        <label>Mostrar<select data-f="filtro">${opt('', 'Todos', st.filtro)}${opt('saldo', 'Con saldo pendiente', st.filtro)}${opt('vencido', 'Con saldo vencido', st.filtro)}${opt('excedido', 'Sobre su límite', st.filtro)}${opt('sinlimite', 'Con saldo y sin límite', st.filtro)}${opt('favor', 'Con saldo a favor', st.filtro)}</select></label>
        <span class="sp"></span>${can('export') ? html`<button class="btn dark" data-act="exportCli">⬇ CSV</button>` : ''}</div><div id="tbl"></div>`
      : ''}`);
    if (soloClientes) {
      bindFilters($('#filtros'), st, load);
      $('#view').onclick = (e) => {
        const th = e.target.closest('th[data-sort]'); const pg = e.target.closest('[data-page]');
        if (th) { const k = th.dataset.sort; st.dir = st.sort === k && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = k; st.page = 1; load(); }
        else if (pg && !pg.disabled) { st.page = Number(pg.dataset.page); load(); }
      };
    }
    CG.acts.exportCli = () => { location.href = '/api/clientes?' + qs(gp({ ...st, formato: 'csv' })); };
    const fc = $('#formCli');
    if (fc) fc.onsubmit = async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(fc)); const ids = Array.isArray(S.user.estaciones) ? S.user.estaciones : []; if (ids.length === 1) b.estacion_id = ids[0];
      const btn = fc.querySelector('button'); btn.disabled = true;
      try { await api('/api/clientes', { method: 'POST', body: b }); toast('Cliente guardado correctamente'); S.clientes = null; fc.reset(); $('#cliErr').textContent = ''; load(); }
      catch (er) { $('#cliErr').textContent = er.message; } finally { btn.disabled = false; }
    };
    const fb = $('#formBanco');
    if (fb) fb.onsubmit = async (e) => {
      e.preventDefault();
      $('#bancoErr').textContent = '';
      try {
        await api('/api/bancos', { method: 'POST', body: Object.fromEntries(new FormData(fb)) });
        toast('Banco agregado'); await CG.loadCatalogos(); CG.route(true);
      } catch (er) { $('#bancoErr').textContent = er.message; }
    };
    const fm = $('#formMetodoPago');
    if (fm) fm.onsubmit = async (e) => {
      e.preventDefault();
      $('#metodoPagoErr').textContent = '';
      try {
        await api('/api/metodos-pago', { method: 'POST', body: Object.fromEntries(new FormData(fm)) });
        toast('Método de pago agregado'); await CG.loadCatalogos(); CG.route(true);
      } catch (er) { $('#metodoPagoErr').textContent = er.message; }
    };
    if (soloClientes) load();
  };
  CG.routes.clientes = () => CG.routes.catalogos(['clientes']);

  // =============== FICHA DE CLIENTE ===============
  let cliTab = 'abiertas', lastK = '';
  CG.routes.cliente = async ([k], query, keepTab) => {
    k = decodeURIComponent(k); if (!keepTab && k !== lastK) cliTab = 'abiertas'; lastK = k;
    loading();
    let d;
    try { d = await api('/api/cliente?' + qs({ k, corte: S.corte })); } catch (e) { return errorView(e); }
    const c = d.cliente, maxA = Math.max(1, ...d.aging.map((a) => a.monto));
    const tab = (id, label, n) => html`<button class="${cliTab === id ? 'on' : ''}" data-tab="${id}">${label}${n != null ? html` <span class="badge b-mut">${n}</span>` : ''}</button>`;
    const body = {
      abiertas: () => d.abiertas.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Factura</th><th>F. factura</th><th>Vencimiento</th><th class="n">Días</th><th>Estado</th><th class="n">Importe</th><th class="n">Saldo</th><th></th></tr></thead><tbody>
        ${d.abiertas.map((f) => html`<tr class="click" data-act="factura" data-k="${c.k_cliente}" data-est="${f.estacion_id}" data-no="${f.no_factura}"><td>${f.no_factura}</td><td>${fdate(f.fecha_factura)}</td><td>${fdate(f.fecha_vencimiento)}</td>
          <td class="n">${diasCell(f.dias_vencido)}</td><td>${badge(f.estado)}</td><td class="n">${money(f.importe)}</td><td class="n strong">${money(f.saldo)}</td>
          <td>${can('pagos') ? html`<button class="btn small" data-act="pago" data-k="${c.k_cliente}" data-est="${f.estacion_id}" data-no="${f.no_factura}">Pago</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Sin facturas abiertas.</div>`,
      porfacturar: () => d.por_facturar.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Fecha despacho</th><th>Despacho</th><th>Grupo</th><th class="n">Días</th><th class="n">Importe</th></tr></thead><tbody>
        ${d.por_facturar.map((x) => html`<tr><td>${fdate(x.fecha_despacho)}</td><td>${x.despacho}</td><td>${x.grupo}</td><td class="n">${x.dias}</td><td class="n">${money(x.importe - x.abono, 2)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Sin despachos por facturar.</div>`,
      debito: () => html`<div class="grid g3" style="margin-bottom:12px">
          <div class="kpi mini k-green"><span class="l">Abonos (recargas)</span><span class="v">${money(d.debito_resumen.recargas)}</span></div>
          <div class="kpi mini"><span class="l">Consumos</span><span class="v">${money(d.debito_resumen.consumos)}</span></div>
          <div class="kpi mini ${d.debito_resumen.saldo < 0 ? 'k-red' : 'k-green'}"><span class="l">Saldo de débito</span><span class="v">${money(d.debito_resumen.saldo)}</span></div></div>
        ${d.debito.length ? html`<div class="tablewrap" style="max-height:380px"><table><thead><tr><th>Fecha</th><th>Folio</th><th>Operación</th><th>Método</th><th>Banco</th><th>Grupo</th><th class="n">Abono</th><th class="n">Consumo</th></tr></thead><tbody>
        ${d.debito.map((x) => html`<tr><td>${fdate(x.fecha)}</td><td>${x.folio}</td><td>${badge(x.tipo)}</td><td>${x.metodo || ''}</td><td>${x.banco || ''}</td><td>${x.grupo}</td><td class="n">${x.abono ? money(x.abono, 2) : ''}</td><td class="n">${x.importe ? money(x.importe, 2) : ''}</td></tr>`)}</tbody></table></div>
        <div class="mut" style="margin-top:6px">Se muestran los últimos 200 movimientos.</div>` : html`<div class="empty">Sin movimientos de débito.</div>`}`,
      gestiones: () => html`${can('gestiones') ? html`<form id="formGest" class="card soft form" style="margin-bottom:12px">
          <label>Tipo<select name="tipo"><option>Llamada</option><option>WhatsApp</option><option>Correo</option><option>Visita</option><option>Otro</option></select></label>
          <label>Resultado<select name="resultado" id="gRes"><option>Contactado</option><option>Sin respuesta</option><option>Promesa de pago</option><option>Disputa</option><option>Otro</option></select></label>
          <label>Fecha<input type="date" name="fecha" value="${hoyLocal()}"></label>
          <label class="prom hidden">Fecha promesa<input type="date" name="promesa_fecha"></label>
          <label class="prom hidden">Monto prometido<input type="number" step="0.01" min="0" name="promesa_monto" value="${Math.round(c.vencido || c.saldo_total)}"></label>
          <label class="full">Notas<textarea name="notas" rows="2" maxlength="500"></textarea></label>
          <div class="full err" id="gErr"></div><div class="full actions"><button class="btn accent" type="submit">Guardar gestión</button></div></form>` : ''}
        ${d.gestiones.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Resultado</th><th>Promesa</th><th>Estado</th><th>Notas</th><th>Usuario</th></tr></thead><tbody>
        ${d.gestiones.map((g) => html`<tr><td>${fdate(g.fecha)}</td><td>${g.tipo}</td><td>${g.resultado}</td><td>${g.promesa_fecha ? html`${fdate(g.promesa_fecha)} ${g.promesa_monto ? money(g.promesa_monto) : ''}` : ''}</td><td>${badge(g.estado)}</td><td class="wrap">${g.notas}</td><td>${g.usuario}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Aún no hay gestiones de cobranza.</div>`}`,
      pagos: () => d.pagos.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Fecha</th><th>Factura</th><th>Método</th><th>Banco</th><th>Referencia</th><th class="n">Monto</th><th>Registró</th><th></th></tr></thead><tbody>
        ${d.pagos.map((p) => html`<tr><td>${fdate(p.fecha)}</td><td>${p.sin_aplicar ? html`<span class="badge b-warn">Sin aplicar</span>` : p.no_factura}</td><td>${p.metodo}</td><td>${p.banco || ''}</td><td>${p.referencia}</td><td class="n">${money(p.monto, 2)}</td><td>${p.usuario}</td><td>${p.anulado ? badge('Cerrada') : p.conciliado ? html`<span class="badge b-mut">Conciliado</span>` : p.sin_aplicar ? html`<span class="badge b-warn">Pendiente de asignar</span>` : html`<span class="badge b-ok">Aplicado</span>`}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Sin pagos capturados en la aplicación.</div>`,
      historial: () => d.historial.length ? html`<div class="tablewrap nomax"><table><thead><tr><th>Mes de factura</th><th class="n">Facturado</th><th class="n">Abonado</th><th class="n">Diferencia</th></tr></thead><tbody>
        ${d.historial.map((h) => html`<tr><td>${fmes(h.mes)}</td><td class="n">${money(h.facturado)}</td><td class="n">${money(h.cobrado)}</td><td class="n ${h.facturado - h.cobrado > 0 ? 'neg' : ''}">${money(h.facturado - h.cobrado)}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">Sin historial.</div>`,
    }[cliTab]();
    setView(html`
      <div class="crumb"><a href="#/clientes">‹ Catálogo de clientes</a></div>
      <div class="head"><div><h2>${c.cliente}</h2><div class="pill-row"><span class="badge b-info">${corto(c.estacion)}</span>${c.no_cliente ? html`<span class="badge b-mut">No. ${c.no_cliente}</span>` : ''}${c.rfc ? html`<span class="badge b-mut">RFC ${c.rfc}</span>` : ''}${badge(c.riesgo)}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="#/cartera?k=${encodeURIComponent(c.k_cliente)}">Ver facturas</a>${can('clientes') ? html`<button class="btn accent" data-act="editCliente" data-k="${c.k_cliente}" data-est="${c.estacion_id}" data-lim="${c.limite}" data-dias="${c.dias_credito}" data-rfc="${c.rfc || ''}" data-email="${c.email || ''}" data-telefono="${c.telefono || ''}" data-no="${c.no_cliente || ''}" data-nombre="${c.cliente}">Editar cliente</button>` : ''}</div></div>
      ${can('export') ? html`<form id="formEstadoCuenta" class="inline-form" style="margin-top:12px">
        <label>Desde<input type="date" name="desde"></label>
        <label>Hasta<input type="date" name="hasta"></label>
        <button class="btn dark" type="submit">Descargar estado de cuenta CSV</button>
        <div class="err" id="estadoCuentaErr" role="alert" style="flex-basis:100%"></div>
      </form>` : ''}
      <div class="grid g3">
        ${kpiMini('Límite de crédito', money(c.limite, 2), html`${c.dias_credito} días de crédito${c.credito_origen === 'app' ? ' · editado en app' : ''}`)}
        ${kpiMini('Saldo total', money(c.saldo_total, 2), html`Facturado ${money(c.saldo_fact, 2)} + por facturar ${money(c.por_facturar, 2)}`, c.riesgo === 'EXCEDIDO' ? 'k-red' : '')}
        ${kpiMini('Disponible', money(c.disponible, 2), c.limite > 0 ? html`Uso ${c.uso > 9.99 ? '>999%' : pct(c.uso)}` : 'Sin límite configurado', c.disponible < 0 ? 'k-red' : 'k-green')}
        ${kpiMini('Vencido', money(c.vencido, 2), `${c.n_fact} facturas abiertas · máx. ${c.n_fact ? c.max_dias : 0} días`, c.vencido > 0 ? 'k-red' : 'k-green')}
        ${kpiMini('Saldo a favor (Débito)', money(c.saldo_favor, 2), 'Prepago disponible', 'k-green')}
      </div>
      <div class="card" style="margin-top:16px"><h3>Antigüedad de saldos</h3>${d.aging.map((a, i) => html`<div class="hbar static"><span>${a.rango}</span><span class="t"><span class="f" style="width:${(a.monto / maxA) * 100}%;background:${PALETA[i]}"></span></span><span class="a">${money(a.monto)}</span></div>`)}</div>
      <div class="subtabs" style="margin-top:18px">${tab('abiertas', 'Facturas abiertas', d.abiertas.length)}${tab('porfacturar', 'Por facturar', d.por_facturar.length)}${tab('debito', 'Débito')}${tab('gestiones', 'Gestiones', d.gestiones.length)}${tab('pagos', 'Pagos', d.pagos.length)}${tab('historial', 'Historial')}</div>
      <div id="tabBody">${body}</div>`);
    $('#view').onclick = (e) => { const t = e.target.closest('[data-tab]'); if (t) { cliTab = t.dataset.tab; CG.routes.cliente([encodeURIComponent(k)], {}, true); } };
    const formEstadoCuenta = $('#formEstadoCuenta');
    if (formEstadoCuenta) formEstadoCuenta.onsubmit = async (e) => {
      e.preventDefault();
      const datos = Object.fromEntries(new FormData(formEstadoCuenta));
      const desde = datos.desde || '';
      const hasta = datos.hasta || '';
      const error = $('#estadoCuentaErr');
      error.textContent = '';
      if (desde && hasta && desde > hasta) { error.textContent = 'La fecha inicial no puede ser posterior a la fecha final.'; return; }
      const btn = formEstadoCuenta.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const url = '/api/cliente/estado-cuenta?' + qs({ k: c.k_cliente, desde, hasta });
        const response = await fetch(url);
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || 'No se pudo generar el estado de cuenta.');
        }
        const archivo = URL.createObjectURL(await response.blob());
        const enlace = document.createElement('a');
        enlace.href = archivo; enlace.download = 'estado_cuenta.csv'; enlace.click();
        URL.revokeObjectURL(archivo);
      } catch (er) { error.textContent = er.message; }
      finally { btn.disabled = false; }
    };
    const fg = $('#formGest');
    if (fg) {
      const sync = () => fg.querySelectorAll('.prom').forEach((l) => l.classList.toggle('hidden', $('#gRes').value !== 'Promesa de pago'));
      $('#gRes').onchange = sync; sync();
      fg.onsubmit = async (e) => {
        e.preventDefault();
        try { await api('/api/gestiones', { method: 'POST', body: { ...Object.fromEntries(new FormData(fg)), k_cliente: c.k_cliente } }); toast('Gestión guardada'); CG.routes.cliente([encodeURIComponent(k)], {}, true); CG.refreshKpis(); }
        catch (er) { $('#gErr').textContent = er.message; }
      };
    }
  };
  CG.acts.editCliente = (el, ev) => {
    if (ev) ev.stopPropagation();
    modal(html`<h2>Editar cliente · ${el.dataset.nombre}</h2><form id="formCred" class="form">
      <label>Nombre del cliente<input name="cliente" maxlength="150" value="${el.dataset.nombre}" required></label>
      <label>Estación<select name="estacion_id">${S.cat.estaciones.map((e) => opt(e.id, e.nombre, el.dataset.est))}</select></label>
      <label>No. cliente<input name="no_cliente" maxlength="30" value="${el.dataset.no}"></label>
      <label>RFC<input name="rfc" maxlength="13" value="${el.dataset.rfc}" style="text-transform:uppercase"></label>
      <label>Límite de crédito (MXN)<input name="limite" type="number" min="0" max="1000000000" step="0.01" value="${el.dataset.lim}" required></label>
      <label>Días de crédito<input name="dias" type="number" min="0" max="365" step="1" value="${el.dataset.dias}" required></label>
      <label>Correo electrónico<input name="email" type="email" maxlength="254" value="${el.dataset.email}"></label>
      <label>Teléfono<input name="telefono" type="tel" maxlength="40" value="${el.dataset.telefono}"></label>
      <div class="full note info">El cambio de estación traslada los registros del cliente. El identificador interno permanece estable y los cambios se conservan al importar Excel.</div>
      <div class="full err" id="credErr"></div>
      <div class="full actions"><button type="button" class="btn" data-act="cerrar">Cancelar</button><button class="btn accent">Guardar</button></div></form>`);
    $('#formCred').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/clientes', { method: 'PUT', body: { ...Object.fromEntries(new FormData(e.target)), k_cliente: el.dataset.k } });
        toast('Cliente actualizado'); closeModal(); await CG.loadCatalogos(); S.clientes = null; CG.route(true);
      }
      catch (er) { $('#credErr').textContent = er.message; }
    };
  };
  CG.acts.editBanco = (el) => {
    modal(html`<h2>Editar banco</h2><form id="formEditarBanco" class="form">
      <label class="full">Nombre<input name="nombre" maxlength="80" value="${el.dataset.nombre}" required></label>
      <div class="full err" id="editarBancoErr"></div><div class="full actions">
        <button type="button" class="btn" data-act="cerrar">Cancelar</button><button class="btn accent">Guardar</button></div></form>`);
    $('#formEditarBanco').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/bancos/' + el.dataset.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
        toast('Banco actualizado'); closeModal(); await CG.loadCatalogos(); CG.route(true);
      } catch (er) { $('#editarBancoErr').textContent = er.message; }
    };
  };
  CG.acts.deleteBanco = async (el) => {
    if (!confirm(`¿Eliminar el banco ${el.dataset.nombre}? Los pagos históricos conservarán su nombre.`)) return;
    try {
      await api('/api/bancos/' + el.dataset.id, { method: 'DELETE' });
      toast('Banco eliminado'); await CG.loadCatalogos(); CG.route(true);
    } catch (e) { toast(e.message, 'bad');     }
  };
  CG.acts.editMetodoPago = (el) => {
    modal(html`<h2>Editar método de pago</h2><form id="formEditarMetodoPago" class="form">
      <label class="full">Nombre<input name="nombre" maxlength="40" value="${el.dataset.nombre}" required></label>
      <label class="full"><input name="requiere_banco" type="checkbox" value="1" ${el.dataset.requiere === '1' ? 'checked' : ''}> Requiere banco en pagos CxC</label>
      <div class="full err" id="editarMetodoPagoErr"></div><div class="full actions">
        <button type="button" class="btn" data-act="cerrar">Cancelar</button><button class="btn accent">Guardar</button></div></form>`);
    $('#formEditarMetodoPago').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/metodos-pago/' + el.dataset.id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
        toast('Método de pago actualizado'); closeModal(); await CG.loadCatalogos(); CG.route(true);
      } catch (er) { $('#editarMetodoPagoErr').textContent = er.message; }
    };
  };
  CG.acts.deleteMetodoPago = async (el) => {
    if (!confirm(`¿Eliminar el método ${el.dataset.nombre}? Los movimientos históricos conservarán el nombre registrado.`)) return;
    try {
      await api('/api/metodos-pago/' + el.dataset.id, { method: 'DELETE' });
      toast('Método de pago eliminado'); await CG.loadCatalogos(); CG.route(true);
    } catch (e) { toast(e.message, 'bad'); }
  };
})();
