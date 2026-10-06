import test from 'node:test';
import assert from 'node:assert/strict';
import { reduce, selection, split, zoneProgress, calibration, totals, orderFor, params } from '../js/plan.js';

const ev = (eid, cts, type, target, value, person = 'A', data) => ({ eid, cts, type, target, value, person, data });

// 8区画をスタジオの周りに円形に並べる。隣どうしが接している。
function ring(n = 8, h = 200, a = (i) => (i < 6 ? 1 : 0)) {
  return Array.from({ length: n }, (_, i) => ({
    id: `z${i}`, h, a: a(i), d: 100 * (i + 1), b: (360 / n) * i,
    nb: [[`z${(i + 1) % n}`, 50, 0], [`z${(i + n - 1) % n}`, 50, 0]],
  }));
}
const prm = { rate: 1, target: 1000, perOuting: 200, timeFactor: 1 };
const noProg = (zones) => Object.fromEntries(zones.map((z) => [z.id, { done: 0, total: z.h, frac: 0, starter: null }]));

test('reduce: 新しい cts を採用し、同じ eid は1回', () => {
  const st = reduce([
    ev('e1', 10, 'block', 'b1', '1'),
    ev('e2', 5, 'block', 'b1', '0'),            // 古い操作が後から届いても負けない
    ev('e1', 10, 'block', 'b1', '1'),            // 重複
    ev('e3', 20, 'zsel', 'z1', 'out', 'B'),
    ev('e4', 30, 'outing', 'z1', '', 'B', JSON.stringify({ count: 180, blocks: ['b1'] })),
  ]);
  assert.equal(st.block.b1.v, '1');
  assert.equal(st.zsel.z1.v, 'out');
  assert.equal(st.outings.length, 1);
  assert.equal(st.outings[0].count, 180);
});

test('selection: 狙いエリアの近い順に目標まで。外した区画は飛ばす', () => {
  const zones = ring();
  const st = reduce([ev('e1', 1, 'zsel', 'z1', 'out')]);
  const { sel, covered } = selection(zones, st, noProg(zones), prm);
  assert.deepEqual([...sel].sort(), ['z0', 'z2', 'z3', 'z4', 'z5']);
  assert.equal(covered, 1000);
});

test('selection: 優先★と手で入れた区画は必ず入り、その分だけ自動の分が減る', () => {
  const zones = ring();
  const st = reduce([ev('e1', 1, 'zprio', 'z7', '1'), ev('e2', 2, 'zsel', 'z6', 'in')]);
  const { sel } = selection(zones, st, noProg(zones), prm);
  assert.ok(sel.has('z7') && sel.has('z6'));
  assert.equal(sel.size, 5);
  assert.ok(!sel.has('z3'));
});

test('selection: 対象外で配り済みのブロックも合計に数える', () => {
  const zones = ring();
  const prog = noProg(zones);
  prog.z7 = { done: 400, total: 200, frac: 1, starter: 'A' };
  const { sel } = selection(zones, reduce([]), prog, prm);
  assert.equal(sel.size, 3); // 400 は配り済み → 残り 600 = 3区画
});

test('split: つり合い、隣り合った扇形になる', () => {
  const zones = ring();
  const ids = new Set(zones.map((z) => z.id));
  const side = split(zones, ids, reduce([]), noProg(zones), prm);
  const a = zones.filter((z) => side[z.id] === 'A').length;
  assert.equal(a, 4);
  // A の区画が連続している（境目は2か所だけ）
  let changes = 0;
  for (let i = 0; i < 8; i++) if (side[`z${i}`] !== side[`z${(i + 1) % 8}`]) changes++;
  assert.equal(changes, 2);
});

test('split: 手で決めた担当と、着手済みの担当は守る', () => {
  const zones = ring();
  const ids = new Set(zones.map((z) => z.id));
  const prog = noProg(zones);
  prog.z0.starter = 'B';
  const st = reduce([ev('e1', 1, 'zperson', 'z4', 'B')]);
  const side = split(zones, ids, st, prog, prm);
  assert.equal(side.z0, 'B');
  assert.equal(side.z4, 'B');
});

test('zoneProgress と calibration', () => {
  const blocksByZone = { z1: [{ id: 'b1', h: 100 }, { id: 'b2', h: 100 }] };
  const st = reduce([
    ev('e1', 1, 'block', 'b1', '1', 'B'),
    ev('e2', 2, 'outing', 'z1', '', 'B', JSON.stringify({ count: 70, minutes: 60, blocks: ['b1'] })),
    ev('e3', 3, 'outing', 'z1', '', 'A', JSON.stringify({ count: 340, minutes: 60, blocks: ['b2', 'b1'] })),
  ]);
  const prog = zoneProgress(blocksByZone, st);
  assert.equal(prog.z1.done, 100);
  assert.equal(prog.z1.starter, 'B');
  const cal = calibration(st, { b1: { h: 100 }, b2: { h: 100 } }, { z1: { h: 200, em: 100 } }, prm);
  assert.equal(cal.outings, 2);
  assert.ok(Math.abs(cal.rate - 410 / 300) < 1e-9);
  assert.ok(Math.abs(cal.timeFactor - 120 / 150) < 1e-9);
});

test('totals と順番', () => {
  const zones = ring();
  const ids = new Set(['z0', 'z1', 'z2', 'z3']);
  const side = { z0: 'A', z1: 'A', z2: 'B', z3: 'B' };
  const st = reduce([ev('e1', 1, 'zprio', 'z1', '1')]);
  const t = totals(zones, ids, side, st, noProg(zones), prm);
  assert.equal(t.planned, 800);
  assert.equal(t.outsA, 2);
  assert.deepEqual(orderFor('A', zones, side, st, noProg(zones)).map((z) => z.id), ['z1', 'z0']);
  assert.equal(params(reduce([ev('e2', 1, 'setting', 'rate', '0.6')]), { rate_default: 1 }).rate, 0.6);
});
