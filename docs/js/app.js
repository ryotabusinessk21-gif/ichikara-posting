// イチカラ ポスティング — 画面
import { params, zoneProgress, selection, split, orderFor, calibration, estMinutes, totals } from './plan.js';
import { Store } from './store.js';
import { CONFIG } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const fmt = (n) => Math.round(n).toLocaleString('ja-JP');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } },
};
const COLOR = { A: '#2f6fdb', B: '#ef7d1a', done: '#2e9d5b', accent: '#e0115f' };

const app = {
  tab: 'plan', tool: null, prevSide: {}, routes: null, todayZone: LS.get('todayZone', null),
  session: LS.get('session', null), bulk: null, wake: null, watchId: null, meMarker: null, meCircle: null,
};

// ---------- データ読み込み ----------
async function loadJSON(p) { const r = await fetch(p, { cache: 'no-cache' }); if (!r.ok) throw new Error(p); return r.json(); }

async function boot() {
  const [plan, zonesGJ, blocksGJ, towns] = await Promise.all(
    ['data/plan.json', 'data/zones.json', 'data/blocks.json', 'data/towns.json'].map(loadJSON));
  app.plan = plan;
  app.zonesGJ = zonesGJ;
  app.zones = zonesGJ.features.map((f) => f.properties);
  app.zonesById = Object.fromEntries(app.zones.map((z) => [z.id, z]));
  app.blocksGJ = blocksGJ;
  app.blocksById = Object.fromEntries(blocksGJ.features.map((f) => [f.properties.id, f.properties]));
  app.blocksByZone = {};
  for (const f of blocksGJ.features) (app.blocksByZone[f.properties.z] ||= []).push(f.properties);
  app.towns = towns;

  app.store = new Store(CONFIG.GAS_URL, { onChange: () => refresh(), onStatus: renderSync });
  window.__app = app; // 不具合調査用（ブラウザのコンソールから状態を見る）
  initMap();
  initTabs();
  recalc();
  setTab(LS.get('tab', 'plan'));
  await firstRun();
  app.store.start(CONFIG.POLL_MS).catch(() => {});
  renderSync(app.store.status() || {});
}

// ---------- 初回: 合言葉・あなたは誰 ----------
function names() {
  const s = app.store.state.setting;
  return { A: s.name_A?.v || 'A', B: s.name_B?.v || 'B' };
}

async function firstRun() {
  if (CONFIG.GAS_URL && !app.store.key) {
    await new Promise((resolve) => {
      const ask = (msg = '') => modal(`<h2>合言葉</h2><p>二人で決めた合言葉を入れてください。${msg}</p>
        <input id="pw" type="password" autocomplete="current-password"><div class="row"><button class="btn primary" id="ok">入る</button></div>`, (card) => {
        $('#ok', card).onclick = async () => {
          app.store.key = $('#pw', card).value.trim();
          const j = await app.store.pull().catch(() => ({ ok: false, error: 'network' }));
          if (j?.ok) { closeModal(); resolve(); } else ask(j?.error === 'auth' ? '<br><b>合言葉が違います。</b>' : '<br><b>つながりません。電波を確認してください。</b>');
        };
      });
      ask();
    });
  }
  if (!app.store.me) await chooseMe();
}

function chooseMe() {
  return new Promise((resolve) => {
    const n = names();
    modal(`<h2>あなたはどちら？</h2><p>この端末で配る人を選んでください。あとで「その他」から変えられます。</p>
      <div class="row"><button class="btn A" data-p="A">${esc(n.A)}</button><button class="btn B" data-p="B">${esc(n.B)}</button></div>`, (card) => {
      card.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { app.store.me = b.dataset.p; closeModal(); refresh(); resolve(); }));
    });
  });
}

// ---------- 地図 ----------
function initMap() {
  const s = app.plan.studio;
  const map = L.map('map', { zoomControl: false, preferCanvas: true, tap: true }).setView([s.lat, s.lon], 14);
  app.map = map;
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 18,
    attribution: '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>／道路 © OpenStreetMap contributors (ODbL)／世帯数：令和2年国勢調査（e-Stat）を加工',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const renderer = L.canvas({ padding: 0.3, tolerance: 4 });
  app.renderer = renderer;

  app.zoneLayer = L.geoJSON(app.zonesGJ, { renderer, style: () => ({}), onEachFeature: (f, l) => l.on('click', (e) => onZoneClick(f.properties.id, e)) }).addTo(map);
  app.zoneLayers = {};
  app.zoneLayer.eachLayer((l) => (app.zoneLayers[l.feature.properties.id] = l));
  app.blockLayer = L.geoJSON(app.blocksGJ, { renderer, style: () => ({}), onEachFeature: (f, l) => l.on('click', (e) => onBlockClick(f.properties.id, e)) });
  app.blockLayers = {};
  app.blockLayer.eachLayer((l) => (app.blockLayers[l.feature.properties.id] = l));
  app.labelLayer = L.layerGroup().addTo(map);
  app.routeLayer = L.layerGroup().addTo(map);
  app.arrowLayer = L.layerGroup().addTo(map);
  L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'pin', html: '<div>★スタジオ</div>' }), interactive: false }).addTo(map);
  map.on('zoomend', () => { renderLabels(); drawArrows(); });
  $('#btnLocate').onclick = toggleLocate;
}

