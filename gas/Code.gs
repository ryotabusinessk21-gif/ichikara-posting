/**
 * イチカラ ポスティング管理 — 共有データ（Google スプレッドシート＋Apps Script）
 *
 * シート「events」に操作を1行ずつ追記する。画面側は全件または差分を読み、同じ項目は
 * 端末で記録した時刻（cts）が新しい方を採用する。同じ eid は1回分として扱う。
 *
 * 設定（スクリプト プロパティ）
 *   PASSCODE … 二人で共有する合言葉（コードには書かない）
 *
 * 初回だけ: エディタで setup() を実行 → ウェブアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）
 * コードを直したら: デプロイを管理 → 編集 → 新バージョン（URL を変えないため）
 */

var SHEET = 'events';
var HEADERS = ['server_ts', 'eid', 'cts', 'person', 'type', 'target', 'value', 'data'];
var TYPES = { block: 1, zsel: 1, zprio: 1, zperson: 1, outing: 1, setting: 1 };
var MAX_EVENTS = 300;

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('B:H').setNumberFormat('@'); // 文字列として保存（数式・日付に化けさせない）
  if (!PropertiesService.getScriptProperties().getProperty('PASSCODE')) {
    Logger.log('スクリプト プロパティに PASSCODE を設定してください');
  }
}

function sheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET);
}

function authed_(k) {
  var pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  return !!pass && String(k || '') === pass;
}

function out_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]{0,40}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/** GET ?k=合言葉&since=行番号（0 なら全件）[&callback=関数名] */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!authed_(p.k)) return out_({ ok: false, error: 'auth' }, p.callback);
  var sh = sheet_();
  var last = sh.getLastRow(); // 1 行目は見出し
  var since = Math.max(0, parseInt(p.since || '0', 10) || 0);
  var rows = [];
  if (last - 1 > since) {
    rows = sh.getRange(since + 2, 1, last - 1 - since, HEADERS.length).getValues();
  }
  var events = rows.map(function (r) {
    return { eid: String(r[1]), cts: Number(r[2]), person: String(r[3]), type: String(r[4]),
             target: unescape_(r[5]), value: unescape_(r[6]), data: unescape_(r[7]) };
  });
  return out_({ ok: true, rev: last - 1, events: events }, p.callback);
}

/** POST（Content-Type: text/plain）本文 {k, events:[{eid,cts,person,type,target,value,data}]} */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'json' });
  }
  if (!authed_(body.k)) return out_({ ok: false, error: 'auth' });
  var evs = body.events || [];
  if (!evs.length) return out_({ ok: true, added: 0 });
  if (evs.length > MAX_EVENTS) return out_({ ok: false, error: 'too_many' });
  var now = new Date().toISOString();
  var rows = [];
  for (var i = 0; i < evs.length; i++) {
    var v = evs[i];
    if (!TYPES[v.type]) return out_({ ok: false, error: 'type' });
    if (!/^[\w\-:.]{1,64}$/.test(String(v.eid || ''))) return out_({ ok: false, error: 'eid' });
    if (!/^[\w\-:.]{0,40}$/.test(String(v.target || ''))) return out_({ ok: false, error: 'target' });
    if (String(v.value == null ? '' : v.value).length > 20) return out_({ ok: false, error: 'value' });
    var data = v.data == null ? '' : (typeof v.data === 'string' ? v.data : JSON.stringify(v.data));
    if (data.length > 2000) return out_({ ok: false, error: 'data' });
    if (v.person !== 'A' && v.person !== 'B') return out_({ ok: false, error: 'person' });
    rows.push([now, String(v.eid), Number(v.cts) || 0, v.person, v.type,
               escape_(v.target), escape_(v.value == null ? '' : String(v.value)), escape_(data)]);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true, added: rows.length });
}

/** 先頭が = + - @ の文字列は数式として実行されないよう ' を付けて保存する */
function escape_(s) {
  s = s == null ? '' : String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function unescape_(s) {
  s = s == null ? '' : String(s);
  return s.charAt(0) === "'" ? s.slice(1) : s;
}
