/* Handball Official Stats Dashboard — Client Application (Zero External CDN) */
(function () {
  "use strict";

  const AREAS = ["9m", "6m", "Wng", "7m", "FB", "Brk"];
  const AREA_LABELS = {
    "9m": "9m Backcourt",
    "6m": "6m Line",
    "Wng": "Wing",
    "7m": "7m Penalty",
    "FB": "Fastbreak",
    "Brk": "Breakthrough",
  };

  const state = {
    data: null,
    activeTab: "overview",
    selectedTeam: "",
    selectedMatchIds: new Set(),
    timelineMode: "sum",
    overviewMetric: "shotPct",
    localServerAvailable: false,
    sorts: {
      overview: { key: "diff", dir: "desc" },
      players: { key: "totG", dir: "desc" },
      gks: { key: "totS", dir: "desc" },
    },
    charts: {
      overview: null,
      scoringArea: null,
      gkArea: null,
      timeline: null,
      modal: null,
    },
  };

  /* ------------------------------------------------------------------ */
  /* Formatting & Safe Math Helpers                                     */
  /* ------------------------------------------------------------------ */
  function safePct(num, den) {
    if (!den || den <= 0) return null;
    return (num / den) * 100;
  }

  function fmtPct(val) {
    if (val === null || val === undefined || Number.isNaN(val)) return "-";
    return val.toFixed(1) + "%";
  }

  function fmtNum(val, decimals = 0) {
    if (val === null || val === undefined || Number.isNaN(val)) return "-";
    return decimals > 0 ? val.toFixed(decimals) : String(Math.round(val));
  }

  function fmtDiff(val) {
    if (val > 0) return "+" + val;
    return String(val);
  }

  function fmtRatio(a, b) {
    if (a === 0 && b === 0) return "0/0";
    return `${a}/${b}`;
  }

  function fmtDateShort(isoDate) {
    if (!isoDate) return "";
    const parts = isoDate.split("-");
    if (parts.length !== 3) return isoDate;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = parseInt(parts[1], 10) - 1;
    return `${parseInt(parts[2], 10)} ${months[mIdx] || parts[1]}`;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pctClass(val, highThreshold = 65, lowThreshold = 40) {
    if (val === null || val === undefined) return "val-muted";
    if (val >= highThreshold) return "pct-high";
    if (val < lowThreshold) return "pct-low";
    return "pct-mid";
  }

  function valClass(val) {
    if (val > 0) return "val-pos";
    if (val < 0) return "val-neg";
    return "val-muted";
  }

  function formatTimestamp(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return iso;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chart.js Custom Inline Annotation Plugin (Bar Labels + Half Line)  */
  /* ------------------------------------------------------------------ */
  const barAnnotatePlugin = {
    id: "barAnnotate",
    afterDatasetsDraw(chart) {
      const opts = chart.options.plugins && chart.options.plugins.barAnnotate;
      if (!opts) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();

      // Optional Half-Time vertical divider on timeline chart
      if (typeof opts.halfDividerIndex === "number" && scales.x) {
        const xPos = scales.x.getPixelForValue(opts.halfDividerIndex);
        if (xPos >= chartArea.left && xPos <= chartArea.right) {
          ctx.save();
          ctx.strokeStyle = "#94a3b8";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(xPos, chartArea.top);
          ctx.lineTo(xPos, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#64748b";
          ctx.font = "600 10px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("HALF TIME", xPos, chartArea.top + 11);
          ctx.restore();
        }
      }

      if (opts.mode === "value") {
        const meta = chart.getDatasetMeta(0);
        const data = chart.data.datasets[0].data;
        const suffix = opts.suffix || "";
        const decimals = opts.decimals ?? 1;
        const customLabels = opts.customLabels || null;
        ctx.font = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = "#1e293b";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        meta.data.forEach((bar, i) => {
          const v = data[i];
          if (v === null || v === undefined) return;
          const label = customLabels ? customLabels[i] : (decimals > 0 ? Number(v).toFixed(decimals) : Math.round(v)) + suffix;
          if (!label) return;
          const yPos = v >= 0 ? bar.y - 4 : bar.y + 13;
          ctx.fillText(label, bar.x, Math.max(chartArea.top + 11, yPos));
        });
      } else if (opts.mode === "pairPct" && chart.data.datasets.length >= 2) {
        const m0 = chart.getDatasetMeta(0);
        const m1 = chart.getDatasetMeta(1);
        const pctLabels = opts.pctLabels || [];
        ctx.font = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (let i = 0; i < pctLabels.length; i++) {
          const b0 = m0.data[i];
          const b1 = m1.data[i];
          if (!b0 || !b1 || !pctLabels[i]) continue;
          const midX = (b0.x + b1.x) / 2;
          const topY = Math.min(b0.y, b1.y) - 5;
          ctx.fillText(pctLabels[i], midX, Math.max(chartArea.top + 12, topY));
        }
      }
      ctx.restore();
    },
  };

  if (typeof Chart !== "undefined") {
    Chart.register(barAnnotatePlugin);
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.color = "#475569";
  }

  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      state.charts[key] = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Data Aggregation Helpers                                           */
  /* ------------------------------------------------------------------ */
  function getTeamMatchEntries(teamName, onlySelected = false) {
    if (!state.data || !state.data.matches) return [];
    const entries = [];
    for (const match of state.data.matches) {
      if (onlySelected && !state.selectedMatchIds.has(match.match_id)) continue;
      if (match.teams.a.team === teamName) {
        entries.push({ match, side: "a", oppSide: "b", teamData: match.teams.a, oppData: match.teams.b });
      } else if (match.teams.b.team === teamName) {
        entries.push({ match, side: "b", oppSide: "a", teamData: match.teams.b, oppData: match.teams.a });
      }
    }
    return entries;
  }

  function aggregateTeamEntries(entries) {
    const agg = {
      gp: entries.length,
      wins: 0,
      draws: 0,
      losses: 0,
      gf: 0,
      ga: 0,
      totG: 0,
      totA: 0,
      as: 0,
      e7: 0,
      tr: 0,
      st: 0,
      twoMin: 0,
      areas: {},
      gkTotS: 0,
      gkTotSh: 0,
      gkAreas: {},
      timelineBuckets: Array.from({ length: 12 }, (_, i) => ({
        label: `${i * 5}-${(i + 1) * 5}`,
        gf: 0,
        ga: 0,
      })),
      timelineValidMatches: 0,
      half1GF: 0,
      half1GA: 0,
      half2GF: 0,
      half2GA: 0,
    };

    for (const area of AREAS) {
      agg.areas[area] = { g: 0, a: 0 };
      agg.gkAreas[area] = { s: 0, sh: 0 };
    }

    for (const { match, side, oppSide, teamData } of entries) {
      const gf = teamData.score;
      const ga = teamData.opponent_score;
      agg.gf += gf;
      agg.ga += ga;
      if (gf > ga) agg.wins += 1;
      else if (gf < ga) agg.losses += 1;
      else agg.draws += 1;

      const pt = teamData.player_total;
      agg.totG += pt.tot.g;
      agg.totA += pt.tot.a;
      agg.as += pt.as;
      agg.e7 += pt.e7;
      agg.tr += pt.tr;
      agg.st += pt.st;
      agg.twoMin += pt["2m"];

      for (const area of AREAS) {
        agg.areas[area].g += pt.areas[area].g;
        agg.areas[area].a += pt.areas[area].a;
      }

      const gkt = teamData.gk_total;
      agg.gkTotS += gkt.tot.s;
      agg.gkTotSh += gkt.tot.sh;
      for (const area of AREAS) {
        agg.gkAreas[area].s += gkt.areas[area].s;
        agg.gkAreas[area].sh += gkt.areas[area].sh;
      }

      agg.half1GF += side === "a" ? match.meta.half1_a : match.meta.half1_b;
      agg.half1GA += side === "a" ? match.meta.half1_b : match.meta.half1_a;
      agg.half2GF += side === "a" ? match.meta.half2_a : match.meta.half2_b;
      agg.half2GA += side === "a" ? match.meta.half2_b : match.meta.half2_a;

      if (match.timeline && Array.isArray(match.timeline.buckets) && match.timeline.buckets.length === 12) {
        agg.timelineValidMatches += 1;
        match.timeline.buckets.forEach((b, idx) => {
          agg.timelineBuckets[idx].gf += side === "a" ? b.a : b.b;
          agg.timelineBuckets[idx].ga += oppSide === "a" ? b.a : b.b;
        });
      }
    }

    agg.diff = agg.gf - agg.ga;
    agg.shotPct = safePct(agg.totG, agg.totA);
    agg.oePct = safePct(agg.totG, agg.totA + agg.tr);
    agg.savePct = safePct(agg.gkTotS, agg.gkTotSh);
    agg.pct9m = safePct(agg.areas["9m"].g, agg.areas["9m"].a);
    agg.pct6m = safePct(agg.areas["6m"].g, agg.areas["6m"].a);
    agg.pctWng = safePct(agg.areas["Wng"].g, agg.areas["Wng"].a);
    agg.fbG = agg.areas["FB"].g;

    agg.gfPerGame = agg.gp > 0 ? agg.gf / agg.gp : 0;
    agg.gaPerGame = agg.gp > 0 ? agg.ga / agg.gp : 0;
    agg.diffPerGame = agg.gp > 0 ? agg.diff / agg.gp : 0;
    agg.fbPerGame = agg.gp > 0 ? agg.fbG / agg.gp : 0;
    agg.trPerGame = agg.gp > 0 ? agg.tr / agg.gp : 0;
    agg.stPerGame = agg.gp > 0 ? agg.st / agg.gp : 0;
    agg.twoMinPerGame = agg.gp > 0 ? agg.twoMin / agg.gp : 0;

    return agg;
  }

  function aggregatePlayers(entries) {
    const map = new Map();
    for (const { match, teamData } of entries) {
      const resultChar = teamData.score > teamData.opponent_score ? "W" : (teamData.score < teamData.opponent_score ? "L" : "D");
      for (const p of teamData.players) {
        const key = `${p.jersey}::${p.name.toUpperCase()}`;
        if (!map.has(key)) {
          const areas = {};
          for (const area of AREAS) areas[area] = { g: 0, a: 0 };
          map.set(key, {
            key,
            jersey: p.jersey,
            jerseyNum: parseInt(p.jersey, 10) || 0,
            name: p.name,
            team: p.team,
            gp: 0,
            totG: 0,
            totA: 0,
            areas,
            as: 0,
            e7: 0,
            tr: 0,
            st: 0,
            twoMin: 0,
            val: 0,
            logs: [],
          });
        }
        const rec = map.get(key);
        rec.gp += 1;
        rec.totG += p.tot.g;
        rec.totA += p.tot.a;
        for (const area of AREAS) {
          rec.areas[area].g += p.areas[area].g;
          rec.areas[area].a += p.areas[area].a;
        }
        rec.as += p.as;
        rec.e7 += p.e7;
        rec.tr += p.tr;
        rec.st += p.st;
        rec.twoMin += p["2m"];
        rec.val += p.val;
        rec.logs.push({
          matchId: match.match_id,
          date: match.meta.date,
          opponent: p.opponent,
          scoreStr: `${teamData.score}-${teamData.opponent_score} ${resultChar}`,
          tot: p.tot,
          areas: p.areas,
          as: p.as,
          e7: p.e7,
          tr: p.tr,
          st: p.st,
          twoMin: p["2m"],
          val: p.val,
        });
      }
    }

    return Array.from(map.values()).map((r) => ({
      ...r,
      totPct: safePct(r.totG, r.totA),
      oePct: safePct(r.totG, r.totA + r.tr),
      g9m: r.areas["9m"].g, p9m: safePct(r.areas["9m"].g, r.areas["9m"].a),
      g6m: r.areas["6m"].g, p6m: safePct(r.areas["6m"].g, r.areas["6m"].a),
      gWng: r.areas["Wng"].g, pWng: safePct(r.areas["Wng"].g, r.areas["Wng"].a),
      g7m: r.areas["7m"].g, p7m: safePct(r.areas["7m"].g, r.areas["7m"].a),
      gFB: r.areas["FB"].g, pFB: safePct(r.areas["FB"].g, r.areas["FB"].a),
      gBrk: r.areas["Brk"].g, pBrk: safePct(r.areas["Brk"].g, r.areas["Brk"].a),
    }));
  }

  function aggregateGoalkeepers(entries) {
    const map = new Map();
    for (const { match, teamData } of entries) {
      const resultChar = teamData.score > teamData.opponent_score ? "W" : (teamData.score < teamData.opponent_score ? "L" : "D");
      for (const gk of teamData.goalkeepers) {
        const key = `${gk.jersey}::${gk.name.toUpperCase()}`;
        if (!map.has(key)) {
          const areas = {};
          for (const area of AREAS) areas[area] = { s: 0, sh: 0 };
          map.set(key, {
            key,
            jersey: gk.jersey,
            jerseyNum: parseInt(gk.jersey, 10) || 0,
            name: gk.name,
            team: gk.team,
            gp: 0,
            totS: 0,
            totSh: 0,
            areas,
            val: 0,
            logs: [],
          });
        }
        const rec = map.get(key);
        rec.gp += 1;
        rec.totS += gk.tot.s;
        rec.totSh += gk.tot.sh;
        for (const area of AREAS) {
          rec.areas[area].s += gk.areas[area].s;
          rec.areas[area].sh += gk.areas[area].sh;
        }
        rec.val += gk.val;
        rec.logs.push({
          matchId: match.match_id,
          date: match.meta.date,
          opponent: gk.opponent,
          scoreStr: `${teamData.score}-${teamData.opponent_score} ${resultChar}`,
          tot: gk.tot,
          areas: gk.areas,
          val: gk.val,
        });
      }
    }

    return Array.from(map.values()).map((r) => ({
      ...r,
      totPct: safePct(r.totS, r.totSh),
      s9m: r.areas["9m"].s, p9m: safePct(r.areas["9m"].s, r.areas["9m"].sh),
      s6m: r.areas["6m"].s, p6m: safePct(r.areas["6m"].s, r.areas["6m"].sh),
      sWng: r.areas["Wng"].s, pWng: safePct(r.areas["Wng"].s, r.areas["Wng"].sh),
      s7m: r.areas["7m"].s, p7m: safePct(r.areas["7m"].s, r.areas["7m"].sh),
      sFB: r.areas["FB"].s, pFB: safePct(r.areas["FB"].s, r.areas["FB"].sh),
      sBrk: r.areas["Brk"].s, pBrk: safePct(r.areas["Brk"].s, r.areas["Brk"].sh),
    }));
  }

  function sortRows(rows, sortState, secondaryKey = "name") {
    const { key, dir } = sortState;
    const mult = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let va = key === "jersey" ? a.jerseyNum : a[key];
      let vb = key === "jersey" ? b.jerseyNum : b[key];

      if (typeof va === "string" || typeof vb === "string") {
        return String(va || "").localeCompare(String(vb || "")) * mult;
      }
      // Treat null percentages as always below valid numbers
      const aNull = va === null || va === undefined;
      const bNull = vb === null || vb === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (va !== vb) return (va - vb) * mult;
      return String(a[secondaryKey] || "").localeCompare(String(b[secondaryKey] || ""));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Header & Global Filter Rendering                                   */
  /* ------------------------------------------------------------------ */
  function renderHeader() {
    const d = state.data;
    document.getElementById("tournamentTitle").textContent = d.tournament_name || "Handball Tournament Analytics";
    document.title = `${d.tournament_name || "Handball Stats"} — Analytics`;

    const s = d.summary;
    document.getElementById("matchCountBadge").textContent =
      `${s.parsed_matches} ${s.parsed_matches === 1 ? "Match" : "Matches"} • ${s.teams.length} Teams`;
    document.getElementById("lastUpdatedLabel").textContent = `Updated ${formatTimestamp(d.generated_at)}`;

    const dot = document.getElementById("statusTabBadge");
    dot.className = "tab-status-dot";
    if (s.error_matches > 0) dot.classList.add("err");
    else if (s.warning_matches > 0) dot.classList.add("warn");
  }

  function renderTeamSelector() {
    const select = document.getElementById("teamSelect");
    const teams = state.data.summary.teams || [];
    select.innerHTML = teams
      .map((t) => `<option value="${escapeHtml(t)}"${t === state.selectedTeam ? " selected" : ""}>${escapeHtml(t)}</option>`)
      .join("");
  }

  function renderMatchChips() {
    const container = document.getElementById("matchChipsContainer");
    const entries = getTeamMatchEntries(state.selectedTeam, false);
    const selectedCount = entries.filter((e) => state.selectedMatchIds.has(e.match.match_id)).length;

    document.getElementById("selectedMatchCount").textContent =
      selectedCount === entries.length && entries.length > 0
        ? `All (${selectedCount})`
        : `${selectedCount} / ${entries.length}`;

    if (entries.length === 0) {
      container.innerHTML = `<span class="val-muted">No matches available for this team.</span>`;
      return;
    }

    container.innerHTML = entries
      .map(({ match, teamData }) => {
        const checked = state.selectedMatchIds.has(match.match_id);
        const res = teamData.score > teamData.opponent_score ? "W" : (teamData.score < teamData.opponent_score ? "L" : "D");
        return `
          <label class="match-chip${checked ? " selected" : ""}" data-match-id="${escapeHtml(match.match_id)}">
            <input type="checkbox" value="${escapeHtml(match.match_id)}"${checked ? " checked" : ""}>
            <span>${escapeHtml(fmtDateShort(match.meta.date))} vs ${escapeHtml(teamData.opponent)}</span>
            <strong>${teamData.score}-${teamData.opponent_score}</strong>
            <span class="res-tag res-${res}">${res}</span>
          </label>
        `;
      })
      .join("");
  }

  function updateSortIndicators(tableId, sortState) {
    const ths = document.querySelectorAll(`#${tableId} thead th[data-sort]`);
    ths.forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === sortState.key) {
        th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* TAB 1: Tournament Overview                                         */
  /* ------------------------------------------------------------------ */
  function renderOverview() {
    const teams = state.data.summary.teams || [];
    const teamRows = teams.map((team) => {
      const agg = aggregateTeamEntries(getTeamMatchEntries(team, false));
      return { team, ...agg };
    });

    const sorted = sortRows(teamRows, state.sorts.overview, "team");
    updateSortIndicators("overviewTable", state.sorts.overview);

    const tbody = document.getElementById("overviewTableBody");
    tbody.innerHTML = sorted
      .map((r) => {
        const activeClass = r.team === state.selectedTeam ? " active-team-row" : "";
        return `
          <tr class="clickable-row${activeClass}" data-team="${escapeHtml(r.team)}">
            <td class="sticky-col"><strong>${escapeHtml(r.team)}</strong></td>
            <td class="num">${r.gp}</td>
            <td class="num">${r.gf}</td>
            <td class="num">${r.ga}</td>
            <td class="num ${valClass(r.diff)}">${fmtDiff(r.diff)}</td>
            <td class="num ${pctClass(r.shotPct, 65, 45)}">${fmtPct(r.shotPct)}</td>
            <td class="num ${pctClass(r.oePct, 55, 38)}">${fmtPct(r.oePct)}</td>
            <td class="num ${pctClass(r.savePct, 35, 20)}">${fmtPct(r.savePct)}</td>
            <td class="num">${fmtPct(r.pct9m)}</td>
            <td class="num">${fmtPct(r.pct6m)}</td>
            <td class="num">${fmtPct(r.pctWng)}</td>
            <td class="num">${r.fbG}</td>
            <td class="num">${r.tr}</td>
            <td class="num">${r.st}</td>
            <td class="num">${r.twoMin}</td>
          </tr>
        `;
      })
      .join("");

    renderOverviewChart(teamRows);
  }

  function renderOverviewChart(teamRows) {
    destroyChart("overview");
    const metricKey = state.overviewMetric;
    const metricMeta = {
      shotPct: { label: "Shot %", suffix: "%", decimals: 1, asc: false },
      oePct: { label: "Offensive Efficiency (OE %)", suffix: "%", decimals: 1, asc: false },
      savePct: { label: "GK Save %", suffix: "%", decimals: 1, asc: false },
      gfPerGame: { label: "Goals For / Match", suffix: "", decimals: 1, asc: false },
      gaPerGame: { label: "Goals Against / Match", suffix: "", decimals: 1, asc: true },
      diffPerGame: { label: "Goal Diff / Match", suffix: "", decimals: 1, asc: false },
      pct9m: { label: "9m Shot %", suffix: "%", decimals: 1, asc: false },
      pct6m: { label: "6m Shot %", suffix: "%", decimals: 1, asc: false },
      pctWng: { label: "Wing Shot %", suffix: "%", decimals: 1, asc: false },
      fbPerGame: { label: "Fastbreak Goals / Match", suffix: "", decimals: 1, asc: false },
      trPerGame: { label: "Turnovers / Match", suffix: "", decimals: 1, asc: true },
      stPerGame: { label: "Steals / Match", suffix: "", decimals: 1, asc: false },
      twoMinPerGame: { label: "2-Min Susp. / Match", suffix: "", decimals: 1, asc: true },
    }[metricKey];

    const sorted = [...teamRows].sort((a, b) => {
      const va = a[metricKey] ?? -999;
      const vb = b[metricKey] ?? -999;
      return metricMeta.asc ? va - vb : vb - va;
    });

    const labels = sorted.map((r) => r.team);
    const values = sorted.map((r) => (r[metricKey] === null ? 0 : Number(r[metricKey].toFixed(1))));
    const colors = sorted.map((r) =>
      r.team === state.selectedTeam ? "rgba(220, 38, 38, 0.88)" : "rgba(37, 99, 235, 0.78)"
    );
    const borders = sorted.map((r) =>
      r.team === state.selectedTeam ? "#b91c1c" : "#1d4ed8"
    );

    const ctx = document.getElementById("overviewBarChart").getContext("2d");
    const maxVal = Math.max(10, ...values.map((v) => Math.abs(v)));
    const minVal = Math.min(0, ...values);

    state.charts.overview = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: metricMeta.label,
            data: values,
            backgroundColor: colors,
            borderColor: borders,
            borderWidth: 1,
            borderRadius: 5,
            maxBarThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => `${metricMeta.label}: ${Number(c.raw).toFixed(metricMeta.decimals)}${metricMeta.suffix}`,
            },
          },
          barAnnotate: {
            mode: "value",
            suffix: metricMeta.suffix,
            decimals: metricMeta.decimals,
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            suggestedMin: minVal < 0 ? Math.floor(minVal * 1.15) : 0,
            suggestedMax: metricMeta.suffix === "%" ? Math.min(100, Math.ceil(maxVal * 1.15)) : Math.ceil(maxVal * 1.15),
            grid: { color: "#e2e8f0" },
          },
        },
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* TAB 2: Team Analysis                                               */
  /* ------------------------------------------------------------------ */
  function renderTeamAnalysis() {
    const entries = getTeamMatchEntries(state.selectedTeam, true);
    const emptyEl = document.getElementById("teamEmptyState");
    const contentEl = document.getElementById("teamAnalysisContent");

    if (entries.length === 0) {
      emptyEl.hidden = false;
      contentEl.hidden = true;
      destroyChart("scoringArea");
      destroyChart("gkArea");
      destroyChart("timeline");
      return;
    }

    emptyEl.hidden = true;
    contentEl.hidden = false;

    const agg = aggregateTeamEntries(entries);
    document.getElementById("teamAnalysisHeading").textContent = `${state.selectedTeam} — Team Analysis`;
    document.getElementById("teamRecordBadge").textContent =
      `${agg.gp} ${agg.gp === 1 ? "Match" : "Matches"} • ${agg.wins}W-${agg.draws}D-${agg.losses}L • Diff ${fmtDiff(agg.diff)}`;
    document.getElementById("teamMatchesSubtitle").textContent = entries
      .map(({ match, teamData }) => `${fmtDateShort(match.meta.date)} vs ${teamData.opponent} (${teamData.score}-${teamData.opponent_score})`)
      .join("  |  ");

    // 8 KPI Cards
    const kpis = [
      { label: "Goals For", value: String(agg.gf), sub: `${agg.gfPerGame.toFixed(1)} per match`, cls: "" },
      { label: "Goals Against", value: String(agg.ga), sub: `${agg.gaPerGame.toFixed(1)} per match`, cls: "kpi-slate" },
      { label: "Shot %", value: fmtPct(agg.shotPct), sub: `${agg.totG} / ${agg.totA} attempts`, cls: "kpi-emerald" },
      { label: "OE %", value: fmtPct(agg.oePct), sub: `${agg.totG} / (${agg.totA} Att + ${agg.tr} Tr)`, cls: "kpi-emerald" },
      { label: "GK Save %", value: fmtPct(agg.savePct), sub: `${agg.gkTotS} / ${agg.gkTotSh} shots`, cls: "" },
      { label: "Turnovers", value: String(agg.tr), sub: `${agg.trPerGame.toFixed(1)} per match`, cls: "kpi-amber" },
      { label: "Steals", value: String(agg.st), sub: `${agg.stPerGame.toFixed(1)} per match`, cls: "kpi-emerald" },
      { label: "2-Min Susp.", value: String(agg.twoMin), sub: `${agg.twoMinPerGame.toFixed(1)} per match`, cls: "kpi-crimson" },
    ];

    document.getElementById("teamKpiGrid").innerHTML = kpis
      .map(
        (k) => `
          <div class="kpi-card ${k.cls}">
            <div class="kpi-label">${escapeHtml(k.label)}</div>
            <div class="kpi-value">${escapeHtml(k.value)}</div>
            <div class="kpi-sub">${escapeHtml(k.sub)}</div>
          </div>
        `
      )
      .join("");

    renderScoringByArea(agg);
    renderGkByArea(agg);
    renderTimeline(agg);
  }

  function renderScoringByArea(agg) {
    destroyChart("scoringArea");

    const goals = AREAS.map((a) => agg.areas[a].g);
    const attempts = AREAS.map((a) => agg.areas[a].a);
    const pctLabels = AREAS.map((a) => fmtPct(safePct(agg.areas[a].g, agg.areas[a].a)));

    const areaSumG = goals.reduce((s, v) => s + v, 0);
    const areaSumA = attempts.reduce((s, v) => s + v, 0);
    const uncatG = agg.totG - areaSumG;
    const uncatA = agg.totA - areaSumA;

    const ctx = document.getElementById("teamScoringAreaChart").getContext("2d");
    state.charts.scoringArea = new Chart(ctx, {
      type: "bar",
      data: {
        labels: AREAS,
        datasets: [
          {
            label: "Goals",
            data: goals,
            backgroundColor: "rgba(37, 99, 235, 0.88)",
            borderColor: "#1d4ed8",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "Attempts",
            data: attempts,
            backgroundColor: "rgba(148, 163, 184, 0.45)",
            borderColor: "#64748b",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, padding: 12 } },
          barAnnotate: { mode: "pairPct", pctLabels },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            suggestedMax: Math.ceil(Math.max(5, ...attempts) * 1.18),
            grid: { color: "#e2e8f0" },
          },
        },
      },
    });

    const tbody = document.getElementById("teamScoringAreaBody");
    const rowsHtml = AREAS.map((area) => {
      const { g, a } = agg.areas[area];
      const sp = safePct(g, a);
      const share = safePct(a, agg.totA);
      return `
        <tr>
          <td class="sticky-col"><strong>${area}</strong> <span class="val-muted">(${AREA_LABELS[area]})</span></td>
          <td class="num">${g}</td>
          <td class="num">${a}</td>
          <td class="num ${pctClass(sp, 65, 45)}">${fmtPct(sp)}</td>
          <td class="num">${fmtPct(share)}</td>
        </tr>
      `;
    }).join("");

    const totalRowHtml = `
      <tr style="background:#f1f5f9;font-weight:700;">
        <td class="sticky-col" style="background:#f1f5f9;">TOTAL</td>
        <td class="num">${agg.totG}</td>
        <td class="num">${agg.totA}</td>
        <td class="num">${fmtPct(agg.shotPct)}</td>
        <td class="num">${agg.totA > 0 ? "100.0%" : "-"}</td>
      </tr>
    `;
    tbody.innerHTML = rowsHtml + totalRowHtml;

    const noteEl = document.getElementById("teamScoringAreaNote");
    if (uncatA > 0) {
      noteEl.hidden = false;
      noteEl.textContent = `Note: TOTAL includes +${uncatG}/${uncatA} uncategorized shot(s) (e.g. Empty Goal / direct throw not listed in the 6 Toma-soft zone columns).`;
    } else {
      noteEl.hidden = true;
    }
  }

  function renderGkByArea(agg) {
    destroyChart("gkArea");

    const saves = AREAS.map((a) => agg.gkAreas[a].s);
    const shots = AREAS.map((a) => agg.gkAreas[a].sh);
    const pctLabels = AREAS.map((a) => fmtPct(safePct(agg.gkAreas[a].s, agg.gkAreas[a].sh)));

    const areaSumS = saves.reduce((s, v) => s + v, 0);
    const areaSumSh = shots.reduce((s, v) => s + v, 0);
    const uncatS = agg.gkTotS - areaSumS;
    const uncatSh = agg.gkTotSh - areaSumSh;

    const ctx = document.getElementById("teamGkAreaChart").getContext("2d");
    state.charts.gkArea = new Chart(ctx, {
      type: "bar",
      data: {
        labels: AREAS,
        datasets: [
          {
            label: "Saves",
            data: saves,
            backgroundColor: "rgba(5, 150, 105, 0.85)",
            borderColor: "#047857",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "Shots Faced",
            data: shots,
            backgroundColor: "rgba(148, 163, 184, 0.45)",
            borderColor: "#64748b",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, padding: 12 } },
          barAnnotate: { mode: "pairPct", pctLabels },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            suggestedMax: Math.ceil(Math.max(5, ...shots) * 1.18),
            grid: { color: "#e2e8f0" },
          },
        },
      },
    });

    const tbody = document.getElementById("teamGkAreaBody");
    const rowsHtml = AREAS.map((area) => {
      const { s, sh } = agg.gkAreas[area];
      const sp = safePct(s, sh);
      const share = safePct(sh, agg.gkTotSh);
      return `
        <tr>
          <td class="sticky-col"><strong>${area}</strong> <span class="val-muted">(${AREA_LABELS[area]})</span></td>
          <td class="num">${s}</td>
          <td class="num">${sh}</td>
          <td class="num ${pctClass(sp, 35, 20)}">${fmtPct(sp)}</td>
          <td class="num">${fmtPct(share)}</td>
        </tr>
      `;
    }).join("");

    const totalRowHtml = `
      <tr style="background:#f1f5f9;font-weight:700;">
        <td class="sticky-col" style="background:#f1f5f9;">TOTAL</td>
        <td class="num">${agg.gkTotS}</td>
        <td class="num">${agg.gkTotSh}</td>
        <td class="num">${fmtPct(agg.savePct)}</td>
        <td class="num">${agg.gkTotSh > 0 ? "100.0%" : "-"}</td>
      </tr>
    `;
    tbody.innerHTML = rowsHtml + totalRowHtml;

    const noteEl = document.getElementById("teamGkAreaNote");
    if (uncatSh > 0) {
      noteEl.hidden = false;
      noteEl.textContent = `Note: TOTAL includes +${uncatS}/${uncatSh} uncategorized shot(s) faced in the PDF.`;
    } else {
      noteEl.hidden = true;
    }
  }

  function renderTimeline(agg) {
    destroyChart("timeline");
    const isAvg = state.timelineMode === "avg";
    const divisor = isAvg && agg.timelineValidMatches > 0 ? agg.timelineValidMatches : 1;

    const labels = agg.timelineBuckets.map((b) => b.label);
    const gfData = agg.timelineBuckets.map((b) => Number((b.gf / divisor).toFixed(isAvg ? 2 : 0)));
    const gaData = agg.timelineBuckets.map((b) => Number((b.ga / divisor).toFixed(isAvg ? 2 : 0)));

    const h1GF = (agg.half1GF / divisor).toFixed(isAvg ? 1 : 0);
    const h1GA = (agg.half1GA / divisor).toFixed(isAvg ? 1 : 0);
    const h2GF = (agg.half2GF / divisor).toFixed(isAvg ? 1 : 0);
    const h2GA = (agg.half2GA / divisor).toFixed(isAvg ? 1 : 0);
    const h1Diff = Number((agg.half1GF - agg.half1GA) / divisor);
    const h2Diff = Number((agg.half2GF - agg.half2GA) / divisor);

    document.getElementById("timelineHalfSummary").innerHTML = `
      <div class="half-pill"><strong>1st Half (0-30'):</strong> ${h1GF} - ${h1GA} (<span class="${valClass(h1Diff)}">${h1Diff > 0 ? "+" : ""}${isAvg ? h1Diff.toFixed(1) : h1Diff}</span>)</div>
      <div class="half-pill"><strong>2nd Half (30-60'):</strong> ${h2GF} - ${h2GA} (<span class="${valClass(h2Diff)}">${h2Diff > 0 ? "+" : ""}${isAvg ? h2Diff.toFixed(1) : h2Diff}</span>)</div>
      <div class="half-pill"><strong>Mode:</strong> ${isAvg ? `Avg across ${agg.timelineValidMatches} match(es)` : `Total across ${agg.timelineValidMatches} match(es)`}</div>
    `;

    const ctx = document.getElementById("teamTimelineChart").getContext("2d");
    const maxVal = Math.max(3, ...gfData, ...gaData);

    state.charts.timeline = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: `${state.selectedTeam} Goals For`,
            data: gfData,
            backgroundColor: "rgba(37, 99, 235, 0.86)",
            borderColor: "#1d4ed8",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "Opponent Goals Against",
            data: gaData,
            backgroundColor: "rgba(220, 38, 38, 0.78)",
            borderColor: "#b91c1c",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } },
          barAnnotate: { halfDividerIndex: 5.5 },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            suggestedMax: Math.ceil(maxVal * 1.18),
            ticks: { precision: isAvg ? 1 : 0 },
            grid: { color: "#e2e8f0" },
          },
        },
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* TAB 3: Individual Stats                                            */
  /* ------------------------------------------------------------------ */
  function renderIndividualStats() {
    const entries = getTeamMatchEntries(state.selectedTeam, true);
    const emptyEl = document.getElementById("indivEmptyState");
    const contentEl = document.getElementById("indivContent");

    if (entries.length === 0) {
      emptyEl.hidden = false;
      contentEl.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    contentEl.hidden = false;

    const teamAgg = aggregateTeamEntries(entries);
    const players = aggregatePlayers(entries);
    const gks = aggregateGoalkeepers(entries);

    document.getElementById("playersTableTitle").textContent = `${state.selectedTeam} — Field Players (${players.length})`;
    document.getElementById("gksTableTitle").textContent = `${state.selectedTeam} — Goalkeepers (${gks.length})`;

    // Render Field Players
    const sortedPlayers = sortRows(players, state.sorts.players, "jerseyNum");
    updateSortIndicators("playersTable", state.sorts.players);

    const pBody = document.getElementById("playersTableBody");
    pBody.innerHTML = sortedPlayers
      .map((p) => {
        const areaCells = AREAS.map((a) => {
          const pct = safePct(p.areas[a].g, p.areas[a].a);
          return `
            <td class="num${p.areas[a].a === 0 ? " val-muted" : ""}">${p.areas[a].a > 0 ? fmtRatio(p.areas[a].g, p.areas[a].a) : "-"}</td>
            <td class="num${p.areas[a].a === 0 ? " val-muted" : ""}">${fmtPct(pct)}</td>
          `;
        }).join("");

        return `
          <tr class="clickable-row" data-player-key="${escapeHtml(p.key)}">
            <td class="sticky-col col-num"><strong>${escapeHtml(p.jersey)}</strong></td>
            <td class="sticky-col-2 col-player" title="${escapeHtml(p.name)}"><strong>${escapeHtml(p.name)}</strong></td>
            <td class="num">${p.gp}</td>
            <td class="num"><strong>${fmtRatio(p.totG, p.totA)}</strong></td>
            <td class="num ${pctClass(p.totPct, 65, 45)}">${fmtPct(p.totPct)}</td>
            <td class="num ${pctClass(p.oePct, 55, 38)}">${fmtPct(p.oePct)}</td>
            ${areaCells}
            <td class="num">${p.as}</td>
            <td class="num">${p.e7}</td>
            <td class="num">${p.tr}</td>
            <td class="num">${p.st}</td>
            <td class="num">${p.twoMin}</td>
            <td class="num ${valClass(p.val)}">${p.val.toFixed(2)}</td>
          </tr>
        `;
      })
      .join("");

    const pFootAreaCells = AREAS.map((a) => {
      const ar = teamAgg.areas[a];
      return `<td class="num">${fmtRatio(ar.g, ar.a)}</td><td class="num">${fmtPct(safePct(ar.g, ar.a))}</td>`;
    }).join("");

    document.getElementById("playersTableFoot").innerHTML = `
      <tr>
        <td class="sticky-col col-num"></td>
        <td class="sticky-col-2 col-player">TOTAL</td>
        <td class="num">${teamAgg.gp}</td>
        <td class="num">${fmtRatio(teamAgg.totG, teamAgg.totA)}</td>
        <td class="num">${fmtPct(teamAgg.shotPct)}</td>
        <td class="num">${fmtPct(teamAgg.oePct)}</td>
        ${pFootAreaCells}
        <td class="num">${teamAgg.as}</td>
        <td class="num">${teamAgg.e7}</td>
        <td class="num">${teamAgg.tr}</td>
        <td class="num">${teamAgg.st}</td>
        <td class="num">${teamAgg.twoMin}</td>
        <td class="num">-</td>
      </tr>
    `;

    // Render Goalkeepers
    const sortedGks = sortRows(gks, state.sorts.gks, "jerseyNum");
    updateSortIndicators("gksTable", state.sorts.gks);

    const gBody = document.getElementById("gksTableBody");
    gBody.innerHTML = sortedGks
      .map((gk) => {
        const areaCells = AREAS.map((a) => {
          const pct = safePct(gk.areas[a].s, gk.areas[a].sh);
          return `
            <td class="num${gk.areas[a].sh === 0 ? " val-muted" : ""}">${gk.areas[a].sh > 0 ? fmtRatio(gk.areas[a].s, gk.areas[a].sh) : "-"}</td>
            <td class="num${gk.areas[a].sh === 0 ? " val-muted" : ""}">${fmtPct(pct)}</td>
          `;
        }).join("");

        return `
          <tr class="clickable-row" data-gk-key="${escapeHtml(gk.key)}">
            <td class="sticky-col col-num"><strong>${escapeHtml(gk.jersey)}</strong></td>
            <td class="sticky-col-2 col-player" title="${escapeHtml(gk.name)}"><strong>${escapeHtml(gk.name)}</strong></td>
            <td class="num">${gk.gp}</td>
            <td class="num"><strong>${fmtRatio(gk.totS, gk.totSh)}</strong></td>
            <td class="num ${pctClass(gk.totPct, 35, 20)}">${fmtPct(gk.totPct)}</td>
            ${areaCells}
            <td class="num ${valClass(gk.val)}">${gk.val.toFixed(2)}</td>
          </tr>
        `;
      })
      .join("");

    const gFootAreaCells = AREAS.map((a) => {
      const ar = teamAgg.gkAreas[a];
      return `<td class="num">${fmtRatio(ar.s, ar.sh)}</td><td class="num">${fmtPct(safePct(ar.s, ar.sh))}</td>`;
    }).join("");

    document.getElementById("gksTableFoot").innerHTML = `
      <tr>
        <td class="sticky-col col-num"></td>
        <td class="sticky-col-2 col-player">TOTAL</td>
        <td class="num">${teamAgg.gp}</td>
        <td class="num">${fmtRatio(teamAgg.gkTotS, teamAgg.gkTotSh)}</td>
        <td class="num">${fmtPct(teamAgg.savePct)}</td>
        ${gFootAreaCells}
        <td class="num">-</td>
      </tr>
    `;

    // Store latest maps for modal click lookup
    state._playersByKey = new Map(players.map((p) => [p.key, p]));
    state._gksByKey = new Map(gks.map((g) => [g.key, g]));
  }

  /* ------------------------------------------------------------------ */
  /* Player & Goalkeeper Detail Modals                                  */
  /* ------------------------------------------------------------------ */
  function openPlayerModal(player) {
    const modal = document.getElementById("detailModal");
    document.getElementById("modalTitle").textContent = `#${player.jersey} ${player.name}`;
    document.getElementById("modalSubtitle").textContent = `${player.team} • Field Player • ${player.gp} Match(es) Selected`;
    document.getElementById("modalChartTitle").textContent = "Scoring by Area (Goals vs Attempts & Shot %)";

    document.getElementById("modalKpiStrip").innerHTML = [
      { l: "Total G/A", v: fmtRatio(player.totG, player.totA) },
      { l: "Shot %", v: fmtPct(player.totPct) },
      { l: "OE %", v: fmtPct(player.oePct) },
      { l: "As / E7", v: `${player.as} / ${player.e7}` },
      { l: "Tr / St / 2m", v: `${player.tr} / ${player.st} / ${player.twoMin}` },
      { l: "Val", v: player.val.toFixed(2) },
    ]
      .map((x) => `<div class="modal-kpi"><div class="mk-label">${x.l}</div><div class="mk-val">${x.v}</div></div>`)
      .join("");

    destroyChart("modal");
    const goals = AREAS.map((a) => player.areas[a].g);
    const attempts = AREAS.map((a) => player.areas[a].a);
    const pctLabels = AREAS.map((a) => (player.areas[a].a > 0 ? fmtPct(safePct(player.areas[a].g, player.areas[a].a)) : ""));

    const ctx = document.getElementById("modalBarChart").getContext("2d");
    state.charts.modal = new Chart(ctx, {
      type: "bar",
      data: {
        labels: AREAS,
        datasets: [
          { label: "Goals", data: goals, backgroundColor: "rgba(37, 99, 235, 0.88)", borderRadius: 4 },
          { label: "Attempts", data: attempts, backgroundColor: "rgba(148, 163, 184, 0.45)", borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12 } },
          barAnnotate: { mode: "pairPct", pctLabels },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 }, suggestedMax: Math.max(3, ...attempts) + 1 },
        },
      },
    });

    document.getElementById("modalLogHead").innerHTML = `
      <tr>
        <th class="sticky-col">Date</th>
        <th>Opponent</th>
        <th>Result</th>
        <th class="num">Tot G/A</th>
        <th class="num">%</th>
        ${AREAS.map((a) => `<th class="num">${a}</th>`).join("")}
        <th class="num">As</th>
        <th class="num">E7</th>
        <th class="num">Tr</th>
        <th class="num">St</th>
        <th class="num">2m</th>
        <th class="num">Val</th>
      </tr>
    `;

    document.getElementById("modalLogBody").innerHTML = player.logs
      .map(
        (lg) => `
          <tr>
            <td class="sticky-col">${escapeHtml(fmtDateShort(lg.date))}</td>
            <td>${escapeHtml(lg.opponent)}</td>
            <td>${escapeHtml(lg.scoreStr)}</td>
            <td class="num"><strong>${fmtRatio(lg.tot.g, lg.tot.a)}</strong></td>
            <td class="num">${fmtPct(safePct(lg.tot.g, lg.tot.a))}</td>
            ${AREAS.map((a) => `<td class="num${lg.areas[a].a === 0 ? " val-muted" : ""}">${lg.areas[a].a > 0 ? fmtRatio(lg.areas[a].g, lg.areas[a].a) : "-"}</td>`).join("")}
            <td class="num">${lg.as}</td>
            <td class="num">${lg.e7}</td>
            <td class="num">${lg.tr}</td>
            <td class="num">${lg.st}</td>
            <td class="num">${lg.twoMin}</td>
            <td class="num ${valClass(lg.val)}">${lg.val.toFixed(2)}</td>
          </tr>
        `
      )
      .join("");

    modal.hidden = false;
  }

  function openGkModal(gk) {
    const modal = document.getElementById("detailModal");
    document.getElementById("modalTitle").textContent = `#${gk.jersey} ${gk.name}`;
    document.getElementById("modalSubtitle").textContent = `${gk.team} • Goalkeeper • ${gk.gp} Match(es) Selected`;
    document.getElementById("modalChartTitle").textContent = "Save Rate (%) by Area (with Saves / Shots)";

    document.getElementById("modalKpiStrip").innerHTML = [
      { l: "Total S/Sh", v: fmtRatio(gk.totS, gk.totSh) },
      { l: "Save %", v: fmtPct(gk.totPct) },
      { l: "Goals Conceded", v: String(gk.totSh - gk.totS) },
      { l: "Val", v: gk.val.toFixed(2) },
    ]
      .map((x) => `<div class="modal-kpi"><div class="mk-label">${x.l}</div><div class="mk-val">${x.v}</div></div>`)
      .join("");

    destroyChart("modal");
    const pctValues = AREAS.map((a) => {
      const p = safePct(gk.areas[a].s, gk.areas[a].sh);
      return p === null ? 0 : Number(p.toFixed(1));
    });
    const customLabels = AREAS.map((a) => {
      const { s, sh } = gk.areas[a];
      if (sh === 0) return "-";
      return `${safePct(s, sh).toFixed(0)}% (${s}/${sh})`;
    });

    const ctx = document.getElementById("modalBarChart").getContext("2d");
    state.charts.modal = new Chart(ctx, {
      type: "bar",
      data: {
        labels: AREAS,
        datasets: [
          {
            label: "Save %",
            data: pctValues,
            backgroundColor: AREAS.map((a) => (gk.areas[a].sh > 0 ? "rgba(5, 150, 105, 0.85)" : "rgba(203, 213, 225, 0.5)")),
            borderColor: "#047857",
            borderWidth: 1,
            borderRadius: 5,
            maxBarThickness: 56,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                const area = AREAS[c.dataIndex];
                const { s, sh } = gk.areas[area];
                return sh > 0 ? `Save %: ${safePct(s, sh).toFixed(1)}% (${s}/${sh})` : "No shots faced";
              },
            },
          },
          barAnnotate: { mode: "value", customLabels },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, max: 110, ticks: { stepSize: 20, callback: (v) => (v <= 100 ? v + "%" : "") } },
        },
      },
    });

    document.getElementById("modalLogHead").innerHTML = `
      <tr>
        <th class="sticky-col">Date</th>
        <th>Opponent</th>
        <th>Result</th>
        <th class="num">Tot S/Sh</th>
        <th class="num">%</th>
        ${AREAS.map((a) => `<th class="num">${a}</th>`).join("")}
        <th class="num">Val</th>
      </tr>
    `;

    document.getElementById("modalLogBody").innerHTML = gk.logs
      .map(
        (lg) => `
          <tr>
            <td class="sticky-col">${escapeHtml(fmtDateShort(lg.date))}</td>
            <td>${escapeHtml(lg.opponent)}</td>
            <td>${escapeHtml(lg.scoreStr)}</td>
            <td class="num"><strong>${fmtRatio(lg.tot.s, lg.tot.sh)}</strong></td>
            <td class="num">${fmtPct(safePct(lg.tot.s, lg.tot.sh))}</td>
            ${AREAS.map((a) => `<td class="num${lg.areas[a].sh === 0 ? " val-muted" : ""}">${lg.areas[a].sh > 0 ? fmtRatio(lg.areas[a].s, lg.areas[a].sh) : "-"}</td>`).join("")}
            <td class="num ${valClass(lg.val)}">${lg.val.toFixed(2)}</td>
          </tr>
        `
      )
      .join("");

    modal.hidden = false;
  }

  function closeModal() {
    document.getElementById("detailModal").hidden = true;
    destroyChart("modal");
  }

  /* ------------------------------------------------------------------ */
  /* TAB 4: Data Status                                                 */
  /* ------------------------------------------------------------------ */
  function renderDataStatus() {
    const d = state.data;
    const s = d.summary;

    document.getElementById("statusSummaryGrid").innerHTML = [
      { l: "Imported Matches", v: String(s.parsed_matches), sub: `${s.total_pdfs} PDF file(s) found`, cls: "" },
      { l: "Validation OK", v: String(s.ok_matches), sub: "All 5 checks passed", cls: "kpi-emerald" },
      { l: "Warnings", v: String(s.warning_matches), sub: "Non-blocking warnings", cls: "kpi-amber" },
      { l: "Errors", v: String(s.error_matches), sub: "Parse or check failures", cls: s.error_matches > 0 ? "kpi-crimson" : "kpi-slate" },
    ]
      .map(
        (k) => `
          <div class="kpi-card ${k.cls}">
            <div class="kpi-label">${k.l}</div>
            <div class="kpi-value">${k.v}</div>
            <div class="kpi-sub">${k.sub}</div>
          </div>
        `
      )
      .join("");

    const tbody = document.getElementById("statusTableBody");
    const matchRows = d.matches.map((m) => {
      const v = m.validation;
      const checkBadges = v.checks
        .map((c) => `<td><span class="status-badge status-${c.status}">${c.status}</span></td>`)
        .join("");
      return `
        <tr>
          <td class="sticky-col"><strong>${escapeHtml(m.match_id)}</strong></td>
          <td>${escapeHtml(m.meta.date)} ${escapeHtml(m.meta.time || "")}</td>
          <td>${escapeHtml(m.meta.team_a)} vs ${escapeHtml(m.meta.team_b)}</td>
          <td class="num"><strong>${m.meta.score_a}-${m.meta.score_b}</strong> <span class="val-muted">(${escapeHtml(m.meta.half_score_1)} / ${escapeHtml(m.meta.half_score_2)})</span></td>
          ${checkBadges}
          <td><span class="status-badge status-${v.status}">${v.status}</span></td>
        </tr>
      `;
    });

    const errRows = (d.parse_errors || []).map(
      (pe) => `
        <tr>
          <td class="sticky-col"><strong>${escapeHtml(pe.match_id)}</strong></td>
          <td colspan="8" class="val-neg">Parse Error: ${escapeHtml(pe.error)}</td>
          <td><span class="status-badge status-ERROR">ERROR</span></td>
        </tr>
      `
    );
    tbody.innerHTML = matchRows.concat(errRows).join("");

    const detailsList = document.getElementById("statusDetailsList");
    detailsList.innerHTML = d.matches
      .map((m) => {
        const v = m.validation;
        const checksHtml = v.checks
          .map(
            (c) => `
              <li>
                <span class="status-badge status-${c.status}">${c.status}</span>
                <span><strong>Check ${c.id} (${escapeHtml(c.name)}):</strong> ${escapeHtml(c.details)}</span>
              </li>
            `
          )
          .join("");
        const notesHtml =
          v.notes && v.notes.length > 0
            ? `
              <div class="status-notes-box">
                <strong>Audit / PDF Source Notes (${v.notes.length}):</strong>
                <ul>${v.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
              </div>
            `
            : "";
        return `
          <div class="status-detail-card">
            <div class="status-detail-head">
              <div class="status-detail-title">
                ${escapeHtml(m.match_id)} — ${escapeHtml(m.meta.team_a)} ${m.meta.score_a}-${m.meta.score_b} ${escapeHtml(m.meta.team_b)}
                <span class="val-muted">(${escapeHtml(m.meta.round || "")} • ${escapeHtml(m.meta.venue || "")})</span>
              </div>
              <span class="status-badge status-${v.status}">${v.status}</span>
            </div>
            <ul class="status-check-list">${checksHtml}</ul>
            ${notesHtml}
          </div>
        `;
      })
      .join("");
  }

  /* ------------------------------------------------------------------ */
  /* Navigation & Render Orchestration                                  */
  /* ------------------------------------------------------------------ */
  function renderActiveTab() {
    if (!state.data) return;
    if (state.activeTab === "overview") renderOverview();
    else if (state.activeTab === "team") renderTeamAnalysis();
    else if (state.activeTab === "individual") renderIndividualStats();
    else if (state.activeTab === "status") renderDataStatus();
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
      if (isActive && typeof btn.scrollIntoView === "function") {
        btn.scrollIntoView({ inline: "nearest", block: "nearest" });
      }
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tabName}`);
    });
    renderActiveTab();
  }

  function selectTeam(teamName, keepSelection = false) {
    state.selectedTeam = teamName;
    const entries = getTeamMatchEntries(teamName, false);
    if (!keepSelection) {
      state.selectedMatchIds = new Set(entries.map((e) => e.match.match_id));
    } else {
      const validIds = new Set(entries.map((e) => e.match.match_id));
      state.selectedMatchIds = new Set([...state.selectedMatchIds].filter((id) => validIds.has(id)));
      if (state.selectedMatchIds.size === 0) {
        state.selectedMatchIds = validIds;
      }
    }
    renderTeamSelector();
    renderMatchChips();
    renderActiveTab();
  }

  function showToast(message, isError = false) {
    const el = document.getElementById("toastBanner");
    el.textContent = message;
    el.className = `toast-banner ${isError ? "toast-err" : "toast-ok"}`;
    el.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.hidden = true;
    }, 5500);
  }

  /* ------------------------------------------------------------------ */
  /* Data Loading & Local Drive Refresh API                             */
  /* ------------------------------------------------------------------ */
  async function loadInitialData() {
    if (window.__HANDBALL_DATA__) {
      return window.__HANDBALL_DATA__;
    }
    const resp = await fetch("./data.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`Failed to load data.json (${resp.status})`);
    return resp.json();
  }

  async function detectRuntimeMode() {
    const refreshBtn = document.getElementById("refreshDriveBtn");
    const modeBadge = document.getElementById("runtimeModeBadge");

    if (window.__OFFLINE_MODE__ || window.location.protocol === "file:") {
      state.localServerAvailable = false;
      refreshBtn.hidden = true;
      modeBadge.textContent = "Offline Single-File Bundle";
      modeBadge.hidden = false;
      return;
    }

    try {
      const resp = await fetch("/api/health", { cache: "no-store" });
      if (resp.ok) {
        const info = await resp.json();
        if (info && info.mode === "local_server") {
          state.localServerAvailable = true;
          refreshBtn.hidden = false;
          modeBadge.hidden = true;
          return;
        }
      }
    } catch (_) {
      // Static web hosting (GitHub Pages, Netlify, etc.)
    }

    state.localServerAvailable = false;
    refreshBtn.hidden = true;
    modeBadge.textContent = "Static Web View";
    modeBadge.hidden = false;
  }

  async function triggerDriveRefresh() {
    const btn = document.getElementById("refreshDriveBtn");
    const label = btn.querySelector(".refresh-label");
    btn.disabled = true;
    btn.classList.add("loading");
    label.textContent = "Updating...";

    try {
      const resp = await fetch("/api/refresh", { method: "POST" });
      const payload = await resp.json();
      if (!resp.ok || payload.status !== "ok") {
        throw new Error(payload.message || `Refresh failed (${resp.status})`);
      }

      const prevTeam = state.selectedTeam;
      const prevMatchIds = new Set(state.data.matches.map((m) => m.match_id));
      state.data = payload.data;

      // Auto-select any brand new matches for the current team
      const teams = state.data.summary.teams || [];
      const nextTeam = teams.includes(prevTeam)
        ? prevTeam
        : (teams.includes(state.data.default_team) ? state.data.default_team : (teams[0] || ""));

      state.selectedTeam = nextTeam;
      const newEntries = getTeamMatchEntries(nextTeam, false);
      newEntries.forEach((e) => {
        if (!prevMatchIds.has(e.match.match_id)) {
          state.selectedMatchIds.add(e.match.match_id);
        }
      });
      // Prune deleted matches
      const validIds = new Set(newEntries.map((e) => e.match.match_id));
      state.selectedMatchIds = new Set([...state.selectedMatchIds].filter((id) => validIds.has(id)));
      if (state.selectedMatchIds.size === 0) state.selectedMatchIds = validIds;

      renderHeader();
      renderTeamSelector();
      renderMatchChips();
      renderActiveTab();

      const s = payload.summary;
      showToast(
        `Drive sync complete: ${s.parsed_matches} match(es) loaded (${s.ok_matches} OK, ${s.warning_matches} Warning, ${s.error_matches} Error).`,
        s.error_matches > 0
      );
    } catch (err) {
      showToast(`Update failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
      label.textContent = "Update from Drive";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Event Wiring                                                       */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("teamSelect").addEventListener("change", (e) => {
      selectTeam(e.target.value, false);
    });

    document.getElementById("selectAllMatchesBtn").addEventListener("click", () => {
      const entries = getTeamMatchEntries(state.selectedTeam, false);
      state.selectedMatchIds = new Set(entries.map((e) => e.match.match_id));
      renderMatchChips();
      renderActiveTab();
    });

    document.getElementById("clearMatchesBtn").addEventListener("click", () => {
      state.selectedMatchIds.clear();
      renderMatchChips();
      renderActiveTab();
    });

    document.getElementById("matchChipsContainer").addEventListener("change", (e) => {
      if (e.target.matches('input[type="checkbox"]')) {
        const id = e.target.value;
        if (e.target.checked) state.selectedMatchIds.add(id);
        else state.selectedMatchIds.delete(id);
        renderMatchChips();
        renderActiveTab();
      }
    });

    document.getElementById("overviewMetricSelect").addEventListener("change", (e) => {
      state.overviewMetric = e.target.value;
      renderOverview();
    });

    document.getElementById("overviewTableBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-team]");
      if (!tr) return;
      selectTeam(tr.dataset.team, false);
      switchTab("team");
    });

    // Sortable table headers
    [
      { id: "overviewTable", key: "overview", render: renderOverview },
      { id: "playersTable", key: "players", render: renderIndividualStats },
      { id: "gksTable", key: "gks", render: renderIndividualStats },
    ].forEach(({ id, key, render }) => {
      document.querySelector(`#${id} thead`).addEventListener("click", (e) => {
        const th = e.target.closest("th[data-sort]");
        if (!th) return;
        const col = th.dataset.sort;
        const cur = state.sorts[key];
        if (cur.key === col) {
          cur.dir = cur.dir === "desc" ? "asc" : "desc";
        } else {
          cur.key = col;
          cur.dir = col === "team" || col === "name" || col === "jersey" ? "asc" : "desc";
        }
        render();
      });
    });

    // Timeline mode segmented toggle
    document.querySelectorAll(".seg-btn[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.timelineMode = btn.dataset.mode;
        document.querySelectorAll(".seg-btn[data-mode]").forEach((b) =>
          b.classList.toggle("active", b.dataset.mode === state.timelineMode)
        );
        renderTeamAnalysis();
      });
    });

    // Player & GK modal triggers
    document.getElementById("playersTableBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-player-key]");
      if (!tr || !state._playersByKey) return;
      const p = state._playersByKey.get(tr.dataset.playerKey);
      if (p) openPlayerModal(p);
    });

    document.getElementById("gksTableBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-gk-key]");
      if (!tr || !state._gksByKey) return;
      const gk = state._gksByKey.get(tr.dataset.gkKey);
      if (gk) openGkModal(gk);
    });

    document.getElementById("closeModalBtn").addEventListener("click", closeModal);
    document.getElementById("detailModal").addEventListener("click", (e) => {
      if (e.target.id === "detailModal") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("detailModal").hidden) {
        closeModal();
      }
    });

    document.getElementById("refreshDriveBtn").addEventListener("click", triggerDriveRefresh);
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                          */
  /* ------------------------------------------------------------------ */
  async function init() {
    bindEvents();
    await detectRuntimeMode();
    try {
      state.data = await loadInitialData();
      const teams = state.data.summary.teams || [];
      const defaultTeam = state.data.default_team || "Japan";
      const initialTeam = teams.includes(defaultTeam) ? defaultTeam : (teams[0] || "");
      renderHeader();
      selectTeam(initialTeam, false);
    } catch (err) {
      showToast(`Failed to load dashboard data: ${err.message}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
