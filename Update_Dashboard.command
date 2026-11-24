#!/bin/bash
set -euo pipefail

# プロジェクトルートへ移動（ダブルクリック起動対応）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================================================"
echo "  ハンドボール公式スタッツ ダッシュボード更新ツール"
echo "============================================================================"
echo ""

# 仮想環境の確認・自動セットアップ
PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  echo "初回セットアップ: Python仮想環境を作成しています..."
  python3 -m venv "$SCRIPT_DIR/.venv"
  "$SCRIPT_DIR/.venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"
fi

# 1. Googleドライブ同期フォルダから全PDFを読み込み・検算・ビルド
echo "[1/3] Googleドライブ同期フォルダからPDFを解析・検算しています..."
"$PYTHON_BIN" "$SCRIPT_DIR/src/pipeline.py"

# 2. オプション: GitHub Pages への自動公開（config.json で auto_publish_pages: true の場合のみ実行）
AUTO_PUBLISH=$("$PYTHON_BIN" -c 'import json; c=json.load(open("config.json")); print("1" if c.get("auto_publish_pages") else "0")')
if [ "$AUTO_PUBLISH" = "1" ] && [ -d "$SCRIPT_DIR/.git" ]; then
  echo ""
  echo "[2/3] GitHub Pages 用に最新ダッシュボードを公開しています..."
  # docs/ フォルダ（GitHub Pages公開用）へ dist/ を同期して push
  rm -rf "$SCRIPT_DIR/docs"
  cp -R "$SCRIPT_DIR/dist" "$SCRIPT_DIR/docs"
  git add docs/ dist/ data/stats.json web/ src/ Update_Dashboard.command README.md .gitignore
  if ! git diff --cached --quiet; then
    git commit -m "Update official stats dashboard ($(date '+%Y-%m-%d %H:%M'))"
    git push || echo "⚠️ ネット未接続のためGitHubへの反映をスキップしました（ローカル版は最新です）。"
  else
    echo "ℹ️ 公開済みデータと差分はありませんでした。"
  fi
else
  echo ""
  echo "[2/3] ローカル静的サイト (dist/) およびオフライン版 (dist/dashboard_offline.html) を生成しました。"
fi

# 3. ローカルサーバー起動＆ブラウザ表示
PORT=$("$PYTHON_BIN" -c 'import json; c=json.load(open("config.json")); print(c.get("server_port", 8765))')
URL="http://127.0.0.1:${PORT}/"

echo ""
echo "[3/3] ダッシュボードをブラウザで開きます..."
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "✅ ローカルサーバーは既に起動中です: $URL"
  open "$URL"
  echo ""
  echo "更新が完了しました。このウィンドウは閉じて構いません。"
else
  exec "$PYTHON_BIN" "$SCRIPT_DIR/src/server.py"
fi
