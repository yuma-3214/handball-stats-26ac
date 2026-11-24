"""Lightweight local HTTP server with one-click Google Drive refresh & optional GitHub Pages sync."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.pipeline import DIST_DIR, load_config, run_pipeline

_REFRESH_LOCK = threading.Lock()


def _safe_write(stream: Any, text: str) -> None:
    """Write to stdout/stderr without crashing if parent pipe was closed."""
    try:
        stream.write(text)
        stream.flush()
    except OSError:
        pass


def _publish_to_github_pages() -> dict[str, Any]:
    """Sync dist/ -> docs/ and push to GitHub Pages if configured."""
    config = load_config()
    if not config.get("auto_publish_pages"):
        return {"attempted": False, "pushed": False, "message": "auto_publish_pages disabled"}
    if not (PROJECT_ROOT / ".git").exists():
        return {"attempted": False, "pushed": False, "message": "not a git repo"}

    try:
        docs_dir = PROJECT_ROOT / "docs"
        if docs_dir.exists():
            shutil.rmtree(docs_dir)
        shutil.copytree(DIST_DIR, docs_dir)
        offline_in_docs = docs_dir / "dashboard_offline.html"
        if offline_in_docs.exists():
            offline_in_docs.unlink()

        subprocess.run(
            [
                "git",
                "add",
                "docs/",
                "dist/",
                "data/stats.json",
                "web/",
                "src/",
                "Update_Dashboard.command",
                "README.md",
                ".gitignore",
            ],
            cwd=str(PROJECT_ROOT),
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )

        diff_res = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            timeout=10,
        )
        if diff_res.returncode == 0:
            return {"attempted": True, "pushed": False, "message": "already up to date"}

        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        subprocess.run(
            ["git", "commit", "-m", f"Update official stats dashboard ({ts})"],
            cwd=str(PROJECT_ROOT),
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        push_res = subprocess.run(
            ["git", "push"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if push_res.returncode == 0:
            return {"attempted": True, "pushed": True, "message": "GitHub Pages updated"}
        return {
            "attempted": True,
            "pushed": False,
            "message": f"local updated, git push skipped ({push_res.stderr.strip()[:120]})",
        }
    except Exception as exc:  # noqa: BLE001
        return {"attempted": True, "pushed": False, "message": f"local updated, publish skipped ({exc})"}


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


class DashboardRequestHandler(SimpleHTTPRequestHandler):
    """Serves static files from dist/ and exposes /api/health and /api/refresh."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        dist_dir = str(PROJECT_ROOT / "dist")
        super().__init__(*args, directory=dist_dir, **kwargs)

    def end_headers(self) -> None:
        # Avoid stale cached data.json or assets during local analysis sessions
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def _send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            config = load_config()
            self._send_json(
                {
                    "status": "ok",
                    "mode": "local_server",
                    "pdf_source": Path(config.get("pdf_dir", "")).name,
                }
            )
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/refresh":
            if not _REFRESH_LOCK.acquire(blocking=False):
                self._send_json(
                    {"status": "busy", "message": "Refresh is already in progress."},
                    status=HTTPStatus.CONFLICT,
                )
                return
            try:
                # Run without stdout printing crashing on detached pipes
                result = run_pipeline(verbose=False)
                publish_info = _publish_to_github_pages()
                _safe_write(
                    sys.stderr,
                    f"[refresh] {result['summary']['parsed_matches']} matches "
                    f"(OK:{result['summary']['ok_matches']} ERR:{result['summary']['error_matches']}) "
                    f"publish={publish_info['message']}\n",
                )
                self._send_json(
                    {
                        "status": "ok",
                        "summary": result["summary"],
                        "publish": publish_info,
                        "data": result["data"],
                    }
                )
            except Exception as exc:  # noqa: BLE001
                self._send_json(
                    {"status": "error", "message": str(exc)},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            finally:
                _REFRESH_LOCK.release()
            return
        self._send_json({"status": "not_found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        _safe_write(sys.stderr, f"[server] {self.address_string()} - {format % args}\n")


def start_server(open_browser: bool = True, host: str | None = None, port: int | None = None) -> None:
    config = load_config()
    bind_host = host or config.get("server_host", "127.0.0.1")
    bind_port = int(port or config.get("server_port", 8765))

    server = ReusableThreadingHTTPServer((bind_host, bind_port), DashboardRequestHandler)
    url = f"http://{bind_host}:{bind_port}/"
    _safe_write(sys.stdout, f"\n🌐 ローカルダッシュボードサーバーを起動しました: {url}\n")
    _safe_write(sys.stdout, "   画面上部の「Update from Drive」ボタンから最新PDFをワンクリック再読み込みできます。\n")
    _safe_write(sys.stdout, "   終了するには Ctrl+C を押してください。\n\n")

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _safe_write(sys.stdout, "\nサーバーを終了しました。\n")
    finally:
        server.server_close()


if __name__ == "__main__":
    no_browser = "--no-browser" in sys.argv
    port_arg = None
    for idx, arg in enumerate(sys.argv):
        if arg == "--port" and idx + 1 < len(sys.argv):
            port_arg = int(sys.argv[idx + 1])
    start_server(open_browser=not no_browser, port=port_arg)