function zoneStyle(z) {
  const C = app.C;
  const inSel = C.sel.has(z.id);
  const side = C.side[z.id];
  const prio = app.store.state.zprio[z.id]?.v === '1';
  const done = (C.prog[z.id]?.frac ?? 0) >= 0.999;
  if (app.tab === 'plan') {
    if (inSel) return { color: prio ? COLOR.accent : '#fff', weight: prio ? 3 : 1, fillColor: done ? COLOR.done : COLOR[side], fillOpacity: 0.42, opacity: 1 };
    if (z.a > 0) return { color: '#555', weight: 1, fillColor: '#999', fillOpacity: 0.12, dashArray: '4 3' };
    return { color: '#aaa', weight: 0.6, fillColor: '#ccc', fillOpacity: 0.05 };
  }
  if (app.tab === 'today') {
    if (z.id === app.todayZone) return { color: COLOR.accent, weight: 3, fillOpacity: 0, opacity: 1 };
    return { color: inSel ? '#888' : '#ccc', weight: 0.6, fillOpacity: 0 };
  }
  return { color: inSel ? COLOR[side] : '#ccc', weight: inSel ? 1.2 : 0.5, fillOpacity: 0, opacity: 0.9 };
}

function blockStyle(b) {
  const done = app.store.state.block[b.id]?.v === '1';
  const cur = b.z === app.todayZone;
  if (app.tab === 'today') {
    if (done) return { color: COLOR.done, weight: 0.5, fillColor: COLOR.done, fillOpacity: cur ? 0.55 : 0.3 };
    return { color: cur ? '#666' : '#ccc', weight: cur ? 0.8 : 0.3, fillColor: '#fff', fillOpacity: cur ? 0.2 : 0 };
  }
  if (done) return { color: COLOR.done, weight: 0.4, fillColor: COLOR.done, fillOpacity: 0.55 };
  const inSel = app.C.sel.has(b.z);
  return { color: inSel ? '#999' : '#ddd', weight: 0.3, fillColor: '#fff', fillOpacity: inSel ? 0.15 : 0 };
}

function restyle() {
  for (const z of app.zones) app.zoneLayers[z.id]?.setStyle(zoneStyle(z));
  const showBlocks = app.tab !== 'plan';
  if (showBlocks && !app.map.hasLayer(app.blockLayer)) app.blockLayer.addTo(app.map);
  if (!showBlocks && app.map.hasLayer(app.blockLayer)) app.map.removeLayer(app.blockLayer);
  if (showBlocks) for (const id in app.blockLayers) app.blockLayers[id].setStyle(blockStyle(app.blocksById[id]));
  renderLabels();
}

function renderLabels() {
  app.labelLayer.clearLayers();
  if (app.tab !== 'plan' || app.map.getZoom() < 13) return;
  const C = app.C;
  for (const z of app.zones) {
    if (!C.sel.has(z.id) || !z.lp) continue;
    const done = (C.prog[z.id]?.frac ?? 0) >= 0.999;
    const star = app.store.state.zprio[z.id]?.v === '1' ? '★' : '';
    const cls = done ? 'done' : C.side[z.id] || 'N';
    L.marker(z.lp, { interactive: false, icon: L.divIcon({ className: 'zlabel', html: `<span class="${cls}">${star}${C.num[z.id] || ''}</span>` }) }).addTo(app.labelLayer);
  }
}

// ---------- 計算 ----------
function recalc() {
  const st = app.store.state;
  const prm = params(st, app.plan);
  const prog = zoneProgress(app.blocksByZone, st);
  const { sel, covered, doneOutside } = selection(app.zones, st, prog, prm);
  const side = split(app.zones, sel, st, prog, prm, app.prevSide);
  app.prevSide = side;
  const order = { A: orderFor('A', app.zones, side, st, prog), B: orderFor('B', app.zones, side, st, prog) };
  const num = {};
  for (const p of ['A', 'B']) order[p].forEach((z, i) => (num[z.id] = `${p}-${i + 1}`));
  app.C = { st, prm, prog, sel, covered, doneOutside, side, order, num,
    tot: totals(app.zones, sel, side, st, prog, prm), cal: calibration(st, app.blocksById, app.zonesById, prm) };
}

function refresh() {
  recalc();
  restyle();
  renderSummary();
  if (app.sheetRender) app.sheetRender();
}

// ---------- タブ ----------
function initTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('#sheet .close').onclick = closeSheet;
}

function setTab(t) {
  if (t === 'more') { openSettings(); return; }
  app.tab = t;
  LS.set('tab', t);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  app.tool = null;
  closeSheet();
  hideToolbar();
  app.routeLayer.clearLayers();
  app.arrowLayer.clearLayers();
  app.routeLatLngs = null;
  if (t === 'today') enterToday();
  if (t === 'progress' && app.bulk) showBulkToolbar();
  if (t === 'plan' && !app.fitted) fitSelection();
  restyle();
  renderSummary();
}

function fitSelection() {
  const ls = [...app.C.sel].map((id) => app.zoneLayers[id]).filter(Boolean);
  if (!ls.length) return;
  app.map.fitBounds(L.featureGroup(ls).getBounds(), { padding: [20, 20] });
  app.fitted = true;
}

