"""Coordinate-based parser for Toma-soft official handball statistics PDFs."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import pdfplumber

AREAS = ("9m", "6m", "Wng", "7m", "FB", "Brk")
BUCKET_LABELS = (
    "0-5",
    "5-10",
    "10-15",
    "15-20",
    "20-25",
    "25-30",
    "30-35",
    "35-40",
    "40-45",
    "45-50",
    "50-55",
    "55-60",
)

TIMELINE_SPLIT_X = 425.0
FOOTER_MIN_Y = 785.0

_RATIO_RE = re.compile(r"^(\d+)/(\d+)$")
_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+[.,]\d+$")
_SCORE_LINE_RE = re.compile(r"^(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+)$")
_HALF_SCORE_RE = re.compile(r"\(\s*(\d+)\s*-\s*(\d+)\s*\)")
_DATE_RE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})\.?")
_TIME_RE = re.compile(r"\b(\d{1,2}:\d{2})\b")
_TIMELINE_RE = re.compile(r"(\d+)\s+\((\d+)'\)\s+(\d+)")


def _group_lines(words: list[dict[str, Any]], tol: float = 2.6) -> list[list[dict[str, Any]]]:
    """Group pdfplumber word dicts into visual horizontal lines."""
    lines: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - word["top"]) <= tol:
            lines[-1].append(word)
        else:
            lines.append([word])
    for line in lines:
        line.sort(key=lambda w: w["x0"])
    return lines


def _word_center(word: dict[str, Any]) -> float:
    return (float(word["x0"]) + float(word["x1"])) / 2.0


def _parse_ratio(text: str) -> tuple[int, int] | None:
    m = _RATIO_RE.match(text.strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def _parse_float(text: str) -> float | None:
    cleaned = text.strip().replace(",", ".")
    if not re.match(r"^-?\d+(?:\.\d+)?$", cleaned):
        return None
    return float(cleaned)


def _empty_player_areas() -> dict[str, dict[str, int]]:
    return {area: {"g": 0, "a": 0} for area in AREAS}


def _empty_gk_areas() -> dict[str, dict[str, int]]:
    return {area: {"s": 0, "sh": 0} for area in AREAS}


def _extract_header_metadata(
    words: list[dict[str, Any]],
    match_id: str,
) -> dict[str, Any]:
    """Extract match metadata from the top section of page 1 (y < 126)."""
    header_words = [w for w in words if w["top"] < 126.0]
    lines = _group_lines(header_words, tol=3.0)

    tournament = ""
    round_name = ""
    team_a = ""
    team_b = ""
    score_a = 0
    score_b = 0
    date_iso = ""
    date_display = ""
    match_time = ""
    attendance = ""
    venue = ""
    referees = ""
    half_pairs: list[tuple[int, int]] = []

    for line in lines:
        y = line[0]["top"]
        full_text = " ".join(w["text"] for w in line).strip()

        if y < 38.0:
            tournament = (tournament + " " + full_text).strip()
            continue

        if 38.0 <= y < 65.0:
            round_name = (round_name + " " + full_text).strip()
            continue

        if 65.0 <= y < 90.0:
            # Left: "Basic statistics", Center (100..445): Teams & score, Right (>=445): date & time
            center_words = [w for w in line if 95.0 <= w["x0"] < 445.0]
            right_words = [w for w in line if w["x0"] >= 445.0]
            center_text = " ".join(w["text"] for w in center_words).strip()
            right_text = " ".join(w["text"] for w in right_words).strip()

            m_score = _SCORE_LINE_RE.match(center_text)
            if m_score:
                team_a = m_score.group(1).strip()
                score_a = int(m_score.group(2))
                score_b = int(m_score.group(3))
                team_b = m_score.group(4).strip()

            m_date = _DATE_RE.search(right_text)
            if m_date:
                dd, mm, yyyy = m_date.group(1), m_date.group(2), m_date.group(3)
                date_iso = f"{yyyy}-{mm}-{dd}"
                date_display = f"{dd}.{mm}.{yyyy}"
            m_time = _TIME_RE.search(right_text)
            if m_time:
                match_time = m_time.group(1)
            continue

        if 90.0 <= y < 114.0:
            center_words = [w for w in line if 140.0 <= w["x0"] < 430.0]
            right_words = [w for w in line if w["x0"] >= 430.0]
            center_text = " ".join(w["text"] for w in center_words).strip()
            right_text = " ".join(w["text"] for w in right_words).strip()

            if center_text:
                found = _HALF_SCORE_RE.findall(center_text)
                if found:
                    half_pairs = [(int(a), int(b)) for a, b in found]

            if right_text:
                if right_text.startswith("Attendance:"):
                    attendance = right_text.replace("Attendance:", "").strip()
                else:
                    venue = (venue + " " + right_text).strip()
            continue

        if 114.0 <= y < 126.0:
            left_words = [w for w in line if w["x0"] < 430.0]
            left_text = " ".join(w["text"] for w in left_words).strip()
            if left_text.startswith("Referees:"):
                referees = left_text.replace("Referees:", "").strip()

    # Fallback date from filename YYMMDD_...
    if not date_iso:
        m_fn = re.match(r"^(\d{2})(\d{2})(\d{2})_", match_id)
        if m_fn:
            yy, mm, dd = m_fn.group(1), m_fn.group(2), m_fn.group(3)
            date_iso = f"20{yy}-{mm}-{dd}"
            date_display = f"{dd}.{mm}.20{yy}"

    half1 = half_pairs[0] if len(half_pairs) >= 1 else (0, 0)
    half2 = half_pairs[1] if len(half_pairs) >= 2 else (0, 0)

    return {
        "tournament": tournament,
        "round": round_name,
        "date": date_iso,
        "date_display": date_display,
        "time": match_time,
        "attendance": attendance,
        "venue": venue,
        "referees": referees,
        "team_a": team_a,
        "team_b": team_b,
        "score_a": score_a,
        "score_b": score_b,
        "half_score_1": f"{half1[0]} - {half1[1]}",
        "half_score_2": f"{half2[0]} - {half2[1]}",
        "half1_a": half1[0],
        "half1_b": half1[1],
        "half2_a": half2[0],
        "half2_b": half2[1],
    }


def _detect_column_centers(header_line: list[dict[str, Any]], expected_keys: tuple[str, ...]) -> dict[str, float]:
    """Map canonical column keys to their horizontal center x-coordinate from the header row."""
    alias_map = {
        "#": "#",
        "Tot.": "Tot",
        "Tot": "Tot",
        "%": "%",
        "9m": "9m",
        "6m": "6m",
        "Wng.": "Wng",
        "Wng": "Wng",
        "7m": "7m",
        "FB": "FB",
        "Brk.": "Brk",
        "Brk": "Brk",
        "As.": "As",
        "As": "As",
        "E7": "E7",
        "Tr.": "Tr",
        "Tr": "Tr",
        "St.": "St",
        "St": "St",
        "2m": "2m",
        "Val.": "Val",
        "Val": "Val",
    }
    centers: dict[str, float] = {}
    for w in header_line:
        key = alias_map.get(w["text"].strip())
        if key and key in expected_keys and key not in centers:
            centers[key] = _word_center(w)
    return centers


def _assign_column(x_center: float, col_centers: dict[str, float], stat_keys: tuple[str, ...]) -> str:
    """Assign a numeric/ratio token to the closest stat column by horizontal center."""
    best_key = stat_keys[0]
    best_dist = float("inf")
    for key in stat_keys:
        if key not in col_centers:
            continue
        dist = abs(x_center - col_centers[key])
        if dist < best_dist:
            best_dist = dist
            best_key = key
    return best_key


def _parse_players_table(
    lines: list[list[dict[str, Any]]],
    header_idx: int,
    team: str,
    opponent: str,
) -> tuple[list[dict[str, Any]], dict[str, int], dict[str, Any], int]:
    """Parse a Field Players table starting at its '# Surname and name ...' header row."""
    stat_keys = ("Tot", "%", "9m", "6m", "Wng", "7m", "FB", "Brk", "As", "E7", "Tr", "St", "2m", "Val")
    col_centers = _detect_column_centers(lines[header_idx], ("#",) + stat_keys)
    stat_start_x = min(col_centers.get("Tot", 155.0) - 14.0, 142.0)
    jersey_max_x = col_centers.get("#", 24.5) + 4.5

    players: list[dict[str, Any]] = []
    bench = {"as": 0, "e7": 0, "tr": 0, "st": 0, "2m": 0}
    total_row: dict[str, Any] = {
        "tot": {"g": 0, "a": 0},
        "areas": _empty_player_areas(),
        "as": 0,
        "e7": 0,
        "tr": 0,
        "st": 0,
        "2m": 0,
    }

    idx = header_idx + 1
    while idx < len(lines):
        line = lines[idx]
        joined = " ".join(w["text"] for w in line).strip()

        if joined.startswith("Goalkeepers") or joined.startswith("Coach:"):
            break

        # Detect TOTAL row
        if line[0]["text"] == "TOTAL":
            for w in line[1:]:
                if w["x0"] < stat_start_x:
                    continue
                col = _assign_column(_word_center(w), col_centers, stat_keys)
                if col == "Tot":
                    r = _parse_ratio(w["text"])
                    if r:
                        total_row["tot"] = {"g": r[0], "a": r[1]}
                elif col in AREAS:
                    r = _parse_ratio(w["text"])
                    if r:
                        total_row["areas"][col] = {"g": r[0], "a": r[1]}
                elif col in ("As", "E7", "Tr", "St", "2m") and _INT_RE.match(w["text"]):
                    total_row[col.lower()] = int(w["text"])
            idx += 1
            break

        # Detect Team / bench row
        if joined.startswith("Team / bench") or (len(line) >= 3 and line[0]["text"] == "Team" and line[2]["text"] == "bench"):
            for w in line:
                if w["x0"] < stat_start_x:
                    continue
                col = _assign_column(_word_center(w), col_centers, stat_keys)
                if col in ("As", "E7", "Tr", "St", "2m") and _INT_RE.match(w["text"]):
                    bench[col.lower()] = int(w["text"])
            idx += 1
            continue

        # Detect jersey number in leftmost column
        jersey_words = [w for w in line if w["x1"] <= jersey_max_x + 1.0 and w["text"].isdigit()]
        name_words = [w for w in line if w["x0"] > jersey_max_x - 1.5 and w["x0"] < stat_start_x]
        stat_words = [w for w in line if w["x0"] >= stat_start_x]

        # Multi-line wrapped player name continuation (no jersey, no stats, only name text)
        if not jersey_words and name_words and not stat_words and players:
            cont_name = " ".join(w["text"] for w in name_words).strip()
            players[-1]["name"] = f"{players[-1]['name']} {cont_name}".strip()
            idx += 1
            continue

        if jersey_words:
            player: dict[str, Any] = {
                "jersey": jersey_words[0]["text"].strip(),
                "name": " ".join(w["text"] for w in name_words).strip(),
                "team": team,
                "opponent": opponent,
                "tot": {"g": 0, "a": 0},
                "areas": _empty_player_areas(),
                "as": 0,
                "e7": 0,
                "tr": 0,
                "st": 0,
                "2m": 0,
                "val": 0.0,
            }
            for w in stat_words:
                col = _assign_column(_word_center(w), col_centers, stat_keys)
                if col == "Tot":
                    r = _parse_ratio(w["text"])
                    if r:
                        player["tot"] = {"g": r[0], "a": r[1]}
                elif col in AREAS:
                    r = _parse_ratio(w["text"])
                    if r:
                        player["areas"][col] = {"g": r[0], "a": r[1]}
                elif col in ("As", "E7", "Tr", "St", "2m") and _INT_RE.match(w["text"]):
                    player[col.lower()] = int(w["text"])
                elif col == "Val":
                    v = _parse_float(w["text"])
                    if v is not None:
                        player["val"] = v
            players.append(player)

        idx += 1

    return players, bench, total_row, idx


def _parse_goalkeepers_table(
    lines: list[list[dict[str, Any]]],
    header_idx: int,
    team: str,
    opponent: str,
) -> tuple[list[dict[str, Any]], dict[str, Any], int]:
    """Parse a Goalkeepers table starting at its '# Surname and name ...' header row."""
    stat_keys = ("Tot", "%", "9m", "6m", "Wng", "7m", "FB", "Brk", "Val")
    col_centers = _detect_column_centers(lines[header_idx], ("#",) + stat_keys)
    stat_start_x = min(col_centers.get("Tot", 157.0) - 14.0, 143.0)
    jersey_max_x = col_centers.get("#", 25.8) + 4.5

    goalkeepers: list[dict[str, Any]] = []
    pdf_total: dict[str, Any] = {
        "tot": {"s": 0, "sh": 0},
        "areas": _empty_gk_areas(),
    }

    idx = header_idx + 1
    while idx < len(lines):
        line = lines[idx]
        joined = " ".join(w["text"] for w in line).strip()

        if joined.startswith("Coach:") or joined.startswith("Players"):
            break

        if line[0]["text"] == "TOTAL":
            for w in line[1:]:
                if w["x0"] < stat_start_x:
                    continue
                col = _assign_column(_word_center(w), col_centers, stat_keys)
                if col == "Tot":
                    r = _parse_ratio(w["text"])
                    if r:
                        pdf_total["tot"] = {"s": r[0], "sh": r[1]}
                elif col in AREAS:
                    r = _parse_ratio(w["text"])
                    if r:
                        pdf_total["areas"][col] = {"s": r[0], "sh": r[1]}
            idx += 1
            break

        jersey_words = [w for w in line if w["x1"] <= jersey_max_x + 1.0 and w["text"].isdigit()]
        name_words = [w for w in line if w["x0"] > jersey_max_x - 1.5 and w["x0"] < stat_start_x]
        stat_words = [w for w in line if w["x0"] >= stat_start_x]

        # Multi-line wrapped goalkeeper name continuation
        if not jersey_words and name_words and not stat_words and goalkeepers:
            cont_name = " ".join(w["text"] for w in name_words).strip()
            goalkeepers[-1]["name"] = f"{goalkeepers[-1]['name']} {cont_name}".strip()
            idx += 1
            continue

        if jersey_words:
            gk: dict[str, Any] = {
                "jersey": jersey_words[0]["text"].strip(),
                "name": " ".join(w["text"] for w in name_words).strip(),
                "team": team,
                "opponent": opponent,
                "tot": {"s": 0, "sh": 0},
                "areas": _empty_gk_areas(),
                "val": 0.0,
            }
            for w in stat_words:
                col = _assign_column(_word_center(w), col_centers, stat_keys)
                if col == "Tot":
                    r = _parse_ratio(w["text"])
                    if r:
                        gk["tot"] = {"s": r[0], "sh": r[1]}
                elif col in AREAS:
                    r = _parse_ratio(w["text"])
                    if r:
                        gk["areas"][col] = {"s": r[0], "sh": r[1]}
                elif col == "Val":
                    v = _parse_float(w["text"])
                    if v is not None:
                        gk["val"] = v
            goalkeepers.append(gk)

        idx += 1

    return goalkeepers, pdf_total, idx


def _sum_gk_totals(goalkeepers: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute goalkeeper team totals directly from individual goalkeeper rows."""
    tot_s = sum(gk["tot"]["s"] for gk in goalkeepers)
    tot_sh = sum(gk["tot"]["sh"] for gk in goalkeepers)
    areas = {
        area: {
            "s": sum(gk["areas"][area]["s"] for gk in goalkeepers),
            "sh": sum(gk["areas"][area]["sh"] for gk in goalkeepers),
        }
        for area in AREAS
    }
    return {"tot": {"s": tot_s, "sh": tot_sh}, "areas": areas}


