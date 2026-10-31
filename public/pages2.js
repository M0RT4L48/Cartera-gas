'use strict';
/* Control de Débito, Aplicación de Pagos (FIFO), Por Facturar, Cobranza, Alertas, Usuarios, Bitácora, Carga de Datos */
(() => {
  const { html, money, int, fdate, corto, badge, S, api, gp, can, toast, modal, closeModal, setView, loading, errorView,
    pager, bindFilters, opt, qs, $, hoyLocal, clientePicker } = CG;

  const selectorEstacionesHtml = (seleccionadas = []) => {
    const ids = seleccionadas.map(Number);
    return html`<details class="estaciones-dropdown">
      <summary><span data-estaciones-resumen>Selecciona estaciones</span></summary>
      <div class="estaciones-menu">
        <div class="estaciones-acciones">
          <button type="button" class="btn small" data-estaciones-accion="todas">Seleccionar todas</button>
          <button type="button" class="btn small" data-estaciones-accion="ninguna">Limpiar</button>
        </div>
        ${S.cat.estaciones.length ? S.cat.estaciones.map((estacion) => html`<label class="estacion-opcion">
          <input type="checkbox" name="estacion_seleccionada" value="${estacion.id}" data-estacion-opcion ${ids.includes(Number(estacion.id)) ? 'checked' : ''}>
          <span>${CG.esc(corto(estacion.nombre))}</span>
        </label>`) : html`<p class="mut">No hay estaciones disponibles.</p>`}
      </div>
    </details>`;
  };
  const conectarSelectorEstaciones = (form) => {
    const todas = form.querySelector('[name="todas_estaciones"]');
    const dropdown = form.querySelector('.estaciones-dropdown');
    const resumen = form.querySelector('[data-estaciones-resumen]');
    const opciones = [...form.querySelectorAll('[data-estacion-opcion]')];
    const actualizar = () => {
      opciones.forEach((opcion) => { opcion.disabled = todas.checked; });
      form.querySelectorAll('[data-estaciones-accion]').forEach((boton) => { boton.disabled = todas.checked; });
      const seleccionadas = opciones.filter((opcion) => opcion.checked).length;
      resumen.textContent = todas.checked ? 'Todas las estaciones' :
        `${seleccionadas} estación${seleccionadas === 1 ? '' : 'es'} seleccionada${seleccionadas === 1 ? '' : 's'}`;
      dropdown.setAttribute('aria-disabled', String(todas.checked));
    };
    todas.addEventListener('change', () => {
      if (todas.checked) opciones.forEach((opcion) => { opcion.checked = false; });
      actualizar();
    });
    opciones.forEach((opcion) => opcion.addEventListener('change', () => {
      if (opcion.checked) todas.checked = false;
      actualizar();
    }));
    form.querySelectorAll('[data-estaciones-accion]').forEach((boton) => boton.addEventListener('click', () => {
      todas.checked = false;
      opciones.forEach((opcion) => { opcion.checked = boton.dataset.estacionesAccion === 'todas'; });
      actualizar();
    }));
    actualizar();
    return () => opciones.filter((opcion) => opcion.checked).map((opcion) => Number(opcion.value));
  };

  // =============== CONTROL DE DÉBITO ===============
  CG.routes.debito = async () => {
    loading();
    let lista;
    try { lista = await CG.clientesLista(false); } catch (e) { return errorView(e); }
    const pick = clientePicker('deb-cliente', lista);
    const st = { q: '', tipo: '', desde: '', hasta: '', page: 1 };
    const puedeEscribir = can('debito');
    const loadRight = async () => {
      try {
        const [r, mv] = await Promise.all([
          api('/api/debito?' + qs(gp({ q: st.q }))),
          api('/api/debito/movimientos?' + qs(gp({ ...st, size: 50 }))),
        ]);
        const favor = r.rows.filter((x) => x.saldo > 0.005);
        $('#debSaldos').innerHTML = html`
          <div class="card debito-table-card" style="padding:0;overflow:hidden"><div class="debito-table-head" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--line)">
            <h3 style="margin:0">Clientes con Saldo a Favor</h3><span><span class="chip ok">${favor.length} clientes · ${money(r.totales.a_favor)}</span>
            ${r.totales.negativo < 0 ? html` <span class="chip bad" title="Clientes cuyos consumos superan sus abonos">Consumido en exceso ${money(r.totales.negativo)}</span>` : ''}</span></div>
            <div class="tablewrap debito-table-scroll" role="region" aria-label="Clientes con saldo a favor" tabindex="0" style="border:0;border-radius:0;max-height:270px"><table class="debito-saldos-table"><thead><tr><th>Cliente</th><th>Estación</th><th class="n">Saldo a favor disponible</th></tr></thead><tbody>
            ${favor.length ? favor.map((x) => html`<tr class="click" data-go="#/cliente/${encodeURIComponent(x.k_cliente)}"><td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td class="n strong pos">${money(x.saldo, 2)}</td></tr>`)
              : html`<tr><td colspan="3" class="empty">Ningún cliente tiene saldo a favor.</td></tr>`}</tbody></table></div></div>
          <div class="card debito-table-card" style="padding:0;overflow:hidden;margin-top:18px"><div style="padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--line)"><h3 style="margin:0">Movimientos <small>${int(mv.total)} en total</small></h3></div>
            <div class="tablewrap debito-table-scroll" role="region" aria-label="Movimientos de prepago" tabindex="0" style="border:0;border-radius:0;max-height:320px"><table class="debito-movimientos-table"><thead><tr><th>Fecha</th><th>Cliente</th><th>Operación</th><th>Método</th><th>Banco</th><th>Folio</th><th class="n">Monto</th><th></th></tr></thead><tbody>
            ${mv.rows.length ? mv.rows.map((m) => { const ab = m.abono > 0; return html`<tr><td>${fdate(m.fecha)}</td><td class="wrap">${m.cliente}</td><td>${badge(m.tipo)}</td>
              <td>${m.metodo || ''}</td><td>${m.banco || ''}</td><td>${m.folio}</td><td class="n strong ${ab ? 'pos' : ''}">${ab ? '+' : '−'}${money(ab ? m.abono : m.importe, 2)}</td>
              <td>${m.origen === 'app' && (puedeEscribir || can('anular_prepago') && ab) ? html`<button class="btn small danger" data-act="anularDeb" data-id="${m.id}">Anular prepago</button>` : ''}</td></tr>`; })
              : html`<tr><td colspan="8" class="empty">Sin movimientos.</td></tr>`}</tbody></table></div>
            ${pager(st, mv.total, mv.size)}</div>`.s;
      } catch (e) { $('#debSaldos').innerHTML = html`<div class="note">${e.message}</div>`.s; }
    };
    setView(html`
      <div class="h"><h2>Registro de Prepago</h2><p>Gestión de abonos anticipados y consumos de combustible. Los saldos a favor no forman parte de la cartera por cobrar.</p></div>
      <div class="split debito-layout">
        <div>${puedeEscribir ? html`<form id="formDeb" class="formcard"><h3>Registrar Movimiento</h3><div class="f">
          <label>Cliente${pick.html}</label>
          <div><label style="margin-bottom:6px">Tipo de operación</label><div class="seg">
            <label><input type="radio" name="tipo" value="ABONO" checked><span class="ab">Deposito (+)</span></label>
            <label><input type="radio" name="tipo" value="CONSUMO"><span class="co">Devolucion (−)</span></label></div></div>
          <div class="row2">
            <label id="deb-metodo-wrap">Método de pago<select name="metodo" id="deb-metodo" required>
              <option value="">Selecciona un método…</option>${S.cat.metodos_pago.map((m) => opt(m.nombre, m.nombre))}
            </select></label>
            <label id="deb-banco-wrap" class="hidden">Banco<select name="banco_id" id="deb-banco" required><option value="">Selecciona un banco…</option>${S.cat.bancos.map((b) => opt(b.id, b.nombre))}</select></label>
          </div>
            <label>Monto ($)<input class="bigin" name="monto" type="number" min="0.01" step="0.01" placeholder="0.00" required></label>
          <div class="row2"><label>Fecha<input name="fecha" type="date" max="${hoyLocal()}" value="${hoyLocal()}" required></label>
            <label>Folio / Ref<input name="folio" maxlength="60" placeholder="Ej. TKT-102" required></label></div>
          <div class="err" id="debErr"></div>
          <button class="btn dark block" type="submit">Registrar Operación</button></div></form>`
          : html`<div class="note info">Tu rol es de solo consulta: puedes ver saldos y movimientos, pero no registrarlos.</div>`}</div>
        <div class="debito-panel"><div class="bar" id="filtros">
          <label style="flex:1">Buscar cliente<input data-f="q" placeholder="Nombre del cliente…" style="width:100%"></label>
          <label>Operación<select data-f="tipo"><option value="">Todas</option><option value="RECARGA">Abonos</option><option value="CONSUMO">Consumos</option></select></label>
          <label>Desde<input data-f="desde" type="date"></label><label>Hasta<input data-f="hasta" type="date"></label>
        </div><div id="debSaldos"><div class="empty">Cargando…</div></div></div>
      </div>`);
    bindFilters($('#filtros'), st, loadRight);
    $('#view').onclick = (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { st.page = Number(pg.dataset.page); loadRight(); }
    };
    const f = $('#formDeb');
    if (f) {
      const bancoWrap = $('#deb-banco-wrap');
      const tipoInputs = [...f.querySelectorAll('input[name=tipo]')];
      const actualizarCamposAbono = () => {
        const esAbono = f.querySelector('input[name=tipo]:checked').value === 'ABONO';
        $('#deb-metodo').required = true;
        const metodoVal = ($('#deb-metodo').value || '').trim();
        const esConBanco = /^(cheque|tarjeta|transferencia)(?:\s|$)/i.test(metodoVal);
        bancoWrap.classList.toggle('hidden', !esConBanco);
        $('#deb-banco').required = esConBanco;
        if (!esConBanco) {
          $('#deb-banco').value = '';
        }
      };
      tipoInputs.forEach((input) => input.addEventListener('change', actualizarCamposAbono));
      $('#deb-metodo').addEventListener('change', actualizarCamposAbono);
      actualizarCamposAbono();
      f.onsubmit = async (e) => {
      e.preventDefault(); $('#debErr').textContent = '';
      const c = pick.resolver(); if (!c) { $('#debErr').textContent = 'Selecciona un cliente de la lista.'; return; }
      const fd = Object.fromEntries(new FormData(f)); const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await api('/api/debito/movimientos', { method: 'POST', body: { k_cliente: c.k_cliente, tipo: fd.tipo, monto: fd.monto, fecha: fd.fecha, folio: fd.folio, metodo: fd.metodo, banco_id: fd.banco_id } });
        toast(`Operación de ${fd.tipo} guardada. Nuevo saldo: ${money(r.saldo_nuevo, 2)}${r.advertencia ? ' — ' + r.advertencia : ''}`, r.advertencia ? 'warn' : undefined);
        f.monto.value = ''; f.folio.value = ''; $('#deb-metodo').value = ''; $('#deb-banco').value = ''; loadRight(); CG.refreshKpis();
      } catch (er) { $('#debErr').textContent = er.message; } finally { btn.disabled = false; }
      };
    }
    CG.acts.anularDeb = async (el) => {
      if (!confirm('¿Anular este movimiento de débito? El saldo del cliente se recalculará.')) return;
      try { await api('/api/debito/movimientos/' + el.dataset.id, { method: 'DELETE' }); toast('Movimiento anulado'); loadRight(); CG.refreshKpis(); } catch (e) { toast(e.message, 'bad'); }
    };
    loadRight();
  };

  // =============== APLICACIÓN DE PAGOS (FIFO) ===============
  CG.routes.pagos = async (args, query) => {
    loading();
    let lista;
    try { lista = await CG.clientesLista(false); } catch (e) { return errorView(e); }
    const pick = clientePicker('pago-cliente', lista, { placeholder: 'Selecciona un cliente…' });
    let facs = [], cli = null, saldoPrepago = 0, tienePrepago = false, deudaTotal = 0;
    const fifoKey = (f) => f.fecha_vencimiento || f.fecha_factura || '9999-12-31';
    const monto = () => parseFloat($('#pago-monto').value) || 0;
    const aplicado = () => $$inputs().reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
    const $$inputs = () => [...document.querySelectorAll('.input-aplicar')];
    const distribuirFIFO = (total) => {
      let restante = total;
      $$inputs().forEach((input) => {
        const pendiente = parseFloat(input.dataset.pending) || 0;
        const asignado = Math.min(pendiente, restante);
        input.value = asignado > 0 ? asignado.toFixed(2) : '';
        restante -= asignado;
      });
      badgeRest();
    };
    const badgeRest = () => {
      const rest = Math.round((monto() - aplicado()) * 100) / 100, b = $('#pago-restante');
      b.textContent = `Sin distribuir: ${money(Math.max(0, rest), 2)}`;
      b.className = 'chip' + (rest < -0.01 ? ' bad' : rest > 0.005 ? ' warn' : ' ok');
      validarMontos();
    };
    const validarMontos = () => {
      const total = monto();
      const chk = $('#pago-usar-prepago');
      const usandoPrepago = tienePrepago && chk && chk.checked;
      const limitePrepago = usandoPrepago && $('#pago-prepago-monto') ? Number($('#pago-prepago-monto').value) : total;
      const invalidaFactura = $$inputs().find((i) => (parseFloat(i.value) || 0) > (parseFloat(i.dataset.pending) || 0) + 0.005);
      let error = '';
      if (cli && total > deudaTotal + 0.005) {
        error = `No se puede exceder la deuda actual (${money(deudaTotal, 2)}).`;
      } else if (usandoPrepago && total > saldoPrepago + 0.005) {
        error = `El monto excede el saldo de prepago disponible (${money(saldoPrepago, 2)}).`;
      } else if (invalidaFactura) {
        error = `El monto aplicado a la factura ${invalidaFactura.dataset.no} no puede exceder su saldo pendiente (${money(invalidaFactura.dataset.pending, 2)}).`;
      } else if (aplicado() > total + 0.005) {
        error = `El monto aplicado supera el monto solicitado (${money(total, 2)}).`;
      }
      $('#pagoErr').textContent = error;
      const montoValido = !!cli && total > 0 && total <= deudaTotal + 0.005 &&
        (!usandoPrepago || (total <= saldoPrepago + 0.005 && limitePrepago > 0));
      $('#btn-fifo').disabled = !montoValido;
      $('#btn-sin-aplicar').disabled = !montoValido;
      $('#btn-guardar').disabled = !montoValido || Boolean(invalidaFactura) || aplicado() > total + 0.005;
      return montoValido && !invalidaFactura && aplicado() <= total + 0.005;
    };
    const renderFacs = () => {
      $('#pagoFacs').innerHTML = !cli ? html`<tr><td colspan="4" class="empty">Selecciona un cliente para cargar su cartera.</td></tr>`.s
        : !facs.length ? html`<tr><td colspan="4" class="empty">Sin facturas pendientes.</td></tr>`.s
        : html`${facs.map((f) => html`<tr><td><b>Fac: ${f.no_factura}</b><br><small class="${f.dias_vencido > 0 ? 'neg strong' : 'mut'}">${f.fecha_vencimiento ? (f.dias_vencido > 0 ? f.dias_vencido + ' días vencida' : 'Al corriente · vence ' + fdate(f.fecha_vencimiento)) : 'Sin fecha de vencimiento'}</small></td>
          <td class="n mut">${money(f.importe, 2)}</td><td class="n strong">${money(f.saldo, 2)}</td>
          <td class="n"><input class="input-aplicar" type="number" min="0" max="${f.saldo}" step="0.01" data-no="${f.no_factura}" data-est="${f.estacion_id}" data-pending="${f.saldo}" placeholder="0.00" style="width:130px;text-align:right;font-weight:600"></td></tr>`)}`.s;
      badgeRest();
    };
    const renderPrepagoBox = (saldo, tiene) => {
      const box = $('#pago-prepago-box');
      if (!box) return;
      if (!cli) {
        box.innerHTML = html`
          <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--bg)">
            <label class="inline-check" style="font-weight:600;color:var(--mut)">
              <input type="checkbox" id="pago-usar-prepago" disabled> Aplicar a saldo de prepago
            </label>
            <div style="margin-top:4px;font-size:12px;color:var(--mut)">Selecciona un cliente para consultar su saldo de prepago</div>
          </div>`.s;
        return;
      }
      const limite = Math.min(saldo, facs.reduce((s, f) => s + Number(f.saldo || 0), 0));
      const puedeAplicar = tiene && limite > 0.005;
      box.innerHTML = html`
        <div style="border:1px solid ${tiene ? 'var(--ok)' : 'var(--line)'};border-radius:8px;padding:10px 12px;background:${tiene ? 'var(--okbg)' : 'var(--bg)'}">
          <label class="inline-check" style="font-weight:600;color:${tiene ? 'var(--oktext)' : 'var(--mut)'}">
            <input type="checkbox" id="pago-usar-prepago" ${puedeAplicar ? '' : 'disabled'}> Aplicar a saldo de prepago
          </label>
          ${tiene
            ? html`<div style="margin-top:6px;font-size:13px;color:var(--oktext)">Saldo disponible: <b>${money(saldo, 2)}</b></div>
                   ${puedeAplicar ? '' : html`<div style="margin-top:4px;font-size:12px;color:var(--mut)">No hay facturas pendientes para aplicar el prepago</div>`}
                   <div id="pago-prepago-monto-wrap" style="margin-top:8px;display:none">
                     <label style="font-size:13px">Monto a aplicar desde prepago (MXN)<input id="pago-prepago-monto" type="number" step="0.01" min="0.01" max="${limite}" value="${limite.toFixed(2)}" style="width:160px;font-weight:600"></label>
                   </div>`
            : html`<div style="margin-top:4px;font-size:12px;color:var(--mut)">Cliente sin saldo de prepago</div>`}
        </div>`.s;
      const chk = $('#pago-usar-prepago');
      if (puedeAplicar && chk) {
        chk.addEventListener('change', () => {
          actualizarVisibilidad();
          if (chk.checked) distribuirFIFO(parseFloat($('#pago-prepago-monto').value) || 0);
        });
        const prepInp = $('#pago-prepago-monto');
        if (prepInp) {
          prepInp.addEventListener('input', () => {
            $('#pago-monto').value = prepInp.value;
            distribuirFIFO(parseFloat(prepInp.value) || 0);
          });
        }
      }
    };
    const actualizarVisibilidad = () => {
      const chk = $('#pago-usar-prepago');
      const usandoPrepago = tienePrepago && chk && chk.checked;
      const wrapMonto = $('#pago-monto-wrap');
      const wrapMetodo = $('#pago-metodo-wrap');
      const wrapBanco = $('#pago-banco-wrap');
      const wrapPrepMonto = $('#pago-prepago-monto-wrap');

      if (wrapPrepMonto) wrapPrepMonto.style.display = usandoPrepago ? '' : 'none';
      if (wrapMonto) wrapMonto.style.display = usandoPrepago ? 'none' : '';
      if (wrapMetodo) wrapMetodo.style.display = usandoPrepago ? 'none' : '';

      if (usandoPrepago) {
        if (wrapBanco) {
          wrapBanco.style.display = 'none';
          $('#pago-banco').required = false;
          $('#pago-banco').value = '';
        }
        const prepInp = $('#pago-prepago-monto');
        if (prepInp) {
          $('#pago-monto').value = prepInp.value;
        }
      } else {
        actualizarBanco();
      }
      badgeRest();
    };
    const cargarCliente = async (c) => {
      if (!$('#pago-monto')) return;
      const cambioCliente = !cli || !c || cli.k_cliente !== c.k_cliente;
      cli = c;
      const confirmacion = $('#pago-confirmacion');
      if (cambioCliente && confirmacion) {
        confirmacion.hidden = true;
        confirmacion.innerHTML = '';
      }
      if (!c) {
        facs = [];
        deudaTotal = 0;
        $('#pago-monto').removeAttribute('max');
        saldoPrepago = 0;
        tienePrepago = false;
        renderFacs();
        renderPrepagoBox(0, false);
        actualizarVisibilidad();
        return;
      }
      try {
        const [d, prepData] = await Promise.all([
          api('/api/cliente?' + qs({ k: c.k_cliente, corte: S.corte })),
          api('/api/prepago/saldo?' + qs({ k: c.k_cliente })).catch(() => ({ saldo_prepago: 0 })),
        ]);
        const pagoMonto = $('#pago-monto');
        if (!pagoMonto) return;
        facs = d.abiertas.slice().sort((a, b) => fifoKey(a).localeCompare(fifoKey(b)));
        deudaTotal = facs.reduce((sum, f) => sum + Number(f.saldo || 0), 0);
        pagoMonto.max = deudaTotal.toFixed(2);
        saldoPrepago = prepData.saldo_prepago || 0;
        tienePrepago = saldoPrepago > 0.005;
        renderFacs();
        renderPrepagoBox(saldoPrepago, tienePrepago);
        actualizarVisibilidad();
      } catch (e) { toast(e.message, 'bad'); }
    };
    setView(html`
      <div class="h"><h2>Aplicación de Pagos</h2><p>Aplica cobros a las facturas pendientes con el método FIFO (primero las más antiguas), o reparte el monto manualmente.</p></div>
      <div class="split">
        <div class="formcard"><h3>Detalles del Cobro</h3><div class="f">
          <label>Cliente con deuda${pick.html}</label>
          <div class="row2"><label>Fecha pago<input id="pago-fecha" type="date" max="${hoyLocal()}" value="${hoyLocal()}"></label>
            <label>Ref / Folio<input id="pago-ref" maxlength="80" placeholder="SPEI-123"></label></div>
          <label id="pago-metodo-wrap">Método<select id="pago-metodo" required><option value="">Selecciona un método…</option>${S.cat.metodos_pago.map((m) => opt(m.nombre, m.nombre))}</select></label>
          <label id="pago-banco-wrap" style="display:none">Banco<select id="pago-banco"><option value="">Selecciona un banco…</option>${S.cat.bancos.map((b) => opt(b.id, b.nombre))}</select></label>
          <label id="pago-monto-wrap">Monto del pago ($)<input id="pago-monto" class="bigin" type="number" min="0.01" step="0.01" placeholder="0.00"></label>
          <div id="pago-prepago-box" style="margin-top:6px;margin-bottom:6px"></div>
          <div id="pago-confirmacion" class="note info" role="status" aria-live="polite" style="margin:8px 0" hidden></div>
          <div class="err" id="pagoErr" role="alert" aria-live="assertive"></div>
          <button type="button" id="btn-fifo" class="btn gray block">Distribuir Automático (FIFO)</button>
          <button type="button" id="btn-sin-aplicar" class="btn gray block">Guardar monto total sin aplicar</button>
          <button type="button" id="btn-guardar" class="btn accent block">Guardar y Aplicar Pago</button></div></div>
        <div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h3 style="margin:0;color:var(--txt)">Facturas Pendientes</h3><span class="chip warn" id="pago-restante">Sin distribuir: $0.00</span></div>
          <div class="tablewrap" style="max-height:480px"><table><thead><tr><th>Factura</th><th class="n">Monto original</th><th class="n">Saldo pendiente</th><th class="n">Asignar pago</th></tr></thead><tbody id="pagoFacs"></tbody></table></div></div>
      </div>`);
    renderFacs();
    renderPrepagoBox(0, false);
    const actualizarBanco = () => {
      const metodoVal = ($('#pago-metodo').value || '').trim();
      const requiere = /^(cheque|tarjeta|transferencia)(?:\s|$)/i.test(metodoVal);
      $('#pago-banco-wrap').style.display = requiere ? '' : 'none';
      $('#pago-banco').required = requiere;
      if (!requiere) $('#pago-banco').value = '';
    };
    $('#pago-metodo').addEventListener('change', actualizarBanco);
    actualizarBanco();
    const inp = $('#pago-cliente');
    inp.addEventListener('input', () => { const c = pick.resolver(); if (c) cargarCliente(c); else if (cli) cargarCliente(null); });
    if (query.k) {
      const seleccionar = (cliente) => {
        inp.value = pick.etiqueta(cliente);
        pick.map.set(pick.etiqueta(cliente), cliente);
        cargarCliente(cliente);
      };
      const c = lista.find((x) => x.k_cliente === query.k);
      if (c) {
        seleccionar(c);
      } else {
        api('/api/cliente?' + qs({ k: query.k, corte: S.corte })).then((d) => {
          if (d && d.cliente) {
            seleccionar({ k_cliente: d.cliente.k_cliente, cliente: d.cliente.cliente, estacion_id: d.cliente.estacion_id, estacion: d.cliente.estacion });
          }
        }).catch(() => {});
      }
    }
    $('#pago-monto').addEventListener('input', badgeRest);
    $('#pagoFacs').addEventListener('input', (e) => { if (e.target.classList.contains('input-aplicar')) badgeRest(); });
    $('#btn-fifo').onclick = () => {
      let rest = monto();
      if (!(rest > 0)) { toast('Captura primero el monto del pago.', 'warn'); return; }
      distribuirFIFO(rest);
    };
    $('#btn-sin-aplicar').onclick = async () => {
      $('#pagoErr').textContent = '';
      if (!cli) { $('#pagoErr').textContent = 'Selecciona un cliente de la lista.'; return; }
      if (!$('#pago-metodo').value) { $('#pagoErr').textContent = 'Selecciona un método de pago.'; return; }
      const chk = $('#pago-usar-prepago');
      if (tienePrepago && chk && chk.checked) {
        $('#pagoErr').textContent = 'El saldo de prepago ya está a favor del cliente. Asígnalo a las facturas pendientes.';
        return;
      }
      const total = monto(); if (!(total > 0)) { $('#pagoErr').textContent = 'Captura el monto del pago.'; return; }
      if (total > deudaTotal + 0.005) { validarMontos(); return; }
      const btn = $('#btn-sin-aplicar'); btn.disabled = true;
      try {
        const r = await api('/api/pagos/lote', { method: 'POST', body: { k_cliente: cli.k_cliente, estacion_id: cli.estacion_id, fecha: $('#pago-fecha').value, metodo: $('#pago-metodo').value, banco_id: $('#pago-banco').value || null, referencia: $('#pago-ref').value, monto: total, aplicaciones: [], corte: S.corte } });
        toast(`Cobro guardado por ${money(r.total, 2)} sin aplicar a ninguna factura.`, 'warn');
        $('#pago-monto').value = ''; $('#pago-ref').value = ''; $$inputs().forEach((i) => i.value = ''); badgeRest(); await cargarCliente(cli); CG.refreshKpis();
      } catch (er) { $('#pagoErr').textContent = er.message; } finally { badgeRest(); }
    };
    $('#btn-guardar').onclick = async () => {
      $('#pagoErr').textContent = '';
      if (!cli) { $('#pagoErr').textContent = 'Selecciona un cliente de la lista.'; return; }
      const chk = $('#pago-usar-prepago');
      const usarPrepago = tienePrepago && chk && chk.checked;
      if (!usarPrepago && !$('#pago-metodo').value) { $('#pagoErr').textContent = 'Selecciona un método de pago.'; return; }
      const montoPrep = usarPrepago ? parseFloat($('#pago-prepago-monto')?.value) || 0 : 0;
      if (usarPrepago && !(montoPrep > 0)) { $('#pagoErr').textContent = 'Indica un monto de prepago mayor a cero.'; return; }
      if (usarPrepago && montoPrep > saldoPrepago + 0.005) { $('#pagoErr').textContent = `El monto excede el saldo de prepago disponible (${money(saldoPrepago, 2)})`; return; }

      const total = usarPrepago ? montoPrep : monto();
      if (!(total > 0)) { $('#pagoErr').textContent = 'Captura el monto del pago.'; return; }
      if (!validarMontos()) return;
      const aplicaciones = $$inputs().map((i) => ({ no_factura: i.dataset.no, estacion_id: i.dataset.est, monto: parseFloat(i.value) || 0 })).filter((a) => a.monto > 0);
      const ap = aplicaciones.reduce((s, a) => s + a.monto, 0);
      if (ap > total + 0.01) { $('#pagoErr').textContent = 'El monto aplicado supera el monto del pago.'; return; }
      if (usarPrepago && !aplicaciones.length) { $('#pagoErr').textContent = 'Asigna al menos una factura para aplicar el saldo de prepago.'; return; }
      if (usarPrepago && Math.abs(ap - montoPrep) > 0.005) { $('#pagoErr').textContent = 'Distribuye el monto completo de prepago entre las facturas, con FIFO o asignación manual.'; return; }

      const btn = $('#btn-guardar'); btn.disabled = true;
      try {
        const body = {
          k_cliente: cli.k_cliente,
          fecha: $('#pago-fecha').value,
          metodo: usarPrepago ? 'Prepago' : $('#pago-metodo').value,
          banco_id: usarPrepago ? null : ($('#pago-banco').value || null),
          referencia: $('#pago-ref').value,
          monto: total,
          aplicaciones,
          corte: S.corte,
        };
        if (usarPrepago) {
          body.desde_prepago = montoPrep;
        }
        const r = await api('/api/pagos/lote', { method: 'POST', body });
        const sobra = Math.round((total - r.aplicado) * 100) / 100;
        if (usarPrepago) {
          const confirmacion = $('#pago-confirmacion');
          confirmacion.innerHTML = html`
            <b>Aplicación de prepago registrada.</b>
            <div>Aplicado a facturas: <b>${money(r.aplicado, 2)}</b></div>
            <div>Saldo de prepago remanente: <b>${money(r.prepago_saldo_remanente, 2)}</b></div>`.s;
          confirmacion.hidden = false;
        } else {
          toast(`Cobro aplicado: ${money(r.aplicado, 2)} en ${Math.max(0, r.ids.length - Number(Boolean(r.sin_aplicar > 0)))} factura(s).${sobra > 0.005 ? ' Quedaron ' + money(sobra, 2) + ' sin aplicar.' : ''}`, sobra > 0.005 ? 'warn' : undefined);
        }
        $('#pago-monto').value = ''; $('#pago-ref').value = ''; $$inputs().forEach((i) => i.value = ''); badgeRest(); await cargarCliente(cli); CG.refreshKpis();
      } catch (er) { $('#pagoErr').textContent = er.message; } finally { badgeRest(); }
    };
  };

  // =============== POR FACTURAR ===============
  CG.routes['por-facturar'] = async () => {
    const st = { q: '' };
    const puedeFacturar = can('facturas');
    const puedeEditarDespacho = can('editar_despacho');
    let lista = [];
    try { lista = await CG.clientesLista(false); } catch (e) { return errorView(e); }
    const pick = clientePicker('porfact-cliente', lista, { placeholder: 'Selecciona un cliente…' });
    const load = async () => {
      try {
        const r = await api('/api/por-facturar?' + qs(gp({ q: st.q })));
        $('#tbl').innerHTML = html`<div class="grid g3" style="margin-bottom:14px">
          <div class="kpi mini k-amber"><span class="l">Importe por facturar</span><span class="v">${money(r.total_monto)}</span></div>
          <div class="kpi mini"><span class="l">Despachos</span><span class="v">${int(r.total_despachos)}</span></div></div>
          <div class="tablewrap"><table><thead><tr><th>Cliente</th><th>Estación</th><th class="n">Despachos</th><th class="n">Importe</th><th>Más antiguo</th><th>Más reciente</th><th class="n">Antigüedad (días)</th><th></th></tr></thead><tbody>
          ${r.rows.length ? r.rows.map((x) => html`<tr class="click" data-go="#/cliente/${encodeURIComponent(x.k_cliente)}"><td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td class="n">${x.despachos}</td>
            <td class="n strong">${money(x.monto)}</td><td>${fdate(x.mas_antiguo)}</td><td>${fdate(x.mas_reciente)}</td><td class="n ${x.dias_antiguedad > 15 ? 'neg' : ''}">${x.dias_antiguedad}</td>
            <td>${puedeFacturar || puedeEditarDespacho ? html`<button class="btn small" data-act="emitirFacturaCliente" data-k="${x.k_cliente}" data-cliente="${x.cliente}">${puedeFacturar ? 'Seleccionar despachos' : 'Modificar importes'}</button>` : ''}</td></tr>`) : html`<tr><td colspan="8" class="empty">Sin despachos por facturar.</td></tr>`}</tbody></table></div>`.s;
      } catch (e) { $('#tbl').innerHTML = html`<div class="note">${e.message}</div>`.s; }
    };
    setView(html`<div class="h"><h2>Despachos por Facturar</h2><p>Despachos a crédito que aún no tienen factura emitida. También puedes registrar un monto de crédito pendiente para un cliente concreto.</p></div>
      ${can('facturas') ? html`<form id="formCargaPorFacturar" class="formcard" style="margin-bottom:18px">
        <h3>Cargar Despachos por facturar</h3>
        <div class="row2" style="align-items:end">
          <label>Archivo de Excel (.xlsx)<input type="file" name="archivo" accept=".xlsx" required></label>
          <button class="btn accent" type="submit">Cargar Despachos por facturar</button>
        </div>
        <div id="cargaPorFacturarOut" role="status" aria-live="polite" style="margin-top:10px"></div>
      </form>` : ''}
      ${can('facturas') ? html`<form id="formPorFacturar" class="formcard" style="margin-bottom:18px">
        <h3>Registrar monto pendiente por facturar</h3>
        <div class="grid g4">
          <label>Cliente${pick.html}</label>
          <label>Monto ($)<input name="importe" type="number" min="0.01" step="0.01" required></label>
          <label>Fecha de despacho<input name="fecha_despacho" type="date" max="${hoyLocal()}" value="${hoyLocal()}" required></label>
          <label>Despacho<input name="despacho" maxlength="80" placeholder="Ej. Entrega 12/10"></label>
        </div>
        <div class="err" id="porFacturarErr" style="margin-top:8px"></div>
        <button class="btn dark" type="submit" style="margin-top:12px">Guardar por facturar</button>
      </form>` : ''}
      <div class="bar" id="filtros"><label>Buscar cliente<input data-f="q" placeholder="Nombre…" style="min-width:240px"></label></div><div id="tbl"></div>`);
    if (can('facturas')) {
      $('#formCargaPorFacturar').onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const file = form.elements.archivo.files[0];
        const output = $('#cargaPorFacturarOut');
        if (!file) { output.innerHTML = html`<div class="note">Selecciona un archivo Excel .xlsx.</div>`.s; return; }
        if (!/\.xlsx$/i.test(file.name)) { output.innerHTML = html`<div class="note">Solo se aceptan archivos .xlsx.</div>`.s; return; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        output.innerHTML = html`<div class="note info">Validando el archivo y sus registros…</div>`.s;
        try {
          const r = await api('/api/por-facturar/carga', { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream' } });
          output.innerHTML = html`<div class="note" style="background:var(--okbg);color:var(--oktext)">Se cargaron ${int(r.importados)} despacho(s) por un pendiente total de ${money(r.total, 2)}.</div>`.s;
          form.reset();
          st.q = '';
          const filtroCliente = $('#filtros [data-f="q"]');
          if (filtroCliente) filtroCliente.value = '';
          await load();
        } catch (err) {
          output.innerHTML = html`<div class="note" style="white-space:pre-wrap">${err.message}</div>`.s;
        } finally { btn.disabled = false; }
      };
      $('#formPorFacturar').onsubmit = async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        $('#porFacturarErr').textContent = '';
        const cliente = pick.resolver();
        if (!cliente) { $('#porFacturarErr').textContent = 'Selecciona un cliente de la lista.'; return; }
        const data = Object.fromEntries(new FormData(form));
        const monto = Number(data.importe);
        if (!(monto > 0)) { $('#porFacturarErr').textContent = 'El monto debe ser mayor a cero.'; return; }
        try {
          await api('/api/por-facturar', { method: 'POST', body: { k_cliente: cliente.k_cliente, importe: monto, fecha_despacho: data.fecha_despacho, despacho: data.despacho || 'PENDIENTE' } });
          toast('Monto registrado como por facturar.');
          await CG.route(true);
        } catch (err) { $('#porFacturarErr').textContent = err.message; }
      };
    }
    bindFilters($('#filtros'), st, load); load();
  };
  CG.acts.emitirFacturaCliente = async (el) => {
    const puedeFacturar = can('facturas');
    const puedeEditarDespacho = can('editar_despacho');
    if (!puedeFacturar && !puedeEditarDespacho) { toast('No tienes permiso para esta acción.', 'bad'); return; }
    const cliente = String(el.dataset.cliente || 'Cliente');
    const k = el.dataset.k;
    let pendientes;
    try {
      const r = await api('/api/por-facturar?' + qs(gp({ k })));
      pendientes = r.rows[0] && r.rows[0].items || [];
    } catch (e) { toast(e.message, 'bad'); return; }
    if (!pendientes.length) { toast('Este cliente no tiene despachos pendientes de facturar.', 'warn'); await CG.route(true); return; }
    modal(html`
      <h2>${puedeFacturar ? 'Seleccionar despachos para facturar' : 'Modificar despachos pendientes'}</h2>
      <form id="formEmitirFacturaCliente" class="form">
        <label>Cliente<input value="${cliente}" readonly></label>
        ${puedeFacturar ? html`<label>Folio / No. factura<input name="no_factura" maxlength="80" required></label>
          <label>Fecha de factura<input name="fecha_factura" type="date" max="${hoyLocal()}" value="${hoyLocal()}" required></label>` : ''}
        <div class="full tablewrap nomax"><table><thead><tr><th>${puedeFacturar ? html`<input type="checkbox" id="seleccionarTodosDespachos" checked aria-label="Seleccionar todos los despachos">` : ''}</th><th>Fecha</th><th>Despacho</th><th>Grupo</th><th class="n">Pendiente</th><th></th></tr></thead><tbody id="despachosEmitir">
          ${pendientes.map((d) => html`<tr><td>${puedeFacturar ? html`<input type="checkbox" name="despacho_id" value="${d.id}" data-monto="${Math.max(0, d.monto)}" checked>` : ''}</td>
            <td>${fdate(d.fecha_despacho)}</td><td>${d.despacho || ''}</td><td>${d.grupo || ''}</td><td class="n">${money(d.monto, 2)}</td>
            <td>${puedeEditarDespacho ? html`<button type="button" class="btn small" data-despacho-action="editar" data-id="${d.id}" aria-label="Editar despacho ${d.despacho || ''}" title="Editar despacho">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>` : ''}</td></tr>`)}</tbody>
          ${puedeFacturar ? html`<tfoot><tr><td colspan="4">Total seleccionado</td><td class="n strong" id="totalSeleccionado"></td><td></td></tr></tfoot>` : ''}</table></div>
        <div class="full err" id="emitirFacturaErr"></div>
        <div class="full actions"><button type="button" class="btn" data-act="cerrar">Cerrar</button>${puedeFacturar ? html`<button type="submit" class="btn dark">Emitir factura</button>` : ''}</div>
      </form>`, { wide: true });
    const form = $('#formEmitirFacturaCliente');
    const checks = () => [...form.querySelectorAll('input[name="despacho_id"]')];
    const renderDespacho = (row, despacho) => {
      const celdas = row.cells;
      celdas[1].textContent = fdate(despacho.fecha_despacho);
      celdas[2].textContent = despacho.despacho || '';
      celdas[3].textContent = despacho.grupo || '';
      celdas[4].textContent = money(despacho.monto, 2);
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'btn small';
      boton.dataset.despachoAction = 'editar';
      boton.dataset.id = despacho.id;
      boton.setAttribute('aria-label', `Editar despacho ${despacho.despacho || ''}`);
      boton.title = 'Editar despacho';
      boton.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
      celdas[5].replaceChildren(boton);
      const checkbox = celdas[0].querySelector('input');
      if (checkbox) checkbox.dataset.monto = String(despacho.monto);
    };
    const inputCelda = (cell, type, value, { maxLength, min, step, max, required } = {}) => {
      const input = document.createElement('input');
      input.type = type;
      input.value = value == null ? '' : String(value);
      if (maxLength) input.maxLength = maxLength;
      if (min != null) input.min = String(min);
      if (step) input.step = String(step);
      if (max != null) input.max = String(max);
      if (required) input.required = true;
      cell.replaceChildren(input);
      return input;
    };
    $('#despachosEmitir').addEventListener('click', async (event) => {
      const boton = event.target.closest('[data-despacho-action]');
      if (!boton) return;
      const fila = boton.closest('tr');
      const despacho = pendientes.find((item) => String(item.id) === boton.dataset.id);
      if (!fila || !despacho) return;
      if (boton.dataset.despachoAction === 'editar') {
        inputCelda(fila.cells[1], 'date', despacho.fecha_despacho, { max: hoyLocal(), required: true });
        inputCelda(fila.cells[2], 'text', despacho.despacho, { maxLength: 80 });
        inputCelda(fila.cells[3], 'text', despacho.grupo, { maxLength: 60 });
        inputCelda(fila.cells[4], 'number', despacho.monto, { min: 0.01, max: 1e9, step: 0.01, required: true });
        const acciones = document.createElement('div');
        acciones.style.cssText = 'display:flex;gap:4px';
        for (const [accion, etiqueta, clase] of [['guardar', 'Guardar', 'btn small dark'], ['cancelar', 'Cancelar', 'btn small']]) {
          const accionBoton = document.createElement('button');
          accionBoton.type = 'button';
          accionBoton.className = clase;
          accionBoton.dataset.despachoAction = accion;
          accionBoton.dataset.id = despacho.id;
          accionBoton.textContent = etiqueta;
          acciones.append(accionBoton);
        }
        fila.cells[5].replaceChildren(acciones);
        return;
      }
      if (boton.dataset.despachoAction === 'cancelar') {
        renderDespacho(fila, despacho);
        return;
      }
      const [fecha, nombre, grupo, monto] = [...fila.cells].slice(1, 5).map((cell) => cell.querySelector('input').value);
      if (!fecha || !monto || Number(monto) <= 0) { toast('Completa una fecha válida y un pendiente mayor a cero.', 'bad'); return; }
      boton.disabled = true;
      try {
        const actualizado = await api('/api/por-facturar/' + encodeURIComponent(despacho.id), {
          method: 'PUT',
          body: { fecha_despacho: fecha, despacho: nombre, grupo, monto },
        });
        Object.assign(despacho, actualizado);
        renderDespacho(fila, despacho);
        updateTotal();
        toast('Despacho actualizado.');
      } catch (error) {
        toast(error.message, 'bad');
        boton.disabled = false;
      }
    });
    $('#despachosEmitir').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
    });
    const updateTotal = () => {
      if (!puedeFacturar) return;
      const total = checks().filter((c) => c.checked).reduce((sum, c) => sum + Number(c.dataset.monto), 0);
      $('#totalSeleccionado').textContent = money(total, 2);
      const all = checks();
      $('#seleccionarTodosDespachos').checked = all.length > 0 && all.every((c) => c.checked);
      $('#seleccionarTodosDespachos').indeterminate = all.some((c) => c.checked) && !all.every((c) => c.checked);
    };
    if (puedeFacturar) $('#seleccionarTodosDespachos').onchange = (e) => { checks().forEach((c) => { c.checked = e.target.checked; }); updateTotal(); };
    $('#despachosEmitir').onchange = updateTotal;
    updateTotal();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!puedeFacturar) return;
      $('#emitirFacturaErr').textContent = '';
      const payload = Object.fromEntries(new FormData(form).entries());
      const ids = checks().filter((c) => c.checked).map((c) => Number(c.value));
      if (!ids.length) { $('#emitirFacturaErr').textContent = 'Selecciona al menos un despacho.'; return; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await api('/api/cartera/facturas', { method: 'POST', body: { k_cliente: k, no_factura: payload.no_factura, fecha_factura: payload.fecha_factura, facturar_por_facturar: true, ids } });
        toast(`Factura ${r.no_factura} emitida para ${cliente}. ${money(r.importe, 2)} transferidos a cartera.`);
        closeModal();
        await CG.route(true);
      } catch (err) { $('#emitirFacturaErr').textContent = err.message; }
      finally { btn.disabled = false; }
    };
  };

  // =============== COBRANZA ===============
  let cobTab = 'gestiones';
  const tabsCob = () => html`<div class="subtabs"><button data-ct="gestiones" class="${cobTab === 'gestiones' ? 'on' : ''}">Gestiones y promesas</button><button data-ct="pagos" class="${cobTab === 'pagos' ? 'on' : ''}">Pagos capturados</button></div>`;
  CG.routes.cobranza = async () => {
    loading();
    try {
      if (cobTab === 'gestiones') {
        const g = await api('/api/gestiones?' + qs({ estacion: S.est }));
        setView(html`<div class="h"><h2>Reporte de Cobranza</h2><p>Seguimiento de gestiones y promesas de pago. Las gestiones se registran desde la ficha de cada cliente.</p></div>${tabsCob()}
          <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Resultado</th><th>Promesa</th><th>Estado</th><th>Notas</th><th>Usuario</th></tr></thead><tbody>
          ${g.rows.length ? g.rows.map((x) => html`<tr><td>${fdate(x.fecha)}</td><td class="wrap"><a href="#/cliente/${encodeURIComponent(x.k_cliente)}">${x.cliente}</a></td><td>${x.tipo}</td><td>${x.resultado}</td>
            <td>${x.promesa_fecha ? html`${fdate(x.promesa_fecha)} ${x.promesa_monto ? money(x.promesa_monto) : ''}` : ''}</td>
            <td>${can('gestiones') ? html`<select data-act-change="estadoGestion" data-id="${x.id}">${['Abierta', 'Cumplida', 'Incumplida', 'Cerrada'].map((s) => opt(s, s, x.estado))}</select>` : badge(x.estado)}</td>
            <td class="wrap">${x.notas}</td><td>${x.usuario}</td></tr>`) : html`<tr><td colspan="8" class="empty">Sin gestiones registradas.</td></tr>`}</tbody></table></div>`);
      } else {
        const p = await api('/api/pagos?' + qs({ estacion: S.est }));
        setView(html`<div class="h"><h2>Reporte de Cobranza</h2><p>Pagos capturados en la aplicación. Los cobros que aún no se asignan a factura aparecen como <b>Sin aplicar</b>. Al importar un Excel nuevo se marcan como <b>conciliados</b> (ya vienen incluidos en el archivo).</p></div>${tabsCob()}
          <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Estación</th><th>Factura</th><th>Método</th><th>Banco</th><th>Referencia</th><th class="n">Monto</th><th>Registró</th><th>Estado</th><th></th></tr></thead><tbody>
          ${p.rows.length ? p.rows.map((x) => html`<tr><td>${fdate(x.fecha)}</td><td class="wrap"><a href="#/cliente/${encodeURIComponent(x.k_cliente)}">${x.cliente}</a></td><td>${corto(x.estacion)}</td><td>${x.sin_aplicar ? html`<span class="badge b-warn">Sin aplicar</span>` : x.no_factura}</td><td>${x.metodo}</td>
            <td>${x.banco || ''}</td><td>${x.referencia}</td><td class="n strong">${money(x.monto, 2)}</td><td>${x.usuario}</td><td>${x.anulado ? badge('Cerrada') : x.conciliado ? html`<span class="badge b-mut">Conciliado</span>` : x.sin_aplicar ? html`<span class="badge b-warn">Pendiente de asignar</span>` : html`<span class="badge b-ok">Aplicado</span>`}</td>
            <td>${!x.anulado && !x.conciliado && (can('pagos') || can('anular_pago')) ? html`<button class="btn small danger" data-act="anularPago" data-id="${x.id}">Anular pago</button>` : ''}</td></tr>`) : html`<tr><td colspan="11" class="empty">Sin pagos capturados.</td></tr>`}</tbody></table></div>`);
      }
    } catch (e) { errorView(e); }
    $('#view').onclick = (e) => { const t = e.target.closest('[data-ct]'); if (t) { cobTab = t.dataset.ct; CG.routes.cobranza(); } };
  };
  CG.changes.estadoGestion = async (el) => {
    try { await api('/api/gestiones/' + el.dataset.id, { method: 'PUT', body: { estado: el.value } }); toast('Estado actualizado'); CG.refreshKpis(); } catch (e) { toast(e.message, 'bad'); }
  };

  // =============== ALERTAS ===============
  CG.routes.alertas = async () => {
    loading();
    let a;
    try { a = await api('/api/alertas?' + qs(gp())); } catch (e) { return errorView(e); }
    const sec = (titulo, desc, n, tabla) => html`<div class="card" style="margin-bottom:16px"><h3>${titulo} <small>${n} ${n >= 100 ? '(primeros 100)' : ''}</small></h3><div class="mut" style="margin-bottom:8px">${desc}</div>${n ? tabla : html`<div class="mut">✔ Sin pendientes.</div>`}</div>`;
    const cli = (x) => html`<tr class="click" data-go="#/cliente/${encodeURIComponent(x.k_cliente)}">`;
    const T = (head, rows) => html`<div class="tablewrap" style="max-height:340px"><table><thead><tr>${head.map((h) => html`<th class="${h[1] || ''}">${h[0]}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
    setView(html`<div class="h"><h2>Alertas de Cartera</h2><p>Calculadas al ${fdate(a.corte)} (fecha de corte seleccionada).</p></div>
      ${sec('Promesas de pago por cumplir', 'Gestiones con promesa vencida o para hoy que siguen abiertas.', a.promesas.length, T([['Cliente'], ['Estación'], ['Fecha promesa'], ['Monto', 'n'], ['Notas']],
        a.promesas.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td>${fdate(x.promesa_fecha)}</td><td class="n">${money(x.promesa_monto)}</td><td class="wrap">${x.notas}</td></tr>`)))}
      ${sec('Clientes sobre su límite de crédito', 'Saldo total (facturado + por facturar) mayor al límite autorizado.', a.excedidos.length, T([['Cliente'], ['Estación'], ['Límite', 'n'], ['Saldo', 'n'], ['Exceso', 'n'], ['Vencido', 'n']],
        a.excedidos.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td class="n">${money(x.limite)}</td><td class="n">${money(x.saldo_total)}</td><td class="n neg strong">${money(x.exceso)}</td><td class="n">${money(x.vencido)}</td></tr>`)))}
      ${sec('Facturas con más de 60 días vencidas', 'Prioridad de cobranza por monto.', a.vencidas_60.length, T([['Cliente'], ['Estación'], ['Factura'], ['Vencimiento'], ['Días', 'n'], ['Saldo', 'n']],
        a.vencidas_60.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td>${x.no_factura}</td><td>${fdate(x.fecha_vencimiento)}</td><td class="n neg">${x.dias_vencido}</td><td class="n strong">${money(x.saldo)}</td></tr>`)))}
      ${sec('Próximas a vencer (7 días)', 'Facturas que vencen en la próxima semana: buen momento para recordatorio.', a.proximas.length, T([['Cliente'], ['Estación'], ['Factura'], ['Vencimiento'], ['Saldo', 'n']],
        a.proximas.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td>${x.no_factura}</td><td>${fdate(x.fecha_vencimiento)}</td><td class="n strong">${money(x.saldo)}</td></tr>`)))}
      ${sec('Con saldo y sin límite de crédito', 'Clientes con cartera pendiente pero límite en cero: conviene definir su límite.', a.sin_limite.length, T([['Cliente'], ['Estación'], ['Saldo', 'n'], ['Vencido', 'n']],
        a.sin_limite.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td class="n strong">${money(x.saldo_total)}</td><td class="n">${money(x.vencido)}</td></tr>`)))}
      ${sec('Despachos sin facturar con más de 15 días', 'Despachos a crédito pendientes de facturar.', a.por_facturar_antiguo.length, T([['Cliente'], ['Estación'], ['Despachos', 'n'], ['Importe', 'n'], ['Días', 'n']],
        a.por_facturar_antiguo.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td class="n">${x.despachos}</td><td class="n strong">${money(x.monto)}</td><td class="n neg">${x.dias}</td></tr>`)))}
      ${sec('Facturas abiertas sin fecha de vencimiento', 'Calidad de datos: no se puede calcular su antigüedad. Se tratan como no vencidas.', a.sin_vencimiento.length, T([['Cliente'], ['Estación'], ['Factura'], ['F. factura'], ['Saldo', 'n']],
        a.sin_vencimiento.map((x) => html`${cli(x)}<td class="wrap">${x.cliente}</td><td>${corto(x.estacion)}</td><td>${x.no_factura}</td><td>${fdate(x.fecha_factura)}</td><td class="n strong">${money(x.saldo)}</td></tr>`)))}`);
  };

  // =============== USUARIOS Y ROLES ===============
  CG.routes.usuarios = async () => {
    loading();
    let r;
    try { r = await api('/api/usuarios'); } catch (e) { return errorView(e); }
    const roles = S.cat.roles;
    setView(html`<div class="h"><h2>Gestión de Usuarios y Roles</h2><p>Administra los accesos al sistema y asigna permisos por estación de servicio. Un usuario puede tener una o varias estaciones asignadas.</p></div>
      <form id="formU" class="inline-form">
        <label style="flex:1;min-width:200px">Nombre del usuario *<input name="nombre" required maxlength="100"></label>
        <label style="width:150px">Usuario (acceso) *<input name="usuario" required pattern="[a-z0-9._-]{3,40}" placeholder="ej. jperez" title="3-40 caracteres: minúsculas, números, . _ -"></label>
        <label style="flex:1;min-width:200px">Correo electrónico<input name="email" type="email" maxlength="120"></label>
        <label style="width:200px">Rol *<select name="rol">${Object.entries(roles).map(([k, v]) => opt(k, v.etiqueta, 'gestor'))}</select></label>
        <div class="asignacion-estaciones"><label class="inline-check"><input type="checkbox" name="todas_estaciones" value="1" checked> Acceso a todas las estaciones</label>
          <label>Estaciones asignadas${selectorEstacionesHtml()}</label></div>
        <button class="btn accent" type="submit">+ Agregar usuario</button><div class="err" id="uErr" style="flex-basis:100%"></div></form>
      <div class="tablewrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Correo</th><th>Rol</th><th>Estaciones asignadas</th><th>Último acceso</th><th>Estado</th><th></th></tr></thead><tbody>
      ${r.rows.map((u) => html`<tr><td><b>${u.nombre}</b></td><td>${u.usuario}</td><td>${u.email}</td><td><span class="badge ${u.rol === 'admin' ? 'b-pink' : ['gestor', 'supervisor'].includes(u.rol) ? 'b-info' : 'b-mut'}">${roles[u.rol] ? roles[u.rol].etiqueta : u.rol}</span></td><td class="usuarios-estaciones" title="${u.estaciones && u.estaciones.length ? u.estaciones.map((e) => e.nombre).join(', ') : 'Todas las estaciones'}">${u.estaciones && u.estaciones.length ? html`<div class="usuarios-estaciones-lista">${u.estaciones.map((e) => html`<span class="badge b-mut">${e.nombre}</span>`)}</div>` : 'Todas'}</td>
        <td>${u.ultimo_login ? u.ultimo_login.slice(0, 16).replace('T', ' ') : '—'}</td><td>${u.activo ? html`<span class="badge b-ok">Activo</span>` : html`<span class="badge b-mut">Inactivo</span>`}</td>
        <td><button class="btn small" data-act="editUsuario" data-u="${JSON.stringify(u)}">Editar</button> <button class="btn small" data-act="resetUsuario" data-id="${u.id}" data-name="${u.usuario}">Restablecer contraseña</button></td></tr>`)}</tbody></table></div>
      <div class="grid g2" style="margin-top:18px"><div class="card"><h3>Permisos por rol</h3><div class="tablewrap nomax" style="border:0"><table><tbody>
        <tr><td><b>Administrador General</b></td><td class="wrap">Todo: consultar, registrar abonos y consumos de débito, aplicar pagos, gestionar clientes y crédito, administrar usuarios, cargar el Excel y ver la bitácora.</td></tr>
        <tr><td><b>Gestor de Estación</b></td><td class="wrap">Consultar, exportar, registrar débito y pagos, gestiones de cobranza, altas de clientes y edición de crédito (dentro de su estación).</td></tr>
        <tr><td><b>Supervisor</b></td><td class="wrap">Puede anular prepagos, modificar importes de despachos pendientes y anular pagos dentro de sus estaciones asignadas; no registra pagos ni administra usuarios.</td></tr>
        <tr><td><b>Consulta</b></td><td class="wrap">Solo lectura y exportación.</td></tr></tbody></table></div></div>
        <div class="card"><h3>Bitácora de actividad</h3><p class="mut">Registro de accesos, pagos, movimientos de débito, cambios de crédito, altas y cargas de datos.</p><a class="btn dark" href="#/bitacora">Ver bitácora</a></div></div>`);
    const formU = $('#formU');
    const todasEstacionesU = formU.querySelector('[name="todas_estaciones"]');
    const estacionesSeleccionadasU = conectarSelectorEstaciones(formU);
    formU.onsubmit = async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); const estaciones = estacionesSeleccionadasU();
      if (!todasEstacionesU.checked && !estaciones.length) { $('#uErr').textContent = 'Selecciona al menos una estación o marca “Todas las estaciones”.'; return; }
      b.todas_estaciones = todasEstacionesU.checked; b.estaciones = estaciones; $('#uErr').textContent = '';
      try { const x = await api('/api/usuarios', { method: 'POST', body: b }); mostrarPassword('Usuario creado', b.usuario, x.password_temporal); CG.route(true); }
      catch (er) { $('#uErr').textContent = er.message; }
    };
  };
  const mostrarPassword = (titulo, usuario, pw) => modal(html`<h2>${titulo}</h2><p>Usuario: <b>${usuario}</b></p>
    <p>Contraseña temporal: <code style="font-size:18px;background:var(--warnbg);padding:4px 10px;border-radius:6px;user-select:all">${pw}</code></p>
    <div class="note">Cópiala y compártela de forma segura. No se volverá a mostrar y el usuario deberá cambiarla en su primer acceso.</div>
    <div class="actions"><button class="btn accent" data-act="cerrar">Listo</button></div>`);
  CG.acts.editUsuario = (el) => {
    const u = JSON.parse(el.dataset.u);
    const prev = Array.isArray(u.estaciones) ? u.estaciones.map((e) => Number(e.id || e)) : [];
    const todas = prev.length === 0;
    modal(html`<h2>Editar usuario · ${u.usuario}</h2><form id="formUE" class="form">
      <label>Nombre completo<input name="nombre" value="${u.nombre}" required></label>
      <label>Correo<input name="email" type="email" value="${u.email || ''}"></label>
      <label>Rol<select name="rol">${Object.entries(S.cat.roles).map(([k, v]) => opt(k, v.etiqueta, u.rol))}</select></label>
      <label class="inline-check"><input type="checkbox" name="todas_estaciones" value="1" ${todas ? 'checked' : ''}> Acceso a todas las estaciones</label>
      <label>Estaciones asignadas${selectorEstacionesHtml(prev)}</label>
      <label>Estado<select name="activo">${opt('1', 'Activo', u.activo)}${opt('0', 'Inactivo', u.activo)}</select></label>
      <div class="full err" id="ueErr"></div>
      <div class="full actions"><button type="button" class="btn" data-act="cerrar">Cancelar</button><button class="btn accent">Guardar</button></div></form>`);
    const formUE = $('#formUE');
    const todasEstacionesUE = formUE.querySelector('[name="todas_estaciones"]');
    const estacionesSeleccionadasUE = conectarSelectorEstaciones(formUE);
    formUE.onsubmit = async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); const estaciones = estacionesSeleccionadasUE();
      if (!todasEstacionesUE.checked && !estaciones.length) { $('#ueErr').textContent = 'Selecciona al menos una estación o marca “Todas las estaciones”.'; return; }
      b.todas_estaciones = todasEstacionesUE.checked; b.estaciones = estaciones; b.activo = b.activo === '1';
      try { await api('/api/usuarios/' + u.id, { method: 'PUT', body: b }); toast('Usuario actualizado'); closeModal(); CG.route(true); }
      catch (er) { $('#ueErr').textContent = er.message; }
    };
  };
  CG.acts.resetUsuario = async (el) => {
    if (!confirm(`¿Restablecer la contraseña de ${el.dataset.name}?`)) return;
    try { const r = await api(`/api/usuarios/${el.dataset.id}/reset`, { method: 'POST', body: {} }); mostrarPassword('Contraseña restablecida', el.dataset.name, r.password_temporal); }
    catch (e) { toast(e.message, 'bad'); }
  };

  // =============== BITÁCORA ===============
  CG.routes.bitacora = async () => {
    loading();
    try {
      const r = await api('/api/bitacora');
      setView(html`<div class="crumb"><a href="#/usuarios">‹ Usuarios y Roles</a></div><div class="h"><h2>Bitácora de actividad</h2><p>Últimos 300 eventos (hora UTC).</p></div>
        <div class="tablewrap"><table><thead><tr><th>Fecha (UTC)</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr><td>${x.fecha}</td><td>${x.usuario}</td><td><span class="badge b-info">${x.accion}</span></td><td class="wrap">${x.detalle}</td><td>${x.ip}</td></tr>`)}</tbody></table></div>`);
    } catch (e) { errorView(e); }
  };

  // =============== CARGA DE DATOS ===============
  CG.routes.carga = async () => {
    const c = S.cat;
    setView(html`<div class="up"><h2>Sube tu archivo de Excel</h2>
      <p class="mut">Selecciona el archivo de Excel con las hojas <b>Dim_Clientes, Credito, Debito y CxC</b>. Antes de cualquier carga se genera un respaldo automático.</p>
      <div class="note info" style="text-align:left">Datos actuales: <b>${c.fuente || '—'}</b> · corte ${fdate(c.fecha_corte)}${c.importado_en ? ' · importados ' + c.importado_en.slice(0, 16) : ''}</div>
      <div class="card" style="text-align:left;margin:16px 0">
        <h3>Tipo de carga</h3>
        <label style="display:block;margin:10px 0"><input type="radio" name="cargaModo" value="completa" checked>
          <b>Carga completa</b> — reemplaza todos los datos del Excel y limpia los datos operativos de la aplicación: usuarios, sesiones, pagos, movimientos manuales, facturas capturadas, gestiones, bancos y métodos de pago. Después se crea nuevamente el usuario administrador inicial.</label>
        <label style="display:block;margin:10px 0"><input type="radio" name="cargaModo" value="parcial">
          <b>Carga parcial</b> — reemplaza solo los módulos seleccionados y conserva los demás módulos y registros capturados en la aplicación.</label>
        <div id="modulosParciales" class="hidden" style="margin:12px 0 0 24px">
          <b>Módulos que se reemplazarán</b>
          <label style="display:block;margin-top:8px"><input type="checkbox" name="modulo" value="clientes_credito"> Clientes y crédito (Dim_Clientes + Credito)</label>
          <label style="display:block;margin-top:8px"><input type="checkbox" name="modulo" value="cxc"> CxC / Cartera</label>
          <label style="display:block;margin-top:8px"><input type="checkbox" name="modulo" value="debito"> Débito prepago</label>
          <p class="mut">En cargas parciales, los pagos se marcan conciliados al reemplazar CxC y los movimientos de débito al reemplazar Débito. Los datos se toman del mismo libro Excel completo.</p>
        </div>
        <div class="note" style="margin-top:12px">La carga completa elimina las cuentas existentes y cierra todas las sesiones. Si no está configurada ADMIN_PASSWORD, se mostrará una contraseña temporal nueva al finalizar.</div>
      </div>
      <div class="drop" id="drop"><input type="file" id="xlsx" accept=".xlsx" class="hidden">
        <label for="xlsx" class="btn" style="display:inline-block;cursor:pointer">Examinar archivo…</label><p class="mut" id="fname" style="margin:10px 0 0">Ningún archivo seleccionado (también puedes arrastrarlo aquí)</p></div>
      <button class="btn accent" id="btnCarga" disabled style="padding:12px 30px;font-size:16px">Procesar y Cargar</button>
      <div id="cargaOut" style="margin-top:18px;text-align:left"></div></div>`);
    let file = null;
    const modoEl = () => document.querySelector('input[name="cargaModo"]:checked').value;
    const modulosEls = () => [...document.querySelectorAll('input[name="modulo"]:checked')].map((el) => el.value);
    const actualizarBoton = () => { $('#btnCarga').disabled = !file || (modoEl() === 'parcial' && !modulosEls().length); };
    const set = (f) => { file = f; $('#fname').textContent = f ? `Seleccionado: ${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : 'Ningún archivo seleccionado'; actualizarBoton(); };
    $('#xlsx').onchange = (e) => set(e.target.files[0] || null);
    document.querySelectorAll('input[name="cargaModo"]').forEach((el) => el.addEventListener('change', () => {
      $('#modulosParciales').classList.toggle('hidden', modoEl() !== 'parcial');
      actualizarBoton();
    }));
    document.querySelectorAll('input[name="modulo"]').forEach((el) => el.addEventListener('change', actualizarBoton));
    const d = $('#drop');
    ['dragover', 'dragenter'].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.remove('over'); }));
    d.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && /\.xlsx$/i.test(f.name)) set(f); else toast('Solo se aceptan archivos .xlsx', 'bad'); });
    $('#btnCarga').onclick = async () => {
      if (!file) return;
      const modo = modoEl(), modulos = modulosEls();
      const mensaje = modo === 'completa'
        ? 'CONFIRMACIÓN DE CARGA COMPLETA: se eliminarán usuarios, sesiones, catálogos administrados, pagos, movimientos manuales, facturas capturadas y gestiones. Se creará un nuevo usuario admin. ¿Tienes un respaldo y deseas continuar?'
        : `Se reemplazarán los módulos seleccionados (${modulos.join(', ')}). Los demás datos se conservarán. ¿Continuar?`;
      if (!confirm(mensaje)) return;
      const btn = $('#btnCarga'); btn.disabled = true;
      $('#cargaOut').innerHTML = '<div class="note info"><span class="spin"></span>Procesando el archivo; puede tardar uno o dos minutos. No cierres esta ventana…</div>';
      try {
        const query = new URLSearchParams({ modo, ...(modo === 'parcial' ? { modulos: modulos.join(',') } : {}) });
        const r = await api('/api/carga?' + query, { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream' } });
        $('#cargaOut').innerHTML = html`<div class="note" style="background:var(--okbg);color:var(--oktext)">✔ Datos importados correctamente.<br><small>${r.resumen}<br>Respaldo previo: ${r.respaldo}</small></div>`.s;
        toast('Datos importados exitosamente.');
        if (r.modo === 'completa') {
          CG.onLogout();
          $('#loginErr').className = 'note info';
          $('#loginErr').textContent = r.password_temporal
            ? `Carga completa finalizada. Usuario inicial: admin. Contraseña temporal (anótala ahora): ${r.password_temporal}`
            : 'Carga completa finalizada. Se restableció el usuario admin; inicia sesión con la contraseña configurada en ADMIN_PASSWORD.';
          return;
        }
        await CG.loadCatalogos(); S.corte = S.snap; $('#gCorte').value = S.corte; CG.refreshKpis();
        $('#datainfo').textContent = `Datos de ${S.cat.fuente || 'Excel'} al ${fdate(S.cat.fecha_corte)}`;
      } catch (e) { $('#cargaOut').innerHTML = html`<div class="note">${e.message}</div>`.s; btn.disabled = false; }
    };
  };

  // =============== CONTRASEÑA ===============
  CG.cambiarPassword = (forzado) => {
    modal(html`<h2>${forzado ? 'Debes cambiar tu contraseña' : 'Cambiar contraseña'}</h2>
      ${forzado ? html`<div class="note" style="margin-bottom:12px">Por seguridad, define una contraseña personal antes de continuar.</div>` : ''}
      <form id="formPw" class="form"><label class="full">Contraseña actual<input type="password" name="actual" autocomplete="current-password" required></label>
      <label class="full">Nueva contraseña (mín. 8, con letras y números)<input type="password" name="nueva" autocomplete="new-password" minlength="8" required></label>
      <label class="full">Confirmar nueva contraseña<input type="password" name="confirmar" autocomplete="new-password" required></label>
      <div class="full err" id="pwErr"></div>
      <div class="full actions">${forzado ? '' : html`<button type="button" class="btn" data-act="cerrar">Cancelar</button>`}<button class="btn accent">Guardar</button></div></form>`, { locked: !!forzado });
    $('#formPw').onsubmit = async (e) => {
      e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
      if (b.nueva !== b.confirmar) { $('#pwErr').textContent = 'Las contraseñas no coinciden'; return; }
      try { await api('/api/cambiar-password', { method: 'POST', body: { actual: b.actual, nueva: b.nueva } }); toast('Contraseña actualizada'); closeModal(); S.user.must_change = false; if (forzado) CG.start(); }
      catch (er) { $('#pwErr').textContent = er.message; }
    };
  };
})();
