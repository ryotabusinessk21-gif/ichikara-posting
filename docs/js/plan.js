// 計画の計算（画面に依存しない純粋関数）。node --test でテストする。

export const KEYED = new Set(['block', 'zsel', 'zprio', 'zperson', 'setting']);

/** イベントの列 → 現在の状態。同じ項目は (cts, eid) が大きい方を採用。同じ eid は1回だけ。 */
export function reduce(events) {
  const st = { block: {}, zsel: {}, zprio: {}, zperson: {}, setting: {}, outings: [] };
  const seen = new Set();
  for (const e of events) {
    if (!e || seen.has(e.eid)) continue;
    seen.add(e.eid);
    if (e.type === 'outing') {
      let data = e.data;
      if (typeof data === 'string') { try { data = JSON.parse(data || '{}'); } catch { data = {}; } }
      st.outings.push({ eid: e.eid, cts: +e.cts, person: e.person, zone: e.target, ...data });
      continue;
    }
    if (!KEYED.has(e.type)) continue;
    const m = st[e.type];
    const cur = m[e.target];
    if (!cur || +e.cts > cur.t || (+e.cts === cur.t && e.eid > cur.e)) {
      m[e.target] = { v: String(e.value ?? ''), t: +e.cts, p: e.person, e: e.eid };
    }
  }
  st.outings.sort((a, b) => a.cts - b.cts);
  return st;
}

export const isDone = (st, blockId) => st.block[blockId]?.v === '1';

/** 設定値（推定率・時間補正）。未設定なら既定値。 */
export function params(st, plan) {
  const num = (k, d) => { const v = parseFloat(st.setting[k]?.v); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    rate: num('rate', plan.rate_default ?? 1),
    timeFactor: num('time_factor', 1),
    target: num('target', plan.target_flyers ?? 10000),
    perOuting: plan.flyers_per_outing ?? 200,
  };
}

/** 区画ごとの配り終わり世帯数と、着手した人（済ブロックの世帯が多い方） */
export function zoneProgress(blocksByZone, st) {
  const out = {};
  for (const [zid, blocks] of Object.entries(blocksByZone)) {
    let done = 0, total = 0;
    const by = { A: 0, B: 0 };
    for (const b of blocks) {
      total += b.h;
      const r = st.block[b.id];
      if (r?.v === '1') { done += b.h; if (by[r.p] !== undefined) by[r.p] += b.h; }
    }
    out[zid] = { done, total, frac: total ? done / total : 0, starter: by.A || by.B ? (by.A >= by.B ? 'A' : 'B') : null };
  }
  return out;
}

/**
 * 対象に入れる区画を決める。
 * 手で「入れる」・優先★ の区画から数え始め、足りない分を「狙いエリアの近い順 → その他の近い順」で足す。
 * 手で「外す」区画は飛ばす。対象外で配り済みのブロックも合計に数える。
 */
export function selection(zones, st, prog, prm) {
  const sel = new Set();
  const out = (z) => st.zsel[z.id]?.v === 'out';
  for (const z of zones) {
    if (out(z)) continue;
    if (st.zsel[z.id]?.v === 'in' || st.zprio[z.id]?.v === '1') sel.add(z.id);
  }
  const doneEst = (z) => (prog[z.id]?.done || 0) * prm.rate;
  let doneOutside = 0;
  for (const z of zones) if (!sel.has(z.id)) doneOutside += doneEst(z);
  let covered = doneOutside;
  for (const z of zones) if (sel.has(z.id)) covered += z.h * prm.rate;
  const auto = [...zones].filter((z) => z.h > 0).sort((a, b) => (b.a > 0) - (a.a > 0) || a.d - b.d);
  for (const z of auto) {
    if (covered >= prm.target) break;
    if (sel.has(z.id) || out(z)) continue;
    sel.add(z.id);
    covered += z.h * prm.rate - doneEst(z); // 区画内の配り済みは「対象外の配り済み」から移るだけ
  }
  return { sel, covered, doneOutside: [...zones].filter((z) => !sel.has(z.id)).reduce((s, z) => s + doneEst(z), 0) };
}

/**
 * A/B の分担。スタジオから見た方角で扇形に二分し、推定部数がつり合う切り方を選ぶ。
 * 手で決めた担当・着手済みの担当は固定。担当が飛び地にならないよう補正する。
 */
export function split(zones, selIds, st, prog, prm, prev = {}) {
  const S = zones.filter((z) => selIds.has(z.id)).sort((a, b) => a.b - b.b);
  const fixed = {};
  for (const z of S) {
    const m = st.zperson[z.id]?.v;
    if (m === 'A' || m === 'B') fixed[z.id] = m;
    else if (prog[z.id]?.starter) fixed[z.id] = prog[z.id].starter;
  }
  const est = (z) => z.h * prm.rate;
  const total = S.reduce((s, z) => s + est(z), 0) || 1;
  const nbr = {};
  for (const z of S) nbr[z.id] = (z.nb || []).map((x) => x[0]).filter((id) => selIds.has(id));
  const n = S.length;
  let best = null;
  for (let i = 0; i < Math.max(n, 1); i++) {
    for (const first of ['A', 'B']) {
      const other = first === 'A' ? 'B' : 'A';
      const side = {};
      let acc = 0;
      for (let j = 0; j < n; j++) {
        const z = S[(i + j) % n];
        side[z.id] = acc < total / 2 ? first : other;
        acc += est(z);
      }
      Object.assign(side, fixed);
      const res = cost(S, side, nbr, est, total, prev);
      if (!best || res < best.cost) best = { cost: res, side };
    }
  }
  const side = best ? best.side : {};
  repairContiguity(S, side, nbr, fixed, est);
  return side;
}

