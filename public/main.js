'use strict';
/* Arranque, pestanas, KPIs globales, enrutador y eventos */
(() => {
  const { $, html, S, api, can, store, toast, closeModal, fdate, qs, hoyLocal, money, int, pct } = CG;

  const NAV = [
    { id: 'clientes', label: 'Clientes', perm: 'ver' },
    { id: 'cartera', label: 'Cartera', perm: 'ver' },
    { id: 'debito', label: 'Prepago', perm: 'ver' },
    { id: 'pagos', label: 'Pagos', perm: 'pagos' },
    { id: 'por-facturar', label: 'Despachos', perm: 'ver' },
    { id: 'cobranza', label: 'Cobranza', perm: 'ver' },
    { id: 'catalogos', label: 'Catálogos', perm: 'ver' },
    { id: 'usuarios', label: 'Usuarios', perm: 'usuarios' },
    { id: 'carga', label: 'Importar', perm: 'carga' },
    { id: 'alertas', label: 'Alertas', perm: 'ver', badge: true },
  ];
  const ALIAS = { cliente: 'clientes', bitacora: 'usuarios' };
  let current = '';

  function renderNav() {
    const act = ALIAS[current] || current;
    $('#tabs').innerHTML = NAV.filter((n) => can(n.perm)).map((n) =>
      `<a href="#/${n.id}" class="${act === n.id ? 'on' : ''}">${n.label}${n.badge && S.alertCount ? `<span class="cnt">${S.alertCount}</span>` : ''}</a>`).join('');
  }
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '') || 'cartera';
    const [path, qstr] = h.split('?'); const [name, ...args] = path.split('/');
    return { name, args, query: Object.fromEntries(new URLSearchParams(qstr || '').entries()) };
  }
  function renderKpis(d) {
    const k = d.kpis;
    $('#kpis').innerHTML = html`
      <div class="kpi k-blue"><span class="l">Facturas abiertas (CxC)</span><span class="v">${int(k.facturas_abiertas)}</span><span class="s">${int(k.clientes_con_saldo)} clientes con saldo</span></div>
      <div class="kpi"><span class="l">Saldo abierto (CxC)</span><span class="v">${money(k.facturada, 2)}</span><span class="s">+ ${money(k.por_facturar, 2)} por facturar</span></div>
      <div class="kpi k-red"><span class="l">Saldo vencido (CxC)</span><span class="v">${money(k.vencida, 2)}</span><span class="s">${pct(k.pct_vencida, 1)} del saldo abierto · ${money(k.mayor_60, 2)} a más de 60 días</span></div>
      <div class="kpi k-green"><span class="l">Saldo a favor (Débito)</span><span class="v">${money(k.saldo_a_favor, 2)}</span><span class="s">${int(k.clientes_a_favor)} clientes con saldo prepagado</span></div>`.s;
  }
  let dashboardCacheKey = '', dashboardRequest = null;
  let sessionGeneration = 0;
  const dashboardKey = () => `${sessionGeneration}|${S.user && S.user.id}|${S.est}|${S.corte}|${S.revision}`;
  const loadDashboard = () => {
    const key = dashboardKey();
    const p = api('/api/dashboard?' + qs({ estacion: S.est, corte: S.corte })).then((d) => {
      if (key === dashboardKey()) {
        dashboardCacheKey = key;
        S.dash = d; renderKpis(d); S.alertCount = d.kpis.excedidos + d.kpis.promesas_vencidas; renderNav();
      }
      return d;
    }).catch((e) => {
      console.error('No se pudieron actualizar los indicadores', e);
      if (key === dashboardKey() && e.status !== 401) {
        $('#kpis').innerHTML = html`<div class="note" role="alert">No se pudieron actualizar los indicadores. ${e.message || 'Intenta de nuevo.'}</div>`.s;
      }
      return null;
    });
    S.dashP = p;
    dashboardRequest = { key, promise: p };
    p.finally(() => { if (dashboardRequest && dashboardRequest.promise === p) dashboardRequest = null; });
    return p;
  };
  CG.refreshKpis = loadDashboard;
  CG.ensureKpis = () => {
    const key = dashboardKey();
    if (S.dash && dashboardCacheKey === key) {
      S.dashP = Promise.resolve(S.dash);
      return S.dashP;
    }
    if (dashboardRequest && dashboardRequest.key === key) return dashboardRequest.promise;
    return loadDashboard();
  };
  CG.refreshAlerts = CG.refreshKpis;

  async function route(keep) {
    const { name, args, query } = parseHash();
    const fn = CG.routes[name] || CG.routes.cartera;
    current = CG.routes[name] ? name : 'cartera';
    renderNav();
    CG.ensureKpis();
    if (keep !== true) window.scrollTo(0, 0);
    try { await fn(args, query, keep === true); } catch (e) { console.error(e); toast(e.message || 'Error', true); }
  }
  CG.route = route;

  function infoBar() {
    const c = S.cat;
    $('#datainfo').textContent = `Datos de ${c.fuente || 'Excel'} al ${fdate(c.fecha_corte)}${c.importado_en ? ` · importados ${c.importado_en.slice(0, 16)}` : ''} · Corte usado: ${fdate(S.corte)}`;
  }
  CG.loadCatalogos = async () => {
    S.cat = await api('/api/catalogos'); S.snap = S.cat.fecha_corte; S.clientes = null;
    const ids = Array.isArray(S.user.estaciones) && S.user.estaciones.length ? S.user.estaciones : null;
    const opts = ids ? S.cat.estaciones.filter((e) => ids.includes(e.id)) : S.cat.estaciones;
    $('#gEst').innerHTML = (ids ? '' : '<option value="">Todas las estaciones</option>') + opts.map((e) => `<option value="${e.id}">${CG.esc(e.nombre)}</option>`).join('');
    if (ids && !ids.includes(Number(S.est))) S.est = String(ids[0]);
    $('#gEst').value = S.est;
  };
  CG.clientesLista = (conFacturas) => {
    const key = `${sessionGeneration}|${S.user && S.user.id}|${S.est}|${conFacturas ? S.corte : ''}|${conFacturas ? 1 : 0}`;
    if (S.clientes && S.clientes.key === key) return S.clientes.promise || S.clientes.rows;
    const promise = api('/api/clientes-lista?' + qs({ estacion: S.est, con_facturas: conFacturas ? 1 : '', corte: S.corte }))
      .then((r) => {
        if (S.clientes && S.clientes.promise === promise) S.clientes = { key, rows: r.rows };
        return r.rows;
      })
      .catch((e) => {
        if (S.clientes && S.clientes.promise === promise) S.clientes = null;
        throw e;
      });
    S.clientes = { key, promise };
    return promise;
  };

  async function start() {
    sessionGeneration++;
    dashboardCacheKey = '';
    dashboardRequest = null;
    S.dash = null; S.dashP = null; S.clientes = null;
    const ids = Array.isArray(S.user.estaciones) && S.user.estaciones.length ? S.user.estaciones : null;
    const defaultEst = ids ? String(ids[0]) : (store.get('est', ''));
    S.est = ids ? (ids.includes(Number(store.get('est', defaultEst))) ? String(store.get('est', defaultEst)) : String(ids[0])) : store.get('est', '');
    await CG.loadCatalogos();
    S.corte = store.get('corte', S.snap);
    $('#gEst').value = S.est; $('#gEst').disabled = !!(ids && ids.length === 1);
    $('#gCorte').value = S.corte;
    $('#whoName').textContent = S.user.nombre;
    $('#whoRole').textContent = S.user.rol_etiqueta + (ids && ids.length ? ' · ' + ids.map((id) => CG.corto(S.cat.estaciones.find((e) => e.id === id)?.nombre || String(id))).join(', ') : '');
    infoBar();
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    route();
  }
  CG.start = start;

  async function boot() {
    try {
      S.user = await api('/api/me');
      if (S.user.must_change) { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); CG.cambiarPassword(true); return; }
      await start();
    } catch { showLogin(); }
  }
  function showLogin() { $('#app').classList.add('hidden'); CG.closeModal(); $('#login').classList.remove('hidden'); $('#loginForm').reset(); $('#loginErr').className = 'err'; $('#loginErr').textContent = ''; }
  CG.onLogout = showLogin;

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#loginErr').className = 'err'; $('#loginErr').textContent = '';
    try { await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); await boot(); }
    catch (er) { $('#loginErr').textContent = er.message; }
  });
  $('#btnOut').onclick = async () => { try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* */ } showLogin(); };
  $('#btnPass').onclick = () => CG.cambiarPassword(false);
  const setCorte = (v) => { S.corte = v; store.set('corte', v); $('#gCorte').value = v; infoBar(); route(true); };
  $('#gCorte').onchange = (e) => e.target.value && setCorte(e.target.value);
  $('#btnHoy').onclick = () => setCorte(hoyLocal());
  $('#btnSnap').onclick = () => setCorte(S.snap);
  $('#gEst').onchange = (e) => { S.est = e.target.value; store.set('est', S.est); route(true); };
  window.addEventListener('hashchange', () => route());

  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const name = act.dataset.act;
      if (name === 'cerrar') {
        const href = act.getAttribute('href');
        closeModal();
        if (href) {
          if (location.hash === href) route();
          else location.hash = href;
        } else {
          e.preventDefault();
        }
        return;
      }
      const fn = CG.acts[name];
      if (fn) { if (act.tagName !== 'A') e.preventDefault(); e.stopPropagation(); fn(act, e); return; }
    }
    const go = e.target.closest('[data-go]');
    if (go && !e.target.closest('a,button,select,input')) { closeModal(); location.hash = go.dataset.go; }
    if (e.target.id === 'modal' && $('#modal').dataset.locked !== '1') closeModal();
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act-change]');
    if (el && CG.changes[el.dataset.actChange]) CG.changes[el.dataset.actChange](el);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal').dataset.locked !== '1') closeModal(); });
  boot();
})();
