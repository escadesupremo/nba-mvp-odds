(() => {
  "use strict";

  const SLOTS = 8;           // colour slots, so at most 8 players can be charted
  const DEFAULT_SHOWN = 4;   // charted on first load; up to 4 also get end labels
  const TABLE_ROWS = 15;
  const REFRESH_MS = 10 * 60 * 1000;
  const SOURCE_LABEL = { avg: "Average", kalshi: "Kalshi", polymarket: "Polymarket" };
  const SVG = "http://www.w3.org/2000/svg";
  const ESPN_IMG = "https://a.espncdn.com/combiner/i";  // ESPN's resizer, so small images stay small

  const state = {
    data: null,
    range: "30",
    source: "avg",
    slots: new Map(),   // player name -> colour slot; follows the player, never the rank
    shown: null,        // Set of charted player names
    showAll: false,
    open: new Set(),    // player names with their detail panel open
    hover: null,        // index into data.dates under the crosshair
  };
  let geom = null;      // current chart geometry, used by the hover layer

  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }
  function sv(tag, attrs, text) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  // --- Formatting ----------------------------------------------------------

  const pct = (p) => p == null ? "–" : p < 0.005 ? "<1%" : p < 0.1 ? (p * 100).toFixed(1) + "%" : Math.round(p * 100) + "%";
  function odds(p) {
    if (p == null || p <= 0) return "–";
    const o = 1 / p;
    return o < 10 ? o.toFixed(2) : o < 100 ? o.toFixed(1) : String(Math.round(o));
  }
  function delta(d) {
    if (d == null) return { text: "–", label: "no data" };
    const pts = d * 100;
    if (Math.abs(pts) < 0.05) return { text: "0.0", label: "unchanged" };
    return pts > 0
      ? { text: "▲ " + pts.toFixed(1), label: `up ${pts.toFixed(1)} points` }
      : { text: "▼ " + (-pts).toFixed(1), label: `down ${(-pts).toFixed(1)} points` };
  }
  const fmtDate = (d, opts) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
  function shortName(name) {
    const parts = name.split(" ").filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w));
    return parts[parts.length - 1] || name;
  }

  // --- Pictures (ESPN) -----------------------------------------------------

  const espnImg = (path, w, h) => `${ESPN_IMG}?img=${encodeURIComponent(path)}&w=${w}&h=${h}`;
  const initials = (name) => name.split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  // Headshot with an initials fallback if there is none or it fails to load.
  function headshot(p, cls, w, h) {
    const box = el("span", { class: cls, "aria-hidden": "true" });
    const fallback = () => { box.textContent = initials(p.name); box.classList.add("initials"); };
    if (!p.headshot) { fallback(); return box; }
    const img = el("img", { src: espnImg(p.headshot, w * 2, h * 2), width: w, height: h, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", fallback, { once: true });
    box.append(img);
    return box;
  }

  // Theme: the toggle's choice if any, else the OS setting.
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";

  // Team logo + name; the dark-mode logo where ESPN has one.
  function teamLine(p, cls, size, long, withRecord) {
    const t = p.team && state.data.teams && state.data.teams[p.team];
    if (!t) return null;
    const line = el("span", { class: cls });
    const logo = isDark() && t.logoDark ? t.logoDark : t.logo;
    if (logo) {
      const img = el("img", { class: "logo", src: espnImg(logo, size * 2, size * 2), width: size, height: size, alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => img.remove(), { once: true });
      line.append(img);
    }
    line.append(long ? t.name : t.short);
    if (withRecord && t.record) line.append(el("span", { class: "rec" }, t.record));
    return line;
  }

  // --- Data helpers --------------------------------------------------------

  function rangeIdx() {
    const n = state.data.dates.length;
    const len = state.range === "all" ? n : Math.min(n, Number(state.range));
    return [n - len, n - 1];
  }
  const nowValue = (p) => p[state.source];
  const series = (p) => (p.history && p.history[state.source]) || null;
  function change(p) {
    const s = series(p);
    if (!s) return null;
    const [i0, i1] = rangeIdx();
    let first = null;
    for (let i = i0; i <= i1; i++) if (s[i] != null) { first = s[i]; break; }
    return first == null || s[i1] == null ? null : s[i1] - first;
  }
  function ranked() {
    return [...state.data.players].sort((a, b) => (nowValue(b) ?? -1) - (nowValue(a) ?? -1));
  }
  function changeLabel() {
    if (state.range === "all") return "since " + fmtDate(state.data.dates[0], { day: "numeric", month: "short" });
    return `in ${state.range} days`;
  }

  // Colour slots go to the 8 leading players with history, in fixed order, once.
  // Later refreshes keep each player's slot; a newcomer takes a freed one.
  function assignSlots() {
    const eligible = state.data.players.filter((p) => p.history).slice(0, SLOTS).map((p) => p.name);
    for (const name of [...state.slots.keys()]) if (!eligible.includes(name)) state.slots.delete(name);
    const used = new Set(state.slots.values());
    for (const name of eligible) {
      if (state.slots.has(name)) continue;
      let s = 1;
      while (used.has(s)) s++;
      state.slots.set(name, s);
      used.add(s);
    }
    if (!state.shown) state.shown = new Set(eligible.slice(0, DEFAULT_SHOWN));
    for (const name of [...state.shown]) if (!state.slots.has(name)) state.shown.delete(name);
  }

  // --- Header & hero -------------------------------------------------------

  function renderHeader() {
    const d = state.data;
    $("season").textContent = d.season;
    // Fresh = updated within 90 minutes (the job runs every 30); otherwise say it may be stale.
    const t = new Date(d.updated);
    const ageMin = (Date.now() - t.getTime()) / 60000;
    const time = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const fresh = ageMin < 90;
    const live = $("live");
    live.className = "live " + (fresh ? "fresh" : "stale");
    live.dataset.short = time;
    $("updated").textContent = fresh
      ? `Updated ${time}`
      : `Updated ${t.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · may be out of date`;
    for (const btn of $("source").querySelectorAll("button")) {
      const src = btn.dataset.v;
      const ok = src === "avg" || (d.sources[src] && d.sources[src].ok);
      btn.disabled = !ok;
      btn.title = ok ? "" : `${SOURCE_LABEL[src]} could not be loaded on the last update`;
      if (!ok && state.source === src) state.source = "avg";
    }
    for (const g of ["range", "source"]) {
      for (const btn of $(g).querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.v === state[g]));
    }
  }

  function fig(value, label, hero) {
    const f = el("div", { class: "fig" });
    f.append(el("span", { class: "fig-value" + (hero ? " hero" : "") }, value), el("span", { class: "fig-label" }, label));
    return f;
  }

  // Top three: the favourite as the page's one hero figure, the next two as compact cards.
  function renderPodium() {
    const box = $("podium");
    box.textContent = "";
    const [top, ...rest] = ranked().slice(0, 3);
    if (!top) return;
    const lastLine = (p) => {
      const L = p.games && p.games.last;
      if (!L) return null;
      const ln = L.line || {};
      return `${L.result || ""} ${L.score || ""} ${L.home ? "vs" : "at"} ${L.opp || ""} · ` +
        [ln.PTS && `${ln.PTS} pts`, ln.REB && `${ln.REB} reb`, ln.AST && `${ln.AST} ast`].filter(Boolean).join(", ");
    };

    const lead = el("article", { class: "lead" });
    const photo = el("div", { class: "lead-photo" });
    photo.append(headshot(top, "lead-shot", 160, 117));
    const body = el("div", { class: "lead-body" });
    const teamRow = el("div", { class: "lead-team" });
    const team = teamLine(top, "team", 16, true);
    if (team) teamRow.append(team);
    const badge = statusBadge(top, true);
    if (badge) teamRow.append(badge);
    const figs = el("div", { class: "figs" });
    const ch = delta(change(top));
    figs.append(fig(pct(nowValue(top)), "Chance", true), fig(odds(nowValue(top)), "Fair odds"));
    if (ch.text !== "–") figs.append(fig(ch.text, `Pts ${changeLabel()}`));
    body.append(el("div", { class: "eyebrow" }, "Favourite"), el("h2", { class: "lead-name" }, top.name), teamRow, figs);
    lead.append(body, photo);

    // Last game and team record along the bottom, visible without opening anything
    const form = el("dl", { class: "lead-form" });
    const last = lastLine(top);
    if (last) {
      const dd = el("dd", {}, last + " ");
      dd.append(el("span", { class: "when" }, "· " + gameDay(top.games.last.date, true)));
      const row = el("div");
      row.append(el("dt", {}, "Last game"), dd);
      form.append(row);
    }
    const t = top.team && state.data.teams[top.team];
    if (t && t.record) {
      const row = el("div");
      row.append(el("dt", {}, "Team"), el("dd", {},
        `${t.record}` + (t.seed ? `, ${ordinal(t.seed)} in the ${t.conf}` : "") + (t.streak ? ` · ${t.streak}` : "")));
      form.append(row);
    }
    if (form.childNodes.length) lead.append(form);
    box.append(lead);

    rest.forEach((p, i) => {
      const card = el("article", { class: "runner" });
      const head = el("div", { class: "runner-top" });
      head.append(el("span", { class: "rank" }, String(i + 2)), headshot(p, "avatar", 48, 35));
      const sub = el("div", { class: "sub-line" });
      const tl = teamLine(p, "team", 14, false, true);
      if (tl) sub.append(tl);
      const b = statusBadge(p, true);
      if (b) sub.append(b);
      const f = el("div", { class: "figs" });
      const d = delta(change(p));
      f.append(fig(pct(nowValue(p)), "Chance"));
      if (d.text !== "–") f.append(fig(d.text, changeLabel()));
      card.append(head, el("div", { class: "runner-name" }, p.name), sub);
      const last = lastLine(p);
      if (last) card.append(el("div", { class: "runner-last" }, "Last game: " + last));
      card.append(f);
      box.append(card);
    });
  }

  // --- Chart ---------------------------------------------------------------

  function chartSeries() {
    const [i0, i1] = rangeIdx();
    return state.data.players
      .filter((p) => state.shown.has(p.name) && series(p))
      .map((p) => ({ name: p.name, slot: state.slots.get(p.name), vals: series(p).slice(i0, i1 + 1) }))
      .filter((s) => s.vals.some((v) => v != null))
      .sort((a, b) => a.slot - b.slot);
  }

  function renderLegend(list, narrow) {
    const ul = $("legend");
    ul.textContent = "";
    if (list.length < 2 && !narrow) return;  // one line is named by its end label
    for (const s of list) {
      const li = el("li");
      li.append(el("span", { class: "key", style: `background:var(--s${s.slot})` }), s.name);
      ul.append(li);
    }
  }

  function renderNote() {
    const src = state.data.sources;
    const missing = ["kalshi", "polymarket"].filter((k) => src[k] && src[k].ok && !src[k].history);
    let note = "";
    if (state.source !== "avg" && missing.includes(state.source)) {
      note = `${SOURCE_LABEL[state.source]} price history could not be loaded on the last update, so only today's price is shown in the table.`;
    } else if (state.source === "avg" && missing.length) {
      note = `${missing.map((k) => SOURCE_LABEL[k]).join(" and ")} price history could not be loaded on the last update, so the average line uses the other market until today.`;
    }
    $("chart-note").textContent = note;
  }

  function renderChart() {
    const box = $("chart");
    box.textContent = "";
    const W = box.clientWidth || 600;
    const narrow = W < 560;
    const list = chartSeries();
    renderLegend(list, narrow);
    renderNote();
    const rangeText = state.range === "all" ? "Since the market opened" : `Last ${state.range} days`;
    $("chart-sub").textContent = `${rangeText} · ${state.source === "avg" ? "average of Kalshi and Polymarket" : SOURCE_LABEL[state.source]} · daily`;

    const H = narrow ? 220 : 280;
    const m = { top: 10, right: narrow ? 14 : 140, bottom: 28, left: 40 };
    const plotW = Math.max(50, W - m.left - m.right);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H + m.top + m.bottom}`, height: H + m.top + m.bottom, role: "img" });
    box.append(svg);

    if (!list.length) {
      svg.append(sv("text", { class: "empty", x: W / 2, y: (H + m.top) / 2, "text-anchor": "middle" },
        state.shown.size ? "No price history from this market on the last update." : "Tick a player in the table to chart them."));
      geom = null;
      return;
    }

    const [i0, i1] = rangeIdx();
    const n = i1 - i0;
    const maxV = Math.max(...list.flatMap((s) => s.vals.filter((v) => v != null)));
    const step = maxV > 0.4 ? 0.1 : maxV > 0.2 ? 0.05 : maxV > 0.08 ? 0.02 : 0.01;
    const yMax = Math.max(step, Math.ceil(maxV / step - 1e-9) * step);
    const x = (j) => m.left + (n ? (j / n) * plotW : plotW);
    const y = (v) => m.top + H - (v / yMax) * H;
    svg.setAttribute("aria-label",
      `Line chart: ${SOURCE_LABEL[state.source]} chance of winning MVP for ${list.map((s) => s.name).join(", ")}, ` +
      `${fmtDate(state.data.dates[i0], { day: "numeric", month: "short" })} to ${fmtDate(state.data.dates[i1], { day: "numeric", month: "short" })}. The table below lists every value.`);

    // Grid and y ticks
    const grid = sv("g", { class: "grid" });
    for (let v = step; v <= yMax + 1e-9; v += step) {
      grid.append(sv("line", { x1: m.left, x2: m.left + plotW, y1: y(v), y2: y(v) }));
      svg.append(sv("text", { class: "tick", x: m.left - 8, y: y(v) + 4, "text-anchor": "end" }, Math.round(v * 100) + "%"));
    }
    svg.append(sv("text", { class: "tick", x: m.left - 8, y: y(0) + 4, "text-anchor": "end" }, "0%"));
    svg.prepend(grid);
    svg.append(sv("line", { class: "baseline", x1: m.left, x2: m.left + plotW, y1: y(0), y2: y(0) }));

    // X ticks: days for a week, weekly for a month, month starts for the season
    const dates = state.data.dates;
    let lastTickX = -Infinity;
    for (let j = 0; j <= n; j++) {
      const d = dates[i0 + j];
      let label = null;
      if (state.range === "7") label = fmtDate(d, { day: "numeric", month: "short" });
      else if (state.range === "30") { if ((n - j) % 7 === 0) label = fmtDate(d, { day: "numeric", month: "short" }); }
      else if (d.endsWith("-01")) label = fmtDate(d, { month: "short" });
      if (!label) continue;
      const tx = x(j);
      if (tx - lastTickX < (narrow ? 44 : 52)) continue;
      const anchor = tx > m.left + plotW - 20 ? "end" : tx < m.left + 20 ? "start" : "middle";
      svg.append(sv("text", { class: "tick", x: tx, y: m.top + H + 18, "text-anchor": anchor }, label));
      lastTickX = tx;
    }

    // Lines
    const ends = [];
    for (const s of list) {
      let d = "", pen = false, last = null;
      s.vals.forEach((v, j) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(j).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
        last = j;
      });
      svg.append(sv("path", { class: "series", d, stroke: `var(--s${s.slot})` }));
      if (last != null) ends.push({ s, j: last, v: s.vals[last] });
    }
    for (const e of ends) {
      svg.append(sv("circle", { class: "end", cx: x(e.j), cy: y(e.v), r: 4, fill: `var(--s${e.s.slot})` }));
    }

    // End labels for up to 4 lines; crowded labels get a leader line instead of drifting off
    if (!narrow && ends.length <= DEFAULT_SHOWN) {
      const gap = 16;
      const items = ends.map((e) => ({ ...e, py: y(e.v), ly: y(e.v) })).sort((a, b) => a.py - b.py);
      for (let k = 1; k < items.length; k++) items[k].ly = Math.max(items[k].ly, items[k - 1].ly + gap);
      const over = items.length ? items[items.length - 1].ly - (m.top + H) : 0;
      if (over > 0) for (const it of items) it.ly -= over;
      for (let k = items.length - 2; k >= 0; k--) items[k].ly = Math.min(items[k].ly, items[k + 1].ly - gap);
      for (const it of items) {
        const ex = x(it.j);
        const lx = m.left + plotW + 14;
        if (Math.abs(it.ly - it.py) > 2) {
          svg.append(sv("line", { class: "leader", x1: ex + 6, y1: it.py, x2: lx - 3, y2: it.ly }));
        }
        const t = sv("text", { class: "label", x: lx, y: it.ly + 4 });
        t.append(sv("tspan", {}, shortName(it.s.name) + " "), sv("tspan", { class: "val" }, pct(it.v)));
        svg.append(t);
      }
    }

    // Hover layer: crosshair snaps to the nearest day and lists every line
    const cross = sv("line", { class: "cross", y1: m.top, y2: m.top + H, visibility: "hidden" });
    const dots = sv("g");
    svg.append(cross, dots);
    const hit = sv("rect", { class: "hit", x: m.left, y: m.top, width: plotW, height: H });
    svg.append(hit);
    geom = { svg, x, y, n, i0, list, cross, dots, m, plotW };
    hit.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const j = Math.round(((px - m.left) / plotW) * n);
      showHover(Math.max(0, Math.min(n, j)), ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", hideHover);
    if (state.hover != null && state.hover <= n) showHover(state.hover);
  }

  function showHover(j, cx, cy) {
    if (!geom) return;
    state.hover = j;
    const { svg, x, y, list, cross, dots, i0, m } = geom;
    const px = x(j);
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    dots.textContent = "";
    const rows = list.map((s) => ({ s, v: s.vals[j] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
    for (const r of rows) dots.append(sv("circle", { class: "end", cx: px, cy: y(r.v), r: 4, fill: `var(--s${r.s.slot})` }));

    const tt = $("tooltip");
    tt.textContent = "";
    tt.append(el("div", { class: "tt-date" }, fmtDate(state.data.dates[i0 + j], { day: "numeric", month: "short", year: "numeric" })));
    for (const r of rows) {
      const row = el("div", { class: "tt-row" });
      row.append(el("span", { class: "key", style: `background:var(--s${r.s.slot})` }), el("strong", {}, pct(r.v)), el("span", {}, r.s.name));
      tt.append(row);
    }
    if (!rows.length) tt.append(el("div", { class: "tt-row" }, "No prices that day"));
    tt.hidden = false;

    // Pointer position, or the crosshair's top when driven by the keyboard
    if (cx == null) {
      const r = svg.getBoundingClientRect();
      const scale = r.width / svg.viewBox.baseVal.width;
      cx = r.left + px * scale;
      cy = r.top + m.top * scale + 20;
    }
    const tw = tt.offsetWidth, th = tt.offsetHeight;
    let left = cx + 14;
    if (left + tw > window.innerWidth - 8) left = cx - tw - 14;
    tt.style.left = Math.max(8, left) + "px";
    tt.style.top = Math.max(8, Math.min(cy - th / 2, window.innerHeight - th - 8)) + "px";
  }

  function hideHover() {
    state.hover = null;
    $("tooltip").hidden = true;
    if (geom) {
      geom.cross.setAttribute("visibility", "hidden");
      geom.dots.textContent = "";
    }
  }

  // --- Table ---------------------------------------------------------------

  const COLS = 9;
  const bookOdds = (o) => o == null ? "–" : o < 10 ? o.toFixed(2) : o < 100 ? o.toFixed(1) : String(Math.round(o));

  function renderTable() {
    const rows = ranked();
    const visible = state.showAll ? rows : rows.slice(0, TABLE_ROWS);
    const tbody = $("table").tBodies[0];
    tbody.textContent = "";
    $("change-head").textContent = "Change " + changeLabel();
    $("count").textContent = String(rows.length);
    $("table-wrap").style.setProperty("--wrap-w", $("table-wrap").clientWidth + "px");
    // Chance bars share one scale: the leader's chance rounded up to the next 10%.
    const scale = Math.max(0.1, Math.ceil(((rows[0] && nowValue(rows[0])) || 0) * 10 - 1e-9) / 10);
    visible.forEach((p, i) => {
      const open = state.open.has(p.name);
      const detailId = "detail-" + i;
      const tr = el("tr", { class: open ? "open" : "" });
      tr.append(el("td", { class: "num c-rank" }, String(i + 1)));

      const name = el("td", { class: "c-player" });
      const wrap = el("span", { class: "player" });
      const slot = state.slots.get(p.name);
      if (slot) {
        const box = el("input", { type: "checkbox", class: "pick", style: `--c:var(--s${slot})`, "aria-label": `Show ${p.name} on the chart` });
        box.checked = state.shown.has(p.name);
        box.addEventListener("change", () => {
          box.checked ? state.shown.add(p.name) : state.shown.delete(p.name);
          renderChart();
        });
        wrap.append(box);
      } else {
        wrap.append(el("span", { class: "pick-spacer", "aria-hidden": "true" }));
      }
      wrap.append(headshot(p, "avatar", 48, 35));  // ESPN's 1040×760 shape; CSS crops it to a circle
      const who = el("span", { class: "who" });
      const btn = el("button", { type: "button", class: "pname", "aria-expanded": String(open), "aria-controls": detailId });
      btn.append(p.name, el("span", { class: "chev", "aria-hidden": "true" }));
      btn.addEventListener("click", () => {
        state.open.has(p.name) ? state.open.delete(p.name) : state.open.add(p.name);
        renderTable();
        tbody.querySelector(`[aria-controls="${detailId}"]`)?.focus();
      });
      who.append(btn);
      const sub = el("span", { class: "sub-line" });
      const team = teamLine(p, "team", 14, false, true);
      if (team) sub.append(team);
      const badge = statusBadge(p, true);
      if (badge) sub.append(badge);
      who.append(sub);
      wrap.append(who);
      name.append(wrap);
      tr.append(name);

      const chance = el("td", { class: "num" });
      const cell = el("span", { class: "chance-cell" });
      const bar = el("span", { class: "bar", "aria-hidden": "true" });
      bar.append(el("span", { style: `width:${Math.min(100, ((nowValue(p) || 0) / scale) * 100).toFixed(1)}%` }));
      cell.append(bar, pct(nowValue(p)));
      chance.append(cell);
      tr.append(chance);
      const ch = delta(change(p));
      tr.append(el("td", { class: "num sec", "aria-label": ch.label }, ch.text));
      tr.append(el("td", { class: p.kalshi == null ? "num dim" : "num sec" }, pct(p.kalshi)));
      tr.append(el("td", { class: p.polymarket == null ? "num dim" : "num sec" }, pct(p.polymarket)));
      tr.append(el("td", { class: "num sec odds-start" }, odds(nowValue(p))));
      for (const book of ["draftkings", "unibet"]) {
        const o = p.books && p.books[book];
        tr.append(el("td", { class: o == null ? "num dim" : "num sec" }, bookOdds(o)));
      }
      tr.classList.add("row");
      tr.addEventListener("click", (ev) => {
        if (!ev.target.closest("input, button")) btn.click();  // the whole row opens the panel
      });
      tbody.append(tr);

      if (open) {
        const dtr = el("tr", { class: "detail", id: detailId });
        const td = el("td", { colspan: COLS });
        td.append(renderDetail(p));
        dtr.append(td);
        tbody.append(dtr);
      }
    });
    const more = $("more");
    more.hidden = rows.length <= TABLE_ROWS;
    more.textContent = state.showAll ? `Show top ${TABLE_ROWS}` : `Show all ${rows.length} players`;
  }

  // --- Player detail -------------------------------------------------------

  const STATUS = {
    active: { cls: "s-good", icon: "✓", label: "Active" },
    "day-to-day": { cls: "s-warn", icon: "!", label: "Day-to-day" },
    out: { cls: "s-crit", icon: "✕", label: "Out" },
  };
  function statusOf(p) {
    if (p.status) return STATUS[(p.status.status || "").toLowerCase()] || { cls: "s-warn", icon: "!", label: p.status.status };
    return state.data.sources.injuries && state.data.sources.injuries.ok ? STATUS.active : null;
  }
  // Icon + label, never colour alone. compact = only shown in the table when not active.
  function statusBadge(p, compact) {
    const s = statusOf(p);
    if (!s || (compact && s === STATUS.active)) return null;
    const b = el("span", { class: "status" });
    b.append(el("span", { class: `sicon ${s.cls}`, "aria-hidden": "true" }, s.icon), s.label);
    return b;
  }

  const etDay = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // Game dates in US Eastern time, as the NBA dates them. short = relative only.
  function gameDay(iso, short) {
    const label = new Date(iso).toLocaleDateString("en-GB", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" });
    const days = Math.round((Date.parse(etDay(Date.now())) - Date.parse(etDay(iso))) / 864e5);
    const rel = days === 0 ? "today" : days === 1 ? "yesterday" : days > 1 ? `${days} days ago` : "";
    if (short) return rel || label;
    return label + (rel ? " · " + rel : "");
  }
  const ordinal = (n) => { n = Number(n); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  function stats(pairs) {
    const box = el("div", { class: "stats" });
    for (const [label, value] of pairs) {
      if (value == null || value === "") continue;
      const cell = el("div", { class: "stat" });
      cell.append(el("strong", {}, value), el("span", {}, label));
      box.append(cell);
    }
    return box;
  }

  function card(title, ...children) {
    const c = el("section", { class: "dcard" });
    c.append(el("h3", {}, title), ...children.filter(Boolean));
    return c;
  }

  function renderDetail(p) {
    const inner = el("div", { class: "detail-inner" });
    const grid = el("div", { class: "detail-grid" });
    inner.append(grid);
    const g = p.games;
    const team = p.team && state.data.teams[p.team];

    // Status
    const badge = statusBadge(p, false);
    let statusLine = el("p", { class: "dmeta" }, "Injury report not available.");
    if (badge) { statusLine = el("div", { class: "big-status" }); statusLine.append(badge); }
    grid.append(card("Status",
      statusLine,
      p.status && p.status.injury ? el("p", { class: "dmeta" }, p.status.injury) : null,
      p.status && p.status.note ? el("p", { class: "dnote" }, p.status.note) : null,
      p.status && p.status.returns ? el("p", { class: "dmeta" }, "Expected back " + fmtDate(p.status.returns, { day: "numeric", month: "short" })) : null,
      !p.status && badge ? el("p", { class: "dmeta" }, "Not on the injury report.") : null,
    ));

    // Last game
    if (g && g.last) {
      const L = g.last;
      const opp = el("div", { class: "game" });
      opp.append((L.home ? "vs " : "at "));
      if (L.oppLogo) opp.append(el("img", { class: "logo", src: espnImg(L.oppLogo, 32, 32), width: 16, height: 16, alt: "", loading: "lazy" }));
      opp.append(L.oppName || L.opp || "");
      const res = el("div", { class: "result" });
      res.append(el("strong", {}, `${L.result || ""} ${L.score || ""}`.trim()));
      const ln = L.line || {};
      grid.append(card("Last game",
        el("p", { class: "dmeta" }, L.date ? gameDay(L.date) : ""),
        opp, res,
        stats([["PTS", ln.PTS], ["REB", ln.REB], ["AST", ln.AST], ["STL", ln.STL], ["BLK", ln.BLK], ["TO", ln.TO]]),
        el("p", { class: "dmeta" }, [ln.MIN && `${ln.MIN} min`, ln.FG && `FG ${ln.FG}`, ln["3PT"] && `3PT ${ln["3PT"]}`, ln.FT && `FT ${ln.FT}`].filter(Boolean).join(" · ")),
      ));
      const a = g.avg || {};
      grid.append(card("Season averages",
        stats([["PTS", a.PTS], ["REB", a.REB], ["AST", a.AST], ["FG%", a["FG%"]], ["3P%", a["3P%"]], ["MIN", a.MIN]]),
        el("p", { class: "dmeta" }, `${g.gp} of ${team && team.games ? team.games + " team" : "their"} games played. MVP needs 65.`),
      ));
    } else {
      grid.append(card("Last game", el("p", { class: "dmeta" },
        p.avg != null && p.avg < 0.01 ? "Game stats are loaded for players at 1% or more." : "No regular-season game data yet.")));
    }

    // Team
    if (team) {
      const head = teamLine(p, "team team-big", 20, true);
      const rec = el("div", { class: "result" });
      rec.append(el("strong", {}, team.record || "–"));
      if (team.seed) rec.append(` · ${ordinal(team.seed)} in the ${team.conf}`);
      grid.append(card("Team",
        head, rec,
        el("p", { class: "dmeta" }, [team.streak && `Streak ${team.streak}`, team.last10 && `Last 10: ${team.last10}`, team.home && `Home ${team.home}`, team.road && `Road ${team.road}`].filter(Boolean).join(" · ")),
        team.ppg ? el("p", { class: "dmeta" }, `${team.ppg} points scored, ${team.oppg} allowed per game (${team.diff})`) : null,
      ));
    }
    return inner;
  }

  // --- Wiring --------------------------------------------------------------

  function renderAll() {
    renderHeader();
    renderPodium();
    renderChart();
    renderTable();
  }

  // Theme toggle: flips against whatever is showing now and remembers the choice.
  // Logos have light and dark versions, so everything re-renders.
  $("theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    $("theme").setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
    if (state.data) renderAll();
  });
  $("theme").setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  darkQuery.addEventListener("change", () => state.data && !document.documentElement.dataset.theme && renderAll());

  for (const g of ["range", "source"]) {
    $(g).addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn || btn.disabled || !state.data) return;
      state[g] = btn.dataset.v;
      hideHover();
      renderAll();
    });
  }
  $("more").addEventListener("click", () => { state.showAll = !state.showAll; renderTable(); });

  const chartBox = $("chart");
  chartBox.tabIndex = 0;
  chartBox.addEventListener("keydown", (ev) => {
    if (!geom) return;
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      const cur = state.hover ?? geom.n;
      showHover(Math.max(0, Math.min(geom.n, cur + (ev.key === "ArrowLeft" ? -1 : 1))));
      ev.preventDefault();
    } else if (ev.key === "Escape") hideHover();
  });
  chartBox.addEventListener("blur", hideHover);
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => state.data && renderChart());
  }).observe(chartBox);
  // Detail panels stay the width of the visible table area when the table scrolls sideways.
  const tableWrap = $("table-wrap");
  new ResizeObserver(() => tableWrap.style.setProperty("--wrap-w", tableWrap.clientWidth + "px")).observe(tableWrap);

  async function load() {
    try {
      const res = await fetch("data.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const first = !state.data;
      state.data = await res.json();
      assignSlots();
      if (first && ranked()[0]) state.open.add(ranked()[0].name);  // show the panel exists
      renderAll();
      $("page").classList.remove("loading");
    } catch (err) {
      console.error("Could not load data.json", err);
      if (!state.data) $("updated").textContent = "Data not available yet";
    }
  }
  load();
  setInterval(load, REFRESH_MS);
})();
