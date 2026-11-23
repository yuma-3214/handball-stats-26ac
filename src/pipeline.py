"""End-to-end data pipeline: scan Google Drive PDFs -> parse -> validate -> build dist & offline HTML."""

from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.parser import parse_match_pdf
from src.validator import validate_match

CONFIG_PATH = PROJECT_ROOT / "config.json"
DATA_DIR = PROJECT_ROOT / "data"
WEB_DIR = PROJECT_ROOT / "web"
DIST_DIR = PROJECT_ROOT / "dist"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def discover_pdf_files(pdf_dir: str | Path) -> list[Path]:
    """Return sorted list of valid .pdf files, excluding macOS hidden/resource-fork files."""
    folder = Path(pdf_dir)
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"PDF directory not found: {folder}")

    pdfs: list[Path] = []
    for entry in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
        name = entry.name
        if name.startswith(".") or name.startswith("._") or name == ".DS_Store":
            continue
        if not entry.is_file():
            continue
        if entry.suffix.lower() != ".pdf":
            continue
        pdfs.append(entry)
    return pdfs


def _safe_inline_json(obj: Any) -> str:
    """Serialize JSON safely for embedding inside an HTML <script> tag."""
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return raw.replace("</", "<\\/")


def build_dist(stats_payload: dict[str, Any]) -> dict[str, str]:
    """Generate dist/ static site and dist/dashboard_offline.html single-file bundle."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # Write stats JSON
    stats_path = DATA_DIR / "stats.json"
    with stats_path.open("w", encoding="utf-8") as f:
        json.dump(stats_payload, f, ensure_ascii=False, indent=2)

    dist_data_path = DIST_DIR / "data.json"
    with dist_data_path.open("w", encoding="utf-8") as f:
        json.dump(stats_payload, f, ensure_ascii=False, separators=(",", ":"))

    index_src = WEB_DIR / "index.html"
    css_src = WEB_DIR / "styles.css"
    js_src = WEB_DIR / "app.js"
    chart_src = WEB_DIR / "vendor" / "chart.umd.min.js"

    if not all(p.exists() for p in (index_src, css_src, js_src, chart_src)):
        return {
            "stats_json": str(stats_path),
            "dist_data": str(dist_data_path),
            "offline_html": "",
        }

    # Copy static assets into dist/
    shutil.copy2(index_src, DIST_DIR / "index.html")
    shutil.copy2(css_src, DIST_DIR / "styles.css")
    shutil.copy2(js_src, DIST_DIR / "app.js")
    shutil.copy2(chart_src, DIST_DIR / "chart.umd.min.js")

    # Build completely self-contained offline HTML
    html_template = index_src.read_text(encoding="utf-8")
    css_content = css_src.read_text(encoding="utf-8")
    chart_content = chart_src.read_text(encoding="utf-8")
    js_content = js_src.read_text(encoding="utf-8")
    embedded_json = _safe_inline_json(stats_payload)

    offline_html = html_template
    offline_html = offline_html.replace(
        '<link rel="stylesheet" href="styles.css">',
        f"<style>\n{css_content}\n</style>",
    )
    offline_html = offline_html.replace(
        '<script src="chart.umd.min.js"></script>',
        f"<script>\nwindow.__OFFLINE_MODE__ = true;\nwindow.__HANDBALL_DATA__ = {embedded_json};\n</script>\n<script>\n{chart_content}\n</script>",
    )
    offline_html = offline_html.replace(
        '<script src="app.js"></script>',
        f"<script>\n{js_content}\n</script>",
    )

    offline_path = DIST_DIR / "dashboard_offline.html"
    offline_path.write_text(offline_html, encoding="utf-8")

    return {
        "stats_json": str(stats_path),
        "dist_index": str(DIST_DIR / "index.html"),
        "dist_data": str(dist_data_path),
        "offline_html": str(offline_path),
    }


def run_pipeline(verbose: bool = True) -> dict[str, Any]:
    """Scan pdf_dir, parse and validate all PDFs, and build dashboard outputs."""
    config = load_config()
    pdf_dir = config["pdf_dir"]
    default_team = config.get("default_team", "Japan")

    pdf_files = discover_pdf_files(pdf_dir)

    # Deduplicate by match_id (latest mtime wins if same stem ever appeared)
    matches_by_id: dict[str, dict[str, Any]] = {}
    parse_errors: list[dict[str, Any]] = []

    for pdf_path in pdf_files:
        match_id = pdf_path.stem
        try:
            match = parse_match_pdf(pdf_path)
            match["validation"] = validate_match(match)
            matches_by_id[match_id] = match
        except Exception as exc:  # noqa: BLE001
            parse_errors.append(
                {
                    "match_id": match_id,
                    "filename": pdf_path.name,
                    "error": str(exc),
                }
            )

    # Sort matches chronologically (Date asc, Time asc, match_id asc)
    matches = sorted(
        matches_by_id.values(),
        key=lambda m: (m["meta"].get("date", ""), m["meta"].get("time", ""), m["match_id"]),
    )

    # Collect unique team list & tournament name
    team_set: set[str] = set()
    tournament_name = config.get("tournament_name", "Handball Tournament Analytics")
    for m in matches:
        if m["meta"].get("team_a"):
            team_set.add(m["meta"]["team_a"])
        if m["meta"].get("team_b"):
            team_set.add(m["meta"]["team_b"])
        if m["meta"].get("tournament"):
            tournament_name = m["meta"]["tournament"]

    ok_count = sum(1 for m in matches if m["validation"]["status"] == "OK")
    warn_count = sum(1 for m in matches if m["validation"]["status"] == "WARNING")
    err_count = sum(1 for m in matches if m["validation"]["status"] == "ERROR") + len(parse_errors)

    summary = {
        "total_pdfs": len(pdf_files),
        "parsed_matches": len(matches),
        "ok_matches": ok_count,
        "warning_matches": warn_count,
        "error_matches": err_count,
        "teams": sorted(team_set),
    }

    payload = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "tournament_name": tournament_name,
        "default_team": default_team,
        "pdf_source": Path(pdf_dir).name,
        "summary": summary,
        "matches": matches,
        "parse_errors": parse_errors,
    }

    outputs = build_dist(payload)

    if verbose:
        _print_terminal_report(payload, outputs)

    return {
        "summary": summary,
        "data": payload,
        "outputs": outputs,
    }


def _print_terminal_report(payload: dict[str, Any], outputs: dict[str, str]) -> None:
    s = payload["summary"]
    print("=" * 76)
    print(f"ハンドボール公式スタッツ解析・検算レポート ({payload['tournament_name']})")
    print(f"参照フォルダ: {payload.get('pdf_source', '')}")
    print(
        f"検出PDF: {s['total_pdfs']}件 | 解析成功: {s['parsed_matches']}試合 | "
        f"OK: {s['ok_matches']} | WARNING: {s['warning_matches']} | ERROR: {s['error_matches']}"
    )
    print("-" * 76)

    for m in payload["matches"]:
        meta = m["meta"]
        v = m["validation"]
        badge = {"OK": "[OK]", "WARNING": "[WARN]", "ERROR": "[ERR]"}.get(v["status"], "[?]")
        print(
            f"{badge:6s} {m['match_id']} | "
            f"{meta['team_a']} {meta['score_a']} - {meta['score_b']} {meta['team_b']} "
            f"(Half: {meta['half_score_1']} / {meta['half_score_2']})"
        )
        for chk in v["checks"]:
            c_badge = chk["status"]
            print(f"       Check {chk['id']} ({chk['name']}): {c_badge} - {chk['details']}")
        for note in v.get("notes", []):
            print(f"       ↳ 注記: {note}")

    for pe in payload["parse_errors"]:
        print(f"[ERR]  {pe['filename']} の解析に失敗: {pe['error']}")

    print("-" * 76)
    if outputs.get("offline_html"):
        print(f"✅ 静的サイト更新完了 : {outputs.get('dist_index')}")
        print(f"✅ オフライン単一HTML : {outputs.get('offline_html')}")
    else:
        print(f"✅ データJSON出力完了 : {outputs.get('stats_json')}")
    print("=" * 76)


if __name__ == "__main__":
    result = run_pipeline(verbose=True)
    if result["summary"]["error_matches"] > 0:
        sys.exit(1)