function cost(S, side, nbr, est, total, prev) {
  let a = 0, b = 0, cut = 0, changed = 0;
  for (const z of S) {
    if (side[z.id] === 'A') a += est(z); else b += est(z);
    for (const o of nbr[z.id]) if (o > z.id && side[o] !== side[z.id]) cut++;
    if (prev[z.id] && prev[z.id] !== side[z.id]) changed++;
  }
  return Math.abs(a - b) / total + (0.02 * cut) / Math.max(S.length, 1) + (0.01 * changed);
}

function repairContiguity(S, side, nbr, fixed, est) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const person of ['A', 'B']) {
      const mine = S.filter((z) => side[z.id] === person).map((z) => z.id);
      const comps = components(mine, nbr);
      if (comps.length <= 1) continue;
      const w = (c) => c.reduce((s, id) => s + est(S.find((z) => z.id === id)), 0);
      comps.sort((x, y) => w(y) - w(x));
      for (const c of comps.slice(1)) {
        if (c.some((id) => fixed[id])) continue;
        const touchesOther = c.some((id) => nbr[id].some((o) => side[o] && side[o] !== person));
        if (!touchesOther) continue;
        for (const id of c) side[id] = person === 'A' ? 'B' : 'A';
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function components(ids, nbr) {
  const set = new Set(ids), seen = new Set(), out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp = [], stack = [id];
    seen.add(id);
    while (stack.length) {
      const x = stack.pop();
      comp.push(x);
      for (const y of nbr[x] || []) if (set.has(y) && !seen.has(y)) { seen.add(y); stack.push(y); }
    }
    out.push(comp);
  }
  return out;
}

/** 担当ごとの順番: 優先★ → スタジオに近い順。終わった区画は後ろへ。 */
export function orderFor(person, zones, side, st, prog) {
  return zones
    .filter((z) => side[z.id] === person)
    .sort((a, b) => ((prog[a.id]?.frac ?? 0) >= 0.999) - ((prog[b.id]?.frac ?? 0) >= 0.999)
      || (st.zprio[b.id]?.v === '1') - (st.zprio[a.id]?.v === '1') || a.d - b.d);
}

/** 実績からの補正値。配った枚数 ÷ その回に塗ったブロックの世帯数、実際の時間 ÷ 目安時間。 */
export function calibration(st, blocksById, zonesById, prm) {
  let flyers = 0, households = 0, mins = 0, estMins = 0, n = 0;
  for (const o of st.outings) {
    const ids = o.blocks || [];
    const h = ids.reduce((s, id) => s + (blocksById[id]?.h || 0), 0);
    if (!(o.count > 0) || !h) continue;
    n++;
    flyers += +o.count;
    households += h;
    if (o.minutes > 0) {
      const z = zonesById[o.zone];
      if (z && z.h && z.em) { mins += +o.minutes; estMins += z.em * (h / z.h); }
    }
  }
  return {
    outings: n, flyers, households,
    rate: households ? flyers / households : null,
    timeFactor: estMins ? mins / estMins : null,
    ready: n >= 2 || flyers >= 400,
  };
}

/** 目安時間（分）。ルートの歩行時間＋1枚あたりの投函時間（いずれも推定値）×時間補正 */
export function estMinutes(z, prm, plan) {
  const walk = (z.rm || 0) / (plan.walk_m_per_min || 70);
  const post = (z.h * prm.rate * (plan.sec_per_flyer || 10)) / 60;
  return Math.round((walk + post) * prm.timeFactor);
}

/** 全体の集計 */
export function totals(zones, selIds, side, st, prog, prm) {
  const t = { planned: 0, A: 0, B: 0, nA: 0, nB: 0, doneH: 0, actual: 0, actualA: 0, actualB: 0, outingsA: 0, outingsB: 0 };
  for (const z of zones) {
    t.doneH += prog[z.id]?.done || 0;
    if (!selIds.has(z.id)) continue;
    const e = z.h * prm.rate;
    t.planned += e;
    if (side[z.id] === 'A') { t.A += e; t.nA++; } else { t.B += e; t.nB++; }
  }
  for (const o of st.outings) {
    const c = +o.count || 0;
    t.actual += c;
    if (o.person === 'A') { t.actualA += c; t.outingsA++; } else { t.actualB += c; t.outingsB++; }
  }
  t.doneEst = t.doneH * prm.rate;
  t.outsA = Math.ceil(t.A / prm.perOuting);
  t.outsB = Math.ceil(t.B / prm.perOuting);
  return t;
}