// ---------- 上部のまとめ ----------
function renderSummary() {
  const el = $('#summary');
  const { tot, prm, cal } = app.C;
  const n = names();
  const rateNote = app.C.st.setting.rate ? `推定率 ${prm.rate.toFixed(2)}（実績で補正）` : `推定率 ${prm.rate.toFixed(2)}（全世帯に1枚の上限仮定・未補正）`;
  if (app.tab === 'plan') {
    el.innerHTML = `<div class="row"><b>計画 ${fmt(app.C.covered)} / ${fmt(prm.target)}枚</b><span class="muted">${rateNote}</span></div>
      <div class="row"><span class="chip A">${esc(n.A)}</span> ${fmt(tot.A)}枚・約${tot.outsA}回
        <span class="chip B">${esc(n.B)}</span> ${fmt(tot.B)}枚・約${tot.outsB}回</div>
      <div class="muted">区画 ${app.C.sel.size}・配り済み（対象外）${fmt(app.C.doneOutside)}枚相当 ／ 世帯数は2020年国勢調査</div>
      <div class="btns"><button class="btn small ${app.tool ? 'on' : ''}" id="bEdit">${app.tool ? '編集中' : '編集'}</button>
        <button class="btn small" id="bTowns">町名リスト</button></div>`;
    $('#bEdit').onclick = () => (app.tool ? exitEdit() : enterEdit());
    $('#bTowns').onclick = openTownList;
  } else if (app.tab === 'today') {
    renderTodaySummary();
  } else if (app.tab === 'progress') {
    const pct = Math.min(100, (tot.actual / prm.target) * 100);
    el.innerHTML = `<div class="row"><b>実績 ${fmt(tot.actual)} / ${fmt(prm.target)}枚</b><span class="muted">${pct.toFixed(1)}%</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row"><span class="chip A">${esc(n.A)}</span> ${fmt(tot.actualA)}枚・${tot.outingsA}回
        <span class="chip B">${esc(n.B)}</span> ${fmt(tot.actualB)}枚・${tot.outingsB}回</div>
      <div class="muted">塗ったブロックの世帯 ${fmt(tot.doneH)}（推定 ${fmt(tot.doneEst)}枚相当）${cal.ready && cal.rate ? `・実測率 ${cal.rate.toFixed(2)}` : ''}</div>
      <div class="btns"><button class="btn small ${app.bulk ? 'on' : ''}" id="bBulk">まとめて塗る（過去の分）</button>
        <button class="btn small" id="bHist">履歴</button><button class="btn small" id="bCal">補正</button></div>`;
    $('#bBulk').onclick = () => (app.bulk ? cancelBulk() : startBulk());
    $('#bHist').onclick = openHistory;
    $('#bCal').onclick = openCalibration;
  }
}

