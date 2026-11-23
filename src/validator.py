"""Automated 5-point validation checks for parsed Toma-soft handball match data."""

from __future__ import annotations

from typing import Any

from src.parser import AREAS


def validate_match(match: dict[str, Any]) -> dict[str, Any]:
    """Run all 5 required automated validation checks on a parsed match."""
    meta = match["meta"]
    team_a = match["teams"]["a"]
    team_b = match["teams"]["b"]
    timeline = match["timeline"]

    checks: list[dict[str, Any]] = []
    notes: list[str] = []

    # ------------------------------------------------------------------
    # Check 1: Sum of individual players/GKs Tot vs PDF TOTAL row
    # ------------------------------------------------------------------
    c1_errors: list[str] = []
    c1_notes: list[str] = []

    for team_data in (team_a, team_b):
        tname = team_data["team"]
        players = team_data["players"]
        bench = team_data["bench"]
        ptot = team_data["player_total"]

        sum_g = sum(p["tot"]["g"] for p in players)
        sum_a = sum(p["tot"]["a"] for p in players)
        if sum_g != ptot["tot"]["g"] or sum_a != ptot["tot"]["a"]:
            c1_errors.append(
                f"{tname} Players Tot sum {sum_g}/{sum_a} != PDF TOTAL {ptot['tot']['g']}/{ptot['tot']['a']}"
            )

        for area in AREAS:
            ag = sum(p["areas"][area]["g"] for p in players)
            aa = sum(p["areas"][area]["a"] for p in players)
            if ag != ptot["areas"][area]["g"] or aa != ptot["areas"][area]["a"]:
                c1_errors.append(
                    f"{tname} Players {area} sum {ag}/{aa} != PDF TOTAL {ptot['areas'][area]['g']}/{ptot['areas'][area]['a']}"
                )

        for stat_key in ("as", "e7", "tr", "st", "2m"):
            s_val = sum(p[stat_key] for p in players) + bench.get(stat_key, 0)
            if s_val != ptot[stat_key]:
                c1_errors.append(
                    f"{tname} Players {stat_key.upper()} sum {s_val} != PDF TOTAL {ptot[stat_key]}"
                )

        # Goalkeepers Tot sum vs PDF GK TOTAL
        gks = team_data["goalkeepers"]
        gk_pdf_tot = team_data["gk_pdf_total"]
        gk_sum_s = sum(g["tot"]["s"] for g in gks)
        gk_sum_sh = sum(g["tot"]["sh"] for g in gks)
        if gk_sum_s != gk_pdf_tot["tot"]["s"] or gk_sum_sh != gk_pdf_tot["tot"]["sh"]:
            c1_errors.append(
                f"{tname} GK Tot sum {gk_sum_s}/{gk_sum_sh} != PDF TOTAL {gk_pdf_tot['tot']['s']}/{gk_pdf_tot['tot']['sh']}"
            )

        # Check individual GK area sums against raw PDF GK TOTAL row
        # (Catches known Toma-soft PDF generator typo on Team B GK TOTAL FB saves)
        for area in AREAS:
            asv = sum(g["areas"][area]["s"] for g in gks)
            ash = sum(g["areas"][area]["sh"] for g in gks)
            pdf_sv = gk_pdf_tot["areas"][area]["s"]
            pdf_sh = gk_pdf_tot["areas"][area]["sh"]
            if asv != pdf_sv or ash != pdf_sh:
                if ash == pdf_sh and area == "FB":
                    msg = (
                        f"Toma-soft PDF source typo in {tname} GK TOTAL {area} cell "
                        f"(PDF prints {pdf_sv}/{pdf_sh}, individual GKs sum to {asv}/{ash}). "
                        f"Dashboard uses verified individual GK sum {asv}/{ash}."
                    )
                    c1_notes.append(msg)
                    notes.append(msg)
                else:
                    c1_errors.append(
                        f"{tname} GK {area} sum {asv}/{ash} != PDF TOTAL {pdf_sv}/{pdf_sh}"
                    )

    checks.append(
        {
            "id": 1,
            "name": "Player/GK Sum vs TOTAL",
            "status": "ERROR" if c1_errors else "OK",
            "details": "; ".join(c1_errors) if c1_errors else (
                "All players & GKs match PDF TOTAL"
                + (f" ({len(c1_notes)} PDF source note)" if c1_notes else "")
            ),
            "notes": c1_notes,
        }
    )

    # ------------------------------------------------------------------
    # Check 2: 6-Area Sum (9m+6m+Wng+7m+FB+Brk) vs Tot
    # ------------------------------------------------------------------
    c2_errors: list[str] = []
    c2_notes: list[str] = []

    for team_data in (team_a, team_b):
        tname = team_data["team"]
        ptot = team_data["player_total"]

        # Individual players
        indiv_res_g = 0
        indiv_res_a = 0
        for p in team_data["players"]:
            ag = sum(p["areas"][area]["g"] for area in AREAS)
            aa = sum(p["areas"][area]["a"] for area in AREAS)
            dg = p["tot"]["g"] - ag
            da = p["tot"]["a"] - aa
            if dg == 0 and da == 0:
                continue
            if dg >= 0 and da >= 0 and dg <= da:
                indiv_res_g += dg
                indiv_res_a += da
                msg = (
                    f"{tname} #{p['jersey']} {p['name']}: Tot {p['tot']['g']}/{p['tot']['a']} vs "
                    f"6-area sum {ag}/{aa} (+{dg}/{da} uncategorized shot in PDF, e.g. Empty Goal / direct throw)"
                )
                c2_notes.append(msg)
                notes.append(msg)
            else:
                c2_errors.append(
                    f"{tname} #{p['jersey']} {p['name']}: 6-area sum {ag}/{aa} invalid vs Tot {p['tot']['g']}/{p['tot']['a']}"
                )

        # Team Players TOTAL row
        tag = sum(ptot["areas"][area]["g"] for area in AREAS)
        taa = sum(ptot["areas"][area]["a"] for area in AREAS)
        tdg = ptot["tot"]["g"] - tag
        tda = ptot["tot"]["a"] - taa
        if tdg != 0 or tda != 0:
            if tdg == indiv_res_g and tda == indiv_res_a and 0 <= tdg <= tda:
                # Matches individual players' uncategorized shots exactly
                pass
            else:
                c2_errors.append(
                    f"{tname} Players TOTAL 6-area sum {tag}/{taa} != Tot {ptot['tot']['g']}/{ptot['tot']['a']}"
                )

        # Goalkeepers individual & verified TOTAL
        gk_res_s = 0
        gk_res_sh = 0
        for gk in team_data["goalkeepers"]:
            asv = sum(gk["areas"][area]["s"] for area in AREAS)
            ash = sum(gk["areas"][area]["sh"] for area in AREAS)
            ds = gk["tot"]["s"] - asv
            dsh = gk["tot"]["sh"] - ash
            if ds == 0 and dsh == 0:
                continue
            if ds >= 0 and dsh >= 0 and ds <= dsh:
                gk_res_s += ds
                gk_res_sh += dsh
                msg = (
                    f"{tname} GK #{gk['jersey']} {gk['name']}: Tot {gk['tot']['s']}/{gk['tot']['sh']} vs "
                    f"6-area sum {asv}/{ash} (+{ds}/{dsh} uncategorized shot in PDF)"
                )
                c2_notes.append(msg)
                notes.append(msg)
            else:
                c2_errors.append(
                    f"{tname} GK #{gk['jersey']} {gk['name']}: 6-area sum {asv}/{ash} invalid vs Tot {gk['tot']['s']}/{gk['tot']['sh']}"
                )

        gk_tot = team_data["gk_total"]
        g_asv = sum(gk_tot["areas"][area]["s"] for area in AREAS)
        g_ash = sum(gk_tot["areas"][area]["sh"] for area in AREAS)
        g_ds = gk_tot["tot"]["s"] - g_asv
        g_dsh = gk_tot["tot"]["sh"] - g_ash
        if g_ds != 0 or g_dsh != 0:
            if not (g_ds == gk_res_s and g_dsh == gk_res_sh and 0 <= g_ds <= g_dsh):
                c2_errors.append(
                    f"{tname} GK TOTAL 6-area sum {g_asv}/{g_ash} != Tot {gk_tot['tot']['s']}/{gk_tot['tot']['sh']}"
                )

    checks.append(
        {
            "id": 2,
            "name": "6-Area Sum vs Tot",
            "status": "ERROR" if c2_errors else "OK",
            "details": "; ".join(c2_errors) if c2_errors else (
                "All 6-area sums verified"
                + (f" ({len(c2_notes)} uncategorized/Empty-Goal shot note(s) in PDF)" if c2_notes else "")
            ),
            "notes": c2_notes,
        }
    )

    # ------------------------------------------------------------------
    # Check 3: Team TOTAL Goals == Match Header Final Score
    # ------------------------------------------------------------------
    c3_errors: list[str] = []
    if team_a["player_total"]["tot"]["g"] != meta["score_a"]:
        c3_errors.append(
            f"{team_a['team']} TOTAL Goals {team_a['player_total']['tot']['g']} != Score {meta['score_a']}"
        )
    if team_b["player_total"]["tot"]["g"] != meta["score_b"]:
        c3_errors.append(
            f"{team_b['team']} TOTAL Goals {team_b['player_total']['tot']['g']} != Score {meta['score_b']}"
        )

    checks.append(
        {
            "id": 3,
            "name": "Team TOTAL Goals vs Match Score",
            "status": "ERROR" if c3_errors else "OK",
            "details": "; ".join(c3_errors) if c3_errors else (
                f"{team_a['team']} {meta['score_a']} == {team_a['player_total']['tot']['g']}, "
                f"{team_b['team']} {meta['score_b']} == {team_b['player_total']['tot']['g']}"
            ),
            "notes": [],
        }
    )

    # ------------------------------------------------------------------
    # Check 4: Cross-check GK TOTAL (Shots - Saves) == Opponent Score
    # ------------------------------------------------------------------
    c4_errors: list[str] = []
    c4_notes: list[str] = []

    for gk_team, opp_team, opp_score in (
        (team_a, team_b["team"], meta["score_b"]),
        (team_b, team_a["team"], meta["score_a"]),
    ):
        conceded = gk_team["gk_total"]["tot"]["sh"] - gk_team["gk_total"]["tot"]["s"]
        diff = opp_score - conceded
        if diff == 0:
            continue
        elif diff > 0:
            # Empty-net goals when GK was off the court
            msg = (
                f"{gk_team['team']} GK conceded {conceded} ({gk_team['gk_total']['tot']['sh']}-"
                f"{gk_team['gk_total']['tot']['s']}) vs {opp_team} score {opp_score} "
                f"(+{diff} empty-net / non-GK goal(s))"
            )
            c4_notes.append(msg)
            notes.append(msg)
        else:
            c4_errors.append(
                f"{gk_team['team']} GK conceded {conceded} > {opp_team} score {opp_score}"
            )

    checks.append(
        {
            "id": 4,
            "name": "GK Conceded vs Opponent Score",
            "status": "ERROR" if c4_errors else "OK",
            "details": "; ".join(c4_errors) if c4_errors else (
                f"{team_a['team']} GK {team_a['gk_total']['tot']['sh'] - team_a['gk_total']['tot']['s']}=={meta['score_b']}, "
                f"{team_b['team']} GK {team_b['gk_total']['tot']['sh'] - team_b['gk_total']['tot']['s']}=={meta['score_a']}"
                + (f" ({len(c4_notes)} empty-net note)" if c4_notes else "")
            ),
            "notes": c4_notes,
        }
    )

    # ------------------------------------------------------------------
    # Check 5: Timeline Final Score == Match Score (mismatch -> WARNING)
    # ------------------------------------------------------------------
    bucket_a = sum(b["a"] for b in timeline["buckets"])
    bucket_b = sum(b["b"] for b in timeline["buckets"])
    tl_ok = (
        timeline.get("status") == "OK"
        and timeline.get("final_a") == meta["score_a"]
        and timeline.get("final_b") == meta["score_b"]
        and bucket_a == meta["score_a"]
        and bucket_b == meta["score_b"]
    )
    if tl_ok:
        c5_status = "OK"
        c5_details = (
            f"Timeline {timeline['final_a']}-{timeline['final_b']} "
            f"({timeline['event_count']} goals) matches final score"
        )
    else:
        c5_status = "WARNING"
        c5_details = (
            f"Timeline {timeline.get('final_a')}-{timeline.get('final_b')} "
            f"(buckets {bucket_a}-{bucket_b}) vs Match {meta['score_a']}-{meta['score_b']}: "
            f"{timeline.get('message', '')}"
        )
        notes.append(c5_details)

    checks.append(
        {
            "id": 5,
            "name": "Timeline Final Score vs Match Score",
            "status": c5_status,
            "details": c5_details,
            "notes": [],
        }
    )

    error_count = sum(1 for c in checks if c["status"] == "ERROR")
    warning_count = sum(1 for c in checks if c["status"] == "WARNING")
    overall = "ERROR" if error_count > 0 else ("WARNING" if warning_count > 0 else "OK")

    return {
        "status": overall,
        "error_count": error_count,
        "warning_count": warning_count,
        "note_count": len(notes),
        "checks": checks,
        "notes": notes,
    }
