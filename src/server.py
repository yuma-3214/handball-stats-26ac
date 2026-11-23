"""Lightweight local HTTP server with one-click Google Drive refresh endpoint."""

from __future__ import annotations

import json
import os
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.pipeline import load_config, run_pipeline

_REFRESH_LOCK = threading.Lock()


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
                    "pdf_dir": config.get("pdf_dir", ""),
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
                result = run_pipeline(verbose=True)
                self._send_json(
                    {
                        "status": "ok",
                        "summary": result["summary"],
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
        # Keep terminal output concise
        sys.stderr.write(f"[server] {self.address_string()} - {format % args}\n")


def start_server(open_browser: bool = True, host: str | None = None, port: int | None = None) -> None:
    config = load_config()
    bind_host = host or config.get("server_host", "127.0.0.1")
    bind_port = int(port or config.get("server_port", 8765))

    server = ThreadingHTTPServer((bind_host, bind_port), DashboardRequestHandler)
    url = f"http://{bind_host}:{bind_port}/"
    print(f"\n🌐 ローカルダッシュボードサーバーを起動しました: {url}")
    print("   画面上部の「Update from Drive」ボタンから最新PDFをワンクリック再読み込みできます。")
    print("   終了するには Ctrl+C を押してください。\n")

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを終了しました。")
    finally:
        server.server_close()


if __name__ == "__main__":
    no_browser = "--no-browser" in sys.argv
    port_arg = None
    for idx, arg in enumerate(sys.argv):
        if arg == "--port" and idx + 1 < len(sys.argv):
            port_arg = int(sys.argv[idx + 1])
    start_server(open_browser=not no_browser, port=port_arg)
