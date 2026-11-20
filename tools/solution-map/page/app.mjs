// The page in the browser: loads the map, keeps the state in the address, and wires the events.
import { renderPage, parseLocation, pathFor, settle, esc } from './view.mjs';

/** A request only the map's own page may make (see lib/server.mjs). */
const post = (url) => fetch(url, { method: 'POST', headers: { 'x-solution-map': '1' } });

const root = document.getElementById('app');
let vm = null;
let ui = parseLocation(location.pathname, location.search);
const st = { refreshing: false };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* the page works without it */ } },
};
const theme = store.get('solution-map.theme');
if (theme) document.documentElement.dataset.theme = theme;
if (ui.tab === 'explore' && !location.pathname.includes('by-system') && store.get('solution-map.group') === 'system' && !ui.sel) ui.group = 'system';

function render({ push = false, keepFocus = false } = {}) {
  if (!vm) return;
  ui = settle(vm, ui);
  const scroll = [...root.querySelectorAll('.a-list, .a-detail')].map((el) => el.scrollTop);
  root.innerHTML = renderPage(vm, ui, st);
  if (keepFocus) {
    const q = root.querySelector('#q');
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  } else {
    root.querySelectorAll('.a-list').forEach((el, i) => { el.scrollTop = scroll[i] || 0; });
  }
  const want = pathFor(ui, vm);
  if (want !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState'](null, '', want);
  document.title = ui.sel && vm.features[ui.sel] ? `${vm.features[ui.sel].title} · Solution map` : 'Solution map';
}

function go(next, opts = { push: true }) {
  ui = { ...ui, ...next };
  render(opts);
  if (opts.push) root.querySelector('.a-detail')?.scrollTo(0, 0);
}

async function load(url, method = 'GET') {
  st.refreshing = true;
  if (vm) render();
  try {
    let r;
    try {
      r = await (method === 'POST' ? post(url) : fetch(url));
    } catch (e) {
      root.innerHTML = `<div class="banner req"><span class="bt">The map’s server doesn’t answer (${esc(e.message || e)}). Start it again with <span class="mono">node tools/solution-map/solution-map.mjs</span>.</span></div>`;
      return;
    }
    if (!r.ok) {
      root.innerHTML = `<div class="banner req"><span class="bt">The map couldn’t be built: <span class="mono">${esc(await r.text())}</span></span><button class="s-btn" data-act="refresh">Try again</button></div>`;
      return;
    }
    vm = await r.json();
  } finally {
    st.refreshing = false;
  }
  render();
}

function toast(msg) {
  root.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

root.addEventListener('click', (e) => {
  const el = (sel) => e.target.closest(sel);
  let x;
  if ((x = el('[data-review]'))) {
    const id = x.dataset.review;
    x.disabled = true;
    post('/api/review').then((r) => r.json()).then((r) => {
      if (r.ok) go({ started: id }, { push: false });
      else { toast(r.error); x.disabled = false; }
    }, () => { toast('The map’s server doesn’t answer.'); x.disabled = false; });
  } else if ((x = el('[data-act]'))) {
    if (x.dataset.act === 'refresh') load('/api/refresh', 'POST');
    if (x.dataset.act === 'theme') {
      const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      store.set('solution-map.theme', document.documentElement.dataset.theme);
    }
  } else if ((x = el('[data-group]'))) {
    store.set('solution-map.group', x.dataset.group);
    go({ tab: 'explore', group: x.dataset.group, q: '' });
  } else if ((x = el('[data-open]'))) go({ tab: 'explore', group: 'domain', sel: x.dataset.open, q: '' });
  else if ((x = el('[data-sel]'))) go({ sel: x.dataset.sel });
  else if ((x = el('[data-tab]'))) go({ tab: x.dataset.tab, q: x.dataset.tab === 'search' ? ui.q : '', sel: null });
});

root.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  const q = e.target.value;
  ui = { ...ui, q, tab: q.trim() ? 'search' : (ui.tab === 'search' ? 'waiting' : ui.tab), sel: null };
  render({ keepFocus: true });
});

document.addEventListener('keydown', (e) => {
  if (!vm) return;
  if (e.target.id === 'q' && e.key === 'Escape') { go({ q: '', tab: 'waiting', sel: null }); return; }
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === '/') { e.preventDefault(); root.querySelector('#q')?.focus(); return; }
  if ((e.key === 'j' || e.key === 'k') && ui.tab === 'waiting' && vm.waiting.length) {
    const i = vm.waiting.indexOf(ui.sel);
    go({ sel: vm.waiting[Math.max(0, Math.min(vm.waiting.length - 1, i + (e.key === 'j' ? 1 : -1)))] });
  }
});

window.addEventListener('popstate', () => { ui = parseLocation(location.pathname, location.search); render(); });

// Opening the page fetches every repository again, as Refresh does.
load('/api/refresh', 'POST');