def _parse_timeline(words: list[dict[str, Any]]) -> dict[str, Any]:
    """Best-effort parser for the right-side scoring timeline (5-minute buckets)."""
    buckets = [{"label": label, "a": 0, "b": 0} for label in BUCKET_LABELS]
    try:
        right_words = [
            w for w in words
            if w["x0"] >= TIMELINE_SPLIT_X and 124.0 <= w["top"] <= FOOTER_MIN_Y
        ]
        rlines = _group_lines(right_words, tol=2.6)

        events: list[dict[str, int]] = []
        current_half = 1
        unmatched_lines: list[str] = []

        for line in rlines:
            txt = " ".join(w["text"] for w in line).strip()
            if not txt:
                continue
            if "1." in txt and "half" in txt.lower():
                current_half = 1
                continue
            if "2." in txt and "half" in txt.lower():
                current_half = 2
                continue

            m = _TIMELINE_RE.search(txt)
            if m:
                sa = int(m.group(1))
                minute = int(m.group(2))
                sb = int(m.group(3))
                events.append({"half": current_half, "minute": minute, "a": sa, "b": sb})
            else:
                unmatched_lines.append(txt)

        if not events:
            return {
                "status": "WARNING",
                "message": "No timeline events found in PDF.",
                "event_count": 0,
                "final_a": 0,
                "final_b": 0,
                "buckets": buckets,
                "unmatched": unmatched_lines,
            }

        prev_a = 0
        prev_b = 0
        anomalies: list[str] = []
        for ev in events:
            da = ev["a"] - prev_a
            db = ev["b"] - prev_b
            if da < 0 or db < 0 or (da + db == 0):
                anomalies.append(f"Non-monotonic score at {ev['minute']}': {prev_a}-{prev_b} -> {ev['a']}-{ev['b']}")
            minute = ev["minute"]
            # Respect half boundary if minute is on boundary (1..30 in 1st half, 31..60 in 2nd half)
            if ev["half"] == 1:
                b_idx = min(5, max(0, (minute - 1) // 5))
            else:
                b_idx = min(11, max(6, (minute - 1) // 5))
            if da > 0:
                buckets[b_idx]["a"] += da
            if db > 0:
                buckets[b_idx]["b"] += db
            prev_a = ev["a"]
            prev_b = ev["b"]

        status = "OK" if not anomalies and not unmatched_lines else "WARNING"
        msg = "Parsed cleanly." if status == "OK" else "; ".join(anomalies[:3] + unmatched_lines[:3])
        return {
            "status": status,
            "message": msg,
            "event_count": len(events),
            "final_a": prev_a,
            "final_b": prev_b,
            "buckets": buckets,
            "unmatched": unmatched_lines,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "WARNING",
            "message": f"Timeline parsing failed: {exc}",
            "event_count": 0,
            "final_a": 0,
            "final_b": 0,
            "buckets": buckets,
            "unmatched": [],
        }


def parse_match_pdf(pdf_path: str | Path) -> dict[str, Any]:
    """Parse a single Toma-soft official stats PDF into structured match JSON."""
    path = Path(pdf_path)
    match_id = path.stem
    stat_info = path.stat()

    with pdfplumber.open(str(path)) as pdf:
        if not pdf.pages:
            raise ValueError(f"PDF has no pages: {path.name}")
        page = pdf.pages[0]
        words = page.extract_words(keep_blank_chars=False, use_text_flow=False)

    meta = _extract_header_metadata(words, match_id)
    team_a = meta["team_a"]
    team_b = meta["team_b"]

    # Split left-side tables (x < 425, y between 124 and footer)
    left_words = [
        w for w in words
        if w["x0"] < TIMELINE_SPLIT_X and 124.0 <= w["top"] <= FOOTER_MIN_Y
    ]
    left_lines = _group_lines(left_words, tol=2.6)

    # Locate the two Players headers and two Goalkeepers headers sequentially
    sections: list[dict[str, Any]] = []
    idx = 0
    team_slots = [
        ("a", team_a, team_b, meta["score_a"], meta["score_b"]),
        ("b", team_b, team_a, meta["score_b"], meta["score_a"]),
    ]

    for slot_key, t_name, opp_name, t_score, opp_score in team_slots:
        players_header_idx = None
        while idx < len(left_lines):
            txt = " ".join(w["text"] for w in left_lines[idx])
            if txt.startswith("# Surname and name") and "As." in txt:
                players_header_idx = idx
                break
            idx += 1
        if players_header_idx is None:
            raise ValueError(f"Could not find Field Players table for {t_name} in {path.name}")

        players, bench, player_total, idx = _parse_players_table(
            left_lines, players_header_idx, t_name, opp_name
        )

        gk_header_idx = None
        while idx < len(left_lines):
            txt = " ".join(w["text"] for w in left_lines[idx])
            if txt.startswith("# Surname and name") and "As." not in txt:
                gk_header_idx = idx
                break
            idx += 1
        if gk_header_idx is None:
            raise ValueError(f"Could not find Goalkeepers table for {t_name} in {path.name}")

        goalkeepers, gk_pdf_total, idx = _parse_goalkeepers_table(
            left_lines, gk_header_idx, t_name, opp_name
        )

        # Look for optional Coach line right after GK table
        coach = ""
        if idx < len(left_lines):
            coach_txt = " ".join(w["text"] for w in left_lines[idx]).strip()
            if coach_txt.startswith("Coach:"):
                coach = coach_txt.replace("Coach:", "").strip()
                idx += 1

        # Compute GK total from individual GKs so any Toma-soft PDF TOTAL FB typo
        # does not corrupt area-level analytics, while preserving raw gk_pdf_total.
        gk_sum_total = _sum_gk_totals(goalkeepers)
        # If there are no individual GKs parsed (unlikely), fall back to gk_pdf_total
        gk_verified_total = gk_sum_total if goalkeepers else gk_pdf_total

        sections.append(
            {
                "slot": slot_key,
                "team": t_name,
                "opponent": opp_name,
                "coach": coach,
                "score": t_score,
                "opponent_score": opp_score,
                "players": players,
                "bench": bench,
                "player_total": player_total,
                "goalkeepers": goalkeepers,
                "gk_total": gk_verified_total,
                "gk_pdf_total": gk_pdf_total,
            }
        )

    timeline = _parse_timeline(words)

    return {
        "match_id": match_id,
        "filename": path.name,
        "file_mtime": stat_info.st_mtime,
        "meta": meta,
        "teams": {
            "a": sections[0],
            "b": sections[1],
        },
        "timeline": timeline,
    }
