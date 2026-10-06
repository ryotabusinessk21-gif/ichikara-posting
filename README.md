# イチカラ ポスティング管理

チラシのポスティング（1万部・2人で分担）を計画・記録するためのWebツール。

- 公開URL: https://ryotabusinessk21-gif.github.io/ichikara-posting/ （検索エンジンには載せない設定）
- 画面: `docs/`（GitHub Pages で公開）
- 計画データの作成: `pipeline/`（Python。手元で実行）
- 共有データ: Google スプレッドシート＋Apps Script（`gas/Code.gs`）

## 使い方（スマホ）

| タブ | できること |
|---|---|
| 計画 | 対象の区画（約200世帯ずつ）を担当の色で表示。区画をタップすると世帯数・ルート長・目安時間。［編集］で区画を連続タップして 対象ON/OFF・優先★・担当A/B を変更。［町名リスト］で町ごとにまとめて入れる／外す |
| 今日の配布 | 自分の次の区画と一筆書きルート（矢印・スタート）を表示。［開始］→ 配り終えたブロックをタップして塗る →［終了して記録］で枚数・時間・メモ |
| 進捗 | 塗った地図・実績枚数・二人の回数。［まとめて塗る］で紙の地図の分を登録。［補正］で実績から推定率と目安時間を直す |
| その他 | この端末で配る人、表示名（あだ名）、目標部数、手動指定の解除、データの出典 |

- ◎ボタンで現在地（青い点）を表示
- 電波がなくても塗れる。つながったら自動で送る（右上に「未送信 n」）

## 数字の意味（推定値）

- **世帯数**: 令和2年国勢調査の基本単位区（ほぼ街区）の世帯数（2020年10月時点）
- **推定配布数** ＝ 世帯数 × 推定率。推定率の初期値 1.00 は「全世帯に1枚」という上限の仮定。実績（配った枚数 ÷ 塗ったブロックの世帯数）で補正する
- **目安時間** ＝ ルート長 ÷ 分速70m ＋ 1枚10秒（どちらも仮置き）× 実績からの補正
- **ルート**: 区画に面した住宅地の道（25m 以内に建物がある区間）を全部通る、最短の一筆書き。赤い実線が配る道、灰色の点線は移動だけ

## 計画データを作り直す

```
cd pipeline
py -V:3.14 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python p1_fetch_estat.py     # e-Stat 境界データ
.venv\Scripts\python p2_blocks.py          # ブロック・町（世帯数の検査つき → out/p2_check.txt）
.venv\Scripts\python p3_osm.py             # OSM 道路網・区切り・スタジオからの距離
.venv\Scripts\python p3b_buildings.py      # OSM 建物（家のない道を外すため）
.venv\Scripts\python p4_areas.py           # 狙いエリアの割り当て → out/target_towns.csv / .html で確認
.venv\Scripts\python p5_zones.py           # 区画分け
.venv\Scripts\python p6_routes.py          # 一筆書きルート（数分）
.venv\Scripts\python p7_export.py          # docs/data/*.json
.venv\Scripts\python p8_preview.py         # ルート確認画像 out/preview_*.png
```

- 設定は `pipeline/config/`（スタジオ・範囲・区画の大きさ・狙いエリアのルール・学区名）
- 塗った記録はブロック単位（e-Stat の KEY_CODE）なので、作り直しても消えない。区画の ID は町の分け方が変わると変わる（手動の「入れる／外す／担当」は付け直しが必要）

## 共有データの設定（初回だけ）

1. Google スプレッドシートを作る（名前は任意。例「イチカラ ポスティング管理」）
2. 拡張機能 → Apps Script → `gas/Code.gs` の中身を貼って保存 → 関数 `setup` を実行して許可
3. プロジェクトの設定 → スクリプト プロパティ → `PASSCODE` に二人で決めた合言葉
4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」→ 実行ユーザー「自分」・アクセス「全員」→ URL をコピー
5. `docs/js/config.js` の `GAS_URL` に貼って公開
6. コードを直したときは「デプロイを管理 → 編集 → 新バージョン」（URL を変えないため）

記録の取り消しは、スプレッドシートの `events` シートで該当の行を削除する。

## 出典・ライセンス

- 世帯数・境界: 政府統計の総合窓口(e-Stat)「令和2年国勢調査 小地域（基本単位区・町丁字等）境界データ」を加工して作成
- 道路・建物: © OpenStreetMap contributors。`docs/data/zones.json`・`routes.json` は OpenStreetMap を加工したデータベースで、[ODbL](https://opendatacommons.org/licenses/odbl/) で提供する
- 背景地図: 国土地理院 地理院タイル（淡色地図）
- 地図ライブラリ: Leaflet（BSD-2-Clause）