function renderSync(s) {
  const el = $('#sync');
  if (!el || !app.store) return;
  s = s || {};
  el.classList.remove('warn');
  if (!CONFIG.GAS_URL) { el.textContent = 'この端末のみ'; el.title = '共有の設定がまだです'; return; }
  const q = app.store.queue.length;
  if (s.error === 'auth') { el.textContent = '合言葉エラー'; el.classList.add('warn'); return; }
  if (q) { el.textContent = `未送信 ${q}`; el.classList.add('warn'); return; }
  if (s.error) { el.textContent = s.error === 'offline' ? 'オフライン' : '同期エラー'; el.classList.add('warn'); return; }
  const t = app.store.lastOk;
  el.textContent = t ? `同期 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '同期中…';
}

// ---------- 計画: 区画の詳細・編集 ----------
function onZoneClick(id, e) {
  if (app.tab === 'plan') {
    if (app.tool) { applyTool(id); return; }
    openZone(id);
  } else if (app.tab === 'today' && !app.session && id !== app.todayZone) {
    openZone(id);
  }
}

function zoneFacts(z) {
  const C = app.C;
  const st = C.st;
  const n = names();
  const side = C.side[z.id];
  const manual = st.zperson[z.id]?.v;
  const pr = C.prog[z.id] || { frac: 0 };
  const flags = (z.f || '').split(',').filter(Boolean).map((f) => ({ big: '大型集合住宅の可能性', small: '小さい区画' }[f] || f));
  if (z.apt) flags.push(`集合住宅の印 ${z.apt}`);
  if (!z.ok) flags.push('ルートなし（建物のある道が見つからない）');
  return `<dl>
    <dt>推定世帯数</dt><dd>${fmt(z.h)}世帯 <span class="meta">2020年国勢調査</span></dd>
    <dt>推定配布数</dt><dd>${fmt(z.h * C.prm.rate)}枚 <span class="meta">世帯数×推定率</span></dd>
    <dt>ルート</dt><dd>${(z.rm / 1000).toFixed(1)}km・目安${estMinutes(z, C.prm, app.plan)}分 <span class="meta">推定値</span></dd>
    <dt>担当</dt><dd>${C.sel.has(z.id) ? `<span class="chip ${side}">${esc(n[side])}</span> ${C.num[z.id] || ''} ${manual ? '（手動）' : '（自動）'}` : '対象外'}</dd>
    <dt>状態</dt><dd>${pr.frac >= 0.999 ? '完了' : pr.frac > 0 ? `途中 ${Math.round(pr.frac * 100)}%` : '未着手'}</dd>
    ${flags.length ? `<dt>メモ</dt><dd>${flags.map(esc).join('・')}</dd>` : ''}
  </dl>`;
}

function openZone(id) {
  const z = app.zonesById[id];
  openSheet(() => {
    const C = app.C;
    const st = C.st;
    const inSel = C.sel.has(id);
    const prio = st.zprio[id]?.v === '1';
    const manual = st.zperson[id]?.v || '';
    const n = names();
    const area = app.plan.areas[String(z.a)] || 'その他';
    return `<h3>${esc(z.l)}</h3><div class="meta">${esc(area)}・区画 ${esc(id)}</div>${zoneFacts(z)}
      <div class="actions">
        <button class="btn ${inSel ? '' : 'primary'}" data-act="sel">${inSel ? '対象から外す' : '対象に入れる'}</button>
        <button class="btn ${prio ? 'on' : ''}" data-act="prio">${prio ? '★優先を外す' : '☆優先にする'}</button>
      </div>
      <div class="actions">担当：
        <button class="btn small ${manual === 'A' ? 'A' : ''}" data-act="pA">${esc(n.A)}</button>
        <button class="btn small ${manual === 'B' ? 'B' : ''}" data-act="pB">${esc(n.B)}</button>
        <button class="btn small ${manual ? '' : 'on'}" data-act="pAuto">自動</button>
      </div>
      <div class="actions"><button class="btn primary" data-act="go">この区画を配る（ルート表示）</button></div>`;
  }, (body) => {
    body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.act;
      const inSel = app.C.sel.has(id);
      if (a === 'sel') app.store.push('zsel', id, inSel ? 'out' : 'in');
      if (a === 'prio') app.store.push('zprio', id, app.C.st.zprio[id]?.v === '1' ? '0' : '1');
      if (a === 'pA') app.store.push('zperson', id, 'A');
      if (a === 'pB') app.store.push('zperson', id, 'B');
      if (a === 'pAuto') app.store.push('zperson', id, '');
      if (a === 'go') { app.todayZone = id; LS.set('todayZone', id); setTab('today'); }
    }));
  });
}

const TOOLS = { sel: '対象ON/OFF', prio: '優先★', pA: '担当A', pB: '担当B', auto: '自動に戻す' };
function enterEdit() {
  app.tool = 'sel';
  closeSheet();
  showToolbar();
  renderSummary();
}
function exitEdit() { app.tool = null; hideToolbar(); renderSummary(); }
function showToolbar() {
  const n = names();
  const tb = $('#toolbar');
  tb.hidden = false;
  tb.innerHTML = `<div class="label">道具を選んで、地図の区画をタップ</div>` +
    Object.entries(TOOLS).map(([k, v]) => `<button class="btn small ${app.tool === k ? 'on' : ''}" data-t="${k}">${esc(v.replace('担当A', `担当${n.A}`).replace('担当B', `担当${n.B}`))}</button>`).join('') +
    `<button class="btn small primary" data-t="__done">完了</button>`;
  tb.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
    if (b.dataset.t === '__done') { exitEdit(); return; }
    app.tool = b.dataset.t;
    showToolbar();
  }));
}
function hideToolbar() { const tb = $('#toolbar'); tb.hidden = true; tb.innerHTML = ''; }

function applyTool(id) {
  const st = app.C.st;
  if (app.tool === 'sel') app.store.push('zsel', id, app.C.sel.has(id) ? 'out' : 'in');
  if (app.tool === 'prio') app.store.push('zprio', id, st.zprio[id]?.v === '1' ? '0' : '1');
  if (app.tool === 'pA') app.store.push('zperson', id, 'A');
  if (app.tool === 'pB') app.store.push('zperson', id, 'B');
  if (app.tool === 'auto') app.store.pushMany([['zsel', id, ''], ['zperson', id, '']]);
}

// ---------- 町名リスト ----------
function openTownList() {
  app.townQuery = app.townQuery || '';
  openSheet(() => {
    const q = app.townQuery.replace(/ヶ|ヵ/g, 'ケ');
    const C = app.C;
    const groups = {};
    for (const [cho, t] of Object.entries(app.towns)) {
      const name = `${t.n}${t.g ? `（${t.g}）` : ''}`;
      if (q && !name.replace(/ヶ|ヵ/g, 'ケ').includes(q)) continue;
      (groups[t.a] ||= []).push({ cho, ...t, name });
    }
    const order = ['1', '2', '3', '4', '5', '0'];
    let html = `<h3>町名リスト</h3><input type="search" id="tq" placeholder="町名で探す（例: 岩倉、修学院）" value="${esc(app.townQuery)}">`;
    for (const a of order) {
      const g = (groups[a] || []).sort((x, y) => x.d - y.d);
      if (!g.length) continue;
      const shown = a === '0' && !q ? g.slice(0, 60) : g;
      html += `<div class="group-h">${esc(app.plan.areas[a] || 'その他（近い順）')} ${a === '0' && !q && g.length > 60 ? `— 上位60件。検索で全件` : ''}</div><ul class="list">`;
      for (const t of shown) {
        const zs = t.z.filter((id) => app.zonesById[id]);
        const nIn = zs.filter((id) => C.sel.has(id)).length;
        const tri = nIn === 0 ? '' : nIn === zs.length ? 'all' : 'some';
        const prio = zs.length && zs.every((id) => C.st.zprio[id]?.v === '1');
        html += `<li><button class="tri ${tri}" data-cho="${t.cho}">${tri === 'all' ? '✓' : tri === 'some' ? '−' : ''}</button>
          <div class="grow"><div>${esc(t.name)}</div><div class="sub">${fmt(t.h)}世帯・${zs.length}区画・${(t.d / 1000).toFixed(1)}km</div></div>
          <button class="star ${prio ? 'on' : ''}" data-star="${t.cho}">${prio ? '★' : '☆'}</button>
          <button class="btn small" data-zoom="${t.cho}">地図</button></li>`;
      }
      html += '</ul>';
    }
    return html + `<div class="note">✓で町全体を対象に入れる／外す。★で優先（先に配る）。区画が複数の町にまたがる場合は、その区画ごと切り替わります。</div>`;
  }, (body) => {
    const tq = $('#tq', body);
    tq.oninput = () => { app.townQuery = tq.value; const pos = tq.selectionStart; app.sheetRender(); const n = $('#tq'); n.focus(); n.setSelectionRange(pos, pos); };
    body.querySelectorAll('[data-cho]').forEach((b) => (b.onclick = () => {
      const zs = app.towns[b.dataset.cho].z.filter((id) => app.zonesById[id]);
      const allIn = zs.every((id) => app.C.sel.has(id));
      app.store.pushMany(zs.map((id) => ['zsel', id, allIn ? 'out' : 'in']));
    }));
    body.querySelectorAll('[data-star]').forEach((b) => (b.onclick = () => {
      const zs = app.towns[b.dataset.star].z.filter((id) => app.zonesById[id]);
      const all = zs.every((id) => app.C.st.zprio[id]?.v === '1');
      app.store.pushMany(zs.map((id) => ['zprio', id, all ? '0' : '1']));
    }));
    body.querySelectorAll('[data-zoom]').forEach((b) => (b.onclick = () => {
      const zs = app.towns[b.dataset.zoom].z.map((id) => app.zoneLayers[id]).filter(Boolean);
      if (zs.length) app.map.fitBounds(L.featureGroup(zs).getBounds(), { padding: [30, 30], maxZoom: 17 });
    }));
  });
}

// ---------- 今日の配布 ----------
function myNextZone() {
  const me = app.store.me || 'A';
  return app.C.order[me].find((z) => (app.C.prog[z.id]?.frac ?? 0) < 0.999)?.id || app.C.order[me][0]?.id || null;
}

async function enterToday() {
  if (app.session) app.todayZone = app.session.zone;
  if (!app.todayZone || !app.zonesById[app.todayZone]) app.todayZone = myNextZone();
  LS.set('todayZone', app.todayZone);
  const z = app.zonesById[app.todayZone];
  if (!z) return;
  const l = app.zoneLayers[z.id];
  if (l) app.map.fitBounds(l.getBounds(), { padding: [20, 60], maxZoom: 18 });
  await drawRoute(z.id);
  if (app.session) showMarkToolbar();
}

function renderTodaySummary() {
  const el = $('#summary');
  const z = app.zonesById[app.todayZone];
  const n = names();
  if (!z) { el.innerHTML = '<b>担当の区画がありません</b><div class="muted">計画タブで対象を決めてください</div>'; return; }
  const C = app.C;
  const pr = C.prog[z.id] || { frac: 0 };
  const side = C.side[z.id];
  const sess = app.session;
  el.innerHTML = `<div class="row"><b>${esc(C.num[z.id] || '')} ${esc(z.l)}</b>
      ${side ? `<span class="chip ${side}">${esc(n[side])}</span>` : ''}</div>
    <div class="muted">推定${fmt(z.h * C.prm.rate)}枚・${(z.rm / 1000).toFixed(1)}km・約${estMinutes(z, C.prm, app.plan)}分（推定値）・${pr.frac >= 0.999 ? '完了' : `済 ${Math.round(pr.frac * 100)}%`}</div>
    <div class="btns">${sess ? `<button class="btn small primary" id="bEnd">終了して記録</button><span class="muted">開始 ${new Date(sess.start).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}・${sess.blocks.length}ブロック</span>`
      : `<button class="btn small primary" id="bStart">開始</button><button class="btn small" id="bPick">別の区画</button>`}</div>`;
  if (sess) $('#bEnd').onclick = endSession; else { $('#bStart').onclick = startSession; $('#bPick').onclick = openPicker; }
}

function openPicker() {
  openSheet(() => {
    const n = names();
    const C = app.C;
    const me = app.store.me || 'A';
    const other = me === 'A' ? 'B' : 'A';
    const row = (z) => {
      const pr = C.prog[z.id] || { frac: 0 };
      return `<li><span class="chip ${C.side[z.id]}">${esc(C.num[z.id])}</span><div class="grow"><div>${esc(z.l)}</div>
        <div class="sub">推定${fmt(z.h * C.prm.rate)}枚・${(z.d / 1000).toFixed(1)}km・${pr.frac >= 0.999 ? '完了' : `済 ${Math.round(pr.frac * 100)}%`}</div></div>
        <button class="btn small" data-z="${z.id}">選ぶ</button></li>`;
    };
    return `<h3>区画を選ぶ</h3><div class="group-h">${esc(n[me])}（あなた）</div><ul class="list">${C.order[me].map(row).join('')}</ul>
      <div class="group-h">${esc(n[other])}</div><ul class="list">${C.order[other].map(row).join('')}</ul>`;
  }, (body) => body.querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => {
    app.todayZone = b.dataset.z; LS.set('todayZone', app.todayZone); closeSheet(); setTab('today');
  })));
}

function startSession() {
  app.session = { zone: app.todayZone, start: Date.now(), blocks: [] };
  LS.set('session', app.session);
  requestWake();
  showMarkToolbar();
  renderSummary();
  toast('配った街区をタップして塗ってください');
}

function showMarkToolbar() {
  const tb = $('#toolbar');
  tb.hidden = false;
  tb.innerHTML = `<div class="label">配り終えたブロックをタップ（もう一度で取り消し）。地図を動かすだけなら塗られません。</div>
    <button class="btn small" id="bFit">区画に戻る</button><button class="btn small primary" id="bEnd2">終了して記録</button>`;
  $('#bFit').onclick = () => { const l = app.zoneLayers[app.todayZone]; if (l) app.map.fitBounds(l.getBounds(), { padding: [20, 60] }); };
  $('#bEnd2').onclick = endSession;
}

function endSession() {
  const sess = app.session;
  if (!sess) return;
  const C = app.C;
  const doneIds = sess.blocks.filter((id) => app.store.state.block[id]?.v === '1');
  const h = doneIds.reduce((s, id) => s + (app.blocksById[id]?.h || 0), 0);
  const mins = Math.round((Date.now() - sess.start) / 60000);
  modal(`<h2>今日の記録</h2><p>${esc(app.zonesById[sess.zone]?.l || '')}・塗ったブロック ${doneIds.length}（${fmt(h)}世帯）</p>
    <label>配った枚数</label><input id="cnt" type="number" inputmode="numeric" value="${Math.round(h * C.prm.rate)}">
    <label>かかった時間（分）</label><input id="min" type="number" inputmode="numeric" value="${mins}">
    <label>メモ（お断りが多い・マンションに入れない など。住人の情報は書かない）</label><input id="memo" type="text" maxlength="200">
    <div class="row"><button class="btn" id="cancel">戻る</button><button class="btn primary" id="save">記録する</button></div>`, (card) => {
    $('#cancel', card).onclick = closeModal;
    $('#save', card).onclick = () => {
      const count = parseInt($('#cnt', card).value, 10) || 0;
      app.store.push('outing', sess.zone, '', { count, minutes: parseInt($('#min', card).value, 10) || 0, start: sess.start, end: Date.now(),
        blocks: sess.blocks.filter((id) => app.store.state.block[id]?.v === '1'), memo: $('#memo', card).value.slice(0, 200) });
      app.session = null; LS.set('session', null); releaseWake(); hideToolbar(); closeModal(); refresh();
      toast(`${count}枚を記録しました`);
    };
  });
}

async function drawRoute(id) {
  app.routeLayer.clearLayers();
  app.arrowLayer.clearLayers();
  app.routeLatLngs = null;
  if (!app.routes) { try { app.routes = await loadJSON('data/routes.json'); } catch { toast('ルートを読み込めません'); return; } }
  const r = app.routes[id];
  if (!r) return;
  const all = [];
  for (const run of r.runs) {
    const ll = decode(run.enc);
    all.push(...ll);
    L.polyline(ll, run.k === 'p' ? { color: COLOR.accent, weight: 5, opacity: 0.8, interactive: false }
      : { color: '#555', weight: 3, opacity: 0.7, dashArray: '6 6', interactive: false }).addTo(app.routeLayer);
  }
  L.marker(r.s, { interactive: false, icon: L.divIcon({ className: 'pin', html: '<div class="start">スタート</div>' }) }).addTo(app.routeLayer);
  L.marker(r.e, { interactive: false, icon: L.divIcon({ className: 'pin', html: '<div>ゴール</div>' }) }).addTo(app.routeLayer);
  app.routeLatLngs = all;
  drawArrows();
}

function drawArrows() {
  app.arrowLayer.clearLayers();
  const ll = app.routeLatLngs;
  if (!ll || ll.length < 2) return;
  const map = app.map;
  const step = 90;
  let carry = step / 2;
  for (let i = 1; i < ll.length; i++) {
    const a = map.latLngToLayerPoint(ll[i - 1]);
    const b = map.latLngToLayerPoint(ll[i]);
    const seg = a.distanceTo(b);
    let pos = carry;
    while (pos < seg) {
      const t = pos / seg;
      const p = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      L.marker(map.layerPointToLatLng(p), { interactive: false, icon: L.divIcon({ className: 'arrow', iconSize: [0, 0], html: `<div style="transform:rotate(${ang}deg)"></div>` }) }).addTo(app.arrowLayer);
      pos += step;
    }
    carry = pos - seg;
  }
}

function decode(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

// ---------- ブロックを塗る ----------
function onBlockClick(id, e) {
  L.DomEvent.stopPropagation(e);
  const b = app.blocksById[id];
  const marking = (app.tab === 'today' && app.session) || (app.tab === 'progress' && app.bulk);
  if (!marking) {
    if (app.tab === 'today') { toast('「開始」を押すと塗れます'); return; }
    if (app.tab === 'progress') { toast(`このブロック ${b.h}世帯${app.store.state.block[id]?.v === '1' ? '・配布済み' : ''}`); return; }
    return;
  }
  const done = app.store.state.block[id]?.v === '1';
  const s = app.tab === 'today' ? app.session : app.bulk;
  app.store.push('block', id, done ? '0' : '1', '', app.tab === 'progress' ? s.person : null);
  if (!done && !s.blocks.includes(id)) s.blocks.push(id);
  if (app.tab === 'today') LS.set('session', app.session); else LS.set('bulk', app.bulk);
  if (navigator.vibrate) navigator.vibrate(15);
  renderSummary();
}

// ---------- 進捗: 過去の分のまとめ塗り・履歴・補正 ----------
function startBulk() {
  const n = names();
  modal(`<h2>過去の配布をまとめて塗る</h2><p>紙の地図で配り済みの範囲を、ブロックをタップして塗ります。だれが配った分ですか？（区画の担当がその人に固定されます）</p>
    <div class="row"><button class="btn A" data-p="A">${esc(n.A)}</button><button class="btn B" data-p="B">${esc(n.B)}</button></div>
    <div class="row"><button class="btn" id="cancel">やめる</button></div>`, (card) => {
    $('#cancel', card).onclick = closeModal;
    card.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
      app.bulk = { start: Date.now(), blocks: [], person: b.dataset.p };
      LS.set('bulk', app.bulk);
      closeModal(); showBulkToolbar(); renderSummary();
    }));
  });
}
function showBulkToolbar() {
  const tb = $('#toolbar');
  tb.hidden = false;
  tb.innerHTML = `<div class="label">紙の地図で配り済みのブロックをタップして塗る。終わったら枚数を記録（補正に使います）。</div>
    <button class="btn small" id="bCancel">やめる</button><button class="btn small primary" id="bSaveBulk">枚数を記録</button>`;
  $('#bCancel').onclick = cancelBulk;
  $('#bSaveBulk').onclick = saveBulk;
}
function cancelBulk() { app.bulk = null; LS.set('bulk', null); hideToolbar(); renderSummary(); }
function saveBulk() {
  const blocks = app.bulk.blocks.filter((id) => app.store.state.block[id]?.v === '1');
  const h = blocks.reduce((s, id) => s + (app.blocksById[id]?.h || 0), 0);
  modal(`<h2>過去の配布を記録</h2><p>塗ったブロック ${blocks.length}（${fmt(h)}世帯）。この範囲に配ったおよその枚数を入れてください。わからなければ空欄で構いません（塗った記録は残ります）。</p>
    <label>配った枚数（およそ）</label><input id="cnt" type="number" inputmode="numeric">
    <div class="row"><button class="btn" id="cancel">戻る</button><button class="btn primary" id="save">記録する</button></div>`, (card) => {
    $('#cancel', card).onclick = closeModal;
    $('#save', card).onclick = () => {
      const count = parseInt($('#cnt', card).value, 10) || 0;
      const zone = blocks.length ? app.blocksById[blocks[0]].z : '';
      if (count > 0) {
        app.store.push('outing', zone, '', { count, minutes: 0, start: app.bulk.start, end: Date.now(), blocks, past: true,
          memo: '過去の配布（まとめて登録）' }, app.bulk.person);
      }
      cancelBulk(); closeModal(); toast('記録しました');
    };
  });
}

function openHistory() {
  openSheet(() => {
    const n = names();
    const rows = [...app.C.st.outings].reverse().map((o) => {
      const d = new Date(o.start || o.cts);
      return `<li><span class="chip ${o.person}">${esc(n[o.person] || o.person)}</span><div class="grow">
        <div>${d.getMonth() + 1}/${d.getDate()} ${esc(app.zonesById[o.zone]?.l || '')} ${o.past ? '（過去分）' : ''}</div>
        <div class="sub">${fmt(o.count || 0)}枚${o.minutes ? `・${o.minutes}分` : ''}・${(o.blocks || []).length}ブロック${o.memo ? `・${esc(o.memo)}` : ''}</div></div></li>`;
    });
    return `<h3>配布の履歴</h3><ul class="list">${rows.join('') || '<li>まだありません</li>'}</ul>
      <div class="note">記録の取り消しは、スプレッドシートの events シートで該当の行を削除してください。</div>`;
  });
}

function openCalibration() {
  openSheet(() => {
    const { cal, prm } = app.C;
    return `<h3>実績からの補正</h3>
      <dl><dt>記録した回数</dt><dd>${cal.outings}回（${fmt(cal.flyers)}枚／塗った世帯 ${fmt(cal.households)}）</dd>
      <dt>実測の配布率</dt><dd>${cal.rate ? cal.rate.toFixed(2) : '—'} <span class="meta">配った枚数÷塗ったブロックの世帯数</span></dd>
      <dt>時間の補正</dt><dd>${cal.timeFactor ? `×${cal.timeFactor.toFixed(2)}` : '—'} <span class="meta">実際の時間÷目安時間</span></dd>
      <dt>いまの設定</dt><dd>推定率 ${prm.rate.toFixed(2)}・時間 ×${prm.timeFactor.toFixed(2)}</dd></dl>
      ${cal.ready ? '' : '<div class="note">2回以上（または400枚以上）記録すると反映できます。</div>'}
      <div class="actions"><button class="btn primary" id="apply" ${cal.ready && cal.rate ? '' : 'disabled'}>計画に反映</button></div>
      <label>手で設定する（推定率）</label><input id="rate" type="number" step="0.01" min="0.1" max="1.5" value="${prm.rate.toFixed(2)}">
      <div class="actions"><button class="btn" id="setRate">この値にする</button></div>
      <div class="note">推定率の初期値 1.00 は「全世帯に1枚」という上限の仮定です。お断りの家や入れない集合住宅があるので、実際はこれより低くなります。反映すると、計画の範囲・分担・回数がすべて計算し直されます。</div>`;
  }, (body) => {
    const apply = $('#apply', body);
    if (apply) apply.onclick = () => {
      const { cal } = app.C;
      const list = [['setting', 'rate', cal.rate.toFixed(3)]];
      if (cal.timeFactor) list.push(['setting', 'time_factor', cal.timeFactor.toFixed(3)]);
      app.store.pushMany(list); toast('反映しました');
    };
    $('#setRate', body).onclick = () => {
      const v = parseFloat($('#rate', body).value);
      if (v > 0.05 && v <= 1.5) { app.store.push('setting', 'rate', v.toFixed(3)); toast('設定しました'); }
    };
  });
}

// ---------- その他（設定） ----------
function openSettings() {
  openSheet(() => {
    const n = names();
    const p = app.plan;
    return `<h3>その他</h3>
      <label>この端末で配る人</label><div class="actions"><button class="btn ${app.store.me === 'A' ? 'A' : ''}" data-me="A">${esc(n.A)}</button>
        <button class="btn ${app.store.me === 'B' ? 'B' : ''}" data-me="B">${esc(n.B)}</button></div>
      <label>表示名（あだ名。実名は入れない）</label>
      <div class="actions"><input type="text" id="nA" value="${esc(n.A === 'A' ? '' : n.A)}" placeholder="Aの表示名" maxlength="10" style="flex:1">
        <input type="text" id="nB" value="${esc(n.B === 'B' ? '' : n.B)}" placeholder="Bの表示名" maxlength="10" style="flex:1"></div>
      <div class="actions"><button class="btn" id="saveNames">表示名を保存</button></div>
      <label>目標部数</label><div class="actions"><input type="number" id="tgt" value="${app.C.prm.target}" style="flex:1"><button class="btn" id="saveTgt">保存</button></div>
      <label>計画を自動に戻す</label>
      <div class="actions"><button class="btn" id="resetSel">対象の手動指定をすべて解除</button><button class="btn" id="resetPerson">担当の手動指定をすべて解除</button></div>
      <div class="note">
        <b>データ</b><br>
        世帯数：令和2年国勢調査 小地域（基本単位区）境界データ（e-Stat）を加工。2020年10月時点の値で、いまの世帯数とは差があります。<br>
        道路・建物：© OpenStreetMap contributors（ODbL）。ルートと目安時間は推定値です。<br>
        地図：国土地理院 地理院タイル（淡色地図）。<br>
        作成 ${esc((p.generated_at || '').slice(0, 10))}・区画 ${app.zones.length}・データ版 ${esc(p.data_version || '')}
      </div>
      <div class="actions"><button class="btn" id="relogin">合言葉を入れ直す</button><button class="btn" id="reload">最新に更新</button></div>`;
  }, (body) => {
    body.querySelectorAll('[data-me]').forEach((b) => (b.onclick = () => { app.store.me = b.dataset.me; refresh(); }));
    $('#saveNames', body).onclick = () => {
      const a = $('#nA', body).value.trim(), b = $('#nB', body).value.trim();
      app.store.pushMany([['setting', 'name_A', a], ['setting', 'name_B', b]]); toast('保存しました');
    };
    $('#saveTgt', body).onclick = () => { const v = parseInt($('#tgt', body).value, 10); if (v > 0) app.store.push('setting', 'target', String(v)); };
    $('#resetSel', body).onclick = () => {
      if (!confirmInline(body, '対象の手動指定（入れる／外す）をすべて解除しますか？', () => {
        const ids = Object.keys(app.C.st.zsel).filter((id) => app.C.st.zsel[id].v);
        app.store.pushMany(ids.map((id) => ['zsel', id, ''])); toast('解除しました');
      }));
    };
    $('#resetPerson', body).onclick = () => {
      confirmInline(body, '担当の手動指定をすべて解除しますか？', () => {
        const ids = Object.keys(app.C.st.zperson).filter((id) => app.C.st.zperson[id].v);
        app.store.pushMany(ids.map((id) => ['zperson', id, ''])); toast('解除しました');
      });
    };
    $('#relogin', body).onclick = () => { app.store.key = ''; location.reload(); };
    $('#reload', body).onclick = () => location.reload();
  });
}

function confirmInline(body, msg, ok) {
  modal(`<h2>確認</h2><p>${esc(msg)}</p><div class="row"><button class="btn" id="no">やめる</button><button class="btn primary" id="yes">解除する</button></div>`, (card) => {
    $('#no', card).onclick = closeModal;
    $('#yes', card).onclick = () => { closeModal(); ok(); };
  });
  return true;
}

// ---------- 現在地 ----------
function toggleLocate() {
  const btn = $('#btnLocate');
  if (app.watchId != null) {
    navigator.geolocation.clearWatch(app.watchId); app.watchId = null; btn.classList.remove('on');
    app.meMarker?.remove(); app.meCircle?.remove(); app.meMarker = app.meCircle = null;
    return;
  }
  if (!navigator.geolocation) { toast('この端末では現在地を使えません'); return; }
  btn.classList.add('on');
  let first = true;
  app.watchId = navigator.geolocation.watchPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!app.meMarker) {
      app.meCircle = L.circle(ll, { radius: p.coords.accuracy, color: COLOR.A, weight: 1, fillOpacity: 0.1, interactive: false }).addTo(app.map);
      app.meMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: COLOR.A, fillOpacity: 1, interactive: false }).addTo(app.map);
    } else { app.meMarker.setLatLng(ll); app.meCircle.setLatLng(ll).setRadius(p.coords.accuracy); }
    if (first) { app.map.setView(ll, Math.max(app.map.getZoom(), 17)); first = false; }
  }, (err) => { toast(err.code === 1 ? '位置情報の許可が必要です（設定アプリで許可）' : '現在地を取得できません'); toggleLocate(); },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && app.watchId != null) toggleLocate();
  if (document.visibilityState === 'visible' && app.session) requestWake();
});

async function requestWake() { try { app.wake = await navigator.wakeLock?.request('screen'); } catch { /* 非対応 */ } }
function releaseWake() { try { app.wake?.release(); } catch { /* noop */ } app.wake = null; }

// ---------- シート・モーダル・トースト ----------
function openSheet(render, bind) {
  const sh = $('#sheet');
  app.sheetRender = () => { $('.body', sh).innerHTML = render(); if (bind) bind($('.body', sh)); };
  app.sheetRender();
  sh.hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; app.sheetRender = null; }
function modal(html, bind) { const m = $('#modal'); $('.card', m).innerHTML = html; m.hidden = false; if (bind) bind($('.card', m)); }
function closeModal() { $('#modal').hidden = true; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }

app.bulk = LS.get('bulk', null);
boot().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;background:#fff;padding:20px;z-index:9999">読み込みに失敗しました：${esc(e.message)}</div>`); });
