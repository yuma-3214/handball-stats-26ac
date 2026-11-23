# ハンドボール国際大会 公式スタッツ可視化ダッシュボード（運用手順書）

Toma-soft形式の公式スタッツPDFを Googleドライブ同期フォルダから自動読み込みし、全試合の集計・5項目自動検算・可視化を行う完全無料・オフライン対応のWebダッシュボードです。

---

## 1. 新しいPDFを追加したときの更新手順

試合終了後、Googleドライブ同期フォルダ（`26AC_Official-Stats`）に新しいPDF（例：`261125_Japan-Iran.pdf`）が同期されたら、以下の**どちらか**を実行するだけで最新化されます。

### 方法A：ダブルクリックで一括更新（基本）
1. プロジェクトフォルダ直下の **`Update_Dashboard.command`** をダブルクリックします。
2. ターミナルが開き、以下が自動実行されます：
   - Googleドライブ同期フォルダ内の全 `.pdf` を読み込み・解析（隠しファイルは自動除外、同名更新時は最新データで上書き）
   - **5項目の自動検算**を実行し、結果をターミナルに表示
   - `dist/`（Web公開用）と `dist/dashboard_offline.html`（単一オフラインHTML）を最新化
   - ローカルサーバーを起動し、ブラウザで最新ダッシュボードを表示

> **補足（初回のみ）**: macOSで「開発元を確認できないため開けません」と表示された場合は、`Update_Dashboard.command` を **右クリック → 開く** を選択してください。

### 方法B：ダッシュボード画面からワンクリック更新（サーバー起動中）
- `http://127.0.0.1:8765/` を開いている間は、画面右上の青い **「Update from Drive」** ボタンをクリックするだけで、Googleドライブ同期フォルダを再スキャンして画面を即座に最新化できます。

---

## 2. オフライン環境・弱回線での利用方法

- 外部CDNは一切使用しておらず、Chart.js を含めすべてローカルにバンドルしています。
- ネット接続が不安定な会場や移動中でも、**`dist/dashboard_offline.html`** をダブルクリックするだけで全機能（フィルター・グラフ・選手詳細モーダル・検算ログ）が完全オフラインで動作します。
- AirDrop や LINE / メール等でこの1ファイルだけ共有しても、受け取った側のPC・スマホでそのまま閲覧できます。

---

## 3. コーチ・選手のスマホへ無料URLで公開する手順（GitHub Pages）

GitHub Pages（無料）を使うと、チーム全員がスマホのブラウザから最新ダッシュボードを閲覧できる専用URLを発行できます。さらに `Update_Dashboard.command` と連携させることで、**以降はダブルクリック1回でスマホURLまで自動更新**できます。

### 初回セットアップ（約3分）
1. GitHub で新しいリポジトリを作成します（例：`handball-stats-26ac`）。
   - ※ 無料プランで公開URLを使う場合は **Public** を選択してください（限定公開にしたい場合は GitHub Pro または Cloudflare Pages / Netlify の利用も可能です）。
2. ターミナルでプロジェクトフォルダへ移動し、初回プッシュを実行します：
   ```bash
   cd /Users/jyouhoukagaku/.gemini/antigravity/scratch/handball-stats-dashboard
   cp -R dist docs
   git init
   git branch -M main
   git add .
   git commit -m "Initial dashboard setup"
   git remote add origin https://github.com/<あなたのユーザー名>/handball-stats-26ac.git
   git push -u origin main
   ```
3. GitHub のリポジトリ画面で **Settings → Pages** を開きます：
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` / フォルダ **`/docs`** を選択して **Save**
4. 1〜2分待つと公開URL（`https://<あなたのユーザー名>.github.io/handball-stats-26ac/`）が発行されます。このURLをコーチ・選手へ共有してください。

### 2回目以降の自動公開設定（ワンクリック化）
`config.json` に `"auto_publish_pages": true` を追加・変更しておくと、**`Update_Dashboard.command` をダブルクリックするたびに `docs/` の同期 → `git commit` → `git push` まで自動実行**され、約1分後に全員のスマホURLへ最新試合が反映されます。

```json
{
  "pdf_dir": "/Users/<Macユーザー名>/Library/CloudStorage/GoogleDrive-<Googleアカウント>/マイドライブ/26AC_Official-Stats",
  "default_team": "Japan",
  "server_host": "127.0.0.1",
  "server_port": 8765,
  "auto_publish_pages": true
}
```
> ネット未接続の環境でダブルクリックしても、自動で `git push` をスキップしてローカル版・オフライン版のみ更新するため安全です。

---

## 4. 自動検算（5項目）について

全PDF読み込み時に以下の5項目を自動チェックし、ダッシュボードの **`Data Status`** タブとターミナルへ出力します。

1. **Player/GK Sum vs TOTAL**: 個人合計（Goals/Attempts・エリア別・As/E7/Tr/St/2m・GK Saves/Shots）が PDF の `TOTAL` 行と一致するか
2. **6-Area Sum vs Tot**: `9m + 6m + Wng + 7m + FB + Brk` の合計が `Tot` と一致するか
   - ※ Toma-soft の仕様上、エンプティゴール等（6エリア外のシュート）は `Tot` のみに計上されるため、正当な差分がある場合はエラーにせず注記として明示します。
   - ※ Toma-soft 側のPDF生成不具合で一部試合の右側チームGK `TOTAL` 行の `FB` セーブ数が誤印字されるケースも自動検知し、個人GK合算値を用いて正確に集計したうえで `Data Status` に注記を残します。
3. **Team TOTAL Goals vs Match Score**: チームの `TOTAL Goals` がヘッダー最終スコアと一致するか
4. **GK Conceded vs Opponent Score**: GK の `TOTAL (Shots - Saves)` が対戦相手の最終スコアと一致するか（エンプティネット失点がある場合は注記を表示）
5. **Timeline Final Score vs Match Score**: 右側タイムライン最終スコアおよび5分刻み集計が試合スコアと一致するか（不一致時はメイン集計を止めず `WARNING` 扱い）

---

## 5. 主なファイル構成

- `config.json`: PDF参照先フォルダ・初期選択チーム・ポート番号・自動公開設定
- `Update_Dashboard.command`: Mac用ワンクリック更新・起動スクリプト
- `src/parser.py`: Toma-soft形式PDFの座標ベースパーサー（`pdfplumber`使用）
- `src/validator.py`: 5項目自動検算エンジン
- `src/pipeline.py`: 全PDF解析・検算・`dist/` および `dashboard_offline.html` 生成パイプライン
- `src/server.py`: 「Update from Drive」ボタン対応ローカルWebサーバー
- `dist/`: Web公開用軽量静的サイト一式（外部CDN依存ゼロ）
- `dist/dashboard_offline.html`: 1ファイル完結型オフラインダッシュボード
