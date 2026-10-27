'use strict';
/* Nucleo: utilidades, plantillas seguras, API, modales y estado global */
window.CG = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---- plantillas con escape automatico ----
  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(s == null ? '' : String(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v));
  const html = (st, ...vs) => new Raw(st.reduce((a, s, i) => a + s + (i < vs.length ? val(vs[i]) : ''), ''));
  const out = (r) => (r instanceof Raw ? r.s : esc(r));

  // ---- formatos ----
  const nf0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n, d = 0) => (n == null || isNaN(n) ? '' : (d ? nf2 : nf0).format(n));
  const int = (n) => (n == null ? '' : new Intl.NumberFormat('es-MX').format(n));
  const pct = (n, d = 0) => (n == null || isNaN(n) ? '' : (n * 100).toFixed(d) + '%');
  const fdate = (s) => (s && s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
  const MES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmes = (ym) => `${MES_C[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  const corto = (n) => String(n || '').replace(/\s*S\.?A\.?\s+De\s+C\.?V\.?/i, '').replace(/^(Gasolinera|Servicio)\s+/i, '').trim();
  const compact = (n) => { const a = Math.abs(n); return (n < 0 ? '-' : '') + '$' + (a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : Math.round(a)); };
  const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const BADGE = { PAGADA: 'b-ok', VENCIDA: 'b-bad', 'POR VENCER': 'b-info', ABONADA: 'b-warn', 'SIN VENCIMIENTO': 'b-warn',
    EXCEDIDO: 'b-bad', 'SIN LÍMITE': 'b-warn', OK: 'b-ok', Abierta: 'b-info', Cumplida: 'b-ok', Incumplida: 'b-bad', Cerrada: 'b-mut',
    RECARGA: 'b-ok', ABONO: 'b-ok', CONSUMO: 'b-warn' };
  const badge = (t) => html`<span class="badge ${BADGE[t] || 'b-mut'}">${t === 'RECARGA' ? 'ABONO' : t}</span>`;
  const diasCell = (d) => (d > 0 ? html`<span class="neg strong">${d}</span>` : html`<span class="mut">al corriente</span>`);

  // ---- estado ----
  const S = { user: null, cat: null, est: '', corte: '', snap: '', alertCount: 0, dash: null, dashP: null, clientes: null };
  const store = { get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => sessionStorage.setItem(k, JSON.stringify(v)) };

  // ---- API ----
  async function api(path, { method = 'GET', body, raw: rawBody, headers } = {}) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: rawBody || (body ? JSON.stringify(body) : undefined) });
    let data = null; try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (res.status === 401 && path !== '/api/login') { CG.onLogout && CG.onLogout(); throw new Error('Sesión expirada'); }
    if (!res.ok) { const e = new Error((data && data.error) || `Error ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const gp = (extra = {}) => ({ estacion: S.est, corte: S.corte, ...extra });
  const can = (p) => !!S.user && S.user.permisos.includes(p);

  // ---- UI ----
  let toastT;
  function toast(msg, kind) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind === true || kind === 'bad' ? ' bad' : kind === 'warn' ? ' warn' : '');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), kind ? 6000 : 3200);
  }
  function modal(content, { wide = false, locked = false } = {}) {
    $('#modalBox').className = 'modal-box' + (wide ? ' wide' : '');
    $('#modalBox').innerHTML = out(content);
    $('#modal').classList.remove('hidden'); $('#modal').dataset.locked = locked ? '1' : '';
    const f = $('#modalBox input:not([type=hidden]),#modalBox select,#modalBox textarea'); if (f) f.focus();
  }
  const closeModal = () => { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; };
  const setView = (c) => { $('#view').innerHTML = out(c); };
  const loading = () => setView(html`<div class="empty">Cargando…</div>`);
  const errorView = (e) => setView(html`<div class="note">${e.message || e}</div>`);
  const thSort = (label, key, st, cls = '') => html`<th class="sort ${cls} ${st.sort === key ? 'on ' + (st.dir === 'asc' ? 'asc' : '') : ''}" data-sort="${key}">${label}</th>`;
  const pager = (st, total, size) => {
    const pages = Math.max(1, Math.ceil(total / size));
    return html`<div class="pager"><span>${int(total)} registros · página ${st.page} de ${pages}</span>
      <button class="btn small" data-page="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
      <button class="btn small" data-page="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>Siguiente ›</button></div>`;
  };
  function bindFilters(root, st, onChange) {
    let t;
    const set = (el) => { st[el.dataset.f] = el.value; st.page = 1; };
    root.addEventListener('input', (e) => { const el = e.target.closest('[data-f]'); if (!el || el.tagName === 'SELECT' || el.type === 'date') return; set(el); clearTimeout(t); t = setTimeout(onChange, 300); });
    root.addEventListener('change', (e) => { const el = e.target.closest('[data-f]'); if (!el) return; set(el); clearTimeout(t); onChange(); });
  }
  const opt = (v, label, cur) => html`<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;

  // Selector de cliente con busqueda (datalist). Devuelve {html, resolver}
  function clientePicker(id, lista, { placeholder = 'Escribe para buscar…' } = {}) {
    const etiq = (c) => `${c.cliente} · ${corto(c.estacion)}`;
    const map = new Map(lista.map((c) => [etiq(c), c]));
    return {
      html: html`<input id="${id}" list="${id}-dl" autocomplete="off" placeholder="${placeholder}" required><datalist id="${id}-dl">${lista.map((c) => html`<option value="${etiq(c)}"></option>`)}</datalist>`,
      resolver: () => map.get(($('#' + id).value || '').trim()) || null,
      etiqueta: etiq, map,
    };
  }

  // ---- graficas ----
  const PALETA = ['#059669', '#84cc16', '#f5b301', '#f08a24', '#e5532d', '#c62828', '#7f1d1d'];
  function trendSVG(t) {
    const W = 720, H = 250, pl = 52, pr = 8, pt = 10, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
    const max = Math.max(1, ...t.flatMap((x) => [x.facturado, x.cobrado]));
    const step = Math.pow(10, Math.floor(Math.log10(max))); let top = Math.ceil(max / step) * step; if (top / max > 1.6) top = Math.ceil(max / (step / 2)) * (step / 2);
    const gw = iw / t.length, bw = Math.min(18, gw / 2.6);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Facturado contra cobrado, últimos 12 meses">`;
    for (let i = 0; i <= 4; i++) { const y = pt + ih - (ih * i) / 4; s += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#e2e8f0"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${compact((top * i) / 4)}</text>`; }
    t.forEach((x, i) => {
      const cx = pl + gw * i + gw / 2, h1 = (x.facturado / top) * ih, h2 = (x.cobrado / top) * ih;
      s += `<rect x="${cx - bw - 1}" y="${pt + ih - h1}" width="${bw}" height="${h1}" rx="3" fill="#172033"><title>${esc(fmes(x.mes))} facturado: ${esc(money(x.facturado))}</title></rect>`;
      s += `<rect x="${cx + 1}" y="${pt + ih - h2}" width="${bw}" height="${h2}" rx="3" fill="#c50063"><title>${esc(fmes(x.mes))} cobrado: ${esc(money(x.cobrado))}</title></rect>`;
      s += `<text x="${cx}" y="${H - 9}" text-anchor="middle">${esc(fmes(x.mes))}</text>`;
    });
    return raw(s + '</svg>');
  }
  const useBar = (u) => { if (u == null) return html`<span class="mut">—</span>`; const w = Math.min(100, u * 100); const c = u > 1 ? '#dc2626' : u > 0.8 ? '#f08a24' : '#059669';
    return html`<span class="useBar"><i style="width:${w}%;background:${c}"></i></span> <small>${u > 9.99 ? '>999%' : pct(u)}</small>`; };

  return { $, $$, raw, esc, html, out, money, int, pct, fdate, fmes, corto, compact, hoyLocal, qs, badge, diasCell, S, store, api, gp, can, toast, modal,
    closeModal, setView, loading, errorView, thSort, pager, bindFilters, opt, clientePicker, trendSVG, useBar, PALETA, routes: {}, acts: {}, changes: {} };
})();
