(() => {
  "use strict";

  // Only run in the top frame (TradingView embeds many iframes)
  try { if (window.top !== window) return; } catch (_) { return; }

  // Emergency cleanup from older broken versions
  (function emergencyChartCleanup() {
    try {
      const bad = document.getElementById("tvup-chart-push");
      if (bad) bad.remove();
      document.documentElement.classList.remove("tvup-panel-open");
      document.querySelectorAll(
        ".layout__area--center, .chart-container, [class*='chart-container'], .chart-gui-wrapper, [class*='chart-gui-wrapper'], #js-category-content, .layout, body"
      ).forEach((el) => {
        if (!el || (el.id === "tvup-root") || (el.closest && el.closest("#tvup-root"))) return;
        try {
          el.style.removeProperty("margin-right");
          el.style.removeProperty("padding-right");
          el.style.removeProperty("max-width");
          if (el.style.width && String(el.style.width).includes("calc")) {
            el.style.removeProperty("width");
          }
        } catch (_) {}
      });
      try {
        document.documentElement.style.removeProperty("padding-right");
        document.body.style.removeProperty("padding-right");
      } catch (_) {}
    } catch (_) {}
  })();

  const TVUP_VERSION = "3.1.44-firestore-proxy";
  if (window.__TVUP_LOADED__ === TVUP_VERSION) return;
  try {
    ["#tvup-root", "#tvup-resize-handle", "#tvup-show-panel", "#tvup-menu", "#tvup-flag-picker",
     "#tvup-modal-backdrop", "#tvup-confirm-backdrop", "#tvup-settings-modal", "#tvup-chart-push", "#tvup-chart-inset",
     "#tvup-add-popup", "#tvup-import-modal", "#tvup-list-edit-menu", "#tvup-alert-backdrop"
    ].forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  } catch (_) {}
  window.__TVUP_LOADED__ = TVUP_VERSION;
  try { console.log("[TVUP] loaded version", TVUP_VERSION); } catch (_) {}

  const REFRESH_MS = 3000;
  let __tvupRefreshing = false;
  let refreshBackoffMs = 0; // extra delay after 429
  let quoteCursor = 0; // rotate large watchlists through Upstox quote batches

  const DEFAULT_WATCHLIST = {
    id: "default",
    name: "My Watchlist",
    starred: true,
    symbols: [],
    entries: [],
    color: null
  };

  const COLORS = [
    "none", "red", "blue", "green", "yellow", "purple"
  ];

  /** Normalize watchlist: entries = ordered mix of symbols + sections (TradingView-style) */
  function ensureListEntries(list) {
    if (!list || typeof list !== "object") return;
    if (!Array.isArray(list.entries)) list.entries = null;
    if (Array.isArray(list.entries) && list.entries.length) {
      // sanitize
      list.entries = list.entries.map((e) => {
        if (!e || typeof e !== "object") return null;
        if (e.type === "sec") {
          return {
            type: "sec",
            id: String(e.id || ("sec_" + uid())),
            name: String(e.name || "SECTION").trim() || "SECTION",
            collapsed: !!e.collapsed
          };
        }
        const s = String(e.s || e.symbol || "").toUpperCase().trim();
        return s ? { type: "sym", s } : null;
      }).filter(Boolean);
      list.symbols = list.entries.filter((e) => e.type === "sym").map((e) => e.s);
      return;
    }
    // migrate flat symbols → entries
    list.entries = (Array.isArray(list.symbols) ? list.symbols : [])
      .map((s) => String(s || "").toUpperCase().trim())
      .filter(Boolean)
      .map((s) => ({ type: "sym", s }));
  }

  function syncSymbolsFromEntries(list) {
    if (!list) return;
    if (!Array.isArray(list.entries)) ensureListEntries(list);
    list.symbols = list.entries.filter((e) => e.type === "sym").map((e) => e.s);
  }


  function dedupeCanonicalSymbols(list) {
    if (!list) return false;
    ensureListEntries(list);
    const DROP = new Set(["NIFTY 500", "NIFTY500", "NIFTY_500", "NIFTY AUTO", "NIFTYAUTO"]);
    // only drop if canonical counterpart already present
    const has = new Set(list.symbols.map((x) => String(x).toUpperCase()));
    const keepCanon = (bad) => {
      if (bad === "NIFTY 500" || bad === "NIFTY500" || bad === "NIFTY_500") return has.has("CNX500");
      if (bad === "NIFTY AUTO" || bad === "NIFTYAUTO") return has.has("CNXAUTO");
      return false;
    };
    const before = list.entries.length;
    list.entries = list.entries.filter((e) => {
      if (!e || e.type !== "sym") return true;
      const s = String(e.s || "").toUpperCase();
      if (DROP.has(s) && keepCanon(s)) return false;
      // also rewrite non-canonical alone → canonical
      if (s === "NIFTY 500" || s === "NIFTY500" || s === "NIFTY_500") { e.s = "CNX500"; return true; }
      if (s === "NIFTY AUTO" || s === "NIFTYAUTO") { e.s = "CNXAUTO"; return true; }
      return true;
    });
    // unique after rewrite
    const seen = new Set();
    list.entries = list.entries.filter((e) => {
      if (!e || e.type !== "sym") return true;
      const s = String(e.s || "").toUpperCase();
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
    syncSymbolsFromEntries(list);
    return list.entries.length !== before;
  }

  function normalizeWatchSymbol(sym) {
    let s = String(sym || "").toUpperCase().trim();
    if (!s) return "";
    // Prefer canonical TV/index symbols (avoid duplicates with spaces)
    const NORM = {
      "NIFTY 500": "CNX500", "NIFTY500": "CNX500", "NIFTY_500": "CNX500",
      "NIFTY 100": "CNX100", "NIFTY100": "CNX100",
      "NIFTY 200": "CNX200", "NIFTY200": "CNX200",
      "NIFTY AUTO": "CNXAUTO", "NIFTYAUTO": "CNXAUTO",
      "NIFTY IT": "CNXIT", "NIFTYIT": "CNXIT",
      "NIFTY FMCG": "CNXFMCG", "NIFTYFMCG": "CNXFMCG",
      "NIFTY PHARMA": "CNXPHARMA", "NIFTYPHARMA": "CNXPHARMA",
      "NIFTY METAL": "CNXMETAL", "NIFTYMETAL": "CNXMETAL",
      "NIFTY REALTY": "CNXREALTY", "NIFTYREALTY": "CNXREALTY",
      "NIFTY ENERGY": "CNXENERGY", "NIFTYENERGY": "CNXENERGY",
      "NIFTY INFRA": "CNXINFRA", "NIFTYINFRA": "CNXINFRA",
      "NIFTY MEDIA": "CNXMEDIA", "NIFTYMEDIA": "CNXMEDIA",
      "NIFTY PSE": "CNXPSE", "NIFTYPSE": "CNXPSE",
      "BANKEX": "BANK", // TV chart symbol for BSE Bankex
    };
    if (NORM[s]) return NORM[s];
    const compact = s.replace(/\s+/g, "");
    if (NORM[compact]) return NORM[compact];
    return s;
  }

  /** Flag system helpers: a coloured list (green/red/...) and the symbol flag are ONE thing. */
  function tvupIsColorList(list) {
    return !!(list && list.color && list.color !== "none");
  }

  /** Make flags match coloured lists. Coloured lists are the source of truth. */
  function reconcileFlags() {
    try {
      if (!state.flags || typeof state.flags !== "object") state.flags = {};
      const colorLists = (state.watchlists || []).filter(tvupIsColorList);
      const owner = {};
      for (const l of colorLists) {
        for (const raw of (l.symbols || [])) {
          const sym = String(raw || "").toUpperCase().trim();
          if (!sym) continue;
          (owner[sym] = owner[sym] || []).push(l);
        }
      }
      const next = {};
      for (const sym of Object.keys(owner)) {
        const ls = owner[sym];
        const keep = ls.find((l) => l.color === state.flags[sym]) || ls[0];
        next[sym] = keep.color;
        // a symbol can live in only ONE coloured list
        for (const l of ls) { if (l !== keep) removeSymbolFromList(l, sym); }
      }
      state.flags = next;
    } catch (_) {}
  }

  function addSymbolToList(list, sym) {
    if (!list) return false;
    const s = normalizeWatchSymbol(sym);
    if (!s) return false;
    if (typeof isBlockedIndex === "function" && isBlockedIndex(s)) return false;
    ensureListEntries(list);
    if (list.symbols.includes(s)) {
      // already inside a coloured list -> make sure the flag is there too
      if (tvupIsColorList(list) && state.flags[s] !== list.color) {
        state.flags[s] = list.color;
        try { patchFlagDom(s, list.color); } catch (_) {}
      }
      return false;
    }
    // Always append at end of entries (bottom of list / last section group)
    list.entries.push({ type: "sym", s });
    syncSymbolsFromEntries(list);
    if (tvupIsColorList(list)) {
      // adding to Green list = flag Green (and leave any other coloured list)
      state.flags[s] = list.color;
      for (const other of state.watchlists) {
        if (other !== list && tvupIsColorList(other) && other.symbols.includes(s)) removeSymbolFromList(other, s);
      }
      try { patchFlagDom(s, list.color); } catch (_) {}
    }
    // Clear active sort so UI shows true append order (bottom); user can re-sort after
    try {
      if (state.sort && state.sort.direction !== 0) {
        state.sort = { column: null, direction: 0 };
      }
    } catch (_) {}
    return true;
  }

  function removeSymbolFromList(list, sym) {
    if (!list) return false;
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return false;
    ensureListEntries(list);
    const before = list.entries.length;
    list.entries = list.entries.filter((e) => !(e.type === "sym" && e.s === s));
    syncSymbolsFromEntries(list);
    if (tvupIsColorList(list) && state.flags[s] === list.color) {
      // removed from Green list = unflag everywhere
      delete state.flags[s];
      try { patchFlagDom(s, "none"); } catch (_) {}
    }
    return list.entries.length !== before;
  }

  function nextSectionName(list) {
    ensureListEntries(list);
    let max = 0;
    for (const e of list.entries) {
      if (e.type !== "sec") continue;
      const m = String(e.name || "").match(/^SECTION\s+(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]) || 0);
    }
    return "SECTION " + (max + 1);
  }

  async function addSectionToCurrent() {
    const list = activeWatchlist();
    if (!list) return;
    ensureListEntries(list);
    const id = "sec_" + uid();
    const name = nextSectionName(list);
    list.entries.push({ type: "sec", id, name, collapsed: false });
    syncSymbolsFromEntries(list);
    try { render(); } catch (_) {}
    try { await saveStateLocal(); } catch (_) {}
    // focus rename on new section
    setTimeout(() => {
      try {
        const row = document.querySelector(`#tvup-tbody tr.tvup-section-row[data-section-id="${id}"]`);
        const inp = row && row.querySelector(".tvup-section-name-input");
        if (inp) {
          inp.focus();
          inp.select();
        }
      } catch (_) {}
    }, 50);
  }

  async function renameSection(list, sectionId, newName) {
    if (!list) return;
    ensureListEntries(list);
    const e = list.entries.find((x) => x.type === "sec" && x.id === sectionId);
    if (!e) return;
    const n = String(newName || "").trim();
    if (!n) return;
    e.name = n;
    try { await saveStateLocal(); } catch (_) {}
  }

  async function toggleSectionCollapse(list, sectionId) {
    if (!list) return;
    ensureListEntries(list);
    const e = list.entries.find((x) => x.type === "sec" && x.id === sectionId);
    if (!e) return;
    e.collapsed = !e.collapsed;
    try { renderTable(); } catch (_) {}
    try { await saveStateLocal(); } catch (_) {}
  }

  async function deleteSection(list, sectionId) {
    if (!list) return;
    ensureListEntries(list);
    // Remove only the section header; symbols stay in place
    list.entries = list.entries.filter((e) => !(e.type === "sec" && e.id === sectionId));
    syncSymbolsFromEntries(list);
    try { renderTable(); } catch (_) {}
    try { await saveStateLocal(); } catch (_) {}
  }


  function entryKey(e) {
    if (!e) return "";
    if (e.type === "sec") return "sec:" + e.id;
    return "sym:" + e.s;
  }

  function findEntryIndexByKey(list, key) {
    ensureListEntries(list);
    for (let i = 0; i < list.entries.length; i++) {
      if (entryKey(list.entries[i]) === key) return i;
    }
    return -1;
  }

  /** Move entry fromKey to before/after toKey. Returns true if moved. */
  function moveEntryRelative(list, fromKey, toKey, place) {
    if (!list || !fromKey || !toKey || fromKey === toKey) return false;
    ensureListEntries(list);
    const fromIdx = findEntryIndexByKey(list, fromKey);
    if (fromIdx < 0) return false;
    const [item] = list.entries.splice(fromIdx, 1);
    let toIdx = findEntryIndexByKey(list, toKey);
    if (toIdx < 0) {
      // restore
      list.entries.splice(fromIdx, 0, item);
      return false;
    }
    if (place === "after") toIdx += 1;
    list.entries.splice(toIdx, 0, item);
    syncSymbolsFromEntries(list);
    return true;
  }

  function bindWatchlistDragDrop(tbody, list) {
    if (!tbody || !list) return;
    const rows = Array.from(tbody.querySelectorAll("tr.tvup-row, tr.tvup-section-row"));
    tbody.dataset.dndBound = "1";

    rows.forEach((tr) => {
      const isSec = tr.classList.contains("tvup-section-row");
      const key = isSec
        ? ("sec:" + (tr.dataset.sectionId || ""))
        : ("sym:" + String(tr.dataset.symbol || "").toUpperCase());
      if (!key || key === "sec:" || key === "sym:") return;
      tr.dataset.dragKey = key;
      if (tr.dataset.dndBound === "1") return;
      tr.dataset.dndBound = "1";

      tr.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("button, input, a, label, .tvup-delete, .tvup-alert-btn, .tvup-section-name-input, .tvup-section-toggle, .tvup-section-delete, [data-flag-symbol], .tvup-sel-wrap, .tvup-sel-cb, .tvup-col-resize, #tvup-resize-handle")) {
          return;
        }

        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;
        let dropPlace = "before";
        let dropKey = null;
        let lastOver = null;
        let raf = 0;
        let pendingEv = null;
        let autoScrollDir = 0; // -1 up, +1 down
        let autoScrollRaf = 0;
        const dragKey = key;

        const stopAutoScroll = () => {
          autoScrollDir = 0;
          if (autoScrollRaf) {
            try { cancelAnimationFrame(autoScrollRaf); } catch (_) {}
            autoScrollRaf = 0;
          }
        };

        const autoScrollTick = () => {
          autoScrollRaf = 0;
          if (!started || !autoScrollDir) return;
          try {
            const wrap = document.getElementById("tvup-table-wrap");
            if (wrap) {
              wrap.scrollTop += autoScrollDir * 14;
            }
          } catch (_) {}
          autoScrollRaf = requestAnimationFrame(autoScrollTick);
        };

        const paintDrop = (over, place) => {
          if (lastOver && lastOver !== over) {
            lastOver.classList.remove("tvup-drop-before", "tvup-drop-after");
          }
          if (over) {
            over.classList.toggle("tvup-drop-before", place === "before");
            over.classList.toggle("tvup-drop-after", place === "after");
          } else if (lastOver) {
            lastOver.classList.remove("tvup-drop-before", "tvup-drop-after");
          }
          lastOver = over || null;
        };

        const onMove = (ev) => {
          pendingEv = ev;
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            const e2 = pendingEv;
            if (!e2) return;
            const dx = e2.clientX - startX;
            const dy = e2.clientY - startY;
            if (!started) {
              if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
              started = true;
              tr.classList.add("tvup-dragging-row");
              tbody.classList.add("tvup-dnd-active");
              document.body.classList.add("tvup-row-dragging");
              try { tr.setPointerCapture(e.pointerId); } catch (_) {}
            }
            try { e2.preventDefault(); } catch (_) {}

            // Edge auto-scroll while dragging (both directions)
            try {
              const wrap = document.getElementById("tvup-table-wrap");
              if (wrap) {
                const wr = wrap.getBoundingClientRect();
                const EDGE = 48;
                let dir = 0;
                if (e2.clientY < wr.top + EDGE) dir = -1;
                else if (e2.clientY > wr.bottom - EDGE) dir = 1;
                if (dir !== autoScrollDir) {
                  autoScrollDir = dir;
                  if (autoScrollDir && !autoScrollRaf) {
                    autoScrollRaf = requestAnimationFrame(autoScrollTick);
                  }
                  if (!autoScrollDir && autoScrollRaf) {
                    try { cancelAnimationFrame(autoScrollRaf); } catch (_) {}
                    autoScrollRaf = 0;
                  }
                }
              }
            } catch (_) {}

            const el = document.elementFromPoint(e2.clientX, e2.clientY);
            const over = el && el.closest ? el.closest("#tvup-tbody tr.tvup-row, #tvup-tbody tr.tvup-section-row") : null;
            if (over && over !== tr && tbody.contains(over)) {
              const rect = over.getBoundingClientRect();
              dropPlace = e2.clientY < rect.top + rect.height * 0.5 ? "before" : "after";
              dropKey = over.dataset.dragKey || null;
              paintDrop(over, dropPlace);
            } else {
              dropKey = null;
              paintDrop(null, null);
            }
          });
        };

        const onUp = async () => {
          stopAutoScroll();
          if (raf) { try { cancelAnimationFrame(raf); } catch (_) {} raf = 0; }
          try { tr.releasePointerCapture(e.pointerId); } catch (_) {}
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onUp, true);
          document.body.classList.remove("tvup-row-dragging");
          tr.classList.remove("tvup-dragging-row");
          tbody.classList.remove("tvup-dnd-active");
          if (lastOver) lastOver.classList.remove("tvup-drop-before", "tvup-drop-after");
          if (started) window.__tvupJustDragged = Date.now();
          if (!started || !dropKey || dropKey === dragKey) return;
          if (state.sort && state.sort.direction !== 0) {
            state.sort = { column: null, direction: 0 };
          }
          const moved = moveEntryRelative(list, dragKey, dropKey, dropPlace);
          if (!moved) return;
          // Reorder DOM only — avoid full table rebuild (no logo blink)
          try {
            const fromTr = tbody.querySelector('tr[data-drag-key="' + CSS.escape(dragKey) + '"]') || tr;
            const toTr = tbody.querySelector('tr[data-drag-key="' + CSS.escape(dropKey) + '"]');
            if (fromTr && toTr && fromTr.parentNode === tbody && toTr.parentNode === tbody) {
              if (dropPlace === "before") {
                tbody.insertBefore(fromTr, toTr);
              } else {
                tbody.insertBefore(fromTr, toTr.nextSibling);
              }
            } else {
              renderTable();
            }
          } catch (_) {
            try { renderTable(); } catch (__) {}
          }
          try { saveStateLocal(); } catch (_) {}
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
      });
    });
  }


  let selectedSymbols = new Set(); // select-mode only (memory)
  let state = {
    watchlists: [],
    activeListId: "default",
    flags: {},
    fyersSeriesMap: {},
    alerts: {},
    sort: { column: null, direction: 0 },
    token: "",
    theme: "dark",
    recent: [],
    ui: {
      panelSide: "right",
      panelWidth: 300,
      columnOrder: ["symbol", "last", "chg", "chgPct"],
      columnWidths: { symbol: 140, last: 70, chg: 60, chgPct: 64 },
      tokenLocked: true,
      collapsed: false,
      fabX: null,
      fabY: null
    }
  };

  let liveData = {};
  let refreshTimer = null;
  let searchDebounce = null;
  let currentFlagSymbol = null;

  // Shared column-resize state (prevents multiple window listeners / drag glitches)
  const columnResize = {
    active: false,
    key: null,
    startX: 0,
    startWidth: 0,
    pointerId: null,
    bound: false,
    justResized: false
  };

  // Major NSE indices — searchable/addable like equities
  const NSE_INDICES = [
    // Broad market
    { trading_symbol: "NIFTY", name: "Nifty 50", short_name: "NIFTY 50", segment: "NSE_INDEX", tv_symbol: "NIFTY", exchange: "NSE", upstox: "NSE_INDEX|Nifty 50", aliases: ["NIFTY50"] },
    { trading_symbol: "BANKNIFTY", name: "Nifty Bank", short_name: "NIFTY BANK", segment: "NSE_INDEX", tv_symbol: "BANKNIFTY", exchange: "NSE", upstox: "NSE_INDEX|Nifty Bank", aliases: ["NIFTYBANK"] },
    { trading_symbol: "FINNIFTY", name: "Nifty Fin Service", short_name: "FINNIFTY", segment: "NSE_INDEX", tv_symbol: "CNXFINANCE", exchange: "NSE", upstox: "NSE_INDEX|Nifty Fin Service", aliases: ["CNXFINANCE", "NIFTYFIN"] },
    { trading_symbol: "MIDCPNIFTY", name: "Nifty Midcap Select", short_name: "MIDCAP SELECT", segment: "NSE_INDEX", tv_symbol: "NIFTY_MID_SELECT", exchange: "NSE", upstox: "NSE_INDEX|NIFTY MID SELECT", aliases: ["NIFTY_MID_SELECT", "NIFTYMIDSELECT", "MIDCPNIFTY"] },
    { trading_symbol: "NIFTYNXT50", name: "Nifty Next 50", short_name: "NEXT 50", segment: "NSE_INDEX", tv_symbol: "NIFTYJR", exchange: "NSE", upstox: "NSE_INDEX|Nifty Next 50", aliases: ["NIFTYNEXT50", "NIFTYJR", "NEXT50"] },
        { trading_symbol: "CNX100", name: "Nifty 100", short_name: "NIFTY 100", segment: "NSE_INDEX", tv_symbol: "CNX100", exchange: "NSE", upstox: "NSE_INDEX|Nifty 100", aliases: ["NIFTY100"] },
    { trading_symbol: "CNX200", name: "Nifty 200", short_name: "NIFTY 200", segment: "NSE_INDEX", tv_symbol: "CNX200", exchange: "NSE", upstox: "NSE_INDEX|Nifty 200", aliases: ["NIFTY200"] },
{ trading_symbol: "CNX500", name: "Nifty 500", short_name: "NIFTY 500", segment: "NSE_INDEX", tv_symbol: "CNX500", exchange: "NSE", upstox: "NSE_INDEX|Nifty 500", aliases: ["NIFTY500"] },
    { trading_symbol: "NIFTY_SMALLCAP_500", name: "Nifty Smallcap 500", short_name: "SMLCAP 500", segment: "NSE_INDEX", tv_symbol: "NIFTY_SMALLCAP_500", exchange: "NSE", upstox: "NSE_INDEX|Nifty Smallcap 500", aliases: ["NIFTYSMLCAP500", "SMALLCAP500", "SMLCAP500"] },
    { trading_symbol: "CNXMIDCAP", name: "Nifty Midcap 100", short_name: "MIDCAP 100", segment: "NSE_INDEX", tv_symbol: "CNXMIDCAP", exchange: "NSE", upstox: "NSE_INDEX|NIFTY MIDCAP 100", aliases: ["NIFTYMIDCAP100", "MIDCAP100", "NIFTY MIDCAP 100"] },
    { trading_symbol: "CNXSMALLCAP", name: "Nifty Smallcap 100", short_name: "SMLCAP 100", segment: "NSE_INDEX", tv_symbol: "CNXSMALLCAP", exchange: "NSE", upstox: "NSE_INDEX|NIFTY SMLCAP 100", aliases: ["NIFTYSMLCAP100", "SMALLCAP100", "SMLCAP100", "NIFTY SMLCAP 100"] },
    { trading_symbol: "NIFTYSMLCAP250", name: "Nifty Smallcap 250", short_name: "SMLCAP 250", segment: "NSE_INDEX", tv_symbol: "NIFTYSMLCAP250", exchange: "NSE", upstox: "NSE_INDEX|NIFTY SMLCAP 250", aliases: ["SMLCAP250", "SMALLCAP250", "NIFTY_SMLCAP_250", "NIFTY SMLCAP 250"] },
    { trading_symbol: "NIFTYSMLCAP50", name: "Nifty Smallcap 50", short_name: "SMLCAP 50", segment: "NSE_INDEX", tv_symbol: "NIFTYSMLCAP50", exchange: "NSE", upstox: "NSE_INDEX|NIFTY SMLCAP 50", aliases: ["SMLCAP50", "SMALLCAP50", "NIFTY_SMLCAP_50", "NIFTY SMLCAP 50"] },
    { trading_symbol: "NIFTYMIDSML400", name: "Nifty MidSmallcap 400", short_name: "MIDSML 400", segment: "NSE_INDEX", tv_symbol: "NIFTYMIDSML400", exchange: "NSE", upstox: "NSE_INDEX|NIFTY MIDSML 400", aliases: ["MIDSML400", "NIFTY_MIDSML_400", "NIFTY MIDSML 400"] },
    { trading_symbol: "INDIAVIX", name: "India VIX", short_name: "INDIA VIX", segment: "NSE_INDEX", tv_symbol: "INDIAVIX", exchange: "NSE", upstox: "NSE_INDEX|India VIX", aliases: ["VIX"] },
    // Sector indices (TradingView CNX* / NIFTY_* symbols)
    { trading_symbol: "CNXIT", name: "Nifty IT", short_name: "NIFTY IT", segment: "NSE_INDEX", tv_symbol: "CNXIT", exchange: "NSE", upstox: "NSE_INDEX|Nifty IT", aliases: ["NIFTYIT"] },
    { trading_symbol: "CNXAUTO", name: "Nifty Auto", short_name: "NIFTY AUTO", segment: "NSE_INDEX", tv_symbol: "CNXAUTO", exchange: "NSE", upstox: "NSE_INDEX|Nifty Auto", aliases: ["NIFTYAUTO"] },
    { trading_symbol: "CNXFMCG", name: "Nifty FMCG", short_name: "NIFTY FMCG", segment: "NSE_INDEX", tv_symbol: "CNXFMCG", exchange: "NSE", upstox: "NSE_INDEX|Nifty FMCG", aliases: ["NIFTYFMCG"] },
    { trading_symbol: "CNXPHARMA", name: "Nifty Pharma", short_name: "NIFTY PHARMA", segment: "NSE_INDEX", tv_symbol: "CNXPHARMA", exchange: "NSE", upstox: "NSE_INDEX|Nifty Pharma", aliases: ["NIFTYPHARMA"] },
    { trading_symbol: "CNXMETAL", name: "Nifty Metal", short_name: "NIFTY METAL", segment: "NSE_INDEX", tv_symbol: "CNXMETAL", exchange: "NSE", upstox: "NSE_INDEX|Nifty Metal", aliases: ["NIFTYMETAL"] },
    { trading_symbol: "CNXREALTY", name: "Nifty Realty", short_name: "NIFTY REALTY", segment: "NSE_INDEX", tv_symbol: "CNXREALTY", exchange: "NSE", upstox: "NSE_INDEX|Nifty Realty", aliases: ["NIFTYREALTY"] },
    { trading_symbol: "CNXENERGY", name: "Nifty Energy", short_name: "NIFTY ENERGY", segment: "NSE_INDEX", tv_symbol: "CNXENERGY", exchange: "NSE", upstox: "NSE_INDEX|Nifty Energy", aliases: ["NIFTYENERGY"] },
    { trading_symbol: "CNXINFRA", name: "Nifty Infra", short_name: "NIFTY INFRA", segment: "NSE_INDEX", tv_symbol: "CNXINFRA", exchange: "NSE", upstox: "NSE_INDEX|Nifty Infra", aliases: ["NIFTYINFRA"] },
    { trading_symbol: "CNXMEDIA", name: "Nifty Media", short_name: "NIFTY MEDIA", segment: "NSE_INDEX", tv_symbol: "CNXMEDIA", exchange: "NSE", upstox: "NSE_INDEX|Nifty Media", aliases: ["NIFTYMEDIA"] },
    { trading_symbol: "CNXPSE", name: "Nifty PSE", short_name: "NIFTY PSE", segment: "NSE_INDEX", tv_symbol: "CNXPSE", exchange: "NSE", upstox: "NSE_INDEX|Nifty PSE", aliases: ["NIFTYPSE"] },
    { trading_symbol: "CNXPSUBANK", name: "Nifty PSU Bank", short_name: "PSU BANK", segment: "NSE_INDEX", tv_symbol: "CNXPSUBANK", exchange: "NSE", upstox: "NSE_INDEX|Nifty PSU Bank", aliases: ["NIFTYPSUBANK"] },
    { trading_symbol: "NIFTYPVTBANK", name: "Nifty Private Bank", short_name: "PVT BANK", segment: "NSE_INDEX", tv_symbol: "NIFTYPVTBANK", exchange: "NSE", upstox: "NSE_INDEX|Nifty Pvt Bank", aliases: ["NIFTYPVTBNK"] },
    { trading_symbol: "NIFTY_CEMENT", name: "Nifty Cement", short_name: "NIFTY CEMENT", segment: "NSE_INDEX", tv_symbol: "NIFTY_CEMENT", exchange: "NSE", upstox: "NSE_INDEX|Nifty Cement", aliases: ["NIFTYCEMENT", "CNXCEMENT"] },
    { trading_symbol: "NIFTY_CHEMICALS", name: "Nifty Chemicals", short_name: "NIFTY CHEMICALS", segment: "NSE_INDEX", tv_symbol: "NIFTY_CHEMICALS", exchange: "NSE", upstox: "NSE_INDEX|Nifty Chemicals", aliases: ["NIFTYCHEMICALS", "CNXCHEMICAL"] },
    { trading_symbol: "CNXCONSUMPTION", name: "Nifty Consumption", short_name: "CONSUMPTION", segment: "NSE_INDEX", tv_symbol: "CNXCONSUMPTION", exchange: "NSE", upstox: "NSE_INDEX|Nifty Consumption", aliases: ["NIFTYCONSUMPTION", "CNXCONSUPTION"] },
    // BSE
    { trading_symbol: "SENSEX", name: "BSE Sensex", short_name: "SENSEX", segment: "BSE_INDEX", tv_symbol: "SENSEX", exchange: "BSE", upstox: "BSE_INDEX|SENSEX", aliases: [] },
    { trading_symbol: "BANKEX", name: "BSE Bankex", short_name: "BANKEX", segment: "BSE_INDEX", tv_symbol: "BANK", exchange: "BSE", upstox: "BSE_INDEX|BANKEX", aliases: ["BANK", "BANKEX"] }
  ];

  // Indices that must NOT appear in search / add (broken or unwanted)
  const BLOCKED_INDEX_SYMBOLS = new Set([
    "NIFTYAQL30", "NIFTY_AQL30", "NIFTYAQLV30", "NIFTY_AQLV30", "AQL30", "AQLV30", "NIFTYAQL",
    "NIFTYCAPITALMKT", "NIFTY_CAPITAL_MKT", "CAPITALMKT", "NIFTYCAPITALMARKET",
    "NIFTYCOREHOUSING", "NIFTY_CORE_HOUSING", "COREHOUSING", "NIFTYCOREHOUS", "COREHOUS",
    "NIFTYCONSRDURBL", "NIFTY_CONSR_DURBL", "CONSRDURBL", "NIFTYCONSRDURABLE",
    "NIFTYCOMMODITIES", "NIFTY_COMMODITIES", "COMMODITIES", "CNXCOMMODITIES"
  ].map((s) => s.replace(/\s+/g, "").toUpperCase()));

  function isBlockedIndex(symbol) {
    const s = String(symbol || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9_&-]/g, "");
    if (!s) return false;
    if (BLOCKED_INDEX_SYMBOLS.has(s)) return true;
    // Block exact junk names from master data search results
    const spaced = String(symbol || "").toUpperCase().replace(/\s+/g, " ").trim();
    if (/NIFTY\s*AQL/i.test(spaced)) return true;
    if (/NIFTY\s*CORE\s*HOUS/i.test(spaced)) return true;
    if (/NIFTY\s*CAPITAL\s*MKT/i.test(spaced)) return true;
    if (/NIFTY\s*CONSR/i.test(spaced)) return true;
    if (/NIFTY\s*COMMODIT/i.test(spaced)) return true;
    return false;
  }





  const logoUrlCache = Object.create(null);
  const logoFailedCache = Object.create(null);

  const $ = (selector, root = document) => root.querySelector(selector);

  function safePrevent(event) {
    try {
      if (event && event.cancelable) event.preventDefault();
      if (event && event.stopPropagation) event.stopPropagation();
    } catch (_) {}
  }

  const escapeHTML = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function uid() {
    return "wl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  function activeWatchlist() {
    return (
      state.watchlists.find((x) => x.id === state.activeListId) ||
      state.watchlists[0]
    );
  }

  async function safeStorageGet(keys) {
    try {
      if (!chrome.runtime?.id) return {};
      return await chrome.storage.local.get(keys);
    } catch {
      return {};
    }
  }

  async function safeStorageSet(data) {
    try {
      if (!chrome.runtime?.id) return;
      await chrome.storage.local.set(data);
    } catch {}
  }

  async function loadState() {
    const saved = await safeStorageGet([
      "tvup_watchlists",
      "tvup_activeListId",
      "tvup_flags",
      "tvup_alerts",
      "tvup_sort",
      "tvup_token",
      "tvup_theme",
      "tvup_recent",
      "tvup_ui",
      "tvup_fb_project",
      "tvup_fb_api_key",
      "tvup_fcm_token"
    ]);

    state.watchlists = Array.isArray(saved.tvup_watchlists)
      ? saved.tvup_watchlists
      : [structuredClone(DEFAULT_WATCHLIST)];

    if (!state.watchlists.length) {
      state.watchlists = [structuredClone(DEFAULT_WATCHLIST)];
    }
    try { state.watchlists.forEach((l) => ensureListEntries(l)); } catch (_) {}

    state.activeListId = saved.tvup_activeListId || state.watchlists[0].id;
    state.flags = saved.tvup_flags || {};
    state.alerts = migrateAlertsToMulti(
      (saved.tvup_alerts && typeof saved.tvup_alerts === "object") ? saved.tvup_alerts : {}
    );
    state.sort = saved.tvup_sort || { column: null, direction: 0 };
    state.token = saved.tvup_token || "";
    state.fyersAppId = "";
    state.fyersSeriesMap = {};
    state.fyersSecret = "";
    state.fyersRefresh = "";
    state.fyersPin = "";
    state.fyersTokenAt = 0;
    state.theme = saved.tvup_theme || "dark";
    state.recent = Array.isArray(saved.tvup_recent) ? saved.tvup_recent : [];
    // Permanent cloud defaults (no more service-worker console hack)
    state.fbProject = String(saved.tvup_fb_project || "tvup-watchlist-for-upstox").trim() || "tvup-watchlist-for-upstox";
    state.fbApiKey = String(saved.tvup_fb_api_key || "direct").trim() || "direct";
    state.fcmToken = saved.tvup_fcm_token || "";
    const savedUI = saved.tvup_ui && typeof saved.tvup_ui === "object" ? saved.tvup_ui : {};
    state.ui = {
      panelSide: savedUI.panelSide === "left" ? "left" : "right",
      panelWidth: Math.min(560, Math.max(280, Number(savedUI.panelWidth) || 300)),
      columnOrder: Array.isArray(savedUI.columnOrder)
        ? ["symbol", "last", "chg", "chgPct"].filter((x) => savedUI.columnOrder.includes(x))
          .concat(["symbol", "last", "chg", "chgPct"].filter((x) => !savedUI.columnOrder.includes(x)))
        : ["symbol", "last", "chg", "chgPct"],
      columnWidths: {
        symbol: Math.min(220, Math.max(48, Number(savedUI.columnWidths?.symbol) || 100)),
        last: Math.min(140, Math.max(44, Number(savedUI.columnWidths?.last) || 70)),
        chg: Math.min(120, Math.max(40, Number(savedUI.columnWidths?.chg) || 60)),
        chgPct: Math.min(130, Math.max(44, Number(savedUI.columnWidths?.chgPct) || 64))
      },
      tokenLocked: savedUI.tokenLocked !== false,
      collapsed: savedUI.collapsed === true,
      hideTvToolbar: false,
      // When true: ArrowUp/Down/Space control TVUP watchlist (even if panel hidden)
      keyboardNav: savedUI.keyboardNav !== false,
      // When true: typing a letter opens TVUP + search (not native TV search)
      quickAddSearch: savedUI.quickAddSearch === true,
      selectMode: savedUI.selectMode === true
    };

    state.ui.panelSide = "right";

    if (!state.watchlists.some((x) => x.id === state.activeListId)) {
      state.activeListId = state.watchlists[0].id;
    }

    reconcileFlags();
    await saveState();
  }

  let _cloudSyncTimer = null;
  let _alertsMsgTimer = null;

  /** Fast local-only save (sort / drag / UI). No network. */
  async function saveStateLocal() {
    await safeStorageSet({
      tvup_watchlists: state.watchlists,
      tvup_activeListId: state.activeListId,
      tvup_flags: state.flags,
      tvup_alerts: state.alerts,
      tvup_sort: state.sort,
      tvup_token: state.token,
      tvup_theme: state.theme,
      tvup_recent: state.recent,
      tvup_ui: state.ui,
      tvup_fb_project: String(state.fbProject || "tvup-watchlist-for-upstox").trim() || "tvup-watchlist-for-upstox",
      tvup_fb_api_key: String(state.fbApiKey || "direct").trim() || "direct",
      tvup_fcm_token: state.fcmToken || ""
    });
  }

  function scheduleCloudSync(delayMs) {
    try { if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer); } catch (_) {}
    _cloudSyncTimer = setTimeout(() => {
      _cloudSyncTimer = null;
      (async () => {
        try { await pullAlertsFromCloud(); } catch (_) {}
        try { syncAlertsToCloud(); } catch (_) {}
      })();
    }, delayMs == null ? 1200 : delayMs);
  }

  function scheduleAlertsChangedMsg() {
    try { if (_alertsMsgTimer) clearTimeout(_alertsMsgTimer); } catch (_) {}
    _alertsMsgTimer = setTimeout(() => {
      _alertsMsgTimer = null;
      try {
        chrome.runtime.sendMessage({ type: "TVUP_ALERTS_CHANGED" }, () => void chrome.runtime.lastError);
      } catch (_) {}
    }, 400);
  }

  /** Full save: local immediately, cloud debounced (does not block UI). */
  async function saveState(opts) {
    await saveStateLocal();
    const skipCloud = opts && opts.skipCloud;
    const alertsOnly = opts && opts.alertsChanged;
    if (alertsOnly) scheduleAlertsChangedMsg();
    if (!skipCloud) {
      // Defer network so sort/drag feel instant
      scheduleCloudSync(alertsOnly ? 600 : 1500);
    }
    if (alertsOnly || !skipCloud) {
      try {
        // light notify without waiting
        if (!alertsOnly) scheduleAlertsChangedMsg();
      } catch (_) {}
    }
  }

  function createUI() {
    if ($("#tvup-root")) return;

    const root = document.createElement("div");
    root.id = "tvup-root";

    root.innerHTML = `
      <div id="tvup-header">
        <button class="tvup-watchlist-button" id="tvup-list-button" title="Switch watchlist">
          <span id="tvup-list-avatar" class="tvup-list-avatar" aria-hidden="true">M</span>
          <span id="tvup-list-name">My Watchlist</span>
          <span class="tvup-chevron">▾</span>
        </button>
        <div class="tvup-header-actions">
          <button type="button" class="tvup-status-mini" id="tvup-status-mini" title="Live data status" aria-label="Live data status">
            <span class="tvup-status-dot" id="tvup-status-dot"></span>
          </button>
          <button class="tvup-square-button" id="tvup-add-btn" title="Add symbol" aria-label="Add symbol">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="tvup-square-button" id="tvup-lists" title="Manage watchlists" aria-label="Manage watchlists">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          </button>
          <button class="tvup-square-button" id="tvup-more" title="More options" aria-label="More">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          </button>
          <button class="tvup-square-button tvup-hide-btn" id="tvup-collapse-btn" title="Hide watchlist" aria-label="Hide watchlist">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <div id="tvup-star-bar" hidden></div>

      <div id="tvup-status" hidden aria-hidden="true">
        <span id="tvup-status-text">Waiting for Upstox API key</span>
      </div>

      <div id="tvup-select-bar" class="tvup-select-bar" hidden>
        <label class="tvup-sel-all-lab"><input type="checkbox" id="tvup-sel-all" /> Select all</label>
        <span id="tvup-sel-count" class="tvup-sel-count">Selected: 0</span>
        <button type="button" id="tvup-sel-to-tv" class="tvup-sel-to-tv" title="Add selected to TradingView native watchlist">Add to TV watchlist</button>
        <span id="tvup-transfer-msg" class="tvup-transfer-msg" hidden></span>
      </div>

      <div id="tvup-table-wrap">
        <table id="tvup-table">
          <colgroup id="tvup-colgroup"></colgroup>
          <thead><tr id="tvup-head-row"></tr></thead>
          <tbody id="tvup-tbody"></tbody>
        </table>
        <div id="tvup-empty">No stocks in this watchlist.</div>
      </div>
      <div id="tvup-resize-handle" title="Drag to resize watchlist"></div>

      <div id="tvup-footer">
        <span id="tvup-count">0 symbols</span>
        <button class="tvup-button" id="tvup-open-lists">Open list…</button>
      </div>
    `;

    document.documentElement.appendChild(root);

    const showBtn = document.createElement("button");
    showBtn.id = "tvup-show-panel";
    showBtn.type = "button";
    showBtn.title = "Show watchlist (drag to move)";
    showBtn.setAttribute("aria-label", "Show watchlist");
    showBtn.innerHTML = `<span class="tvup-fab-avatar" id="tvup-fab-avatar">W</span>`;
    showBtn.style.display = "none";
    document.documentElement.appendChild(showBtn);
    setupFabDrag(showBtn);

    const menu = document.createElement("div");
    menu.id = "tvup-menu";
    menu.className = "tvup-menu";
    menu.style.display = "none";
    document.documentElement.appendChild(menu);

    const flagPicker = document.createElement("div");
    flagPicker.id = "tvup-flag-picker";
    flagPicker.innerHTML = COLORS.filter((c) => c !== "none").map(
      (color) => `<span class="tvup-flag-option tvup-flag-${color}" data-flag="${color}"></span>`
    ).join("");
    document.documentElement.appendChild(flagPicker);

    const backdrop = document.createElement("div");
    backdrop.id = "tvup-modal-backdrop";
    backdrop.innerHTML = `
      <div id="tvup-modal">
        <div class="tvup-modal-header">
          <span>Manage watchlists</span>
          <button class="tvup-icon-button tvup-close-btn" id="tvup-modal-close">✕</button>
        </div>
        <div id="tvup-modal-list"></div>
        <div class="tvup-modal-footer">
          <button class="tvup-button tvup-button-primary" id="tvup-new-list">Create new list</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(backdrop);

    const confirm = document.createElement("div");
    confirm.id = "tvup-confirm-backdrop";
    confirm.innerHTML = `
      <div id="tvup-confirm">
        <div id="tvup-confirm-title">Confirm</div>
        <div id="tvup-confirm-message"></div>
        <div id="tvup-confirm-actions">
          <button class="tvup-button" id="tvup-confirm-cancel">Cancel</button>
          <button class="tvup-button tvup-button-primary" id="tvup-confirm-ok">Delete</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(confirm);

    const addPopup = document.createElement("div");
    addPopup.id = "tvup-add-popup";
    addPopup.innerHTML = `
      <div class="tvup-add-card">
        <div class="tvup-add-top">
          <div class="tvup-add-title">Add symbol</div>
          <button type="button" class="tvup-icon-button tvup-close-btn" id="tvup-add-close" title="Close">✕</button>
        </div>
        <div class="tvup-add-body">
          <div class="tvup-add-search-wrap">
            <span class="tvup-add-search-ico" aria-hidden="true">⌕</span>
            <input type="text" id="tvup-add-input" class="tvup-input" placeholder="Symbol or paste many: RELIANCE, TCS, INFY" autocomplete="off" />
          </div>
          <div class="tvup-add-cats" id="tvup-add-cats">
            <button type="button" class="tvup-add-cat active" data-cat="all">All</button>
            <button type="button" class="tvup-add-cat" data-cat="stocks">Stocks</button>
            <button type="button" class="tvup-add-cat" data-cat="indices">Indices</button>
            <button type="button" class="tvup-add-cat" data-cat="etf">ETF</button>
            <button type="button" class="tvup-add-cat" data-cat="commodities">Commodities</button>
          </div>
          <div id="tvup-suggestions"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(addPopup);
    window.__tvupAddCat = "all";

    applyTheme();
    bindEvents();
    render();
  }

  function openAddStockPopup() {
    const popup = $("#tvup-add-popup");
    if (!popup) return;
    popup.classList.toggle("tvup-light", state.theme === "light");
    popup.dataset.theme = state.theme === "light" ? "light" : "dark";
    popup.style.display = "flex";
    window.__tvupAddCat = "all";
    popup.querySelectorAll(".tvup-add-cat").forEach((b) => {
      b.classList.toggle("active", b.dataset.cat === "all");
    });
    const input = $("#tvup-add-input");
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
    renderRecentSuggestions();
  }

  function getRecentSymbols() {
    try {
      const raw = localStorage.getItem("tvup_recent_symbols");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 12) : [];
    } catch (_) {
      return [];
    }
  }

  function pushRecentSymbol(sym) {
    if (!sym) return;
    try {
      const s = String(sym).toUpperCase();
      let arr = getRecentSymbols().filter((x) => x !== s);
      arr.unshift(s);
      arr = arr.slice(0, 12);
      localStorage.setItem("tvup_recent_symbols", JSON.stringify(arr));
    } catch (_) {}
  }

  function classifyInstrument(item) {
    const seg = String(item?.segment || item?.instrument_key || "").toUpperCase();
    const name = String(item?.name || item?.short_name || "").toUpperCase();
    const sym = String(item?.trading_symbol || item?.tv_symbol || "").toUpperCase();
    if (seg.includes("INDEX") || /NIFTY|SENSEX|BANKNIFTY|INDIA VIX/.test(sym + name)) return "indices";
    if (/\bETF\b|BEES|IETF|GOLDSHARE|SILVERBEES/.test(sym + " " + name)) return "etf";
    if (/GOLD|SILVER|CRUDE|NATURALGAS|COPPER|ZINC|ALUMINIUM|COMMODITY/.test(sym + " " + name + " " + seg)) return "commodities";
    return "stocks";
  }

  async function renderRecentSuggestions() {
    const box = $("#tvup-suggestions");
    if (!box) return;
    const recent = getRecentSymbols();
    const cat = window.__tvupAddCat || "all";
    const items = [];
    const seen = new Set();
    for (const sym of recent) {
      if (seen.has(sym)) continue;
      seen.add(sym);
      const idx = NSE_INDICES.find((x) => String(x.tv_symbol || x.trading_symbol).toUpperCase() === sym);
      items.push(idx || { trading_symbol: sym, tv_symbol: sym, name: sym, short_name: sym, segment: "NSE_EQ" });
    }
    if (!items.length) {
      for (const x of NSE_INDICES.slice(0, 8)) {
        const sym = String(x.tv_symbol || x.trading_symbol).toUpperCase();
        if (seen.has(sym)) continue;
        seen.add(sym);
        items.push(x);
      }
    }
    const filtered = cat === "all" ? items : items.filter((it) => classifyInstrument(it) === cat);
    box.style.display = "block";
    if (!filtered.length) {
      box.innerHTML = `<div class="tvup-suggest-empty">Type to search symbols</div>`;
      return;
    }
    box.innerHTML = `<div class="tvup-suggest-section">RECENT</div>` + filtered.map((item) => suggestRowHTML(item)).join("");
    bindSuggestRowEvents(box);
  }

  function suggestRowHTML(item) {
    const sym = String(item.trading_symbol || "").toUpperCase();
    const tv = String(item.tv_symbol || sym).toUpperCase();
    const cat = classifyInstrument(item);
    const tag = cat === "indices" ? "index" : cat === "etf" ? "etf" : cat === "commodities" ? "cmdty" : "stock";
    const ex = String(item.exchange || (String(item.segment || "").startsWith("BSE") ? "BSE" : "NSE")).toUpperCase();
    const label = escapeHTML(item.short_name || item.name || ex);
    const key = escapeHTML(item.instrument_key || "");
    return `<div class="tvup-suggest-item">
      <button type="button" class="tvup-suggest-main" data-add-symbol="${escapeHTML(sym)}" data-key="${key}">
        ${logoHTML(tv)}
        <div class="tvup-suggest-text">
          <div class="tvup-suggest-top">
            <span class="tvup-suggest-sym">${escapeHTML(tv)}</span>
            <span class="tvup-suggest-meta">${escapeHTML(tag)} · ${escapeHTML(ex)}</span>
          </div>
          <span class="tvup-suggest-name">${label}</span>
        </div>
      </button>
      <button type="button" class="tvup-suggest-plus" data-add-plus="${escapeHTML(sym)}" data-key="${key}" title="Add to watchlist">+</button>
    </div>`;
  }

  function bindSuggestRowEvents(box, helpers) {
    const resolveSearchSymbol = helpers?.resolveSearchSymbol || ((rawIn, keyIn) => {
      const raw = String(rawIn || "").toUpperCase().replace(/^(NSE|BSE|INDEXBOM):/, "");
      return { sym: raw, idx: null, key: keyIn || "" };
    });
    const focusSearchInputSelect = helpers?.focusSearchInputSelect || (() => {
      const input = $("#tvup-add-input");
      if (input) { try { input.focus(); input.select(); } catch (_) {} }
    });
    const addSymbolFromSearch = helpers?.addSymbolFromSearch || (async (rawIn, keyIn, opts) => {
      const { sym } = resolveSearchSymbol(rawIn, keyIn);
      const list = activeWatchlist();
      if (!sym || !list) return null;
      const already = list.symbols.includes(sym);
      if (opts?.toggle && already) {
        removeSymbolFromList(list, sym);
        try { await saveStateLocal(); } catch (_) {}
        try { scheduleCloudSync(1500); } catch (_) {}
        try {
          const tr = document.querySelector('#tvup-tbody tr.tvup-row[data-symbol="' + CSS.escape(sym) + '"]');
          if (tr) tr.remove();
          else try { renderTable(); } catch (__) {}
        } catch (_) { try { renderTable(); } catch (__) {} }
        try { updateSymbolCount(); } catch (_) {}
        return { sym, action: "removed" };
      }
      if (!already) {
        addSymbolToList(list, sym);
        try { await saveStateLocal(); } catch (_) {}
        try { scheduleCloudSync(1500); } catch (_) {}
        try { appendSymbolToTable(sym); } catch (_) { try { renderTable(); } catch (__) {} }
        setTimeout(() => { try { refreshMarketData(); } catch (_) {} }, 180);
        pushRecentSymbol(sym);
        return { sym, action: "added" };
      }
      return { sym, action: "exists" };
    });

    box.querySelectorAll("[data-add-symbol]").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const { sym } = resolveSearchSymbol(btn.dataset.addSymbol, btn.dataset.key);
        if (!sym) return;
        pushRecentSymbol(sym);
        const input = $("#tvup-add-input");
        if (input) input.value = "";
        closeAddStockPopup();
        try { await openTradingViewSymbol(sym); }
        catch (err) { updateStatus(`Chart failed: ${sym}`, "error"); }
      });
    });

    const listNow = activeWatchlist();
    const inList = new Set((listNow?.symbols || []).map((s) => String(s).toUpperCase()));
    const markPlusBtn = (btn, done) => {
      if (!btn) return;
      if (done) {
        btn.textContent = "✓";
        btn.classList.add("tvup-suggest-plus-done");
        btn.title = "Remove from watchlist";
      } else {
        btn.textContent = "+";
        btn.classList.remove("tvup-suggest-plus-done");
        btn.title = "Add to watchlist";
      }
    };
    const refreshAllPlusMarks = () => {
      const listNow2 = activeWatchlist();
      const set2 = new Set((listNow2?.symbols || []).map((s) => String(s).toUpperCase()));
      box.querySelectorAll("[data-add-plus]").forEach((b) => {
        const raw2 = String(b.dataset.addPlus || "").toUpperCase();
        const resolved = resolveSearchSymbol(raw2, b.dataset.key);
        const s2 = String(resolved?.sym || raw2).toUpperCase();
        markPlusBtn(b, !!(s2 && set2.has(s2)));
      });
    };
    box.querySelectorAll("[data-add-plus]").forEach((btn) => {
      const raw = String(btn.dataset.addPlus || "").toUpperCase();
      const { sym } = resolveSearchSymbol(raw, btn.dataset.key);
      markPlusBtn(btn, !!(sym && inList.has(String(sym).toUpperCase())));
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        const result = await addSymbolFromSearch(btn.dataset.addPlus, btn.dataset.key, {
          closeSearch: false,
          toggle: true
        });
        // Always resync marks from live watchlist (handles normalize/render races)
        try { refreshAllPlusMarks(); } catch (_) {
          if (result && result.action === "removed") markPlusBtn(btn, false);
          else if (result) markPlusBtn(btn, true);
        }
        if (result && (result.action === "added" || result.action === "removed")) {
          try { updateSymbolCount(); } catch (_) {}
        }
        if (result && result.action === "added") {
          try { pushRecentSymbol(result.sym); } catch (_) {}
        }
        focusSearchInputSelect();
      });
    });
  }

  function closeAddStockPopup() {
    const popup = $("#tvup-add-popup");
    if (popup) popup.style.display = "none";
    const box = $("#tvup-suggestions");
    if (box) {
      box.innerHTML = "";
      box.style.display = "none";
    }
  }

  function bindEvents() {
    const searchInput = $("#tvup-add-input");
    const suggestionsBox = $("#tvup-suggestions");

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const q = e.target.value.trim().toUpperCase();
        clearTimeout(searchDebounce);
        window.__tvupSuggestIndex = -1;

        if (!q) {
          if (suggestionsBox) suggestionsBox.style.display = "none";
          return;
        }

        searchDebounce = setTimeout(() => {
          fetchSearchSuggestions(q);
        }, 300);
      });

      searchInput.addEventListener("keydown", async (e) => {
        const box = $("#tvup-suggestions");

        if (e.key === "Escape") {
          e.preventDefault();
          closeAddStockPopup();
          return;
        }

        // Bulk paste: RELIANCE, TCS, INFY  OR  one-per-line  → Enter adds all
        if (e.key === "Enter") {
          e.preventDefault();
          const rawVal = String(searchInput.value || "").trim();
          const bulk = parseBulkSymbols(rawVal);
          if (bulk.length > 1) {
            try {
              const result = await bulkAddSymbolsToWatchlist(bulk);
              searchInput.value = "";
              if (box) box.style.display = "none";
              window.__tvupSuggestIndex = -1;
              closeAddStockPopup();
              const msg = result.added
                ? `Added ${result.added} symbol${result.added === 1 ? "" : "s"}` +
                  (result.skipped ? ` · ${result.skipped} already in list` : "")
                : (result.skipped
                  ? `All ${result.skipped} already in list`
                  : "No valid symbols");
              updateStatus(msg, result.added ? "online" : "neutral");
            } catch (err) {
              console.error("[TVUP] bulk add failed:", err);
              updateStatus("Bulk add failed", "error");
            }
            return;
          }

          // Single symbol: use suggestion list if open
          if (!box || box.style.display === "none") {
            // No suggestions — if one valid token, add it directly
            if (bulk.length === 1) {
              try {
                const result = await bulkAddSymbolsToWatchlist(bulk);
                searchInput.value = "";
                closeAddStockPopup();
                updateStatus(
                  result.added ? `${bulk[0]} added` : `${bulk[0]} already in list`,
                  result.added ? "online" : "neutral"
                );
              } catch (_) {
                updateStatus("Add failed", "error");
              }
            }
            return;
          }
          const items = Array.from(box.querySelectorAll(".tvup-suggest-item"));
          if (!items.length) {
            if (bulk.length === 1) {
              try {
                const result = await bulkAddSymbolsToWatchlist(bulk);
                searchInput.value = "";
                box.style.display = "none";
                closeAddStockPopup();
                updateStatus(
                  result.added ? `${bulk[0]} added` : `${bulk[0]} already in list`,
                  result.added ? "online" : "neutral"
                );
              } catch (_) {}
            }
            return;
          }
          let idx = Number(window.__tvupSuggestIndex);
          if (!Number.isFinite(idx) || idx < 0) idx = 0;
          const row = items[idx];
          if (!row) return;
          const plus = row.querySelector("[data-add-plus]");
          if (plus) {
            plus.click();
            setTimeout(() => {
              const rows = Array.from(($('#tvup-suggestions') || box).querySelectorAll(".tvup-suggest-item"));
              rows.forEach((el, i) => el.classList.toggle("tvup-suggest-active", i === idx));
              window.__tvupSuggestIndex = idx;
            }, 50);
          }
          return;
        }

        if (!box || box.style.display === "none") return;
        const items = Array.from(box.querySelectorAll(".tvup-suggest-item"));
        if (!items.length) return;

        let idx = Number(window.__tvupSuggestIndex);
        if (!Number.isFinite(idx)) idx = -1;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          idx = Math.min(items.length - 1, idx + 1);
          window.__tvupSuggestIndex = idx;
          items.forEach((el, i) => el.classList.toggle("tvup-suggest-active", i === idx));
          items[idx]?.scrollIntoView({ block: "nearest" });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          idx = Math.max(0, idx - 1);
          window.__tvupSuggestIndex = idx;
          items.forEach((el, i) => el.classList.toggle("tvup-suggest-active", i === idx));
          items[idx]?.scrollIntoView({ block: "nearest" });
          return;
        }
      });
    }

    const addBtn = $("#tvup-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openAddStockPopup();
      });
    }
    const addClose = $("#tvup-add-close");
    if (addClose) {
      addClose.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAddStockPopup();
      });
    }
    const addPopup = $("#tvup-add-popup");
    if (addPopup) {
      addPopup.addEventListener("click", (e) => {
        if (e.target === addPopup) closeAddStockPopup();
      });
      addPopup.querySelectorAll(".tvup-add-cat").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          window.__tvupAddCat = btn.dataset.cat || "all";
          addPopup.querySelectorAll(".tvup-add-cat").forEach((b) => {
            b.classList.toggle("active", b === btn);
          });
          const input = $("#tvup-add-input");
          const q = (input?.value || "").trim().toUpperCase();
          if (q) fetchSearchSuggestions(q);
          else renderRecentSuggestions();
        });
      });
    }

    $("#tvup-list-button").addEventListener("click", (event) => {
      event.stopPropagation();
      showWatchlistMenu();
    });

    $("#tvup-open-lists").addEventListener("click", openManagementModal);
    $("#tvup-modal-close").addEventListener("click", closeManagementModal);
    $("#tvup-new-list").addEventListener("click", createNewWatchlist);

    $("#tvup-lists").addEventListener("click", (event) => {
      event.stopPropagation();
      openManagementModal();
    });

    $("#tvup-more").addEventListener("click", (event) => {
      event.stopPropagation();
      showActionMenu();
    });

    const setCollapsed = async (collapsed) => {
      state.ui.collapsed = !!collapsed;
      await saveState();
      applyLayout();
    };

    const collapseBtn = $("#tvup-collapse-btn");
    if (collapseBtn) {
      const hidePanel = (event) => {
        safePrevent(event);
        setCollapsed(true);
      };
      collapseBtn.addEventListener("click", hidePanel, true);
      collapseBtn.addEventListener("pointerup", hidePanel, { capture: true });
    }

    const showBtn = $("#tvup-show-panel");
    if (showBtn) {
      const showPanel = (event) => {
        safePrevent(event);
        if (showBtn.dataset.skipClick === "1") return;
        setCollapsed(false);
      };
      showBtn.addEventListener("click", showPanel, true);
      showBtn.addEventListener("touchend", showPanel, { passive: false, capture: true });
    }

    $("#tvup-table").addEventListener("click", (event) => {
      const th = event.target.closest("th[data-sort]");
      if (!th) return;
      if (event.target.closest(".tvup-col-resize")) return;
      if (columnResize.justResized || columnResize.active) return;
      changeSort(th.dataset.sort);
    });

    setupPanelResize();

    document.addEventListener("click", (event) => {
      const menu = $("#tvup-menu");
      const listButton = $("#tvup-list-button");
      const moreButton = $("#tvup-more");

      if (searchInput && suggestionsBox &&
          !searchInput.contains(event.target) && !suggestionsBox.contains(event.target) &&
          !(event.target.closest && event.target.closest("#tvup-add-popup .tvup-add-card"))) {
        suggestionsBox.style.display = "none";
      }

      if (
        menu.style.display !== "none" &&
        !menu.contains(event.target) &&
        !listButton.contains(event.target) &&
        !moreButton.contains(event.target)
      ) {
        menu.style.display = "none";
      }

      const picker = $("#tvup-flag-picker");
      if (picker.style.display !== "none" && !picker.contains(event.target)) {
        picker.style.display = "none";
      }
    });

    $("#tvup-flag-picker").addEventListener("click", async (event) => {
      const option = event.target.closest(".tvup-flag-option");
      if (!option || !currentFlagSymbol) return;

      const flag = option.dataset.flag;
      const oldFlag = state.flags[currentFlagSymbol] || "none";

      if (flag === oldFlag) {
        delete state.flags[currentFlagSymbol];
        if (oldFlag && oldFlag !== "none") removeFromColorWatchlist(oldFlag, currentFlagSymbol);
        patchFlagDom(currentFlagSymbol, "none");
      } else {
        state.flags[currentFlagSymbol] = flag;
        syncColorWatchlist(flag, currentFlagSymbol);
        if (oldFlag && oldFlag !== "none" && oldFlag !== flag) {
          removeFromColorWatchlist(oldFlag, currentFlagSymbol);
        }
        patchFlagDom(currentFlagSymbol, flag);
      }

      try { $("#tvup-flag-picker").style.display = "none"; } catch (_) {}
      try { await saveStateLocal(); } catch (_) {}
      try { scheduleCloudSync(1500); } catch (_) {}
      try { renderStarBar(); } catch (_) {}
    });

    $("#tvup-confirm-cancel").addEventListener("click", closeConfirm);

    $("#tvup-confirm-ok").addEventListener("click", async () => {
      const okBtn = $("#tvup-confirm-ok");
      const action = okBtn?.dataset?.action || "";
      const id = okBtn?.dataset?.deleteId;

      if (action === "alert_delete_all") {
        state.alerts = {};
        await saveState();
        const bd = document.getElementById("tvup-alert-backdrop");
        if (bd) renderAlertList(bd);
        renderTable();
        updateStatus("All alerts deleted", "neutral");
        closeConfirm();
        return;
      }

      if (id) {
        try {
          const gone = state.watchlists.find((x) => x.id === id);
          if (tvupIsColorList(gone)) {
            for (const k of Object.keys(state.flags)) { if (state.flags[k] === gone.color) delete state.flags[k]; }
          }
        } catch (_) {}
        state.watchlists = state.watchlists.filter((x) => x.id !== id);

        if (!state.watchlists.length) {
          state.watchlists.push(structuredClone(DEFAULT_WATCHLIST));
        }

        if (!state.watchlists.some((x) => x.id === state.activeListId)) {
          state.activeListId = state.watchlists[0].id;
        }

        render();
        try {
          // refresh the open "Manage watchlists" popup instantly (keep scroll + search text)
          const listBox = $("#tvup-modal-list");
          const prevTop = listBox ? listBox.scrollTop : 0;
          const prevQ = ($("#tvup-mgmt-search") || {}).value || "";
          renderManagementModal();
          const sInput = $("#tvup-mgmt-search");
          if (sInput && prevQ) {
            sInput.value = prevQ;
            sInput.dispatchEvent(new Event("input"));
          }
          if (listBox) listBox.scrollTop = prevTop;
          renderStarBar();
        } catch (_) {}
        closeConfirm();
        await saveState();
      }
    });
  }

  function syncColorWatchlist(color, symbol) {
    let list = state.watchlists.find((x) => x.color === color);

    if (!list) {
      list = {
        id: "color_" + color,
        name: color,
        starred: false,
        symbols: [],
        entries: [],
        color: color
      };
      state.watchlists.push(list);
    }

    if (!list.symbols.includes(symbol)) {
      addSymbolToList(list, symbol);
    }
  }

  function removeFromColorWatchlist(color, symbol) {
    const list = state.watchlists.find((x) => x.color === color);
    if (list) {
      removeSymbolFromList(list, symbol);
    }
  }

  /** Update only the flag button DOM for one symbol — no full table rebuild */
  function patchFlagDom(sym, flag) {
    const s = String(sym || "").toUpperCase();
    const f = flag && flag !== "none" ? String(flag) : "none";
    if (!s) return;
    try {
      document.querySelectorAll('[data-flag-symbol="' + CSS.escape(s) + '"]').forEach((el) => {
        el.className = "tvup-flag tvup-flag-" + f;
      });
    } catch (_) {}
    // Viewing a coloured list and this stock is no longer that colour -> row leaves the list instantly
    try {
      const cur = activeWatchlist();
      if (tvupIsColorList(cur) && f !== cur.color) {
        const rows = document.querySelectorAll('#tvup-tbody tr.tvup-row[data-symbol="' + CSS.escape(s) + '"]');
        if (rows.length) {
          rows.forEach((r) => { try { r.remove(); } catch (_) {} });
          try { updateSymbolCount(); } catch (_) {}
        }
      }
    } catch (_) {}
  }


  async function fetchSearchSuggestions(query) {
    const box = $("#tvup-suggestions");
    const q = String(query || "").trim().toUpperCase();
    if (!q) { box.style.display = "none"; return; }
    box.innerHTML = `<div class="tvup-suggest-item" style="color:var(--tv-muted)">Searching…</div>`;
    box.style.display = "block";

    const renderMatches = async (matches) => {
      const unique = [];
      const seen = new Set();
      const JUNK = /(ENH|ESG|LIQ|EW$|LMS|QUALITY|MOMENTUM|VALUE|GROWTH|EQUAL|MULTIFACTOR|ALPHA|LOWVOL|DIVIDEND|ETF|BEES|IETF)/i;
      for (const item of (Array.isArray(matches) ? matches : [])) {
        const sym = String(item?.trading_symbol || "").toUpperCase();
        const tv = String(item?.tv_symbol || sym).toUpperCase();
        const name = String(item?.name || item?.short_name || "").toUpperCase();
        const key = tv || sym;
        if (!key || seen.has(key)) continue;
        if (JUNK.test(sym) || JUNK.test(tv) || JUNK.test(name)) continue;
        if (/-INDEX$/i.test(sym) || /-INDEX$/i.test(tv)) continue;
        if (typeof isBlockedIndex === "function" && (isBlockedIndex(sym) || isBlockedIndex(tv) || isBlockedIndex(key))) continue;
        seen.add(key);
        unique.push(item);
      }
      if (!unique.length) {
        box.innerHTML = `<div class="tvup-suggest-item" style="color:var(--tv-muted)">No stock or index found</div>`;
        box.style.display = "block";
        return;
      }
      const resolveSearchSymbol = (rawIn, keyIn) => {
        const raw = String(rawIn || "").toUpperCase();
        const key = keyIn || "";
        let bareRaw = raw.replace(/^(NSE|BSE|INDEXBOM):/, "");
        const EQUITY_ALIASES = {
          "BAJAJ-AUTO": "BAJAJ_AUTO",
          "BAJAJAUTO": "BAJAJ_AUTO",
          "BAJAJ_AUTO": "BAJAJ_AUTO",
          "M&M": "M&M",
          "M_M": "M&M",
          "MM": "M&M",
          "L&TFH": "L&TFH",
          "LT": "LT"
        };
        if (EQUITY_ALIASES[bareRaw]) bareRaw = EQUITY_ALIASES[bareRaw];
        const idx = NSE_INDICES.find((x) => {
          const a = String(x.trading_symbol).toUpperCase();
          const b = String(x.tv_symbol || "").toUpperCase();
          const aliases = (x.aliases || []).map((z) => String(z).toUpperCase().replace(/^(NSE|BSE|INDEXBOM):/, ""));
          return a === bareRaw || b === bareRaw || aliases.includes(bareRaw) || a === raw || b === raw;
        });
        const sym = String((idx && idx.tv_symbol) || bareRaw).toUpperCase().replace(/^(NSE|BSE|INDEXBOM):/, "");
        return { sym, idx, key };
      };

      const focusSearchInputSelect = () => {
        const input = $("#tvup-add-input");
        if (!input) return;
        try {
          input.focus();
          if (typeof input.select === "function") input.select();
          else if (typeof input.setSelectionRange === "function") {
            input.setSelectionRange(0, String(input.value || "").length);
          }
        } catch (_) {}
      };

      const addSymbolFromSearch = async (rawIn, keyIn, { closeSearch, toggle }) => {
        const { sym, idx, key } = resolveSearchSymbol(rawIn, keyIn);
        const list = activeWatchlist();
        if (!sym || !list) return null;

        const already = list.symbols.includes(sym);
        let action = "added";

        if (toggle && already) {
          removeSymbolFromList(list, sym);
          action = "removed";
        } else if (!already) {
          addSymbolToList(list, sym);
          const ikey = (idx && idx.instrument_key) || key || "";
          // Fire-and-forget key/meta storage — don't block UI
          if (ikey) { try { safeStorageSet({ ["tvup_key_" + sym]: ikey }); } catch (_) {} }
          if (idx) {
            liveData[sym] = liveData[sym] || {};
            liveData[sym].short_name = idx.short_name || idx.name;
            try { safeStorageSet({ ["tvup_ex_" + sym]: String(idx.exchange || "NSE").toUpperCase() }); } catch (_) {}
          }
          action = "added";
        } else {
          action = "exists";
        }

        // Fast local save only — cloud deferred (no hang on +/✓)
        try { await saveStateLocal(); } catch (_) {}
        try { scheduleCloudSync(1500); } catch (_) {}

        if (closeSearch) {
          try { forceChartRelayout(); } catch (_) {}
          try { render(); } catch (_) {}
          const input = $("#tvup-add-input");
          if (input) input.value = "";
          try { box.style.display = "none"; } catch (_) {}
          try { closeAddStockPopup(); } catch (_) {}
          if (action !== "removed") {
            setTimeout(() => { try { refreshMarketData(); } catch (_) {} }, 120);
          }
        } else {
          // Stay in search: light table update, defer quotes
          try {
            if (action === "removed") {
              const tr = document.querySelector('#tvup-tbody tr.tvup-row[data-symbol="' + CSS.escape(sym) + '"]');
              if (tr) tr.remove();
              else try { renderTable(); } catch (_) {}
              try { updateSymbolCount(); } catch (_) {}
            } else if (action === "added") {
              try { appendSymbolToTable(sym); } catch (_) { try { renderTable(); } catch (__) {} }
            }
          } catch (_) {
            try { renderTable(); } catch (__) {}
          }
          try { focusSearchInputSelect(); } catch (_) {}
          if (action === "added") {
            setTimeout(() => { try { refreshMarketData(); } catch (_) {} }, 180);
          }
        }

        if (action === "added") {
          pushRecentSymbol(sym);
          updateStatus(sym + " added", "online");
        } else if (action === "removed") updateStatus(sym + " removed", "neutral");
        else updateStatus(sym + " already in list", "online");

        return { sym, action };
      };

      const cat = window.__tvupAddCat || "all";
      const filtered = (cat === "all" ? unique : unique.filter((it) => classifyInstrument(it) === cat)).slice(0, 40);
      if (!filtered.length) {
        box.innerHTML = `<div class="tvup-suggest-empty">No results in this category</div>`;
        box.style.display = "block";
        return;
      }
      box.innerHTML = filtered.map((item) => suggestRowHTML(item)).join("");
      bindSuggestRowEvents(box, { resolveSearchSymbol, addSymbolFromSearch, focusSearchInputSelect });
    };

    try {
      const LIST_ALL = new Set(["INDEX", "INDICES", "CNX", "NIFTY", "BSE"]);
      const rawHits = NSE_INDICES.filter((item) => {
        const sym = item.trading_symbol.toUpperCase();
        const tv = String(item.tv_symbol || "").toUpperCase();
        const name = item.name.toUpperCase();
        const short = (item.short_name || "").toUpperCase();
        const aliases = (Array.isArray(item.aliases) ? item.aliases : []).map((a) => String(a).toUpperCase());
        if (LIST_ALL.has(q)) return true;
        if (sym.startsWith(q) || tv.startsWith(q)) return true;
        if (sym.includes(q) || tv.includes(q)) return true;
        if (name.includes(q) || short.includes(q)) return true;
        if (aliases.some((a) => a === q || a.startsWith(q) || a.includes(q))) return true;
        return false;
      });
      const indexHits = [];
      const idxSeen = new Set();
      for (const item of rawHits) {
        const k = String(item.tv_symbol || item.trading_symbol).toUpperCase();
        if (idxSeen.has(k)) continue;
        idxSeen.add(k);
        indexHits.push(item);
      }

      // Local company-name hits from logo pack (instant, offline-friendly)
      const localCompanyHits = [];
      try {
        const cmap = (_logoPack && _logoPack.company) ? _logoPack.company : null;
        if (cmap && q.length >= 2) {
          const scored = [];
          for (const [t, name] of Object.entries(cmap)) {
            const tu = String(t).toUpperCase();
            const nu = String(name || "").toUpperCase();
            if (!tu || !nu) continue;
            let score = 0;
            if (tu === q) score = 100;
            else if (tu.startsWith(q)) score = 90;
            else if (nu.startsWith(q)) score = 80;
            else if (tu.includes(q)) score = 70;
            else if (nu.includes(q)) score = 60;
            else continue;
            scored.push({ score, t: tu, name });
          }
          scored.sort((a, b) => b.score - a.score || a.t.localeCompare(b.t));
          for (const s of scored.slice(0, 15)) {
            localCompanyHits.push({
              trading_symbol: s.t,
              tv_symbol: s.t,
              name: s.name,
              short_name: s.name,
              segment: "NSE_EQ",
              exchange: "NSE"
            });
          }
        }
      } catch (_) {}

      let result = { ok: false, reason: "skipped" };
      if (isExtensionContextValid()) {
        result = await new Promise((resolve) => {
          let done = false;
          const finish = (value) => { if (!done) { done = true; resolve(value); } };
          try {
            chrome.runtime.sendMessage({
              type: "TVUP_SEARCH_PUBLIC_INSTRUMENTS",
              requestId: `public_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              query: q
            }, (response) => {
              if (chrome.runtime.lastError) {
                return finish({ ok: false, reason: chrome.runtime.lastError.message || "runtime-error" });
              }
              finish(response || { ok: false, reason: "No response from extension worker" });
            });
          } catch (e) {
            finish({ ok: false, reason: e?.message || "runtime-unavailable" });
          }
          setTimeout(() => finish({ ok: false, reason: "search-timeout" }), 12000);
        });
      } else {
        result = { ok: false, reason: "context-expired" };
      }

      if (result?.ok) {
        const merged = [];
        const seen = new Set();
        const equities = Array.isArray(result.data) ? result.data : [];
        const wantIndexFirst = LIST_ALL.has(q) || /INDEX|NIFTY|CNX|SENSEX|BANKNIFTY|BANKEX/i.test(q);
        const ordered = wantIndexFirst
          ? indexHits.concat(localCompanyHits).concat(equities)
          : localCompanyHits.concat(equities).concat(indexHits);
        for (const item of ordered) {
          const tv = String(item.tv_symbol || item.trading_symbol || "").toUpperCase();
          const sym = String(item.trading_symbol || "").toUpperCase();
          const dedupeKey = tv || sym;
          if (!dedupeKey || seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          merged.push(item);
        }
        await renderMatches(merged.slice(0, 40));
        return;
      }

      if (indexHits.length || localCompanyHits.length) {
        await renderMatches(indexHits.concat(localCompanyHits));
        return;
      }

      if (/^[A-Z0-9_&-]{1,20}$/.test(q)) {
        await renderMatches([{
          trading_symbol: q,
          tv_symbol: q,
          name: q,
          short_name: q,
          segment: "NSE_EQ",
          exchange: "NSE"
        }]);
        return;
      }

      const soft = (result?.reason || "").toLowerCase();
      const msg = soft.includes("context") || soft.includes("extension")
        ? "Reload this TradingView tab once (extension was updated)"
        : (result?.reason || "No results");
      box.innerHTML = `<div class="tvup-suggest-item" style="color:var(--tv-muted)">${escapeHTML(msg)}</div>`;
      box.style.display = "block";
    } catch (error) {
      const msg = String(error?.message || error || "Search failed");
      if (/^[A-Z0-9_&-]{1,20}$/.test(q)) {
        try {
          await renderMatches([{
            trading_symbol: q,
            tv_symbol: q,
            name: q,
            short_name: q,
            segment: "NSE_EQ",
            exchange: "NSE"
          }]);
          return;
        } catch (_) {}
      }
      box.innerHTML = `<div class="tvup-suggest-item" style="color:var(--tv-muted)">${escapeHTML(msg)}</div>`;
      box.style.display = "block";
    }
  }

  /** Append one symbol row at bottom without rebuilding the whole table (no logo blink) */
  function appendSymbolToTable(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return false;
    const tbody = $("#tvup-tbody");
    if (!tbody) return false;
    try {
      if (tbody.querySelector('tr.tvup-row[data-symbol="' + CSS.escape(sym) + '"]')) return true;
    } catch (_) {
      if (tbody.querySelector('tr.tvup-row[data-symbol="' + sym + '"]')) return true;
    }
    const empty = $("#tvup-empty");
    if (empty) empty.style.display = "none";

    const data = liveData[sym] || {};
    const flag = state.flags[sym] || "none";
    const cols = (state.ui && state.ui.columnOrder) ? state.ui.columnOrder : ["symbol", "last", "chg", "chgPct"];
    const tr = document.createElement("tr");
    tr.className = "tvup-row";
    tr.dataset.symbol = sym;
    tr.dataset.dragKey = "sym:" + sym;
    // dndBound intentionally NOT set — bindWatchlistDragDrop will attach drag once
    tr.innerHTML = cols.map((key) => rowCellHTML(key, sym, data, flag)).join("") +
      '<button type="button" class="tvup-delete" data-delete-symbol="' + escapeHTML(sym) + '" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h8m-7 0v11m6-11v11M9 7l1-2h4l1 2m-9 0h12m-2 0-.6 14H8.6L8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';

    tr.addEventListener("click", (event) => {
      if (event.target.closest(".tvup-delete, [data-flag-symbol], .tvup-alert-btn, .tvup-sel-wrap, .tvup-sel-cb")) return;
      try {
        if (window.__tvupJustDragged && (Date.now() - window.__tvupJustDragged) < 400) return;
      } catch (_) {}
      event.stopPropagation();
      event.preventDefault();
      try { setActiveWatchlistRow(sym, { scroll: false }); } catch (_) {
        try { window.__tvupLastNavSym = sym; } catch (__) {}
      }
      try { openTradingViewSymbol(sym); } catch (_) {}
    });

    const delBtn = tr.querySelector(".tvup-delete");
    if (delBtn) {
      delBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const current = activeWatchlist();
        if (current) removeSymbolFromList(current, sym);
        try { await saveStateLocal(); } catch (_) {}
        try { scheduleCloudSync(1500); } catch (_) {}
        try { tr.remove(); } catch (_) {}
        try { updateSymbolCount(); } catch (_) {}
      });
    }
    const alertBtn = tr.querySelector(".tvup-alert-btn");
    if (alertBtn) {
      alertBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        try { openAlertModal(sym); } catch (_) {}
      });
    }
    const flagEl = tr.querySelector("[data-flag-symbol]");
    if (flagEl) {
      flagEl.addEventListener("pointerdown", (event) => { event.stopPropagation(); });
      flagEl.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        currentFlagSymbol = sym;
        const cur = state.flags[sym] || "none";
        if (cur && cur !== "none") {
          delete state.flags[sym];
          try { removeFromColorWatchlist(cur, sym); } catch (_) {}
          try { patchFlagDom(sym, "none"); } catch (_) {}
          try { await saveStateLocal(); } catch (_) {}
          try { scheduleCloudSync(1500); } catch (_) {}
          try { renderStarBar(); } catch (_) {}
          return;
        }
        const rect = flagEl.getBoundingClientRect();
        const picker = $("#tvup-flag-picker");
        if (!picker) return;
        picker.querySelectorAll(".tvup-flag-option").forEach((opt) => {
          opt.classList.remove("tvup-flag-option-active");
        });
        picker.style.display = "flex";
        const pw = picker.offsetWidth || 160;
        const ph = picker.offsetHeight || 40;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        picker.style.left = left + "px";
        picker.style.top = top + "px";
      });
    }

    tbody.appendChild(tr);
    try { bindLogoHandlers(tr); } catch (_) {}
    try { bindRowSelectCheckbox(tr); } catch (_) {}
    // Bind drag only for unbound rows (existing rows skip via data-dnd-bound)
    try {
      const list = activeWatchlist();
      if (list) bindWatchlistDragDrop(tbody, list);
    } catch (_) {}
    try { updateSymbolCount(); } catch (_) {}
    return true;
  }




  function isSelectMode() {
    return !!(state.ui && state.ui.selectMode);
  }

  function updateSelCount() {
    try {
      const el = document.getElementById("tvup-sel-count");
      if (el) el.textContent = "Selected: " + selectedSymbols.size;
      const all = document.getElementById("tvup-sel-all");
      if (all) {
        const rows = document.querySelectorAll("#tvup-tbody tr.tvup-row[data-symbol]");
        const n = rows.length;
        all.checked = n > 0 && selectedSymbols.size >= n;
        all.indeterminate = selectedSymbols.size > 0 && selectedSymbols.size < n;
      }
    } catch (_) {}
  }

  function renderSelectBar() {
    try {
      const bar = document.getElementById("tvup-select-bar");
      if (!bar) return;
      bar.hidden = !isSelectMode();
      if (!isSelectMode()) selectedSymbols.clear();
      updateSelCount();
    } catch (_) {}
  }

  
  function bindRowSelectCheckbox(tr) {
    if (!tr) return;
    const cb = tr.querySelector(".tvup-sel-cb");
    if (!cb || cb.dataset.selBound === "1") return;
    cb.dataset.selBound = "1";
    const stop = (e) => {
      try { e.stopPropagation(); } catch (_) {}
      try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (_) {}
    };
    cb.addEventListener("pointerdown", stop, true);
    cb.addEventListener("mousedown", stop, true);
    cb.addEventListener("click", (e) => { stop(e); }, true);
    cb.addEventListener("change", (e) => {
      stop(e);
      if (!(state.ui && state.ui.selectMode)) return;
      const s = String(cb.getAttribute("data-sel-symbol") || tr.dataset.symbol || "").toUpperCase();
      if (!s) return;
      if (cb.checked) selectedSymbols.add(s);
      else selectedSymbols.delete(s);
      try { updateSelCount(); } catch (_) {}
    }, true);
    const s0 = String(cb.getAttribute("data-sel-symbol") || tr.dataset.symbol || "").toUpperCase();
    if (s0) cb.checked = selectedSymbols.has(s0);
  }

  function bindSelectModeOnce() {
    if (window.__tvupSelectBound) return;
    window.__tvupSelectBound = true;
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (!t || !isSelectMode()) return;
      if (t.id === "tvup-sel-all") {
        const rows = document.querySelectorAll("#tvup-tbody tr.tvup-row[data-symbol]");
        if (t.checked) {
          rows.forEach((tr) => {
            const s = String(tr.dataset.symbol || "").toUpperCase();
            if (s) selectedSymbols.add(s);
            const cb = tr.querySelector(".tvup-sel-cb");
            if (cb) cb.checked = true;
          });
        } else {
          selectedSymbols.clear();
          rows.forEach((tr) => {
            const cb = tr.querySelector(".tvup-sel-cb");
            if (cb) cb.checked = false;
          });
        }
        updateSelCount();
        return;
      }
      if (t.classList && t.classList.contains("tvup-sel-cb")) {
        const s = String(t.getAttribute("data-sel-symbol") || "").toUpperCase();
        if (!s) return;
        if (t.checked) selectedSymbols.add(s);
        else selectedSymbols.delete(s);
        updateSelCount();
      }
    }, true);

    document.addEventListener("click", async (e) => {
      const btn = e.target && e.target.closest && e.target.closest("#tvup-sel-to-tv");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (!isSelectMode()) return;
      let list = [...selectedSymbols];
      if (!list.length) {
        try { updateStatus("Select at least one stock", "neutral"); } catch (_) {}
        return;
      }
      if (list.length > 30) {
        try { updateStatus("TV free limit 30 — pehle 30 hi add honge", "neutral"); } catch (_) {}
        list = list.slice(0, 30);
      }
      btn.disabled = true;
      const prev = btn.textContent;
      const msgEl = document.getElementById("tvup-transfer-msg");
      const showMsg = (text, ok) => {
        try {
          if (msgEl) {
            msgEl.hidden = false;
            msgEl.textContent = text;
            msgEl.style.color = ok ? "#26a69a" : "#ef5350";
            msgEl.style.fontWeight = "600";
            msgEl.style.fontSize = "12px";
            msgEl.style.marginLeft = "8px";
          }
        } catch (_) {}
      };
      try {
        if (msgEl) { msgEl.hidden = true; msgEl.textContent = ""; }
        btn.textContent = "Adding…";
        const listCopy = list.slice();
        const res = await addSymbolsToNativeWatchlist(listCopy, (done, total) => {
          const d = done || 0, t = total || listCopy.length;
          btn.textContent = "Adding " + d + "/" + t + "…";
        });
        const okN = Number(res && res.okCount != null ? res.okCount : 0) || 0;
        const failN = Number(res && res.failCount != null ? res.failCount : 0) || 0;
        const over = Number(res && res.skippedOverLimit ? res.skippedOverLimit : 0) || 0;
        try { updateSelCount(); } catch (_) {}
        let msg = "✓ " + okN + " stocks added";
        if (failN) msg += ", " + failN + " failed";
        if (over) msg += ", " + over + " skipped (max 30)";
        const full = msg + ". Extension list unchanged.";
        if (okN && !failN) updateStatus(full, "online");
        else if (okN) updateStatus(full, "neutral");
        else updateStatus((res && res.message) || full, "error");
        showMsg(msg, okN > 0);
        btn.textContent = okN ? ("✓ " + okN + " added") : "Add failed";
        // Force-dismiss leftover native Add-symbol dialog (must not need manual Escape)
        try {
          for (let i = 0; i < 10; i++) {
            const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
            document.dispatchEvent(new KeyboardEvent("keydown", opts));
            document.dispatchEvent(new KeyboardEvent("keyup", opts));
            window.dispatchEvent(new KeyboardEvent("keydown", opts));
            await new Promise((r) => setTimeout(r, 70));
          }
        } catch (_) {}
        // Keep message visible 3 seconds
        await new Promise((r) => setTimeout(r, 3000));
      } catch (_) {
        try { updateStatus("TV transfer failed", "error"); } catch (__) {}
        showMsg("Transfer failed", false);
        btn.textContent = "Add failed";
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        btn.disabled = false;
        btn.textContent = prev || "Add to TV watchlist";
      }
    }, true);
  }


  async function addSymbolsToNativeWatchlist(symbols, onProgress) {
    const TV_FREE_MAX = 30;
    let list = (symbols || []).map((s) => String(s || "").toUpperCase().trim()).filter(Boolean);
    const skippedOverLimit = Math.max(0, list.length - TV_FREE_MAX);
    if (list.length > TV_FREE_MAX) list = list.slice(0, TV_FREE_MAX);
    if (!list.length) return { okCount: 0, failCount: 0, message: "empty", skippedOverLimit };

    // Snapshot extension list — NEVER allow transfer path to shrink it
    let snap = [];
    try {
      const wl = activeWatchlist();
      snap = (wl && Array.isArray(wl.symbols)) ? wl.symbols.map((s) => String(s).toUpperCase()) : [];
    } catch (_) {}

    const restoreIfNeeded = () => {
      try {
        const wl = activeWatchlist();
        if (!wl || !snap.length) return;
        const now = (wl.symbols || []).map((s) => String(s).toUpperCase());
        const missing = snap.filter((s) => !now.includes(s));
        if (!missing.length) return;
        // Restore any symbols that were accidentally removed
        for (const s of missing) {
          try { addSymbolToList(wl, s); } catch (_) {}
        }
        try { saveStateLocal(); } catch (_) {}
        try { renderTable(); } catch (_) {}
        try { updateSymbolCount(); } catch (_) {}
      } catch (_) {}
    };

    try {
      if (!chrome?.runtime?.id) {
        restoreIfNeeded();
        return { okCount: 0, failCount: list.length, skippedOverLimit, message: "no-extension-runtime" };
      }
      const result = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "TVUP_ADD_TO_WATCHLIST", symbols: list },
            (res) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(res || null);
            }
          );
        } catch (_) {
          resolve(null);
        }
      });
      restoreIfNeeded();
      if (result) {
        result.skippedOverLimit = result.skippedOverLimit || skippedOverLimit;
        if (typeof onProgress === "function") onProgress(result.okCount || 0, list.length);
        return result;
      }
    } catch (_) {
      restoreIfNeeded();
    }

    // No content-script DOM fallback — that was hitting TVUP search and removing stocks
    try {
      await navigator.clipboard.writeText(list.join(","));
      return {
        okCount: 0,
        failCount: list.length,
        skippedOverLimit,
        message: "TV transfer failed — symbols copied to clipboard. Extension list unchanged."
      };
    } catch (_) {}
    return { okCount: 0, failCount: list.length, skippedOverLimit, message: "TV transfer failed" };
  }



  function updateSymbolCount() {
    try {
      const el = $("#tvup-count");
      if (!el) return;
      const list = activeWatchlist();
      const n = (list && Array.isArray(list.symbols)) ? list.symbols.length : 0;
      el.textContent = n + " symbol" + (n === 1 ? "" : "s");
    } catch (_) {}
  }

  function render() {
    applyLayout();
    renderStarBar();
    const list = activeWatchlist();
    const avatar = $("#tvup-list-avatar");
    if (avatar) {
      avatar.textContent = listInitial(list.name || "W");
      avatar.className = "tvup-list-avatar" + (list.color && list.color !== "none" ? ` tvup-avatar-${list.color}` : "");
    }
    $("#tvup-list-name").textContent = list.name || "Watchlist";
    updateSymbolCount();
    try { bindSelectModeOnce(); } catch (_) {}
    try { renderSelectBar(); } catch (_) {}
    renderTable();
    try { updateSelCount(); } catch (_) {}
    updateStatus();
  }

  function renderTableHeader() {
    const head = $("#tvup-head-row");
    const colgroup = $("#tvup-colgroup");
    if (!head || !colgroup) return;

    const order = state.ui.columnOrder;
    const labels = { symbol: "Symbol", last: "Last", chg: "Chg", chgPct: "Chg%" };
    head.innerHTML = `
      ${order.map((key) => `<th data-sort="${key}" data-column="${key}">${labels[key] || key}<span class="tvup-col-resize" data-resize-column="${key}" title="Drag to resize"></span></th>`).join("")}
    `;

    colgroup.innerHTML = `
      ${order.map((key) => `<col data-column-width="${key}" style="width:${state.ui.columnWidths[key]}px">`).join("")}
    `;

    head.querySelectorAll("th[data-column]").forEach((th) => {
      th.setAttribute("draggable", "false");
    });

    if (!columnResize.bound) {
      columnResize.bound = true;

      const onMove = (event) => {
        if (!columnResize.active || !columnResize.key) return;
        if (columnResize.pointerId != null && event.pointerId !== columnResize.pointerId) return;
        const x = Number(event.clientX);
        if (!Number.isFinite(x)) return;
        const delta = x - columnResize.startX;
        const key = columnResize.key;
        const mins = { symbol: 48, last: 44, chg: 40, chgPct: 44 };
        const maxs = { symbol: 220, last: 140, chg: 120, chgPct: 130 };
        const min = mins[key] ?? 44;
        const max = maxs[key] ?? 140;
        state.ui.columnWidths[key] = Math.round(Math.min(max, Math.max(min, columnResize.startWidth + delta)));
        const col = document.querySelector(`#tvup-colgroup col[data-column-width="${key}"]`);
        if (col) col.style.width = `${state.ui.columnWidths[key]}px`;
        try { event.preventDefault(); } catch (_) {}
      };

      const onUp = async (event) => {
        if (!columnResize.active) return;
        if (columnResize.pointerId != null && event?.pointerId != null && event.pointerId !== columnResize.pointerId) return;
        columnResize.active = false;
        columnResize.key = null;
        columnResize.pointerId = null;
        columnResize.justResized = true;
        setTimeout(() => { columnResize.justResized = false; }, 120);
        document.body.classList.remove("tvup-resizing-column");
        document.querySelectorAll(".tvup-col-resize.tvup-column-dragging").forEach((h) => {
          h.classList.remove("tvup-column-dragging");
        });
        try { if (event?.pointerId != null) (event.target || document).releasePointerCapture?.(event.pointerId); } catch (_) {}
        await saveState();
      };

      window.addEventListener("pointermove", onMove, { capture: true, passive: false });
      window.addEventListener("pointerup", onUp, { capture: true });
      window.addEventListener("pointercancel", onUp, { capture: true });
    }

    head.querySelectorAll(".tvup-col-resize").forEach((handle) => {
      if (handle.dataset.resizeBound === "1") return;
      handle.dataset.resizeBound = "1";
      const key = handle.dataset.resizeColumn;
      if (!key || !Object.prototype.hasOwnProperty.call(state.ui.columnWidths, key)) return;

      handle.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        columnResize.active = true;
        columnResize.key = key;
        columnResize.pointerId = event.pointerId;
        columnResize.startX = Number(event.clientX);
        columnResize.startWidth = Number(state.ui.columnWidths[key]);
        document.body.classList.add("tvup-resizing-column");
        handle.classList.add("tvup-column-dragging");
        try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
      }, { passive: false });
    });
  }

  function bindLogoHandlers(root = document) {
    root.querySelectorAll("img.tvup-logo-img").forEach((img) => {
      if (img.dataset.tvupBound === "1") return;
      img.dataset.tvupBound = "1";
      const wrap = img.closest("[data-logo-symbol]");
      const symbol = String(wrap?.dataset.logoSymbol || "").toUpperCase();
      let attempt = Number(img.dataset.attempt || 0);
      img.addEventListener("load", () => {
        if (symbol) logoUrlCache[symbol] = img.currentSrc || img.src;
        img.classList.add("tvup-logo-ok");
        if (wrap) wrap.classList.add("tvup-logo-loaded");
      });
      img.addEventListener("error", () => {
        attempt += 1;
        img.dataset.attempt = String(attempt);
        const sources = logoSources(symbol);
        if (attempt < sources.length) {
          img.src = sources[attempt];
          return;
        }
        if (symbol) logoFailedCache[symbol] = true;
        img.remove();
      });
    });
  }

  function updateLiveCells() {
    const tbody = $("#tvup-tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll("tr.tvup-row");
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      const symbol = tr.dataset.symbol;
      if (!symbol) continue;
      const data = liveData[symbol] || liveData[String(symbol).toUpperCase()];
      if (!data) continue;

      const lastEl = tr.querySelector(".tvup-last-cell");
      const chgEl = tr.querySelector(".tvup-chg-cell");
      const pctEl = tr.querySelector(".tvup-chgpct-cell");

      const chgN = Number(data.chg);
      let dir = "tvup-neutral";
      if (chgN > 0) dir = "tvup-positive";
      else if (chgN < 0) dir = "tvup-negative";

      if (lastEl) {
        const next = formatPrice(data.last);
        if (lastEl.textContent !== next) lastEl.textContent = next;
        if (!lastEl.classList.contains(dir)) {
          lastEl.classList.remove("tvup-positive", "tvup-negative", "tvup-neutral");
          lastEl.classList.add(dir);
        }
      }
      if (chgEl) {
        const next = formatSigned(data.chg);
        if (chgEl.textContent !== next) chgEl.textContent = next;
        if (!chgEl.classList.contains(dir)) {
          chgEl.classList.remove("tvup-positive", "tvup-negative", "tvup-neutral");
          chgEl.classList.add(dir);
        }
      }
      if (pctEl) {
        const next = formatPercent(data.chgPct);
        if (pctEl.textContent !== next) pctEl.textContent = next;
        if (!pctEl.classList.contains(dir)) {
          pctEl.classList.remove("tvup-positive", "tvup-negative", "tvup-neutral");
          pctEl.classList.add(dir);
        }
      }
    }
  }


  function listInitial(name) {
    const s = String(name || "W").trim();
    const ch = s.charAt(0).toUpperCase();
    return /[A-Z0-9]/.test(ch) ? ch : "W";
  }

  // Logo pack data (from indian-listed-company-logos) — optional, loaded via logo-data.js
  const _logoPack = (typeof window !== "undefined" && window.__TVUP_LOGO_DATA__) ? window.__TVUP_LOGO_DATA__ : null;
  const _logoNseSet = (function () {
    try {
      if (!_logoPack || !Array.isArray(_logoPack.nse)) return null;
      return new Set(_logoPack.nse.map((t) => String(t).toUpperCase()));
    } catch (_) { return null; }
  })();
  const _logoBseOnlySet = (function () {
    try {
      if (!_logoPack || !Array.isArray(_logoPack.bseOnly)) return null;
      return new Set(_logoPack.bseOnly.map((t) => String(t).toUpperCase()));
    } catch (_) { return null; }
  })();
  const LOGO_CDN = (_logoPack && _logoPack.base)
    ? String(_logoPack.base).replace(/\/$/, "")
    : "https://dharunashokkumar.github.io/indian-listed-company-logos";

  function companyNameFor(symbol) {
    try {
      const sym = String(symbol || "").toUpperCase();
      if (_logoPack && _logoPack.company && _logoPack.company[sym]) return _logoPack.company[sym];
    } catch (_) {}
    return "";
  }

  function isIndexSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9_&-]/g, "");
    if (!sym) return false;
    if (NSE_INDICES.some((x) =>
      String(x.tv_symbol || "").toUpperCase() === sym ||
      String(x.trading_symbol || "").toUpperCase() === sym ||
      (x.aliases || []).some((a) => String(a).toUpperCase() === sym)
    )) return true;
    return /^(NIFTY|SENSEX|BANKNIFTY|BANKEX|CNX|INDIAVIX|VIX)/i.test(sym);
  }

  function indexDisplayName(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const idx = NSE_INDICES.find((x) =>
      String(x.tv_symbol || "").toUpperCase() === sym ||
      String(x.trading_symbol || "").toUpperCase() === sym ||
      (x.aliases || []).some((a) => String(a).toUpperCase() === sym)
    );
    return idx ? (idx.name || idx.short_name || sym) : (companyNameFor(sym) || "");
  }

  function logoSources(symbol) {
    const raw = String(symbol || "").toUpperCase();
    const sym = raw.replace(/[^A-Z0-9_&-]/g, "");
    if (!sym) return [];
    if (logoUrlCache[sym]) return [logoUrlCache[sym]];
    if (logoFailedCache[sym]) return [];

    if (isIndexSymbol(sym)) {
      // Only official TradingView index logos — NO country/Indian-flag fallback
      const TVL = "https://s3-symbol-logo.tradingview.com";
      const map = {
        NIFTY: `${TVL}/indices/nifty-50.svg`,
        NIFTY50: `${TVL}/indices/nifty-50.svg`,
        BANKNIFTY: `${TVL}/indices/nifty-bank.svg`,
        SENSEX: `${TVL}/indices/bse-sensex.svg`,
        INDIAVIX: `${TVL}/indices/india-vix.svg`,
        BANKEX: `${TVL}/indices/bse-bankex.svg`,
        BANK: `${TVL}/indices/bse-bankex.svg`,
        CNX100: `${TVL}/indices/nifty-100.svg`,
        NIFTY100: `${TVL}/indices/nifty-100.svg`,
        CNX200: `${TVL}/indices/nifty-200.svg`,
        NIFTY200: `${TVL}/indices/nifty-200.svg`,
        CNX500: `${TVL}/indices/nifty-500.svg`,
        NIFTY500: `${TVL}/indices/nifty-500.svg`,
        CNXIT: `${TVL}/indices/nifty-it.svg`,
        CNXAUTO: `${TVL}/indices/nifty-auto.svg`,
        CNXFMCG: `${TVL}/indices/nifty-fmcg.svg`,
        CNXPHARMA: `${TVL}/indices/nifty-pharma.svg`,
        CNXMETAL: `${TVL}/indices/nifty-metal.svg`,
        CNXREALTY: `${TVL}/indices/nifty-realty.svg`,
        CNXENERGY: `${TVL}/indices/nifty-energy.svg`,
        CNXINFRA: `${TVL}/indices/nifty-infra.svg`,
        CNXMEDIA: `${TVL}/indices/nifty-media.svg`,
        CNXPSE: `${TVL}/indices/nifty-pse.svg`,
        CNXPSUBANK: `${TVL}/indices/nifty-psu-bank.svg`,
        NIFTYPVTBANK: `${TVL}/indices/nifty-private-bank.svg`,
        FINNIFTY: `${TVL}/indices/nifty-financial.svg`,
        CNXFINANCE: `${TVL}/indices/nifty-financial.svg`,
        NIFTYNXT50: `${TVL}/indices/nifty-next-50.svg`,
        NIFTYJR: `${TVL}/indices/nifty-next-50.svg`,
        MIDCPNIFTY: `${TVL}/indices/nifty-midcap-select.svg`,
        NIFTY_MID_SELECT: `${TVL}/indices/nifty-midcap-select.svg`,
        CNXMIDCAP: `${TVL}/indices/nifty-midcap-100.svg`,
        CNXSMALLCAP: `${TVL}/indices/nifty-smallcap-100.svg`,
        NIFTYSMLCAP250: `${TVL}/indices/nifty-smallcap-250.svg`,
        NIFTYSMLCAP50: `${TVL}/indices/nifty-smallcap-50.svg`,
        NIFTYMIDSML400: `${TVL}/indices/nifty-midsmallcap-400.svg`,
        NIFTY_SMALLCAP_500: `${TVL}/indices/nifty-smallcap-500.svg`,
        NIFTY_CEMENT: `${TVL}/indices/nifty-cement.svg`,
        NIFTY_CHEMICALS: `${TVL}/indices/nifty-chemicals.svg`,
        CNXCONSUMPTION: `${TVL}/indices/nifty-consumption.svg`
      };
      if (map[sym]) return [map[sym]];
      return []; // no official logo → show nothing (no Indian flag)
    }

    const sources = [];
    const hasNse = !_logoNseSet || _logoNseSet.has(sym);
    const hasBseOnly = _logoBseOnlySet && _logoBseOnlySet.has(sym);

    if (hasNse) {
      sources.push(`${LOGO_CDN}/nse/NSE_${encodeURIComponent(sym)}.svg`);
      if (sym.includes("_")) sources.push(`${LOGO_CDN}/nse/NSE_${encodeURIComponent(sym.replace(/_/g, ""))}.svg`);
      if (sym.includes("-")) sources.push(`${LOGO_CDN}/nse/NSE_${encodeURIComponent(sym.replace(/-/g, ""))}.svg`);
    }
    if (hasBseOnly || !_logoNseSet) {
      sources.push(`${LOGO_CDN}/bse/BSE_${encodeURIComponent(sym)}.svg`);
    } else if (hasNse) {
      sources.push(`${LOGO_CDN}/bse/BSE_${encodeURIComponent(sym)}.svg`);
    }
    return sources;
  }

  function logoHTML(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const letter = listInitial(sym);
    const srcs = logoSources(sym);
    const src = srcs[0] || "";
    const idxCls = isIndexSymbol(sym) ? " tvup-logo-index" : "";
    // No native title — we use delayed custom tooltip
    return `<span class="tvup-logo-wrap${idxCls}" data-logo-symbol="${escapeHTML(sym)}">
      <span class="tvup-logo-fallback" aria-hidden="true">${escapeHTML(letter)}</span>
      ${src ? `<img class="tvup-logo-img" src="${escapeHTML(src)}" alt="" loading="lazy" decoding="async" draggable="false" />` : ""}
    </span>`;
  }

  // FIX 1: Show ⏱ ONLY IF ALERT IS ACTIVE (Remove if triggered, paused or deleted)
  function rowCellHTML(key, symbol, data, flag) {
    if (key === "symbol") {
      const safeSymbol = escapeHTML(symbol);
      const shortName = escapeHTML(data?.short_name || companyNameFor(symbol) || "");
      const flagHtml = `<button type="button" class="tvup-flag tvup-flag-${escapeHTML(flag || "none")}" data-flag-symbol="${escapeHTML(symbol)}" title="Change flag" aria-label="Change flag"></button>`;
      const _symU = String(symbol || "").toUpperCase();
      const alertRules = getAlertsForSymbol(_symU);
      const activeRules = alertRules.filter((r) => isAlertActivelyArmed(r));
      const hasActiveAlert = activeRules.length > 0;
      const hasAnyAlert = alertRules.length > 0;
      const alertTitle = hasAnyAlert
        ? (hasActiveAlert
          ? `${activeRules.length} active alert(s) · click to add another`
          : `${alertRules.length} alert(s) · click to add another`)
        : "Set price alert";
      
      const alertMark = hasActiveAlert
        ? `<span class="tvup-alert-mark" title="${escapeHTML(alertTitle)}" aria-label="Alert active">⏱</span>`
        : "";
      const alertBtn = `<button type="button" class="tvup-alert-btn${hasActiveAlert ? " tvup-alert-active" : ""}${hasAnyAlert && !hasActiveAlert ? " tvup-alert-inactive" : ""}" data-alert-symbol="${safeSymbol}" title="${escapeHTML(alertTitle)}" aria-label="Price alert"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22zm6-6.2V11a6 6 0 1 0-12 0v4.8L4 17.6V19h16v-1.4l-2-1.8z" fill="currentColor"/></svg></button>`;
      const selOn = !!(state.ui && state.ui.selectMode);
      const isSel = selOn && selectedSymbols.has(_symU);
      const checkHtml = selOn
        ? `<label class="tvup-sel-wrap" title="Select for TV transfer"><input type="checkbox" class="tvup-sel-cb" data-sel-symbol="${safeSymbol}" ${isSel ? "checked" : ""} /></label>`
        : "";
      return `<td class="tvup-symbol-cell" data-column="symbol"><div class="tvup-sym-main">${checkHtml}${flagHtml}${logoHTML(symbol)}<div class="tvup-sym-text"><span class="tvup-symbol-name">${safeSymbol}${alertMark}</span></div>${alertBtn}</div></td>`;
    }
    if (key === "last") {
        const n = Number(data?.chg);
        const cls = n > 0 ? "tvup-positive" : n < 0 ? "tvup-negative" : "tvup-neutral";
        return `<td class="tvup-last-cell ${cls}" data-column="last">${escapeHTML(formatPrice(data?.last))}</td>`;
      }
    if (key === "chg") {
      const n = Number(data?.chg);
      const cls = n > 0 ? "tvup-positive" : n < 0 ? "tvup-negative" : "tvup-neutral";
      return `<td class="tvup-chg-cell ${cls}" data-column="chg">${escapeHTML(formatSigned(data?.chg))}</td>`;
    }
    if (key === "chgPct") {
      const n = Number(data?.chgPct);
      const cls = n > 0 ? "tvup-positive" : n < 0 ? "tvup-negative" : "tvup-neutral";
      return `<td class="tvup-chgpct-cell ${cls}" data-column="chgPct">${escapeHTML(formatPercent(data?.chgPct))}</td>`;
    }
    return `<td data-column="${escapeHTML(key)}"></td>`;
  }


  // ===== Delayed hover tooltip (TradingView-style, ~2s) =====
  const nameTip = {
    el: null,
    timer: null,
    hideTimer: null,
    activeSym: null,
    shown: false
  };

  function ensureNameTip() {
    if (nameTip.el && document.body.contains(nameTip.el)) return nameTip.el;
    const el = document.createElement("div");
    el.id = "tvup-name-tip";
    el.setAttribute("role", "tooltip");
    el.style.display = "none";
    document.body.appendChild(el);
    nameTip.el = el;
    return el;
  }

  function tipTextFor(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const full = indexDisplayName(sym) || companyNameFor(sym) || "";
    if (!full) return null;
    const ex = isIndexSymbol(sym)
      ? ((NSE_INDICES.find((x) => String(x.tv_symbol || x.trading_symbol).toUpperCase() === sym || (x.aliases || []).some((a) => String(a).toUpperCase() === sym)) || {}).exchange || "NSE")
      : "NSE";
    return { title: full, meta: ex + " · Real-time" };
  }

  function positionNameTip(anchor) {
    const el = ensureNameTip();
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const tw = el.offsetWidth || 220;
    const th = el.offsetHeight || 48;
    let left = r.left - tw - 12;
    let top = r.top + (r.height - th) / 2;
    if (left < 8) left = r.right + 12;
    if (top < 8) top = 8;
    if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function showNameTip(symbol, anchor) {
    const info = tipTextFor(symbol);
    if (!info) return;
    const el = ensureNameTip();
    el.innerHTML = `<div class="tvup-tip-title">${escapeHTML(info.title)}</div><div class="tvup-tip-meta">${escapeHTML(info.meta)}</div>`;
    el.style.display = "block";
    nameTip.shown = true;
    nameTip.activeSym = symbol;
    positionNameTip(anchor);
  }

  function hideNameTip() {
    if (nameTip.timer) { clearTimeout(nameTip.timer); nameTip.timer = null; }
    if (nameTip.hideTimer) { clearTimeout(nameTip.hideTimer); nameTip.hideTimer = null; }
    nameTip.shown = false;
    nameTip.activeSym = null;
    if (nameTip.el) nameTip.el.style.display = "none";
  }

  function bindRowNameTooltips(tbody) {
    if (!tbody) return;
    // Hide tip when pointer leaves the whole table body
    if (!tbody._tvupTipBound) {
      tbody._tvupTipBound = true;
      tbody.addEventListener("pointerleave", (e) => {
        // only if leaving tbody entirely (not moving between rows)
        const related = e.relatedTarget;
        if (related && tbody.contains(related)) return;
        hideNameTip();
      });
      tbody.addEventListener("scroll", () => hideNameTip(), { passive: true });
    }
    tbody.querySelectorAll("tr.tvup-row").forEach((tr) => {
      if (tr._tvupTipBound) return;
      tr._tvupTipBound = true;
      const sym = String(tr.dataset.symbol || "").toUpperCase();
      if (!sym) return;
      tr.addEventListener("pointerenter", () => {
        if (nameTip.hideTimer) { clearTimeout(nameTip.hideTimer); nameTip.hideTimer = null; }
        if (nameTip.timer) clearTimeout(nameTip.timer);
        // If already showing a tip (user is moving down the list), switch after short delay
        const delay = nameTip.shown ? 280 : 2000;
        nameTip.timer = setTimeout(() => {
          nameTip.timer = null;
          // only show if pointer still over this row
          if (tr.matches(":hover") || document.elementFromPoint == null) {
            showNameTip(sym, tr);
          } else {
            // fallback: still show if active hover target is this tr
            try {
              const el = document.elementFromPoint && null;
            } catch (_) {}
            showNameTip(sym, tr);
          }
        }, delay);
      });
      tr.addEventListener("pointerleave", () => {
        if (nameTip.timer) { clearTimeout(nameTip.timer); nameTip.timer = null; }
        // slight delay so moving to next row feels continuous
        nameTip.hideTimer = setTimeout(() => {
          if (nameTip.activeSym === sym) hideNameTip();
        }, 80);
      });
    });
  }

  // Global safety: hide sticky tip when clicking elsewhere or pressing Escape
  if (!window._tvupNameTipGlobal) {
    window._tvupNameTipGlobal = true;
    document.addEventListener("pointerdown", (e) => {
      if (!nameTip.shown) return;
      const t = e.target;
      if (t && (t.closest && (t.closest("tr.tvup-row") || t.closest("#tvup-name-tip")))) return;
      hideNameTip();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideNameTip();
    }, true);
  }


  function newAlertId() {
    return "a_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  /** Migrate old { SYMBOL: rule } → { id: { id, symbol, ... } } */
  function migrateAlertsToMulti(alerts) {
    if (!alerts || typeof alerts !== "object" || Array.isArray(alerts)) return {};
    const out = {};
    for (const [k, rule] of Object.entries(alerts)) {
      if (!rule || typeof rule !== "object") continue;
      const hasSym = !!rule.symbol;
      const keyIsId = hasSym && rule.id && String(k) === String(rule.id);
      if (keyIsId) {
        out[rule.id] = rule;
        continue;
      }
      // Old single-per-symbol format (key was the ticker)
      const id = rule.id || newAlertId();
      const symbol = String(rule.symbol || k || "").toUpperCase();
      if (!symbol) continue;
      out[id] = Object.assign({}, rule, { id, symbol });
    }
    return out;
  }

  function getAlertById(id) {
    if (!id || !state.alerts) return null;
    return state.alerts[id] || null;
  }

  function getAlertsForSymbol(symbol) {
    const s = String(symbol || "").toUpperCase();
    if (!state.alerts) return [];
    return Object.values(state.alerts).filter(
      (r) => r && String(r.symbol || "").toUpperCase() === s
    );
  }

  /** @deprecated use getAlertsForSymbol — returns first match for compatibility */
  function getAlertForSymbol(symbol) {
    const list = getAlertsForSymbol(symbol);
    return list.length ? list[0] : null;
  }

  function alertSymbolOf(rule, fallbackKey) {
    if (rule && rule.symbol) return String(rule.symbol).toUpperCase();
    return String(fallbackKey || "").toUpperCase();
  }

  function formatAlertPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function normalizeAlertCondition(c) {
    const v = String(c || "").toLowerCase();
    if (v === "below" || v === "crossing_down" || v === "down") return "crossing_down";
    if (v === "above" || v === "crossing_up" || v === "up") return "crossing_up";
    return "crossing";
  }

  function conditionLabel(c) {
    const n = normalizeAlertCondition(c);
    if (n === "crossing_up") return "Crossing Up";
    if (n === "crossing_down") return "Crossing Down";
    return "Crossing";
  }

  function conditionIcon(c) {
    const n = normalizeAlertCondition(c);
    if (n === "crossing_up") return "↗";
    if (n === "crossing_down") return "↘";
    return "✕";
  }

  function setConditionUI(backdrop, condition) {
    if (!backdrop) return;
    const c = normalizeAlertCondition(condition);
    backdrop.dataset.condition = c;
    const ico = backdrop.querySelector("#tvup-pa-cond-ico");
    const txt = backdrop.querySelector("#tvup-pa-cond-txt");
    if (ico) ico.textContent = conditionIcon(c);
    if (txt) txt.textContent = conditionLabel(c);
    backdrop.querySelectorAll(".tvup-pa-select-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.cond === c);
    });
  }

  const alertPrevLast = Object.create(null);

  function ensureAlertShell() {
    let backdrop = document.getElementById("tvup-alert-backdrop");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "tvup-alert-backdrop";
    backdrop.innerHTML = `
      <div class="tvup-pa-shell" role="dialog" aria-modal="true">
        <div class="tvup-pa-panel" id="tvup-pa-panel">
          <div class="tvup-pa-view" id="tvup-pa-view-list">
            <div class="tvup-pa-header">
              <div class="tvup-pa-header-left">
                <span class="tvup-pa-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22zm6-6.2V11a6 6 0 1 0-12 0v4.8L4 17.6V19h16v-1.4l-2-1.8z"/></svg>
                </span>
                <div>
                  <div class="tvup-pa-title">Price Alerts</div>
                  <div class="tvup-pa-subtitle" id="tvup-pa-list-count">0 active</div>
                </div>
              </div>
              <button type="button" class="tvup-pa-icon-btn" id="tvup-pa-list-close" title="Close" aria-label="Close">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </div>
            <div class="tvup-pa-body" id="tvup-pa-list-body" style="overflow-y:auto; max-height:360px;"></div>
            <div class="tvup-pa-footer tvup-pa-list-footer">
              <button type="button" class="tvup-pa-btn tvup-pa-btn-secondary tvup-pa-bulk" id="tvup-pa-pause-all" title="Pause all">⏸ All</button>
              <button type="button" class="tvup-pa-btn tvup-pa-btn-secondary tvup-pa-bulk" id="tvup-pa-play-all" title="Resume all">▶ All</button>
              <button type="button" class="tvup-pa-btn tvup-pa-btn-ghost tvup-pa-bulk" id="tvup-pa-delete-all" title="Delete all">🗑 All</button>
            </div>
          </div>

          <div class="tvup-pa-view" id="tvup-pa-view-form" hidden>
            <div class="tvup-pa-header">
              <div class="tvup-pa-header-left">
                <span class="tvup-pa-header-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22zm6-6.2V11a6 6 0 1 0-12 0v4.8L4 17.6V19h16v-1.4l-2-1.8z"/></svg>
                </span>
                <div>
                  <div class="tvup-pa-title" id="tvup-pa-form-title">Create Alert</div>
                  <div class="tvup-pa-subtitle" id="tvup-pa-form-symbol">—</div>
                </div>
              </div>
              <button type="button" class="tvup-pa-icon-btn" id="tvup-pa-form-close" title="Close" aria-label="Close">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </div>
            <div class="tvup-pa-body tvup-pa-form-body">
              <div class="tvup-pa-current-mini">
                Current <strong id="tvup-pa-current-price">—</strong>
              </div>

              <div class="tvup-pa-field">
                <label class="tvup-pa-label">Condition</label>
                <div class="tvup-pa-select-wrap">
                  <button type="button" class="tvup-pa-select" id="tvup-pa-cond-btn" aria-haspopup="listbox" aria-expanded="false">
                    <span class="tvup-pa-select-ico" id="tvup-pa-cond-ico">✕</span>
                    <span class="tvup-pa-select-txt" id="tvup-pa-cond-txt">Crossing</span>
                    <span class="tvup-pa-select-chev">▾</span>
                  </button>
                  <div class="tvup-pa-select-menu" id="tvup-pa-cond-menu" hidden role="listbox">
                    <button type="button" class="tvup-pa-select-item active" data-cond="crossing" role="option">
                      <span class="tvup-pa-select-ico">✕</span> Crossing
                    </button>
                    <button type="button" class="tvup-pa-select-item" data-cond="crossing_up" role="option">
                      <span class="tvup-pa-select-ico">↗</span> Crossing Up
                    </button>
                    <button type="button" class="tvup-pa-select-item" data-cond="crossing_down" role="option">
                      <span class="tvup-pa-select-ico">↘</span> Crossing Down
                    </button>
                  </div>
                </div>
              </div>

              <div class="tvup-pa-field">
                <label class="tvup-pa-label" for="tvup-pa-price">Price</label>
                <div class="tvup-pa-price-wrap">
                  <span class="tvup-pa-currency">₹</span>
                  <input type="number" id="tvup-pa-price" class="tvup-pa-price-input" inputmode="decimal" step="any" min="0" placeholder="0.00" />
                </div>
              </div>
            </div>
            <div class="tvup-pa-footer tvup-pa-form-footer">
              <button type="button" class="tvup-pa-btn tvup-pa-btn-ghost" id="tvup-pa-delete" hidden>Delete</button>
              <div class="tvup-pa-footer-right">
                <button type="button" class="tvup-pa-btn tvup-pa-btn-secondary" id="tvup-pa-cancel">Cancel</button>
                <button type="button" class="tvup-pa-btn tvup-pa-btn-primary" id="tvup-pa-save">Create</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(backdrop);
    if (!window.__tvupPaEsc) {
      window.__tvupPaEsc = true;
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        const bd = document.getElementById("tvup-alert-backdrop");
        if (bd && bd.classList.contains("tvup-pa-open")) closeAlertModal();
      });
    }


    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.classList.contains("tvup-pa-shell")) closeAlertModal();
    });
    backdrop.querySelector("#tvup-pa-list-close").addEventListener("click", closeAlertModal);
    backdrop.querySelector("#tvup-pa-form-close").addEventListener("click", () => {
      if (backdrop.dataset.fromList === "1") showAlertListView();
      else closeAlertModal();
    });
    backdrop.querySelector("#tvup-pa-cancel").addEventListener("click", () => {
      if (backdrop.dataset.fromList === "1") showAlertListView();
      else closeAlertModal();
    });

    const condBtn = backdrop.querySelector("#tvup-pa-cond-btn");
    const condMenu = backdrop.querySelector("#tvup-pa-cond-menu");
    condBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !condMenu.hidden;
      condMenu.hidden = open;
      condBtn.setAttribute("aria-expanded", open ? "false" : "true");
    });
    backdrop.addEventListener("click", () => {
      condMenu.hidden = true;
      condBtn.setAttribute("aria-expanded", "false");
    });
    condMenu.addEventListener("click", (e) => e.stopPropagation());
    condMenu.querySelectorAll(".tvup-pa-select-item").forEach((item) => {
      item.addEventListener("click", () => {
        const c = item.dataset.cond;
        setConditionUI(backdrop, c);
        condMenu.hidden = true;
        condBtn.setAttribute("aria-expanded", "false");
      });
    });

    backdrop.querySelector("#tvup-pa-save").addEventListener("click", async () => {
      const s = String(backdrop.dataset.symbol || "").toUpperCase();
      const editId = String(backdrop.dataset.alertId || "").trim();
      const condition = normalizeAlertCondition(backdrop.dataset.condition || "crossing");
      const price = Number(backdrop.querySelector("#tvup-pa-price")?.value);
      if (!s || !Number.isFinite(price) || price <= 0) {
        updateStatus("Enter a valid price", "error");
        backdrop.querySelector("#tvup-pa-price")?.focus();
        return;
      }
      state.alerts = state.alerts || {};
      const armPx = Number(liveData[s]?.last);
      const id = editId && state.alerts[editId] ? editId : newAlertId();
      const prev = editId && state.alerts[editId] ? state.alerts[editId] : null;
      state.alerts[id] = {
        id,
        symbol: s,
        condition,
        price,
        status: "active",
        createdAt: prev?.createdAt || Date.now(),
        updatedAt: Date.now(),
        lastTriggeredAt: null,
        armed: true,
        armPrice: Number.isFinite(armPx) ? armPx : null,
        once: true,
        repeat: false
      };
      try { delete alertPrevLast[id]; } catch (_) {}
      await saveState();
      try { await syncAlertsToCloud(); } catch (e) { console.warn("[TVUP] cloud sync", e); }
      renderTable();
      updateStatus(`Alert: ${s} ${conditionLabel(condition)} ₹${formatAlertPrice(price)}`, "online");
      if (backdrop.dataset.fromList === "1") showAlertListView();
      else closeAlertModal();
      // Force local check immediately so same-LTP alerts fire without waiting poll
      try { checkPriceAlerts(); } catch (_) {}
    });

    backdrop.querySelector("#tvup-pa-delete").addEventListener("click", async () => {
      const editId = String(backdrop.dataset.alertId || "").trim();
      if (editId && state.alerts && state.alerts[editId]) {
        delete state.alerts[editId];
        await saveState();
        renderTable();
        updateStatus("Alert removed", "neutral");
      }
      if (backdrop.dataset.fromList === "1") showAlertListView();
      else closeAlertModal();
    });

    const pauseAll = backdrop.querySelector("#tvup-pa-pause-all");
    const playAll = backdrop.querySelector("#tvup-pa-play-all");
    const deleteAll = backdrop.querySelector("#tvup-pa-delete-all");
    if (pauseAll) pauseAll.addEventListener("click", async () => {
      if (!state.alerts) return;
      let n = 0;
      for (const [sym, r] of Object.entries(state.alerts)) {
        if (!r) continue;
        const st = r.status || "active";
        // Only pause currently active alerts (leave triggered / already paused alone)
        if (st === "active") {
          r.status = "paused";
          r.armed = false;
          n++;
        }
      }
      await saveState();
      renderAlertList(backdrop);
      renderTable();
      updateStatus(n ? `Paused ${n} alert(s)` : "No active alerts to pause", "neutral");
    });
    if (playAll) playAll.addEventListener("click", async () => {
      if (!state.alerts) return;
      let n = 0;
      for (const [sym, r] of Object.entries(state.alerts)) {
        if (!r) continue;
        // Resume only paused alerts (do not auto-rearm triggered)
        if (r.status === "paused") {
          r.status = "active";
          r.armed = true;
          r.lastTriggeredAt = null;
          try { delete alertPrevLast[String(sym).toUpperCase()]; } catch (_) {}
          n++;
        }
      }
      await saveState();
      renderAlertList(backdrop);
      renderTable();
      updateStatus(n ? `Resumed ${n} alert(s)` : "No paused alerts to resume", "online");
    });
    if (deleteAll) deleteAll.addEventListener("click", () => {
      const n = state.alerts ? Object.keys(state.alerts).length : 0;
      if (!n) {
        updateStatus("No alerts to delete", "neutral");
        return;
      }
      openConfirm(
        `Delete all ${n} price alert${n === 1 ? "" : "s"}? This cannot be undone.`,
        "",
        "alert_delete_all"
      );
    });

    return backdrop;
  }

  function showAlertListView() {
    const backdrop = ensureAlertShell();
    backdrop.dataset.mode = "list";
    backdrop.dataset.symbol = "";
    backdrop.dataset.fromList = "";
    setAlertView(backdrop, "list");
    renderAlertList(backdrop);
    backdrop.classList.toggle("tvup-light", state.theme === "light");
    openAlertBackdrop(backdrop);
  }

  function isAlertActivelyArmed(rule) {
    if (!rule || typeof rule !== "object") return false;
    // Explicit non-active states
    const st = String(rule.status || "").toLowerCase();
    if (st === "triggered" || st === "stopped" || st === "paused") return false;
    if (rule.armed === false) return false;
    if (rule.lastTriggeredAt && st !== "active") return false;
    // Only active + armed
    return (st === "active" || st === "") && rule.armed !== false;
  }

  function normalizeAlertRule(rule) {
    if (!rule || typeof rule !== "object") return rule;
    const st = String(rule.status || "").toLowerCase();
    if (st === "triggered" || st === "stopped" || (rule.armed === false && rule.lastTriggeredAt)) {
      rule.status = "triggered";
      rule.armed = false;
      return rule;
    }
    if (st === "paused") {
      rule.status = "paused";
      rule.armed = false;
      return rule;
    }
    if (rule.armed === false) {
      // disarmed without trigger timestamp → treat as paused
      rule.status = "paused";
      rule.armed = false;
      return rule;
    }
    rule.status = "active";
    rule.armed = true;
    return rule;
  }

  async function setAlertArmedState(alertId, next) {
    const id = String(alertId || "");
    const rule = state.alerts && state.alerts[id];
    if (!rule) return false;
    if (next === "active") {
      rule.status = "active";
      rule.armed = true;
      rule.lastTriggeredAt = null;
      try { delete alertPrevLast[id]; } catch (_) {}
    } else if (next === "paused") {
      rule.status = "paused";
      rule.armed = false;
    } else if (next === "triggered") {
      rule.status = "triggered";
      rule.armed = false;
    }
    await saveState();
    return true;
  }

  // TV-native style vertical alert list
  function renderAlertList(backdrop, opts) {
    const skipPull = !!(opts && opts.skipPull);
    if (!skipPull) {
      try {
        pullAlertsFromCloud().then((r) => {
          if (r && r.changed && backdrop && backdrop.classList.contains("tvup-pa-open")) {
            try { renderAlertList(backdrop, { skipPull: true }); } catch (_) {}
          }
        }).catch(() => {});
      } catch (_) {}
    }

    const body = backdrop.querySelector("#tvup-pa-list-body");
    const countEl = backdrop.querySelector("#tvup-pa-list-count");
    if (!body) return;

    const alerts = state.alerts && typeof state.alerts === "object" ? state.alerts : {};
    for (const r of Object.values(alerts)) normalizeAlertRule(r);

    const entries = Object.entries(alerts).sort((a, b) => {
      const rank = (r) => {
        const s = r?.status || "active";
        if (s === "active") return 0;
        if (s === "paused") return 1;
        return 2;
      };
      const d = rank(a[1]) - rank(b[1]);
      if (d !== 0) return d;
      const sa = String(a[1]?.symbol || a[0]);
      const sb = String(b[1]?.symbol || b[0]);
      const sc = sa.localeCompare(sb);
      if (sc !== 0) return sc;
      return Number(a[1]?.price || 0) - Number(b[1]?.price || 0);
    });

    const activeN = entries.filter(([, r]) => (r?.status || "active") === "active").length;
    const pausedN = entries.filter(([, r]) => r?.status === "paused").length;
    const triggeredN = entries.filter(([, r]) => r?.status === "triggered").length;

    if (countEl) {
      countEl.textContent = `${activeN} active · ${pausedN} paused · ${triggeredN} triggered`;
    }

    if (!entries.length) {
      body.innerHTML = `
        <div class="tvup-pa-empty">
          <div class="tvup-pa-empty-title">No alerts yet</div>
          <div class="tvup-pa-empty-text">Watchlist row pe 🔔 dabao, ya yahan se create karo.</div>
        </div>`;
      body.onclick = null;
      return;
    }

    const cards = entries.map(([aid, rule]) => {
      const id = String(rule?.id || aid);
      const sym = alertSymbolOf(rule, aid);
      const last = Number(liveData[sym]?.last);
      const status = rule?.status || "active";
      const cond = normalizeAlertCondition(rule?.condition);
      const isPaused = status === "paused";
      const isTriggered = status === "triggered";
      const ltpTxt = Number.isFinite(last) ? ("₹" + formatAlertPrice(last)) : "—";
      const targetTxt = "₹" + formatAlertPrice(rule?.price);

      let statusClass = "tvup-pa-row-active";
      let statusText = "Active";
      if (isPaused) { statusClass = "tvup-pa-row-paused"; statusText = "Paused"; }
      if (isTriggered) { statusClass = "tvup-pa-row-triggered"; statusText = "Stopped — Triggered"; }

      let actions = "";
      if (isTriggered) {
        actions = `
          <button type="button" class="tvup-pa-act tvup-pa-act-restart" data-alert-toggle="${escapeHTML(id)}" data-next="active" title="Restart">Restart</button>
          <button type="button" class="tvup-pa-act tvup-pa-act-icon tvup-pa-act-del" data-alert-del="${escapeHTML(id)}" title="Delete">🗑</button>`;
      } else if (isPaused) {
        actions = `
          <button type="button" class="tvup-pa-act tvup-pa-act-icon" data-alert-toggle="${escapeHTML(id)}" data-next="active" title="Resume">▶</button>
          <button type="button" class="tvup-pa-act tvup-pa-act-icon" data-alert-edit="${escapeHTML(id)}" title="Edit">✎</button>
          <button type="button" class="tvup-pa-act tvup-pa-act-icon tvup-pa-act-del" data-alert-del="${escapeHTML(id)}" title="Delete">🗑</button>`;
      } else {
        actions = `
          <button type="button" class="tvup-pa-act tvup-pa-act-icon" data-alert-toggle="${escapeHTML(id)}" data-next="paused" title="Pause">⏸</button>
          <button type="button" class="tvup-pa-act tvup-pa-act-icon" data-alert-edit="${escapeHTML(id)}" title="Edit">✎</button>
          <button type="button" class="tvup-pa-act tvup-pa-act-icon tvup-pa-act-del" data-alert-del="${escapeHTML(id)}" title="Delete">🗑</button>`;
      }

      return `
        <div class="tvup-pa-card ${statusClass}" data-alert-card="${escapeHTML(id)}" data-status="${escapeHTML(status)}">
          <div class="tvup-pa-card-top">
            <div class="tvup-pa-card-title">
              <span class="tvup-pa-card-sym">${escapeHTML(sym)}</span>
              <span class="tvup-pa-card-cond">${conditionIcon(cond)} ${conditionLabel(cond)} ${escapeHTML(targetTxt)}</span>
            </div>
            <div class="tvup-pa-card-actions">${actions}</div>
          </div>
          <div class="tvup-pa-card-bottom">
            <span class="tvup-pa-card-status">${statusText}</span>
            <span class="tvup-pa-card-ltp">LTP ${escapeHTML(ltpTxt)}</span>
          </div>
        </div>`;
    }).join("");

    body.innerHTML = `<div class="tvup-pa-card-list">${cards}</div>`;

    body.onclick = null;
    body.querySelectorAll("[data-alert-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const aid = String(btn.getAttribute("data-alert-del") || "");
        if (!aid || !state.alerts) return;
        delete state.alerts[aid];
        try {
          await chrome.storage.local.set({ tvup_alerts: state.alerts });
        } catch (_) {}
        try {
          await syncAlertsToCloud();
        } catch (_) {}
        try { await saveState(); } catch (_) {}
        renderAlertList(backdrop, { skipPull: true });
        try { renderTable(); } catch (_) {}
        try { refreshAlertUI(); } catch (_) {}
        updateStatus("Alert deleted", "neutral");
      });
    });
    body.querySelectorAll("[data-alert-toggle]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const aid = String(btn.getAttribute("data-alert-toggle") || "");
        const next = btn.getAttribute("data-next") === "paused" ? "paused" : "active";
        const ok = await setAlertArmedState(aid, next);
        if (!ok) return;
        try { await syncAlertsToCloud(); } catch (_) {}
        renderAlertList(backdrop, { skipPull: true });
        try { renderTable(); } catch (_) {}
        const rule = getAlertById(aid);
        const lab = rule ? alertSymbolOf(rule) : aid;
        updateStatus(
          next === "paused" ? `Alert paused: ${lab}` : `Alert restarted: ${lab}`,
          next === "paused" ? "neutral" : "online"
        );
      });
    });
    body.querySelectorAll("[data-alert-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const aid = btn.getAttribute("data-alert-edit");
        const rule = getAlertById(aid);
        if (rule) openAlertModal(rule.symbol, { fromList: true, alertId: aid });
      });
    });
  }

  function openAlertModal(symbol, opts = {}) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    const backdrop = ensureAlertShell();
    const editId = opts.alertId ? String(opts.alertId) : "";
    const existing = editId ? getAlertById(editId) : null;
    const isEdit = !!existing;
    backdrop.dataset.symbol = sym;
    backdrop.dataset.alertId = isEdit ? editId : "";
    backdrop.dataset.mode = isEdit ? "edit" : "create";
    backdrop.dataset.fromList = opts.fromList ? "1" : "";
    backdrop.classList.toggle("tvup-light", state.theme === "light");

    setAlertView(backdrop, "form");

    const nExisting = getAlertsForSymbol(sym).length;
    backdrop.querySelector("#tvup-pa-form-title").textContent = isEdit
      ? "Edit Alert"
      : (nExisting ? "Add another alert" : "Create Alert");
    backdrop.querySelector("#tvup-pa-form-symbol").textContent = sym;
    const last = Number(liveData[sym]?.last);
    backdrop.querySelector("#tvup-pa-current-price").textContent = Number.isFinite(last)
      ? `₹${formatAlertPrice(last)}`
      : "—";

    const priceInput = backdrop.querySelector("#tvup-pa-price");
    priceInput.value = existing?.price != null
      ? String(existing.price)
      : (Number.isFinite(last) ? String(last) : "");

    setConditionUI(backdrop, existing?.condition || "crossing");
    backdrop.querySelector("#tvup-pa-delete").hidden = !isEdit;
    backdrop.querySelector("#tvup-pa-save").textContent = isEdit ? "Save" : "Create";

    openAlertBackdrop(backdrop);
    setTimeout(() => priceInput && priceInput.focus(), 40);
  }

  function openAlertsManager() {
    showAlertListView();
  }


  function setAlertView(backdrop, which) {
    if (!backdrop) return;
    const listView = backdrop.querySelector("#tvup-pa-view-list");
    const formView = backdrop.querySelector("#tvup-pa-view-form");
    const showList = which === "list";
    if (listView) {
      listView.hidden = !showList;
      listView.classList.toggle("tvup-pa-view-active", showList);
      listView.style.setProperty("display", showList ? "flex" : "none", "important");
    }
    if (formView) {
      formView.hidden = showList;
      formView.classList.toggle("tvup-pa-view-active", !showList);
      formView.style.setProperty("display", showList ? "none" : "flex", "important");
    }
  }

  function openAlertBackdrop(backdrop) {
    if (!backdrop) return;
    backdrop.classList.add("tvup-pa-open");
    backdrop.style.setProperty("display", "flex", "important");
  }

  function closeAlertModal() {
    const backdrop = document.getElementById("tvup-alert-backdrop");
    if (!backdrop) return;
    backdrop.classList.remove("tvup-pa-open");
    backdrop.style.setProperty("display", "none", "important");
    if (backdrop.querySelector("#tvup-pa-view-list") || backdrop.querySelector("#tvup-pa-view-form")) {
      const listView = backdrop.querySelector("#tvup-pa-view-list");
      const formView = backdrop.querySelector("#tvup-pa-view-form");
      if (listView) {
        listView.hidden = true;
        listView.classList.remove("tvup-pa-view-active");
        listView.style.setProperty("display", "none", "important");
      }
      if (formView) {
        formView.hidden = true;
        formView.classList.remove("tvup-pa-view-active");
        formView.style.setProperty("display", "none", "important");
      }
    }
    const menu = backdrop.querySelector("#tvup-pa-cond-menu");
    if (menu) menu.hidden = true;
    // Never leave chart blank after modal
    try { restoreBlankedChartSurfaces(); } catch (_) {}
    try { forceChartRelayout(); } catch (_) {}
  }

  async function syncAlertsToCloud() {
    // Always use permanent project id — never depend on manual console injection
    const projectId = String(state.fbProject || "tvup-watchlist-for-upstox").trim() || "tvup-watchlist-for-upstox";
    state.fbProject = projectId;
    if (!state.fbApiKey) state.fbApiKey = "direct";

    const alerts = state.alerts && typeof state.alerts === "object" ? state.alerts : {};
    const fields = {
      updatedAt: { integerValue: String(Date.now()) },
      upstoxToken: { stringValue: String(state.token || "") },
      fyersAccessToken: { stringValue: "" },
      fyersAppId: { stringValue: "" },
      dataProvider: { stringValue: "upstox" },
      fcmToken: { stringValue: String(state.fcmToken || "") },
      alertsJson: { stringValue: JSON.stringify(alerts) }
    };
    try {
      // Background SW has host_permissions — no CORS from tradingview.com
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "TVUP_FIRESTORE_SYNC", projectId, apiKey: state.fbApiKey || "direct", fields },
            (r) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, reason: chrome.runtime.lastError.message });
              } else {
                resolve(r || { ok: false, reason: "no response" });
              }
            }
          );
        } catch (e) {
          resolve({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
      });
      if (res && res.ok) {
        // success — quiet
        return { ok: true };
      }
      // Soft fail: network / rules / offline — do not spam extension error page
      return { ok: false, reason: (res && (res.reason || ("HTTP " + res.status))) || "sync failed" };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }


  async function pullAlertsFromCloud() {
    // Only UPDATE status of alerts that already exist locally.
    // Never re-import deleted alerts (extension is source of truth for create/delete).
    const projectId = String(state.fbProject || "tvup-watchlist-for-upstox").trim() || "tvup-watchlist-for-upstox";
    try {
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "TVUP_FIRESTORE_PULL", projectId, apiKey: state.fbApiKey || "direct" },
            (r) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, reason: chrome.runtime.lastError.message });
              } else {
                resolve(r || { ok: false, reason: "no response" });
              }
            }
          );
        } catch (e) {
          resolve({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
      });
      if (!res || !res.ok) {
        // Soft fail — offline / rules / network. No console.error spam.
        return { ok: false, reason: (res && (res.reason || ("HTTP " + res.status))) || "pull failed" };
      }
      const doc = res.json || null;
      const raw = doc && doc.fields && doc.fields.alertsJson && doc.fields.alertsJson.stringValue;
      if (!raw) return { ok: true, changed: false };
      let cloudAlerts = {};
      try { cloudAlerts = JSON.parse(raw); } catch (_) { return { ok: false, reason: "bad json" }; }
      if (!cloudAlerts || typeof cloudAlerts !== "object") return { ok: true, changed: false };
      if (!state.alerts || typeof state.alerts !== "object") state.alerts = {};

      let changed = false;
      for (const [id, local] of Object.entries(state.alerts)) {
        if (!local || typeof local !== "object") continue;
        const cloudRule = cloudAlerts[id];
        if (!cloudRule || typeof cloudRule !== "object") continue;

        const cStatus = String(cloudRule.status || "active").toLowerCase();
        const cloudTriggered =
          cStatus === "triggered" ||
          cStatus === "stopped" ||
          (cloudRule.armed === false && Number(cloudRule.lastTriggeredAt) > 0);

        const lStatus = String(local.status || "active").toLowerCase();
        if (cloudTriggered && lStatus !== "triggered" && lStatus !== "stopped") {
          local.status = "triggered";
          local.armed = false;
          local.lastTriggeredAt = Number(cloudRule.lastTriggeredAt) || Date.now();
          if (cloudRule.cloudTelegramSentAt) local.cloudTelegramSentAt = cloudRule.cloudTelegramSentAt;
          try { normalizeAlertRule(local); } catch (_) {}
          state.alerts[id] = local;
          changed = true;
        }
      }

      if (changed) {
        try { await chrome.storage.local.set({ tvup_alerts: state.alerts }); } catch (_) {}
        try { refreshAlertUI(); } catch (_) {}
        try { renderTable(); } catch (_) {}
        try {
          const bd = document.getElementById("tvup-alert-backdrop");
          if (bd && bd.classList.contains("tvup-pa-open")) {
            renderAlertList(bd, { skipPull: true });
          }
        } catch (_) {}
      }
      return { ok: true, changed };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  function priceAlertHit(prev, last, target, cond, armPrice) {
    if (!Number.isFinite(last) || !Number.isFinite(target)) return false;
    const eps = Math.max(0.10, Math.abs(target) * 0.0002);
    // Require a real cross/touch from outside the band (no spam while LTP stays near target)
    const base = Number.isFinite(prev) ? prev : (Number.isFinite(armPrice) ? armPrice : NaN);

    if (cond === "crossing_up") {
      if (!Number.isFinite(base)) return last >= target - eps;
      return base < target - eps && last >= target - eps;
    }
    if (cond === "crossing_down") {
      if (!Number.isFinite(base)) return last <= target + eps;
      return base > target + eps && last <= target + eps;
    }
    // generic "crossing": either direction
    if (!Number.isFinite(base)) {
      // First sample only: fire if already at/through target (user / arm)
      return Math.abs(last - target) <= eps;
    }
    return (base < target - eps && last >= target - eps) ||
           (base > target + eps && last <= target + eps);
  }

  function markAlertTriggered(sym, rule, last, cond) {
    const key = String(sym || "").toUpperCase();
    const target = Number(rule.price);
    const priceStr = formatAlertPrice(last);
    const targetStr = formatAlertPrice(target);
    const condRaw = String(cond || rule.condition || "crossing");
    const condStr = condRaw.replace(/_/g, " ");
    const msg = `${key} ${conditionLabel(cond)} ₹${targetStr} (now ₹${priceStr})`;
    const telegramText =
      `🎯 Price Alert Hit!\n\n` +
      `📈 Symbol: ${key}\n` +
      `💰 Price: ₹${priceStr}\n` +
      `🎯 Target: ₹${targetStr}\n` +
      `⚙️ Condition: ${condStr}`;

    // 1) Status FIRST so UI can update immediately
    rule.lastTriggeredAt = Date.now();
    rule.armed = false;
    rule.status = "triggered";
    try { normalizeAlertRule(rule); } catch (_) {}
    if (!state.alerts) state.alerts = {};
    const id = rule.id || newAlertId();
    rule.id = id;
    rule.symbol = key;
    state.alerts[id] = rule;

    // 2) UI immediately (⏱ off + list shows Triggered)
    try { refreshAlertUI(); } catch (_) {}
    try { renderTable(); } catch (_) {}
    try {
      const bd = document.getElementById("tvup-alert-backdrop");
      if (bd && bd.classList.contains("tvup-pa-open")) renderAlertList(bd);
    } catch (_) {}
    try {
      chrome.storage.local.set({ tvup_alerts: state.alerts }, () => void chrome.runtime.lastError);
    } catch (_) {}
    try { saveState(); } catch (_) {}

    // 3) Notifications
    try {
      chrome.runtime.sendMessage({ type: "TVUP_TELEGRAM_NOTIFY", text: telegramText, retries: 2 }, () => void chrome.runtime.lastError);
    } catch (_) {}
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("TVUP Price Alert", { body: msg, tag: "tvup-alert-" + key });
      }
    } catch (_) {}
    try { updateStatus("🔔 " + msg, "online"); } catch (_) {}
  }

  function refreshAlertUI() {
    try { renderTable(); } catch (_) {}
    // Extra safety: strip ⏱ from any row whose alert is not actively armed
    try {
      document.querySelectorAll("#tvup-tbody tr.tvup-row").forEach((tr) => {
        const sym = String(tr.dataset.symbol || "").toUpperCase();
        const rules = getAlertsForSymbol(sym);
        if (rules.some((r) => isAlertActivelyArmed(r))) return;
        const rule = rules[0];
        tr.querySelectorAll(".tvup-alert-mark").forEach((el) => el.remove());
        const btn = tr.querySelector(".tvup-alert-btn");
        if (btn) {
          btn.classList.remove("tvup-alert-active");
          if (rule) btn.classList.add("tvup-alert-inactive");
        }
      });
    } catch (_) {}
    try {
      const bd = document.getElementById("tvup-alert-backdrop");
      if (bd && (bd.classList.contains("tvup-pa-open") || bd.style.display === "flex" || bd.style.getPropertyValue("display") === "flex")) {
        renderAlertList(bd);
      }
    } catch (_) {}
  }

  function checkPriceAlerts() {
    if (!state.alerts || typeof state.alerts !== "object") return;
    const now = Date.now();
    let changed = false;

    for (const [aid, rule] of Object.entries(state.alerts)) {
      if (!rule || typeof rule !== "object") continue;
      if (rule.status === "triggered" || rule.status === "paused") continue;
      if (rule.armed === false) {
        if (rule.lastTriggeredAt) {
          rule.status = "triggered";
          changed = true;
        }
        continue;
      }

      const sym = alertSymbolOf(rule, aid);
      const id = rule.id || aid;
      rule.id = id;
      rule.symbol = sym;

      const last = Number(liveData[sym]?.last);
      if (!Number.isFinite(last)) continue;
      const target = Number(rule.price);
      if (!Number.isFinite(target)) continue;
      const cond = normalizeAlertCondition(rule.condition);
      const prev = alertPrevLast[id];

      if (!Number.isFinite(prev)) {
        alertPrevLast[id] = last;
        if (rule.armPrice == null || !Number.isFinite(Number(rule.armPrice))) {
          rule.armPrice = last;
        }
        continue;
      }

      const hit = priceAlertHit(prev, last, target, cond, Number(rule.armPrice));
      alertPrevLast[id] = last;
      if (!hit) continue;
      // Once alerts (default): never fire again if already triggered
      const isOnce = rule.repeat !== true && rule.once !== false;
      if (isOnce && rule.lastTriggeredAt) continue;
      // Safety cooldown even for rare repeat mode
      if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < 45000) continue;

      markAlertTriggered(sym, rule, last, cond);
      changed = true;
    }

    if (changed) {
      refreshAlertUI();
      try {
        chrome.storage.local.set({ tvup_alerts: state.alerts }, () => void chrome.runtime.lastError);
      } catch (_) {}
      setTimeout(() => { try { saveState().catch(() => {}); } catch (_) {} }, 800);
    }
  }

  function renderTable() {
    try { hideNameTip(); } catch (_) {}
    const list = activeWatchlist();
    const tbody = $("#tvup-tbody");
    const empty = $("#tvup-empty");
    renderTableHeader();
    ensureListEntries(list);
    try { dedupeCanonicalSymbols(list); } catch (_) {}

    const sorting = !!(state.sort.column && state.sort.direction !== 0);

    function cmpSymbols(a, b) {
      if (!sorting) return 0;
      const av = getSortValue(a, state.sort.column);
      const bv = getSortValue(b, state.sort.column);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * state.sort.direction;
      }
      return (Number(av) - Number(bv)) * state.sort.direction;
    }

    /** Build display order: sections stay; symbols sorted within each section group */
    function buildDisplayEntries() {
      ensureListEntries(list);
      const entries = list.entries;
      if (!sorting) return entries.slice();

      // Split into groups: [syms before first sec] then [sec + its syms] ...
      const groups = [];
      let cur = { sec: null, syms: [] };
      for (const e of entries) {
        if (e.type === "sec") {
          groups.push(cur);
          cur = { sec: e, syms: [] };
        } else {
          cur.syms.push(e.s);
        }
      }
      groups.push(cur);

      const out = [];
      for (const g of groups) {
        const sorted = g.syms.slice().sort(cmpSymbols);
        if (g.sec) out.push(g.sec);
        for (const s of sorted) out.push({ type: "sym", s });
      }
      return out;
    }

    tbody.innerHTML = "";
    if (!list.symbols.length && !(list.entries || []).some((e) => e.type === "sec")) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    const colSpan = (state.ui.columnOrder || []).length + 1;

    function appendSymbolRow(symbol) {
      const data = liveData[symbol] || {};
      const flag = state.flags[symbol] || "none";
      const tr = document.createElement("tr");
      tr.className = "tvup-row";
      tr.dataset.symbol = symbol;
      tr.innerHTML = state.ui.columnOrder.map((key) => rowCellHTML(key, symbol, data, flag)).join("") +
        `<button type="button" class="tvup-delete" data-delete-symbol="${escapeHTML(symbol)}" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h8m-7 0v11m6-11v11M9 7l1-2h4l1 2m-9 0h12m-2 0-.6 14H8.6L8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      tr.addEventListener("click", (event) => {
        if (event.target.closest(".tvup-delete") || event.target.closest("[data-flag-symbol]") || event.target.closest(".tvup-alert-btn") || event.target.closest(".tvup-sel-wrap, .tvup-sel-cb")) return;
        try {
          if (window.__tvupJustDragged && (Date.now() - window.__tvupJustDragged) < 400) return;
        } catch (_) {}
        event.stopPropagation();
        event.preventDefault();
        try { setActiveWatchlistRow(symbol, { scroll: false }); } catch (_) {
          try { window.__tvupLastNavSym = symbol; } catch (__) {}
        }
        openTradingViewSymbol(symbol).catch((err) => {
          console.error("[TVUP] click handler error:", err);
          updateStatus(`Error opening ${symbol} — see console`, "error");
        });
      });
      tbody.appendChild(tr);
    }

    function appendSectionRow(sec) {
      const tr = document.createElement("tr");
      tr.className = "tvup-section-row" + (sec.collapsed ? " tvup-section-collapsed" : "");
      tr.dataset.sectionId = sec.id;
      tr.innerHTML = `
        <td colspan="${colSpan}" class="tvup-section-cell">
          <div class="tvup-section-inner">
            <button type="button" class="tvup-section-toggle" data-section-toggle="${escapeHTML(sec.id)}" title="${sec.collapsed ? "Expand" : "Collapse"}" aria-label="Toggle section">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${sec.collapsed ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6"}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <input type="text" class="tvup-section-name-input" data-section-name="${escapeHTML(sec.id)}" value="${escapeHTML(sec.name)}" maxlength="40" spellcheck="false" />
            <button type="button" class="tvup-section-delete" data-section-delete="${escapeHTML(sec.id)}" title="Delete section" aria-label="Delete section">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 7h8m-7 0v11m6-11v11M9 7l1-2h4l1 2m-9 0h12m-2 0-.6 14H8.6L8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    }

    // Always keep sections; when sorting, only reorder symbols inside each section
    {
      let hide = false;
      const display = buildDisplayEntries();
      for (const entry of display) {
        if (entry.type === "sec") {
          hide = !!entry.collapsed;
          appendSectionRow(entry);
          continue;
        }
        if (hide) continue;
        appendSymbolRow(entry.s);
      }
    }

    // Section controls
    tbody.querySelectorAll("[data-section-toggle]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleSectionCollapse(list, btn.getAttribute("data-section-toggle"));
      });
    });
    tbody.querySelectorAll("[data-section-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-section-delete");
        await deleteSection(list, id);
      });
    });
    tbody.querySelectorAll(".tvup-section-name-input").forEach((inp) => {
      const commit = async () => {
        const id = inp.getAttribute("data-section-name");
        await renameSection(list, id, inp.value);
        // keep visual in sync if empty restored
        const e = list.entries.find((x) => x.type === "sec" && x.id === id);
        if (e) inp.value = e.name;
      };
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
        if (e.key === "Escape") {
          const id = inp.getAttribute("data-section-name");
          const sec = list.entries.find((x) => x.type === "sec" && x.id === id);
          if (sec) inp.value = sec.name;
          inp.blur();
        }
      });
      inp.addEventListener("change", commit);
      inp.addEventListener("blur", commit);
    });

    bindLogoHandlers(tbody);
    bindWatchlistDragDrop(tbody, list);
    bindRowNameTooltips(tbody);

    tbody.querySelectorAll("tr.tvup-row").forEach((tr) => {
      try { bindRowSelectCheckbox(tr); } catch (_) {}
      tr.addEventListener("pointerdown", () => {
        const s = String(tr.dataset.symbol || "").toUpperCase();
        try { setActiveWatchlistRow(s, { scroll: false }); } catch (_) {
          tbody.querySelectorAll("tr.tvup-row-active").forEach((r) => r.classList.remove("tvup-row-active"));
          tr.classList.add("tvup-row-active");
        }
      });
    });
    setupPanelKeyboardNav();
    tbody.querySelectorAll(".tvup-delete").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const symbol = button.dataset.deleteSymbol;
        const current = activeWatchlist();
        removeSymbolFromList(current, symbol);
        await saveState();
        render();
        try { forceChartRelayout(); } catch (_) {}
      });
    });

    tbody.querySelectorAll(".tvup-alert-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        const symbol = button.dataset.alertSymbol;
        if (symbol) openAlertModal(symbol);
      });
    });

    tbody.querySelectorAll("[data-flag-symbol]").forEach((flagEl) => {
      // Prevent row drag from capturing flag presses
      flagEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      flagEl.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        const sym = String(flagEl.dataset.flagSymbol || "").toUpperCase();
        if (!sym) return;
        currentFlagSymbol = sym;
        const cur = state.flags[sym] || "none";
        if (cur && cur !== "none") {
          delete state.flags[sym];
          removeFromColorWatchlist(cur, sym);
          patchFlagDom(sym, "none");
          try { await saveStateLocal(); } catch (_) {}
          try { scheduleCloudSync(1500); } catch (_) {}
          try { renderStarBar(); } catch (_) {}
          return;
        }
        const rect = flagEl.getBoundingClientRect();
        const picker = $("#tvup-flag-picker");
        if (!picker) return;
        picker.querySelectorAll(".tvup-flag-option").forEach((opt) => {
          opt.classList.toggle("tvup-flag-option-active", false);
        });
        picker.style.display = "flex";
        const pw = picker.offsetWidth || 160;
        const ph = picker.offsetHeight || 40;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        picker.style.left = `${left}px`;
        picker.style.top = `${top}px`;
      });
    });
  }

  function setActiveWatchlistRow(sym, opts) {
    try {
      const s = String(sym || "").toUpperCase().trim();
      if (!s) return false;
      const scroll = !opts || opts.scroll !== false;
      window.__tvupLastNavSym = s;
      if (!opts || !opts.fromChart) window.__tvupPanelNavAt = Date.now();
      const rows = Array.from(document.querySelectorAll("#tvup-tbody tr.tvup-row"));
      if (!rows.length) return false;
      rows.forEach((r) => r.classList.remove("tvup-row-active"));
      const row = rows.find((r) => String(r.dataset.symbol || "").toUpperCase() === s);
      if (!row) return false;
      row.classList.add("tvup-row-active");
      if (scroll) {
        try { row.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) {
          try { row.scrollIntoView({ block: "nearest" }); } catch (__) {}
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function tvupCleanChartSym(raw) {
    let t = String(raw || "").toUpperCase().trim();
    if (!t) return "";
    t = t.replace(/^[A-Z_]+:/, "");           // NSE:DEEPA -> DEEPA
    t = t.replace(/[^A-Z0-9&._-]/g, "");
    if (!t || t === "TRADINGVIEW" || t === "SYMBOL" || t.length > 24) return "";
    return t;
  }

  /** All possible symbol names of the current TradingView chart (best first). */
  function readTvChartSymbols() {
    const out = [];
    const push = (v) => { const c = tvupCleanChartSym(v); if (c && !out.includes(c)) out.push(c); };
    try {
      const btn = document.querySelector("#header-toolbar-symbol-search, button[data-name=\"symbol-search-button\"]");
      if (btn) push((btn.textContent || "").trim().split(/\s+/)[0]);
    } catch (_) {}
    try {
      // "DEEPA 123.45 ▲ 1.2% ..." or "DEEPA — Deepa Jewellers — TradingView"
      const title = String(document.title || "").trim();
      const m = title.match(/^([A-Z0-9][A-Z0-9&._:-]*)/i);
      if (m) push(m[1]);
    } catch (_) {}
    try {
      const el = document.querySelector("[data-name=\"legend-source-item\"], [data-name=\"legend-series-item\"]");
      if (el) push(el.getAttribute("data-symbol") || el.getAttribute("data-name-full") || (el.textContent || "").trim().split(/\s+/)[0]);
    } catch (_) {}
    try {
      const u = new URL(window.location.href).searchParams.get("symbol");
      if (u) push(u);
    } catch (_) {}
    return out;
  }

  function readTvChartSymbol() {
    const all = readTvChartSymbols();
    return all.length ? all[0] : "";
  }

  /** Chart symbol -> highlight matching TVUP row (highlight only, never opens chart). */
  function setupChartSymbolSync() {
    if (window.__tvupChartSymSync) return;
    window.__tvupChartSymSync = true;
    let lastKey = "";
    const rowFor = (cands) => {
      const rows = document.querySelectorAll("#tvup-tbody tr.tvup-row");
      if (!rows.length) return null;
      const map = new Map();
      rows.forEach((r) => map.set(String(r.dataset.symbol || "").toUpperCase(), r));
      for (const c of cands) { if (map.has(c)) return map.get(c); }
      return null;
    };
    const tick = () => {
      try {
        if (!document.getElementById("tvup-tbody")) return;
        const cands = readTvChartSymbols();
        if (!cands.length) return;
        const key = cands[0];
        const row = rowFor(cands);
        if (key !== lastKey) {
          // Ignore chart changes caused by our own panel click / keyboard nav (still loading)
          const fromPanel = (Date.now() - (window.__tvupPanelNavAt || 0)) < 2500;
          if (fromPanel && row && String(row.dataset.symbol || "").toUpperCase() !== String(window.__tvupLastNavSym || "").toUpperCase()) return;
          lastKey = key;
          if (row) setActiveWatchlistRow(row.dataset.symbol, { scroll: true, fromChart: true });
          return;
        }
        // Same chart symbol, but table was re-rendered and border was lost -> restore (no scroll)
        if (row && !row.classList.contains("tvup-row-active") &&
            !document.querySelector("#tvup-tbody tr.tvup-row-active") &&
            (Date.now() - (window.__tvupPanelNavAt || 0)) > 2500) {
          setActiveWatchlistRow(row.dataset.symbol, { scroll: false, fromChart: true });
        }
      } catch (_) {}
    };
    setInterval(tick, 400);
    try {
      const t = document.querySelector("title");
      if (t) new MutationObserver(() => { try { tick(); } catch (_) {} }).observe(t, { childList: true, characterData: true, subtree: true });
    } catch (_) {}
  }

  function setupPanelKeyboardNav() {

    // Always re-bind single handler (prevents multi-listener skip of 4–5 rows)
    if (window.__tvupKeyNavHandler) {
      try { document.removeEventListener("keydown", window.__tvupKeyNavHandler, true); } catch (_) {}
    }

    let chartNavTimer = null;
    let navLockUntil = 0;

    function getOrderedSymbols() {
      // Prefer visible table order (matches what user sees, including sort)
      const rows = Array.from(document.querySelectorAll("#tvup-tbody tr.tvup-row"));
      if (rows.length) {
        return rows.map((r) => String(r.dataset.symbol || "")).filter(Boolean);
      }
      try {
        const list = activeWatchlist();
        return (list && Array.isArray(list.symbols)) ? list.symbols.map((s) => String(s)) : [];
      } catch (_) {
        return [];
      }
    }

    function navigateWatchlist(direction) {
      const ordered = getOrderedSymbols();
      if (!ordered.length) return false;

      const last = String(window.__tvupLastNavSym || "").toUpperCase();
      let idx = last
        ? ordered.findIndex((s) => String(s).toUpperCase() === last)
        : -1;

      if (idx < 0) {
        const rows = Array.from(document.querySelectorAll("#tvup-tbody tr.tvup-row"));
        idx = rows.findIndex((r) => r.classList.contains("tvup-row-active"));
      }
      if (idx < 0) {
        // First press: start at first (down) or last (up)
        idx = direction < 0 ? ordered.length - 1 : 0;
      } else {
        idx = idx + direction;
        // Wrap: last + down → first, first + up → last
        if (idx < 0) idx = ordered.length - 1;
        else if (idx >= ordered.length) idx = 0;
      }

      const sym = ordered[idx];
      if (!sym) return false;
      window.__tvupLastNavSym = sym;

      try { setActiveWatchlistRow(sym, { scroll: true }); } catch (_) {}

      if (chartNavTimer) clearTimeout(chartNavTimer);
      chartNavTimer = setTimeout(() => {
        openTradingViewSymbol(sym).catch(() => {});
      }, 60);
      return true;
    }

    // Type-to-add: letter keys open TVUP + search when option enabled
    if (!window.__tvupQuickAddHandler) {
      window.__tvupQuickAddHandler = function tvupQuickAddHandler(e) {
        try {
          if (!state.ui || state.ui.quickAddSearch !== true) return;
          if (e.defaultPrevented) return;
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const key = e.key;
          // single printable letter/digit only (TV search style)
          if (!key || key.length !== 1) return;
          if (!/[A-Za-z0-9]/.test(key)) return;
          const t = e.target;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
          if (t && t.closest && (
            t.closest("#tvup-add-popup") ||
            t.closest("#tvup-settings-modal") ||
            t.closest("#tvup-import-modal") ||
            t.closest("#tvup-modal-backdrop") ||
            t.closest("#tvup-alert-backdrop") ||
            t.closest("#tvup-confirm-backdrop") ||
            t.closest("#tvup-flag-picker")
          )) return;
          // if add popup already open, let its input handle typing
          const popup = document.getElementById("tvup-add-popup");
          if (popup && popup.style.display === "flex") return;

          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

          try { openAddStockPopup(); } catch (_) {}
          const input = document.getElementById("tvup-add-input");
          if (input) {
            input.value = key;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            try { input.focus(); } catch (_) {}
          }
        } catch (_) {}
      };
      // capture phase so we beat TradingView native search
      document.addEventListener("keydown", window.__tvupQuickAddHandler, true);
    }

    window.__tvupKeyNavHandler = function tvupKeyNavHandler(e) {
      if (!state.ui || state.ui.keyboardNav === false) return;

      const key = e.key;
      const isArrow = key === "ArrowUp" || key === "ArrowDown";
      const isSpace = key === " " || key === "Spacebar" || key === "Space";
      if (!isArrow && !isSpace) return;

      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (t && t.closest && (
        t.closest("#tvup-add-popup") ||
        t.closest("#tvup-settings-modal") ||
        t.closest("#tvup-import-modal") ||
        t.closest("#tvup-modal-backdrop") ||
        t.closest("#tvup-alert-backdrop") ||
        t.closest("#tvup-confirm-backdrop")
      )) return;

      const ordered = getOrderedSymbols();
      if (!ordered.length) return;

      // Stop TV native + any duplicate handlers
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

      // One step per keypress (blocks multi-listener jump)
      const now = Date.now();
      if (now < navLockUntil) return;
      navLockUntil = now + 120;

      if (key === "ArrowUp") navigateWatchlist(-1);
      else navigateWatchlist(1);
    };

    document.addEventListener("keydown", window.__tvupKeyNavHandler, true);
    window.__tvupPanelKeyNav = true;
  }

  function setupPanelResize() {
    const root = $("#tvup-root");
    if (!root || root.dataset.resizeBound === "1") return;
    const handle = root.querySelector("#tvup-resize-handle");
    if (!handle) return;
    root.dataset.resizeBound = "1";

    let resizing = false;
    let startX = 0;
    let startWidth = 0;

    const clampWidth = (value) => {
      const viewport = Math.max(320, Number(window.innerWidth) || 320);
      const minPanel = 280;
      const minChart = 200;
      const max = Math.max(minPanel, Math.min(Math.floor(viewport * 0.48), viewport - minChart, 560));
      return Math.round(Math.max(minPanel, Math.min(max, Number(value) || 300)));
    };

    const onStart = (clientX, event) => {
      if (!Number.isFinite(clientX)) return;
      resizing = true;
      startX = clientX;
      startWidth = clampWidth(state.ui.panelWidth || 300);
      document.body.classList.add("tvup-resizing-panel");
      handle.classList.add("tvup-dragging");
      try { event.preventDefault(); event.stopPropagation(); } catch (_) {}
    };

    const onMove = (clientX, event) => {
      if (!resizing || !Number.isFinite(clientX)) return;
      const delta = clientX - startX;
      const next = state.ui.panelSide === "right" ? startWidth - delta : startWidth + delta;
      state.ui.panelWidth = clampWidth(next);
      root.style.setProperty("width", state.ui.panelWidth + "px", "important");
      document.documentElement.style.setProperty("--tvup-panel-width", state.ui.panelWidth + "px");
      setChartInset(state.ui.panelWidth);
      try { event.preventDefault(); event.stopPropagation(); } catch (_) {}
    };

    const onEnd = async (event) => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove("tvup-resizing-panel");
      handle.classList.remove("tvup-dragging");
      try { event && event.preventDefault(); } catch (_) {}
      await saveState();
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      onStart(e.clientX, e);
    }, { passive: false });

    handle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      onMove(e.clientX, e);
    }, { passive: false });

    handle.addEventListener("pointerup", onEnd, { passive: false });
    handle.addEventListener("pointercancel", onEnd, { passive: false });
  }

  function forceChartRelayout() {
    try {
      document.documentElement.classList.remove("tvup-hide-tv-toolbar");
      const hideSt = document.getElementById("tvup-hide-tv-toolbar-style");
      if (hideSt) hideSt.remove();
      const push = document.getElementById("tvup-chart-push");
      if (push) { push.textContent = ""; push.remove(); }
    } catch (_) {}
    try {
      document.querySelectorAll("[data-tvup-gap-hidden='1'], [data-tvup-was-hidden='1']").forEach((el) => {
        el.removeAttribute("data-tvup-gap-hidden");
        el.removeAttribute("data-tvup-was-hidden");
        try {
          el.style.removeProperty("display");
          el.style.removeProperty("width");
          el.style.removeProperty("min-width");
          el.style.removeProperty("max-width");
          el.style.removeProperty("opacity");
          el.style.removeProperty("pointer-events");
        } catch (_) {}
      });
    } catch (_) {}
    try { restoreBlankedChartSurfaces(); } catch (_) {}
    try { window.dispatchEvent(new Event("resize")); } catch (_) {}
    setTimeout(() => { try { window.dispatchEvent(new Event("resize")); } catch (_) {} }, 80);
  }

  function setChartInset(panelWidth) {
    let style = document.getElementById("tvup-chart-inset");
    if (!style) {
      style = document.createElement("style");
      style.id = "tvup-chart-inset";
      (document.head || document.documentElement).appendChild(style);
    }
    const w = Math.max(0, Math.round(Number(panelWidth) || 0));
    try { document.documentElement.style.removeProperty("padding-right"); } catch (_) {}
    if (!w) {
      style.textContent = "";
      try { document.body.style.removeProperty("padding-right"); } catch (_) {}
      forceChartRelayout();
      return;
    }
    style.textContent = `
      body.chart-page {
        padding-right: ${w}px !important;
        box-sizing: border-box !important;
      }
    `;
    forceChartRelayout();
  }

  function setupFabDrag(btn) {
    if (!btn || btn.dataset.dragBound === "1") return;
    btn.dataset.dragBound = "1";
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    const place = (x, y) => {
      const size = 48;
      const maxX = Math.max(0, window.innerWidth - size);
      const maxY = Math.max(0, window.innerHeight - size);
      const nx = Math.min(maxX, Math.max(0, x));
      const ny = Math.min(maxY, Math.max(0, y));
      btn.style.setProperty("left", nx + "px", "important");
      btn.style.setProperty("top", ny + "px", "important");
      btn.style.setProperty("right", "auto", "important");
      btn.style.setProperty("bottom", "auto", "important");
      state.ui.fabX = nx;
      state.ui.fabY = ny;
    };

    if (Number.isFinite(state.ui.fabX) && Number.isFinite(state.ui.fabY)) {
      place(state.ui.fabX, state.ui.fabY);
    }

    const onDown = (e) => {
      if (e.type === "pointerdown" && e.button != null && e.button !== 0) return;
      const pt = e.touches ? e.touches[0] : e;
      if (!pt) return;
      dragging = true;
      moved = false;
      startX = pt.clientX;
      startY = pt.clientY;
      const rect = btn.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      btn.classList.add("tvup-fab-dragging");
      try { if (e.pointerId != null) btn.setPointerCapture(e.pointerId); } catch (_) {}
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
    };
    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      if (!pt) return;
      const dx = pt.clientX - startX;
      const dy = pt.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      place(origX + dx, origY + dy);
      try { e.preventDefault(); } catch (_) {}
    };
    const onUp = async (e) => {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove("tvup-fab-dragging");
      if (moved) {
        btn.dataset.skipClick = "1";
        await saveState();
        setTimeout(() => { delete btn.dataset.skipClick; }, 80);
      }
    };

    btn.addEventListener("pointerdown", onDown, { passive: false });
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    btn.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp, { passive: false });
  }

  function applyTvToolbarVisibility() {
    try { state.ui.hideTvToolbar = false; } catch (_) {}
    restoreTvToolbarDom();
    try {
      document.documentElement.classList.remove("tvup-hide-tv-toolbar");
      const st = document.getElementById("tvup-hide-tv-toolbar-style");
      if (st) st.remove();
    } catch (_) {}
    try {
      const btn = document.getElementById("tvup-tv-toolbar-btn");
      if (btn) btn.remove();
    } catch (_) {}
  }

  function restoreTvToolbarDom() {
    try {
      document.querySelectorAll("[data-tvup-gap-hidden='1'], [data-tvup-was-hidden='1']").forEach((el) => {
        el.removeAttribute("data-tvup-gap-hidden");
        el.removeAttribute("data-tvup-was-hidden");
        try {
          el.style.removeProperty("display");
          el.style.removeProperty("width");
          el.style.removeProperty("min-width");
          el.style.removeProperty("max-width");
          el.style.removeProperty("flex");
          el.style.removeProperty("overflow");
          el.style.removeProperty("opacity");
          el.style.removeProperty("pointer-events");
        } catch (_) {}
      });
    } catch (_) {}
  }

  function applyLayout() {
    const root = $("#tvup-root");
    if (!root) return;

    const side = state.ui.panelSide || "right";
    const showBtn = $("#tvup-show-panel");
    applyTvToolbarVisibility();

    if (state.ui.collapsed) {
      root.style.setProperty("display", "none", "important");
      if (showBtn) {
        showBtn.style.setProperty("display", "flex", "important");
        const list = activeWatchlist();
        showBtn.innerHTML = `<span class="tvup-fab-avatar" id="tvup-fab-avatar">${escapeHTML(listInitial(list?.name || "W"))}</span>`;
        if (Number.isFinite(state.ui.fabX) && Number.isFinite(state.ui.fabY)) {
          showBtn.style.left = state.ui.fabX + "px";
          showBtn.style.top = state.ui.fabY + "px";
          showBtn.style.right = "auto";
          showBtn.style.bottom = "auto";
        }
      }
      document.documentElement.style.setProperty("--tvup-panel-width", "0px");
      setChartInset(0);
      return;
    }

    root.style.setProperty("display", "flex", "important");
    const width = Math.round(state.ui.panelWidth) || 300;
    root.style.setProperty("width", `${width}px`, "important");
    root.style.left = side === "left" ? "0" : "auto";
    root.style.right = side === "right" ? "0" : "auto";
    document.documentElement.style.setProperty("--tvup-panel-width", `${width}px`);
    root.dataset.side = side;

    const handle = root.querySelector("#tvup-resize-handle");
    if (handle) handle.dataset.side = side;

    if (showBtn) showBtn.style.setProperty("display", "none", "important");

    setChartInset(width);
  }

  function cleanupBrokenChartPush() {
    try {
      const push = document.getElementById("tvup-chart-push");
      if (push) { push.textContent = ""; push.remove(); }
      const hideSt = document.getElementById("tvup-hide-tv-toolbar-style");
      if (hideSt) hideSt.remove();
      document.documentElement.classList.remove("tvup-panel-open", "tvup-hide-tv-toolbar");
      try { document.documentElement.style.removeProperty("padding-right"); } catch (_) {}
    } catch (_) {}
  }

  function applyTheme() {
    const isLight = state.theme === "light";
    const root = $("#tvup-root");
    if (root) root.classList.toggle("tvup-light", isLight);

    ["#tvup-menu", "#tvup-flag-picker", "#tvup-modal-backdrop", "#tvup-confirm-backdrop",
     "#tvup-add-popup", "#tvup-import-modal", "#tvup-settings-modal", "#tvup-list-edit-menu"].forEach((sel) => {
      const el = $(sel);
      if (el) {
        el.classList.toggle("tvup-light", isLight);
        el.dataset.theme = isLight ? "light" : "dark";
      }
    });
  }

  function getSortValue(symbol, column) {
    if (column === "symbol") return symbol.toUpperCase();
    const data = liveData[symbol] || {};
    if (column === "last") return Number(data.last) || 0;
    if (column === "chg") return Number(data.chg) || 0;
    if (column === "chgPct") return Number(data.chgPct) || 0;
    return 0;
  }

  function changeSort(column) {
    if (state.sort.column !== column) {
      state.sort = { column, direction: 1 };
    } else if (state.sort.direction === 1) {
      state.sort.direction = -1;
    } else if (state.sort.direction === -1) {
      state.sort = { column: null, direction: 0 };
    }
    // Instant UI — local save only (no Firestore)
    try { renderTable(); } catch (_) {}
    try { saveStateLocal(); } catch (_) {}
  }

  function showActionMenu() {
    const menu = $("#tvup-menu");
    const button = $("#tvup-more");
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const themeClass = state.theme === "light" ? " tvup-light" : "";
    menu.className = "tvup-menu" + themeClass;
    const selOn = !!(state.ui && state.ui.selectMode);
    menu.innerHTML = `
      <div class="tvup-menu-section-label">Actions</div>
      <button type="button" class="tvup-menu-item" data-action="select-mode"><span class="tvup-mi-ico">${selOn ? "☑" : "☐"}</span><span class="tvup-mi-txt">Select mode (TV transfer)</span><span class="tvup-mi-info" style="opacity:0.75;margin-left:auto;font-size:11px;">${selOn ? "ON" : "OFF"}</span></button>
      <button type="button" class="tvup-menu-item" data-action="alerts"><span class="tvup-mi-ico">🔔</span><span class="tvup-mi-txt">Price Alerts</span></button>
      <button type="button" class="tvup-menu-item" data-action="settings"><span class="tvup-mi-ico">⚙</span><span class="tvup-mi-txt">Settings</span></button>
      <button type="button" class="tvup-menu-item" data-action="rename"><span class="tvup-mi-ico">✎</span><span class="tvup-mi-txt">Rename list</span></button>
      <button type="button" class="tvup-menu-item" data-action="add-section"><span class="tvup-mi-ico">☰</span><span class="tvup-mi-txt">Add section</span></button>
      <button type="button" class="tvup-menu-item" data-action="clear"><span class="tvup-mi-ico">⌫</span><span class="tvup-mi-txt">Clear list</span></button>
      <button type="button" class="tvup-menu-item" data-action="import"><span class="tvup-mi-ico">⇪</span><span class="tvup-mi-txt">Import CSV</span><span class="tvup-mi-info" title="CSV format help">i</span></button>
      <div class="tvup-menu-separator"></div>
      <button type="button" class="tvup-menu-item tvup-menu-danger" data-action="hide"><span class="tvup-mi-ico">‹</span><span class="tvup-mi-txt">Hide watchlist</span></button>
    `;
    const left = Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228));
    menu.style.left = left + "px";
    menu.style.top = (rect.bottom + 6) + "px";
    menu.style.display = "block";

    menu.querySelectorAll("[data-action]").forEach((item) => {
      item.addEventListener("click", async () => {
        menu.style.display = "none";
        const action = item.dataset.action;
        if (action === "hide") {
          state.ui.collapsed = true;
          await saveState();
          applyLayout();
          return;
        }
        if (action === "select-mode") {
          state.ui.selectMode = !state.ui.selectMode;
          if (!state.ui.selectMode) selectedSymbols.clear();
          try { await saveStateLocal(); } catch (_) {}
          try { renderSelectBar(); } catch (_) {}
          try { renderTable(); } catch (_) {}
          try { updateStatus(state.ui.selectMode ? "Select mode ON" : "Select mode OFF", "neutral"); } catch (_) {}
          return;
        }
        if (action === "add-section") addSectionToCurrent();
        if (action === "alerts") openAlertsManager();
        if (action === "settings") openSettings();
        if (action === "rename") renameCurrent();
        if (action === "clear") clearCurrent();
        if (action === "import") importCSV();
      });
    });
  }

  function showWatchlistMenu() {
    const menu = $("#tvup-menu");
    const button = $("#tvup-list-button");
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    menu.className = "tvup-menu" + (state.theme === "light" ? " tvup-light" : "");

    const row = (list) => `
      <button type="button" class="tvup-menu-item tvup-recent ${list.id === state.activeListId ? "tvup-menu-active" : ""}" data-recent="${escapeHTML(list.id)}">
        <span class="tvup-mi-ico">${list.starred ? "★" : "•"}</span>
        <span class="tvup-mi-txt">${escapeHTML(list.name || "List")}</span>
        <span class="tvup-mi-meta">${list.symbols.length}</span>
      </button>`;

    const allRows = state.watchlists.slice().sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" });
    });
    const starred = allRows.filter((l) => l.starred);
    const starredHtml = starred.map(row).join("");

    menu.innerHTML = `
      ${starredHtml
        ? `<div class="tvup-menu-section-label">★ Starred</div>${starredHtml}`
        : `<div class="tvup-menu-empty">No starred lists</div>`}
      <div class="tvup-menu-separator"></div>
      <button type="button" class="tvup-menu-item" data-action="new"><span class="tvup-mi-ico">＋</span><span class="tvup-mi-txt">Create new list</span></button>
      <button type="button" class="tvup-menu-item" data-action="open"><span class="tvup-mi-ico">▦</span><span class="tvup-mi-txt">Manage lists…</span></button>
    `;

    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 240));
    menu.style.left = left + "px";
    menu.style.top = (rect.bottom + 6) + "px";
    menu.style.display = "block";

    menu.querySelectorAll("[data-action]").forEach((item) => {
      item.addEventListener("click", () => {
        menu.style.display = "none";
        if (item.dataset.action === "new") createNewWatchlist();
        if (item.dataset.action === "open") openManagementModal();
      });
    });
    menu.querySelectorAll("[data-recent]").forEach((item) => {
      item.addEventListener("click", async () => {
        await switchWatchlist(item.dataset.recent);
        menu.style.display = "none";
      });
    });
  }

  async function switchWatchlist(id) {
    const list = state.watchlists.find((x) => x.id === id);
    if (!list) return;

    state.activeListId = id;
    state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 10);

    await saveState();
    render();
    refreshMarketData();
  }

  async function renameCurrent() {
    const list = activeWatchlist();
    if (list.color) return;
    const name = prompt("Rename watchlist:", list.name);
    if (!name || !name.trim()) return;

    list.name = name.trim();
    await saveState();
    render();
  }

  async function clearCurrent() {
    const list = activeWatchlist();
    if (!list.symbols.length) return;

    const ok = confirm(`Clear all ${list.symbols.length} symbols from watchlist?`);
    if (!ok) return;

    list.symbols = [];
    list.entries = [];
    await saveState();
    render();
  }

  async function createNewWatchlist() {
    const name = prompt("New watchlist name:");
    if (!name || !name.trim()) return;

    const list = {
      id: uid(),
      name: name.trim(),
      starred: false,
      symbols: [],
      entries: []
    };

    state.watchlists.push(list);
    state.activeListId = list.id;
    state.recent = [list.id, ...state.recent.filter((x) => x !== list.id)].slice(0, 10);

    await saveState();
    render();
    try {
      const bd = $("#tvup-modal-backdrop");
      if (bd && bd.style.display === "flex") renderManagementModal();
    } catch (_) {}
    refreshMarketData();
  }

  function parseCSVSymbols(fileText) {
    const lines = String(fileText || "").split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i].trim();
      if (!line) continue;
      if (i === 0 && /^(symbol|symbols|ticker|scrip|name)\b/i.test(line)) continue;
      const cell = line.split(/[,;\t]/)[0] || "";
      const sym = cell.replace(/["']/g, "").trim().toUpperCase();
      if (sym && /^[A-Z0-9&._-]+$/.test(sym)) out.push(sym);
    }
    return out;
  }

  /** Parse bulk paste: comma / space / newline / semicolon separated symbols */
  function parseBulkSymbols(text) {
    const raw = String(text || "");
    const parts = raw
      .split(/[\s,;|]+/)
      .map((s) => String(s || "").trim().toUpperCase().replace(/^(NSE|BSE|INDEXBOM|NSE_INDEX|BSE_INDEX):/i, ""))
      .map((s) => s.replace(/["']/g, "").trim())
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const p of parts) {
      if (!/^[A-Z0-9&._-]{1,32}$/.test(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  async function bulkAddSymbolsToWatchlist(symbols) {
    const list = activeWatchlist();
    if (!list || !Array.isArray(symbols) || !symbols.length) {
      return { added: 0, skipped: 0, total: list ? list.symbols.length : 0 };
    }
    const set = new Set(list.symbols.map((s) => String(s).toUpperCase()));
    let added = 0;
    let skipped = 0;
    for (const raw of symbols) {
      const sym = String(raw || "").toUpperCase();
      if (!sym) continue;
      if (set.has(sym)) {
        skipped += 1;
        continue;
      }
      set.add(sym);
      addSymbolToList(list, sym);
      added += 1;
      try { pushRecentSymbol(sym); } catch (_) {}
    }
    await saveState();
    render();
    try { refreshMarketData(); } catch (_) {}
    return { added, skipped, total: list.symbols.length };
  }

  function pickAndImportCSVFile(onDone) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.txt,text/csv,text/plain";
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px;";
    document.documentElement.appendChild(input);
    const cleanup = () => {
      try { input.remove(); } catch (_) {}
      try { if (typeof onDone === "function") onDone(); } catch (_) {}
    };
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        updateStatus("No file selected", "neutral");
        return;
      }
      try {
        const textContent = await file.text();
        const symbols = parseCSVSymbols(textContent);
        if (!symbols.length) {
          updateStatus("No valid symbols in CSV", "error");
          return;
        }
        const list = activeWatchlist();
        if (!list) return;
        const before = list.symbols.length;
        {
          ensureListEntries(list);
          for (const s of symbols) addSymbolToList(list, s);
        }
        const added = list.symbols.length - before;
        await saveState();
        render();
        refreshMarketData();
        updateStatus(`Imported ${added} symbol${added === 1 ? "" : "s"}`, "online");
      } catch (err) {
        console.error("[TVUP] CSV import failed:", err);
        updateStatus("CSV import failed", "error");
      }
    });
    input.addEventListener("cancel", cleanup);
    try {
      input.click();
    } catch (err) {
      cleanup();
      updateStatus("Cannot open file picker", "error");
    }
  }

  function importCSV() {
    const existing = $("#tvup-import-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "tvup-import-modal";
    modal.className = "tvup-settings-modal" + (state.theme === "light" ? " tvup-light" : "");
    modal.dataset.theme = state.theme === "light" ? "light" : "dark";
    modal.innerHTML = `
      <div class="tvup-settings-card" data-theme="${state.theme === "light" ? "light" : "dark"}">
        <div class="tvup-settings-top">
          <div class="tvup-settings-heading">
            <div class="tvup-settings-title">Import CSV</div>
            <div class="tvup-settings-subtitle">Add many symbols at once</div>
          </div>
          <button type="button" class="tvup-settings-x" id="tvup-import-close" title="Close">×</button>
        </div>
        <div class="tvup-settings-body">
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title tvup-settings-section-title-row">
              <span>CSV format</span>
              <button type="button" class="tvup-info-btn tvup-info-btn-on" id="tvup-import-info" title="Format help">i</button>
            </div>
            <div class="tvup-token-help" id="tvup-import-help">
              <div class="tvup-token-help-title">How to format your CSV / TXT file</div>
              <ol class="tvup-token-help-steps">
                <li>One symbol per line, <b>or</b> comma / semicolon separated.</li>
                <li>Use NSE / TradingView tickers (e.g. <code>RELIANCE</code>, <code>TCS</code>, <code>NIFTY</code>).</li>
                <li>Optional header is OK: <code>Symbol</code> or <code>Ticker</code>.</li>
                <li>If multiple columns, only the <b>first column</b> is used.</li>
                <li>Allowed characters: A–Z, 0–9, <code>&amp;</code> <code>.</code> <code>-</code> (no spaces).</li>
              </ol>
              <div class="tvup-token-help-title">Example</div>
              <pre class="tvup-csv-example">Symbol
RELIANCE
TCS
INFY
HDFCBANK
SENSEX
BANKNIFTY</pre>
            </div>
          </section>
        </div>
        <div class="tvup-settings-footer">
          <button type="button" class="tvup-button" id="tvup-import-cancel">Cancel</button>
          <button type="button" class="tvup-button tvup-button-primary" id="tvup-import-pick">Choose CSV file</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(modal);

    const close = () => modal.remove();
    $("#tvup-import-close").onclick = close;
    $("#tvup-import-cancel").onclick = close;
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    const help = $("#tvup-import-help");
    const infoBtn = $("#tvup-import-info");
    if (infoBtn && help) {
      infoBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = help.hasAttribute("hidden");
        if (open) help.removeAttribute("hidden");
        else help.setAttribute("hidden", "");
        infoBtn.classList.toggle("tvup-info-btn-on", open);
      };
    }

    $("#tvup-import-pick").onclick = (e) => {
      safePrevent(e);
      pickAndImportCSVFile(() => close());
    };
  }

  function renderStarBar() {
    const bar = $("#tvup-star-bar");
    if (!bar) return;
    const starred = state.watchlists.filter((x) => x.starred);
    if (!starred.length) {
      bar.hidden = true;
      bar.setAttribute("hidden", "");
      bar.style.setProperty("display", "none", "important");
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.removeAttribute("hidden");
    bar.style.setProperty("display", "flex", "important");
    bar.innerHTML = starred.map((list) => {
      const isColor = list.color && list.color !== "none";
      const colorLabel = isColor
        ? (list.color.charAt(0).toUpperCase() + list.color.slice(1))
        : "";
      const inner = isColor
        ? `<span class="tvup-star-chip-flag tvup-flag-${escapeHTML(list.color)}" title="${escapeHTML(colorLabel)}"></span>`
        : (list.emoji
          ? `<span class="tvup-star-chip-emoji">${list.emoji}</span>`
          : `<span class="tvup-star-chip-av">${escapeHTML(listInitial(list.name || "W"))}</span>`);
      return `<button type="button" class="tvup-star-chip ${list.id === state.activeListId ? "tvup-star-chip-active" : ""} ${isColor ? "tvup-star-chip-color" : ""}" data-star-chip="${escapeHTML(list.id)}" title="${escapeHTML(isColor ? colorLabel : (list.name || "List"))}">${inner}</button>`;
    }).join("");
    bar.querySelectorAll("[data-star-chip]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await switchWatchlist(btn.dataset.starChip);
      });
    });
  }

  function openManagementModal() {
    renderManagementModal();
    const bd = $("#tvup-modal-backdrop");
    if (bd) {
      bd.classList.toggle("tvup-light", state.theme === "light");
      bd.dataset.theme = state.theme === "light" ? "light" : "dark";
      bd.style.display = "flex";
    }
  }

  function closeManagementModal() {
    $("#tvup-modal-backdrop").style.display = "none";
  }

  function renderManagementModal() {
    const container = $("#tvup-modal-list");
    const lists = [...state.watchlists].sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" });
    });
    const flagged = lists.filter((l) => l.color && l.color !== "none");
    const created = lists.filter((l) => !(l.color && l.color !== "none"));

    const rowHTML = (list) => {
      const isColor = list.color && list.color !== "none";
      const displayName = isColor
        ? (list.color.charAt(0).toUpperCase() + list.color.slice(1) + " list")
        : (list.name || "List");
      const filterText = `${list.name || ""} ${displayName} ${list.color || ""} ${list.emoji || ""}`.toLowerCase();
      const icon = isColor
        ? `<span class="tvup-star-chip-flag tvup-flag-${escapeHTML(list.color)}"></span>`
        : (list.emoji
          ? `<span class="tvup-list-emoji" aria-hidden="true">${list.emoji}</span>`
          : `<span class="tvup-list-avatar tvup-list-avatar-sm">${escapeHTML(listInitial(list.name || "W"))}</span>`);
      return `
      <div class="tvup-list-row ${list.id === state.activeListId ? "tvup-list-row-active" : ""}" data-list-filter="${escapeHTML(filterText)}">
        <button class="tvup-star-button ${list.starred ? "tvup-starred" : ""}" data-star="${escapeHTML(list.id)}" title="Star priority">★</button>
        <div class="tvup-list-name" data-open-list="${escapeHTML(list.id)}">
          ${icon}
          <span class="tvup-list-title">${escapeHTML(displayName)}</span>
          ${!isColor ? `<button type="button" class="tvup-list-rename" data-list-rename="${escapeHTML(list.id)}" title="Rename / emoji" aria-label="Rename">✎</button>` : ""}
        </div>
        <div class="tvup-count">${list.symbols.length}</div>
        <button class="tvup-list-delete" data-list-delete="${escapeHTML(list.id)}" title="Delete">✕</button>
      </div>`;
    };

    container.innerHTML = `
      <div class="tvup-mgmt-search-wrap">
        <input type="search" id="tvup-mgmt-search" class="tvup-input" placeholder="Search lists" autocomplete="off" />
      </div>
      <div id="tvup-mgmt-rows">
        ${flagged.length ? `<div class="tvup-mgmt-section-label">FLAGGED LISTS</div>${flagged.map(rowHTML).join("")}` : ""}
        <div class="tvup-mgmt-section-label">CREATED LISTS</div>
        ${created.length ? created.map(rowHTML).join("") : `<div class="tvup-menu-empty">No lists</div>`}
      </div>`;

    const search = container.querySelector("#tvup-mgmt-search");
    if (search) {
      search.addEventListener("input", () => {
        const q = String(search.value || "").trim().toLowerCase();
        container.querySelectorAll("#tvup-mgmt-rows .tvup-list-row").forEach((row) => {
          const name = (row.getAttribute("data-list-filter") || "").toLowerCase();
          const show = !q || name.includes(q);
          row.style.setProperty("display", show ? "flex" : "none", "important");
        });
      });
      search.addEventListener("keydown", (e) => {
        e.stopPropagation();
      });
    }

    container.querySelectorAll("[data-star]").forEach((button) => {
      button.addEventListener("click", async () => {
        const list = state.watchlists.find((x) => x.id === button.dataset.star);
        if (!list) return;
        list.starred = !list.starred;
        await saveState();
        renderManagementModal();
        renderStarBar();
      });
    });

    container.querySelectorAll("[data-open-list]").forEach((row) => {
      row.addEventListener("click", async () => {
        await switchWatchlist(row.dataset.openList);
        closeManagementModal();
      });
    });
    container.querySelectorAll("[data-list-delete]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = button.dataset.listDelete;
        const list = state.watchlists.find((x) => x.id === id);
        if (!list) return;

        if (state.watchlists.length === 1) {
          alert("You cannot delete the last watchlist.");
          return;
        }

        openConfirm(`Delete this watchlist?`, id);
      });
    });

    container.querySelectorAll("[data-list-rename]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        const id = button.dataset.listRename;
        const list = state.watchlists.find((x) => x.id === id);
        if (!list || (list.color && list.color !== "none")) return;
        openListEditMenu(list, button);
      });
    });
  }

  function openListEditMenu(list, anchor) {
    let menu = $("#tvup-list-edit-menu");
    if (menu) menu.remove();
    menu = document.createElement("div");
    menu.id = "tvup-list-edit-menu";
    const emojiGroups = [
      ["Popular", "⭐ 🌟 ✨ 🔥 🚀 📈 📉 💰 💎 🎯 ⚡ 🔔 🚩 🏆 👑 💥 ✅ ❌ ⚠️ ❗"],
      ["Market & Money", "📊 💹 💵 💴 💶 💷 💸 💳 🏦 🏧 🪙 🧾 💼 🏢 🏛️ ⚖️ 🧮 📌 📍 🔒 🔓 🔑 ⏳ ⏰ 📅 🗓️"],
      ["Status & Signals", "🆕 🆗 🔝 🏁 🥇 🥈 🥉 🎖️ 🚫 ❓ ♻️ 🔁 🔄 ⬆️ ⬇️ ↗️ ↘️ ➡️ ⬅️ 🔼 🔽 ➕ ➖ ☑️"],
      ["Colors & Shapes", "🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔶 🔷 🔺 🔻 💠 ♦️"],
      ["Hearts", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💖 💗 💝"],
      ["Sectors", "🏭 ⚙️ 🔧 🛠️ 🔩 🏗️ 🧱 ⛏️ 🛢️ ⛽ 🔋 🔌 💡 ☀️ 🌬️ 💧 🚗 🚙 🚚 🚛 🏍️ ✈️ 🚢 🚆 💊 💉 🧪 🧬 🏥 🩺 💻 🖥️ 📱 📡 🛰️ 🤖 🧠 🎮 🎬 📺 📰 🏠 🏘️ 🏨 🛒 🛍️ 🧴 🧵 👕 👟 💍 ⌚ 🎓 📚 🏫"],
      ["Agri & Food", "🌾 🚜 🐄 🐟 🥛 ☕ 🍵 🍺 🍷 🥤 🍔 🍕 🍞 🍚 🌶️ 🧂 🍬 🍫 🥭 🍎 🍌 🥕 🌽 🥥"],
      ["Nature & Weather", "🌱 🌳 🌴 🌸 🌻 🍀 🍁 🌍 🌙 ☁️ ☔ ❄️ 🌈 🌊 ⛰️"],
      ["Animals", "🐂 🐻 🦁 🐯 🐘 🐎 🦅 🐢 🐇 🦊 🐼 🐶 🐱 🐝 🦋"],
      ["People & Fun", "👍 👎 👀 🙏 💪 🤝 👌 ✌️ 🧘 😎 🤑 😍 🤔 😴 🙌 🎉 🎁"],
      ["Other", "📝 📋 📁 📂 🗂️ 🔍 🔎 🧭 🗺️ 🎲 🧩 ♟️ 🎨 🎵 ⚽ 🏏 🏀 🏸 🧿 🪔 🕉️ 🔱 🇮🇳"]
    ];
    const emojiHTML = emojiGroups.map(([label, list], i) => `
      <div class="tvup-edit-emoji-cat">${label}</div>
      <div class="tvup-edit-emoji-grid">
        ${i === 0 ? `<button type="button" class="tvup-edit-emoji" data-emoji="" title="Clear">∅</button>` : ""}
        ${list.split(" ").map((e) => `<button type="button" class="tvup-edit-emoji" data-emoji="${e}">${e}</button>`).join("")}
      </div>`).join("");
    menu.innerHTML = `
      <button type="button" class="tvup-edit-rename" data-act="rename">✎ Rename list</button>
      <div class="tvup-edit-emoji-label">Choose icon</div>
      ${emojiHTML}
    `;
    document.documentElement.appendChild(menu);
    menu.style.display = "block";
    menu.style.visibility = "hidden";
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 300;
    const natural = Math.min(menu.scrollHeight || 420, 420);
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 16;
    let left = rect.left;
    if (left + mw > window.innerWidth - 10) left = window.innerWidth - mw - 10;
    if (left < 10) left = 10;
    let top, mh;
    if (spaceBelow >= natural || spaceBelow >= spaceAbove) {
      // enough room below (or more room below than above): open downward
      mh = Math.max(160, Math.min(natural, spaceBelow));
      top = rect.bottom + 6;
    } else {
      // near the bottom of the screen: open UPWARD so the menu is never cut off
      mh = Math.max(160, Math.min(natural, spaceAbove));
      top = rect.top - mh - 6;
    }
    if (top < 10) top = 10;
    if (top + mh > window.innerHeight - 10) mh = Math.max(120, window.innerHeight - 10 - top);
    menu.style.setProperty("max-height", mh + "px", "important");
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    const onScroll = (ev) => { if (!menu.contains(ev.target)) close(); };
    const close = () => {
      try { menu.remove(); } catch (_) {}
      try { document.removeEventListener("scroll", onScroll, true); } catch (_) {}
    };
    setTimeout(() => document.addEventListener("scroll", onScroll, true), 0);
    menu.querySelector('[data-act="rename"]').onclick = async (e) => {
      e.stopPropagation();
      close();
      const name = prompt("Rename watchlist:", list.name || "List");
      if (!name || !name.trim()) return;
      list.name = name.trim();
      await saveState();
      renderManagementModal();
      render();
    };
    menu.querySelectorAll("[data-emoji]").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const em = btn.getAttribute("data-emoji") || "";
        if (em) list.emoji = em;
        else delete list.emoji;
        await saveState();
        close();
        renderManagementModal();
        renderStarBar();
        render();
      };
    });
    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) {
        close();
        document.removeEventListener("click", onDoc, true);
      }
    };
    setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  }

  function openConfirm(message, deleteId, action) {
    const title = $("#tvup-confirm-title");
    if (title) title.textContent = action === "alert_delete_all" ? "Delete all alerts?" : "Confirm";
    $("#tvup-confirm-message").textContent = message;
    const ok = $("#tvup-confirm-ok");
    if (ok) {
      if (deleteId) ok.dataset.deleteId = deleteId;
      else delete ok.dataset.deleteId;
      if (action) ok.dataset.action = action;
      else delete ok.dataset.action;
      ok.textContent = action === "alert_delete_all" ? "Delete all" : "Delete";
    }
    $("#tvup-confirm-backdrop").style.display = "flex";
  }

  function closeConfirm() {
    $("#tvup-confirm-backdrop").style.display = "none";
    const ok = $("#tvup-confirm-ok");
    if (ok) {
      delete ok.dataset.deleteId;
      delete ok.dataset.action;
      ok.textContent = "Delete";
    }
    const title = $("#tvup-confirm-title");
    if (title) title.textContent = "Confirm";
  }


  function fyersAuthStatusHtml() {
    if (state.token) {
      return `<div class="tvup-fyers-status tvup-fyers-status-ok">✓ Upstox API key saved</div>`;
    }
    return `<div class="tvup-fyers-status tvup-fyers-status-warn">⚠ Settings mein Upstox API key daalo</div>`;
  }

  async function openSettings() {
    const existing = $("#tvup-settings-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "tvup-settings-modal";
    modal.className = "tvup-settings-modal" + (state.theme === "light" ? " tvup-light" : "");
    modal.dataset.theme = state.theme === "light" ? "light" : "dark";
    modal.innerHTML = `
      <div class="tvup-settings-card" data-theme="${state.theme === "light" ? "light" : "dark"}">
        <div class="tvup-settings-top">
          <div class="tvup-settings-heading">
            <div class="tvup-settings-title">Settings</div>
            <div class="tvup-settings-subtitle">Theme · Upstox API key</div>
          </div>
          <button type="button" class="tvup-settings-x" id="tvup-settings-close" title="Close">×</button>
        </div>
        <div class="tvup-settings-body">
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Theme</div>
            <select class="tvup-input" id="tvup-theme-input">
              <option value="dark" ${state.theme === "dark" ? "selected" : ""}>Dark</option>
              <option value="light" ${state.theme === "light" ? "selected" : ""}>Light</option>
            </select>
          </section>
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Mobile alerts</div>
            <label class="tvup-settings-label">Firebase Project ID</label>
            <input type="text" id="tvup-fb-project" class="tvup-input" placeholder="my-project-id" autocomplete="off" />
            <label class="tvup-settings-label">Firebase Web API Key</label>
            <input type="password" id="tvup-fb-apikey" class="tvup-input" placeholder="AIza..." autocomplete="off" />
            <label class="tvup-settings-label">Android FCM device token</label>
            <input type="text" id="tvup-fcm-token" class="tvup-input" placeholder="Paste FCM token from Android" autocomplete="off" />
          </section>
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Keyboard navigation</div>
            <label class="tvup-settings-check" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;line-height:1.35;">
              <input type="checkbox" id="tvup-keyboard-nav" ${state.ui.keyboardNav !== false ? "checked" : ""} style="margin-top:3px;width:16px;height:16px;flex-shrink:0;" />
              <span>
                <b>TVUP arrows / Space</b><br/>
                <span style="opacity:0.75;font-size:12px;">ON = ↑↓ and Space change our watchlist chart (panel hide pe bhi). OFF = native TradingView watchlist.</span>
              </span>
            </label>
            <label class="tvup-settings-check" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;line-height:1.35;margin-top:12px;">
              <input type="checkbox" id="tvup-quick-add-search" ${state.ui.quickAddSearch === true ? "checked" : ""} style="margin-top:3px;width:16px;height:16px;flex-shrink:0;" />
              <span>
                <b>Type-to-add (TVUP +)</b><br/>
                <span style="opacity:0.75;font-size:12px;">ON = keyboard se letter dabate hi hamara + search khule. OFF = TradingView native search.</span>
              </span>
            </label>
          </section>
          
          
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Backup &amp; Restore</div>
            <p style="opacity:0.75;font-size:12px;margin:0 0 8px;line-height:1.4;">
              Watchlists, flags, alerts aur settings ka backup file banao. Naya zip / naya folder load karne par Restore se sab wapas aa jayega.
            </p>
            <div style="display:flex;gap:8px;">
              <button type="button" class="tvup-button" id="tvup-backup-btn">Backup</button>
              <button type="button" class="tvup-button" id="tvup-restore-btn">Restore</button>
            </div>
            <input type="file" id="tvup-restore-file" accept=".json,application/json" style="display:none;" />
          </section>

          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Setup guide</div>
            <p style="font-size:13px;line-height:1.5;opacity:0.9;margin:0;">
              This build is <b>Upstox only</b>. Full setup guide is inside the ZIP file:
              <b>TVUP_UPSTOX_SETUP.md</b>.
              Extract the ZIP, open that file, and follow the steps from scratch
              (Upstox, Telegram, Firebase, Render, alerts).
            </p>
          </section>

          <section class="tvup-settings-section tvup-about-section">
            <div class="tvup-settings-section-title">About</div>
            <div class="tvup-about-box">
              <div class="tvup-about-name">TVUP Watchlist for Upstox</div>
              <div class="tvup-about-line"><b>Made by</b> MITHUN MALI</div>
              <div class="tvup-about-line">Sirohi, Rajasthan, India</div>
              <div class="tvup-about-line tvup-about-muted">Version 3.1.44</div>
            </div>
          </section>
          <section class="tvup-settings-section">
            <div class="tvup-settings-section-title">Upstox API key</div>
            <label class="tvup-settings-label">API key (access token)</label>
            <input class="tvup-input tvup-token-field" id="tvup-token-input" type="password" autocomplete="off" value="${escapeHTML(state.token)}" ${state.ui.tokenLocked ? "disabled" : ""} placeholder="Paste Upstox access token" />
            <div class="tvup-token-row">
              <span class="tvup-token-note">Locked by default</span>
              <button type="button" class="tvup-button" id="tvup-token-toggle">${state.ui.tokenLocked ? "Unlock" : "Lock"}</button>
            </div>
            <p style="opacity:0.75;font-size:12px;margin:8px 0 0;line-height:1.4;">
              Upstox Developer Console se access token paste karo. Sirf yahi field chahiye.
            </p>
          </section>
        </div>
        <div class="tvup-settings-footer">
          <button type="button" class="tvup-button" id="tvup-settings-cancel">Cancel</button>
          <button type="button" class="tvup-button tvup-button-primary" id="tvup-settings-save">Save</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(modal);

    $("#tvup-settings-close").onclick = () => modal.remove();
    $("#tvup-settings-cancel").onclick = () => modal.remove();

    // ---- Backup / Restore (survives new folder / new extension ID) ----
    $("#tvup-backup-btn").onclick = async () => {
      try {
        try { await saveStateLocal(); } catch (_) {}
        const all = await chrome.storage.local.get(null);
        const data = {};
        Object.keys(all || {}).forEach((k) => { if (k.indexOf("tvup_") === 0) data[k] = all[k]; });
        const payload = { tvupBackup: true, version: TVUP_VERSION, savedAt: new Date().toISOString(), data };
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "TVUP_backup_" + new Date().toISOString().slice(0, 10) + ".json";
        document.documentElement.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (_) {} }, 1500);
        updateStatus("Backup downloaded", "online");
      } catch (err) {
        alert("Backup failed. Dobara try karo.");
      }
    };
    $("#tvup-restore-btn").onclick = () => { try { $("#tvup-restore-file").click(); } catch (_) {} };
    $("#tvup-restore-file").onchange = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const data = parsed && parsed.tvupBackup && parsed.data ? parsed.data : null;
        if (!data || !Array.isArray(data.tvup_watchlists) || !data.tvup_watchlists.length) {
          alert("Ye valid TVUP backup file nahi hai.");
          return;
        }
        if (!confirm("Restore karne par abhi ki watchlists/flags/alerts is backup se replace ho jayengi. Continue?")) return;
        const clean = {};
        Object.keys(data).forEach((k) => { if (k.indexOf("tvup_") === 0) clean[k] = data[k]; });
        await chrome.storage.local.set(clean);
        window.location.reload();
      } catch (err) {
        alert("Restore failed. File check karke dobara try karo.");
      }
    };

    const lockFyersFields = (locked) => {
      [
        "tvup-token-input"
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = !!locked;
          el.readOnly = !!locked;
          if (!locked) el.style.pointerEvents = "auto";
        }
      });
    };

    // If permanent setup incomplete, start unlocked so user can paste
    if (!(state.fyersSecret && state.fyersRefresh && state.fyersPin)) {
      state.ui.tokenLocked = false;
    }
    lockFyersFields(state.ui.tokenLocked);
    const tog = document.getElementById("tvup-token-toggle");
    if (tog) tog.textContent = state.ui.tokenLocked ? "Unlock" : "Lock";

    $("#tvup-token-toggle").onclick = () => {
      state.ui.tokenLocked = !state.ui.tokenLocked;
      lockFyersFields(state.ui.tokenLocked);
      $("#tvup-token-toggle").textContent = state.ui.tokenLocked ? "Unlock" : "Lock";
      if (!state.ui.tokenLocked) document.getElementById("tvup-token-input")?.focus();
    };

    const fbProj = $("#tvup-fb-project");
    const fbKey = $("#tvup-fb-apikey");
    const fcmIn = $("#tvup-fcm-token");
    if (fbProj) fbProj.value = state.fbProject || "";
    if (fbKey) fbKey.value = state.fbApiKey || "";
    if (fcmIn) fcmIn.value = state.fcmToken || "";

    $("#tvup-settings-save").onclick = async () => {
      if (!state.ui.tokenLocked) {
        state.token = (document.getElementById("tvup-token-input")?.value || "").replace(/\s+/g, "").trim();
        if (state.token) state.fyersTokenAt = Date.now();
        state.fyersAuthError = "";
      }
      state.theme = $("#tvup-theme-input").value;
      if (fbProj) state.fbProject = fbProj.value.trim();
      if (fbKey) state.fbApiKey = fbKey.value.trim();
      if (fcmIn) state.fcmToken = fcmIn.value.trim();
      const kb = document.getElementById("tvup-keyboard-nav");
      if (kb) state.ui.keyboardNav = !!kb.checked;
      const qa = document.getElementById("tvup-quick-add-search");
      if (qa) state.ui.quickAddSearch = !!qa.checked;
      state.ui.tokenLocked = true;
      await saveState();
      try { await syncAlertsToCloud(); } catch (_) {}
      applyTheme();
      applyLayout();
      modal.remove();
      updateStatus();
      refreshMarketData();
    };
  }

  async function refreshMarketData() {
    if (!ensureExtensionContext()) return;

    if (__tvupRefreshing) return;
    __tvupRefreshing = true;

    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    if (!state.token) {
      __tvupRefreshing = false;
      updateStatus("Add Upstox API key in Settings", "error");
      scheduleRefresh();
      return;
    }

    const list = activeWatchlist();
    const watchSyms = (list && Array.isArray(list.symbols)) ? list.symbols.slice() : [];
    // Also fetch LTP for active price-alert symbols (indices may not be on watchlist)
    const alertSyms = [];
    try {
      for (const [aid, rule] of Object.entries(state.alerts || {})) {
        if (!rule) continue;
        const st = String(rule.status || "active").toLowerCase();
        if (st === "paused" || st === "triggered") continue;
        if (rule.armed === false) continue;
        const sym = String(rule.symbol || "").toUpperCase();
        if (sym) alertSyms.push(sym);
      }
    } catch (_) {}
    const allSyms = [...new Set([...watchSyms.map((s) => String(s).toUpperCase()), ...alertSyms])];
    if (!allSyms.length) {
      __tvupRefreshing = false;
      updateStatus("No symbols", "neutral");
      scheduleRefresh();
      return;
    }

    try {
      updateStatus("Updating...", "neutral");

      const resolved = await resolveInstrumentKeys(allSyms);
      let keys = resolved.keys;
      let symbolToKey = resolved.symbolToKey;
      // Fill ISIN-based keys from Upstox public master
      try {
        const extra = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "TVUP_RESOLVE_INSTRUMENT_KEYS", symbols: allSyms }, (r) => {
            resolve(r && r.ok ? (r.data || {}) : {});
          });
        });
        for (const [sym, key] of Object.entries(extra || {})) {
          if (!key) continue;
          symbolToKey[sym] = key;
          symbolToKey[String(sym).toUpperCase()] = key;
          if (!keys.includes(key)) keys.push(key);
        }
      } catch (_) {}

      if (!keys.length) {
        __tvupRefreshing = false;
        updateStatus("No valid NSE symbols found", "error");
        scheduleRefresh();
        return;
      }

      if (!isExtensionContextValid()) {
        throw new Error("Extension context expired — reload the TradingView tab once");
      }

      // Upstox: fetch full list; service worker chunks by 50
      const batchKeys = keys;

      const result = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: "TVUP_MARKET_QUOTE",
            token: state.token,
            appId: state.fyersAppId,
            fyersAppId: state.fyersAppId,
            instrumentKeys: batchKeys,
            symbols: batchKeys
          }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, reason: chrome.runtime.lastError.message || "Market-data request failed" });
              return;
            }
            resolve(response || { ok: false, reason: "No response from extension worker" });
          });
        } catch (error) {
          resolve({ ok: false, reason: String(error?.message || error || "Market-data request failed") });
        }
      });

      if (!result?.ok) throw new Error(result?.reason || "Market data request failed");

      parseMarketData(result.data, symbolToKey);
      try { checkPriceAlerts(); } catch (_) {}

      refreshBackoffMs = Math.max(0, Math.floor((refreshBackoffMs || 0) / 2));
      const filled = Object.keys(liveData || {}).length;
      updateStatus(`Live data • ${filled} quotes • ${new Date().toLocaleTimeString()}`, "online");
      updateLiveCells();
    } catch (error) {
      const msg = String(error?.message || error || "");
      if (/429|rate|too many|limit/i.test(msg)) {
        refreshBackoffMs = Math.min(90000, Math.max(20000, (refreshBackoffMs || 0) * 2 || 20000));
        if (chrome.runtime?.id) {
          updateStatus(`Rate limit (not API key) — wait ${Math.round((REFRESH_MS + refreshBackoffMs) / 1000)}s · list too large`, "error");
        }
      } else if (/valid token|token rejected|token required|auto-refresh failed|refresh failed/i.test(msg)) {
        refreshBackoffMs = Math.min(60000, Math.max(10000, (refreshBackoffMs || 0) + 10000));
        if (chrome.runtime?.id) {
          updateStatus(`API key invalid — paste a new Upstox access token in Settings`, "error");
        }
        // Ask background to refresh on next cycle
        try {
          chrome.runtime.sendMessage({ type: "TVUP_MARKET_QUOTE", forceRefresh: true, symbols: [], instrumentKeys: [] }, () => {});
        } catch (_) {}
      } else if (chrome.runtime?.id) {
        updateStatus(`Market data: ${msg.slice(0, 80)}`, "error");
      }
    } finally {
      __tvupRefreshing = false;
    }

    scheduleRefresh();
  }

  function scheduleRefresh() {
    if (!isExtensionContextValid()) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const list = activeWatchlist();
    const n = (list?.symbols || []).length;
    // Large watchlists need slower cadence so every symbol gets quotes without 429
    const sizeBonus = n > 150 ? Math.min(8000, Math.floor(n / 80) * 1000) : 0;
    const delay = REFRESH_MS + sizeBonus + (refreshBackoffMs || 0);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshMarketData();
    }, delay);
  }

  function isExtensionContextValid() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function ensureExtensionContext() {
    if (isExtensionContextValid()) return true;
    try {
      updateStatus("Extension updated — reload this TradingView tab once", "error");
    } catch (_) {}
    return false;
  }

  async function resolveInstrumentKeys(symbols) {
    // Fyers symbols only — no Upstox instrument keys

    // NSE renamed / alternate tickers (Fyers master)

    const INDEX_UPSTOX = {
      NIFTY: "NSE_INDEX|Nifty 50", NIFTY50: "NSE_INDEX|Nifty 50",
      BANKNIFTY: "NSE_INDEX|Nifty Bank", NIFTYBANK: "NSE_INDEX|Nifty Bank",
      FINNIFTY: "NSE_INDEX|Nifty Fin Service", CNXFINANCE: "NSE_INDEX|Nifty Fin Service", NIFTYFIN: "NSE_INDEX|Nifty Fin Service",
      MIDCPNIFTY: "NSE_INDEX|NIFTY MID SELECT", NIFTYMIDSELECT: "NSE_INDEX|NIFTY MID SELECT", NIFTY_MID_SELECT: "NSE_INDEX|NIFTY MID SELECT",
      NIFTYNXT50: "NSE_INDEX|Nifty Next 50", NIFTYNEXT50: "NSE_INDEX|Nifty Next 50", NIFTYJR: "NSE_INDEX|Nifty Next 50", NEXT50: "NSE_INDEX|Nifty Next 50",
      NIFTY100: "NSE_INDEX|Nifty 100", CNX100: "NSE_INDEX|Nifty 100",
      NIFTY200: "NSE_INDEX|Nifty 200", CNX200: "NSE_INDEX|Nifty 200",
      NIFTY500: "NSE_INDEX|Nifty 500", CNX500: "NSE_INDEX|Nifty 500",
      NIFTYMIDCAP100: "NSE_INDEX|NIFTY MIDCAP 100", CNXMIDCAP: "NSE_INDEX|NIFTY MIDCAP 100", MIDCAP100: "NSE_INDEX|NIFTY MIDCAP 100", "NIFTY MIDCAP 100": "NSE_INDEX|NIFTY MIDCAP 100",
      NIFTYMIDCAP50: "NSE_INDEX|Nifty Midcap 50", MIDCAP50: "NSE_INDEX|Nifty Midcap 50", "NIFTY MIDCAP 50": "NSE_INDEX|Nifty Midcap 50",
      NIFTYMIDCAP150: "NSE_INDEX|NIFTY MIDCAP 150", MIDCAP150: "NSE_INDEX|NIFTY MIDCAP 150", "NIFTY MIDCAP 150": "NSE_INDEX|NIFTY MIDCAP 150",
      NIFTYSMLCAP100: "NSE_INDEX|NIFTY SMLCAP 100", CNXSMALLCAP: "NSE_INDEX|NIFTY SMLCAP 100", SMALLCAP100: "NSE_INDEX|NIFTY SMLCAP 100", SMLCAP100: "NSE_INDEX|NIFTY SMLCAP 100", "NIFTY SMLCAP 100": "NSE_INDEX|NIFTY SMLCAP 100",
      NIFTYSMLCAP250: "NSE_INDEX|NIFTY SMLCAP 250", SMALLCAP250: "NSE_INDEX|NIFTY SMLCAP 250", SMLCAP250: "NSE_INDEX|NIFTY SMLCAP 250", "NIFTY SMLCAP 250": "NSE_INDEX|NIFTY SMLCAP 250",
      NIFTYSMLCAP50: "NSE_INDEX|NIFTY SMLCAP 50", SMALLCAP50: "NSE_INDEX|NIFTY SMLCAP 50", SMLCAP50: "NSE_INDEX|NIFTY SMLCAP 50", "NIFTY SMLCAP 50": "NSE_INDEX|NIFTY SMLCAP 50",
      NIFTYMIDSML400: "NSE_INDEX|NIFTY MIDSML 400", MIDSML400: "NSE_INDEX|NIFTY MIDSML 400", "NIFTY MIDSML 400": "NSE_INDEX|NIFTY MIDSML 400",
      NIFTYSMLCAP500: "NSE_INDEX|Nifty Smallcap 500", NIFTY_SMALLCAP_500: "NSE_INDEX|Nifty Smallcap 500", SMALLCAP500: "NSE_INDEX|Nifty Smallcap 500", SMLCAP500: "NSE_INDEX|Nifty Smallcap 500",
      NIFTYIT: "NSE_INDEX|Nifty IT", CNXIT: "NSE_INDEX|Nifty IT",
      NIFTYAUTO: "NSE_INDEX|Nifty Auto", CNXAUTO: "NSE_INDEX|Nifty Auto",
      NIFTYFMCG: "NSE_INDEX|Nifty FMCG", CNXFMCG: "NSE_INDEX|Nifty FMCG",
      NIFTYPHARMA: "NSE_INDEX|Nifty Pharma", CNXPHARMA: "NSE_INDEX|Nifty Pharma",
      NIFTYMETAL: "NSE_INDEX|Nifty Metal", CNXMETAL: "NSE_INDEX|Nifty Metal",
      NIFTYREALTY: "NSE_INDEX|Nifty Realty", CNXREALTY: "NSE_INDEX|Nifty Realty",
      NIFTYENERGY: "NSE_INDEX|Nifty Energy", CNXENERGY: "NSE_INDEX|Nifty Energy",
      NIFTYINFRA: "NSE_INDEX|Nifty Infra", CNXINFRA: "NSE_INDEX|Nifty Infra",
      INDIAVIX: "NSE_INDEX|India VIX", VIX: "NSE_INDEX|India VIX",

      NIFTYCEMENT: "NSE_INDEX|Nifty Cement", NIFTY_CEMENT: "NSE_INDEX|Nifty Cement", CNXCEMENT: "NSE_INDEX|Nifty Cement",
      NIFTYCHEMICALS: "NSE_INDEX|Nifty Chemicals", NIFTY_CHEMICALS: "NSE_INDEX|Nifty Chemicals",
      CNXCONSUMPTION: "NSE_INDEX|Nifty Consumption", NIFTYCONSUMPTION: "NSE_INDEX|Nifty Consumption", CNXCONSUPTION: "NSE_INDEX|Nifty Consumption",
      NIFTYMEDIA: "NSE_INDEX|Nifty Media", CNXMEDIA: "NSE_INDEX|Nifty Media",
      NIFTYPSE: "NSE_INDEX|Nifty PSE", CNXPSE: "NSE_INDEX|Nifty PSE",
      NIFTYPSUBANK: "NSE_INDEX|Nifty PSU Bank", CNXPSUBANK: "NSE_INDEX|Nifty PSU Bank",
      NIFTYPVTBANK: "NSE_INDEX|Nifty Pvt Bank", NIFTYPVTBNK: "NSE_INDEX|Nifty Pvt Bank",
      BANK: "BSE_INDEX|BANKEX",
      SENSEX: "BSE_INDEX|SENSEX", BANKEX: "BSE_INDEX|BANKEX"
    };

    const TICKER_ALIAS = {
      HEG: "HEGAM",
      HEGAM: "HEGAM"
    };
    const INDEX_FYERS = {
      NIFTY: "NSE:NIFTY50-INDEX", NIFTY50: "NSE:NIFTY50-INDEX",
      BANKNIFTY: "NSE:NIFTYBANK-INDEX", NIFTYBANK: "NSE:NIFTYBANK-INDEX",
      FINNIFTY: "NSE:FINNIFTY-INDEX", CNXFINANCE: "NSE:FINNIFTY-INDEX", NIFTYFIN: "NSE:FINNIFTY-INDEX",
      MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX", NIFTYMIDSELECT: "NSE:MIDCPNIFTY-INDEX", NIFTY_MID_SELECT: "NSE:MIDCPNIFTY-INDEX",
      NIFTYNXT50: "NSE:NIFTYNXT50-INDEX", NIFTYNEXT50: "NSE:NIFTYNXT50-INDEX", NIFTYJR: "NSE:NIFTYNXT50-INDEX", NEXT50: "NSE:NIFTYNXT50-INDEX",
      NIFTY100: "NSE:NIFTY100-INDEX", CNX100: "NSE:NIFTY100-INDEX",
      NIFTY200: "NSE:NIFTY200-INDEX", CNX200: "NSE:NIFTY200-INDEX",
      NIFTY500: "NSE:NIFTY500-INDEX", CNX500: "NSE:NIFTY500-INDEX", "NIFTY 500": "NSE:NIFTY500-INDEX", NIFTY_500: "NSE:NIFTY500-INDEX",
      NIFTYMIDCAP50: "NSE:NIFTYMIDCAP50-INDEX", MIDCAP50: "NSE:NIFTYMIDCAP50-INDEX",
      NIFTYMIDCAP100: "NSE:NIFTYMIDCAP100-INDEX", CNXMIDCAP: "NSE:NIFTYMIDCAP100-INDEX", MIDCAP100: "NSE:NIFTYMIDCAP100-INDEX",
      NIFTYMIDCAP150: "NSE:NIFTYMIDCAP150-INDEX", MIDCAP150: "NSE:NIFTYMIDCAP150-INDEX",
      NIFTYSMLCAP50: "NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50: "NSE:NIFTYSMLCAP50-INDEX", SMLCAP50: "NSE:NIFTYSMLCAP50-INDEX",
      NIFTYSMLCAP100: "NSE:NIFTYSMLCAP100-INDEX", CNXSMALLCAP: "NSE:NIFTYSMLCAP100-INDEX", SMALLCAP100: "NSE:NIFTYSMLCAP100-INDEX", SMLCAP100: "NSE:NIFTYSMLCAP100-INDEX",
      NIFTYSMLCAP250: "NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250: "NSE:NIFTYSMLCAP250-INDEX", SMLCAP250: "NSE:NIFTYSMLCAP250-INDEX",
      NIFTYM150: "NSE:NIFTYMICROCAP250-INDEX", MICROCAP250: "NSE:NIFTYMICROCAP250-INDEX", NIFTYMICROCAP250: "NSE:NIFTYMICROCAP250-INDEX",
      NIFTYTOTALMKT: "NSE:NIFTYTOTALMKT-INDEX", TOTALMARKET: "NSE:NIFTYTOTALMKT-INDEX",
      CNXIT: "NSE:NIFTYIT-INDEX", NIFTYIT: "NSE:NIFTYIT-INDEX",
      CNXAUTO: "NSE:NIFTYAUTO-INDEX", NIFTYAUTO: "NSE:NIFTYAUTO-INDEX", "NIFTY AUTO": "NSE:NIFTYAUTO-INDEX",
      CNXFMCG: "NSE:NIFTYFMCG-INDEX", NIFTYFMCG: "NSE:NIFTYFMCG-INDEX",
      CNXPHARMA: "NSE:NIFTYPHARMA-INDEX", NIFTYPHARMA: "NSE:NIFTYPHARMA-INDEX",
      CNXMETAL: "NSE:NIFTYMETAL-INDEX", NIFTYMETAL: "NSE:NIFTYMETAL-INDEX",
      CNXREALTY: "NSE:NIFTYREALTY-INDEX", NIFTYREALTY: "NSE:NIFTYREALTY-INDEX",
      CNXENERGY: "NSE:NIFTYENERGY-INDEX", NIFTYENERGY: "NSE:NIFTYENERGY-INDEX",
      CNXINFRA: "NSE:NIFTYINFRA-INDEX", NIFTYINFRA: "NSE:NIFTYINFRA-INDEX",
      INDIAVIX: "NSE:INDIAVIX-INDEX", VIX: "NSE:INDIAVIX-INDEX",

      NIFTYSMLCAP250: "NSE:NIFTYSMLCAP250-INDEX", SMLCAP250: "NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250: "NSE:NIFTYSMLCAP250-INDEX",
      NIFTYSMLCAP50: "NSE:NIFTYSMLCAP50-INDEX", SMLCAP50: "NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50: "NSE:NIFTYSMLCAP50-INDEX",
      NIFTYMIDSML400: "NSE:NIFTYMIDSML400-INDEX", MIDSML400: "NSE:NIFTYMIDSML400-INDEX",
      NIFTY_SMALLCAP_500: "NSE:NIFTYSMLCAP500-INDEX", NIFTYSMLCAP500: "NSE:NIFTYSMLCAP500-INDEX", SMALLCAP500: "NSE:NIFTYSMLCAP500-INDEX", SMLCAP500: "NSE:NIFTYSMLCAP500-INDEX",
      SENSEX: "BSE:SENSEX-INDEX", BANKEX: "BSE:BANKEX-INDEX", BANK: "BSE:BANKEX-INDEX"
    };


    const keys = [];
    const symbolToKey = {};
    const seen = new Set();

    for (const symbol of symbols || []) {
      const upper = String(symbol || "").toUpperCase().trim();
      if (!upper) continue;
      let bare = upper
        .replace(/^(NSE|BSE|INDEXBOM|NSE_INDEX|BSE_INDEX):/, "")
        .replace(/-EQ$/i, "")
        .replace(/-INDEX$/i, "")
        .replace(/\s+/g, "");

      let fyers = "";
      if (INDEX_UPSTOX[bare] || INDEX_UPSTOX[upper]) {
        fyers = INDEX_UPSTOX[bare] || INDEX_UPSTOX[upper];
      } else if (INDEX_FYERS[bare] || INDEX_FYERS[upper] || INDEX_FYERS[bare.replace(/\s+/g, "")]) {
        fyers = INDEX_FYERS[bare] || INDEX_FYERS[upper] || INDEX_FYERS[bare.replace(/\s+/g, "")];
      } else if (/NIFTY\s*500|CNX\s*500/i.test(upper) || bare === "NIFTY500" || bare === "CNX500") {
        fyers = "NSE_INDEX|Nifty 500";
      } else if (/^(NSE|BSE):.+-(EQ|INDEX)$/i.test(upper)) {
        fyers = upper;
      } else if (/^BSE:/i.test(upper) || upper.startsWith("BSE")) {
        fyers = "BSE:" + bare + "-EQ";
      } else if (bare) {
        if (TICKER_ALIAS[bare]) bare = TICKER_ALIAS[bare];
        // Prefer remembered series (many NSE names trade as -BE not -EQ)
        const mem = String((state.fyersSeriesMap || {})[bare] || "").toUpperCase();
        if (mem && /^(NSE|BSE):.+-(EQ|BE|BZ|SM|A)$/i.test(mem)) {
          fyers = mem;
        } else {
          fyers = "NSE:" + bare + "-EQ";
        }
      }
      if (!fyers) continue;
      // Convert leftover Fyers-style keys to Upstox instrument_key
      if (/^(NSE|BSE):.+-INDEX$/i.test(fyers)) {
        const u = INDEX_UPSTOX[bare] || INDEX_UPSTOX[upper] || INDEX_UPSTOX[bare.replace(/\s+/g, "")];
        if (u) fyers = u;
        else {
          // last-resort: strip NSE: and -INDEX → try as Nifty name
          const name = fyers.replace(/^(NSE|BSE):/i, "").replace(/-INDEX$/i, "").replace(/^NIFTY/i, "Nifty ");
          if (/^NSE:/i.test(fyers)) fyers = "NSE_INDEX|" + (INDEX_UPSTOX[bare] ? INDEX_UPSTOX[bare].split("|")[1] : fyers.replace(/^NSE:/i, "").replace(/-INDEX$/i, ""));
          // if still Fyers form, drop — invalid for Upstox
          if (/^(NSE|BSE):.+-INDEX$/i.test(fyers)) {
            const mapped = INDEX_UPSTOX[bare] || INDEX_UPSTOX[upper];
            if (mapped) fyers = mapped;
            else continue; // skip unmapped index rather than bad key
          }
        }
      } else if (/^NSE:[A-Z0-9&._-]+-(EQ|BE)$/i.test(fyers) && !fyers.includes("|")) {
        fyers = "NSE_EQ|" + bare;
      } else if (/^BSE:[A-Z0-9&._-]+-(EQ|A)$/i.test(fyers) && !fyers.includes("|")) {
        fyers = "BSE_EQ|" + bare;
      }

      symbolToKey[upper] = fyers;
      symbolToKey[bare] = fyers;
      if (!seen.has(fyers)) {
        seen.add(fyers);
        keys.push(fyers);
      }
    }
    return { keys, symbolToKey };
  }

  function parseMarketData(json, symbolToKey) {
    // key → list of watchlist symbols (CNX500 + NIFTY 500 share one instrument)
    const keyToSymbols = {};
    const addMap = (k, sym) => {
      if (!k || !sym) return;
      const ku = String(k).toUpperCase();
      if (!keyToSymbols[ku]) keyToSymbols[ku] = [];
      if (!keyToSymbols[ku].includes(sym)) keyToSymbols[ku].push(sym);
    };
    for (const [symbol, instrumentKey] of Object.entries(symbolToKey || {})) {
      const sym = String(symbol).toUpperCase();
      const key = String(instrumentKey || "").toUpperCase();
      if (!key) continue;
      addMap(key, sym);
      addMap(key.replace(/\|/g, ":"), sym);
      addMap(key.replace(/:/g, "|"), sym);
      addMap(sym, sym);
      const bare = sym.replace(/^(NSE|BSE):/, "").replace(/-(EQ|BE|BZ|SM|INDEX)$/i, "").replace(/\s+/g, "");
      if (bare) addMap(bare, sym);
      const isin = (key.split("|")[1] || key.split(":")[1] || "").toUpperCase();
      if (isin) {
        addMap(isin, sym);
        addMap("NSE_EQ|" + isin, sym);
        addMap("NSE_EQ:" + isin, sym);
        addMap("BSE_EQ|" + isin, sym);
        addMap("BSE_EQ:" + isin, sym);
        addMap("NSE_INDEX|" + isin, sym);
        addMap("NSE_INDEX:" + isin, sym);
        addMap("BSE_INDEX|" + isin, sym);
        addMap("BSE_INDEX:" + isin, sym);
      }
      if (key.endsWith("-INDEX") || key.includes("_INDEX|") || key.includes("_INDEX:")) {
        const ib = key.replace(/^(NSE|BSE):/, "").replace(/-INDEX$/i, "").replace(/^(NSE|BSE)_INDEX[|:]/, "");
        if (ib) {
          addMap(ib, sym);
          addMap("NSE:" + ib + "-INDEX", sym);
        }
      }
    }
    // legacy single lookup (first symbol)
    const keyToSymbol = {};
    for (const [k, arr] of Object.entries(keyToSymbols)) {
      if (arr && arr.length) keyToSymbol[k] = arr[0];
    }
    const resolveSyms = (...cands) => {
      const out = [];
      const seen = new Set();
      for (const cand of cands) {
        if (!cand) continue;
        const ku = String(cand).toUpperCase();
        const arr = keyToSymbols[ku];
        if (!arr) continue;
        for (const s of arr) {
          if (!seen.has(s)) { seen.add(s); out.push(s); }
        }
      }
      return out;
    };

    const applyTick = (symbol, last, previousClose, chg, chgPct) => {
      if (!symbol || !Number.isFinite(last)) return;
      const hasPrev = Number.isFinite(previousClose) && previousClose > 0;
      let c = Number(chg);
      let cp = Number(chgPct);
      if (!Number.isFinite(c) && hasPrev) c = last - previousClose;
      if (!Number.isFinite(cp) && hasPrev && previousClose) cp = (c / previousClose) * 100;
      // Prefer showing 0 over dash when LTP is known
      if (!Number.isFinite(c)) c = 0;
      if (!Number.isFinite(cp)) cp = 0;
      const sym = String(symbol).toUpperCase();
      liveData[sym] = {
        last,
        previousClose: hasPrev ? previousClose : NaN,
        chg: c,
        chgPct: cp,
        updatedAt: Date.now()
      };
    };

    // Upstox v2 quotes: { status, data: { "NSE_EQ:ISIN": { last_price, net_change, ohlc, symbol } } }
    let uData = null;
    if (json && json.data && !Array.isArray(json.data) && !json.data.d && typeof json.data === "object") {
      uData = json.data;
    } else if (json && !json.d && !Array.isArray(json) && typeof json === "object") {
      // background sends result.data already unwrapped
      const sample = Object.values(json).find((v) => v && typeof v === "object" && (v.last_price != null || v.ltp != null));
      if (sample) uData = json;
    }
    if (uData && typeof uData === "object") {
      for (const [k, row] of Object.entries(uData)) {
        if (!row || typeof row !== "object") continue;
        const last = Number(row.last_price ?? row.ltp ?? row.lastPrice);
        if (!Number.isFinite(last)) continue;
        const ohlc = row.ohlc || {};
        // Docs: net_change = change from yesterday close → LTP
        let net = Number(row.net_change);
        if (!Number.isFinite(net)) net = Number(row.change ?? row.ch);
        let previousClose = Number(
          row.close_price ?? row.prev_close_price ?? row.prev_close ?? row.cp
        );
        if (!Number.isFinite(previousClose) || previousClose <= 0) {
          previousClose = Number(ohlc.close);
        }
        // Prefer net_change; else last - prev close
        let chg = Number.isFinite(net) ? net : NaN;
        if (!Number.isFinite(chg) && Number.isFinite(previousClose) && previousClose > 0) {
          chg = last - previousClose;
        }
        // If still missing but we have last+prev that are equal → 0
        if (!Number.isFinite(chg) && Number.isFinite(previousClose)) {
          chg = last - previousClose;
        }
        // Recover prev from last - net
        if ((!Number.isFinite(previousClose) || previousClose <= 0) && Number.isFinite(net)) {
          previousClose = last - net;
        }
        let chgPct = Number(
          row.percentage_change ?? row.percent ?? row.pChange ?? row.chp ?? row.change_percent
        );
        if (!Number.isFinite(chgPct) && Number.isFinite(chg) && Number.isFinite(previousClose) && previousClose !== 0) {
          chgPct = (chg / previousClose) * 100;
        }
        // Always show numbers when LTP exists (0.00 ok after market close)
        if (!Number.isFinite(chg)) chg = 0;
        if (!Number.isFinite(chgPct)) chgPct = 0;

        const keyU = String(k || "").toUpperCase();
        const pipe = keyU.replace(/:/g, "|");
        const colon = keyU.replace(/\|/g, ":");
        const ik = String(row.instrument_token || row.instrument_key || "").toUpperCase();
        const tsym = String(row.symbol || row.trading_symbol || "").toUpperCase();
        const isinPart = (pipe.split("|")[1] || colon.split(":")[1] || "").toUpperCase();
        let symbols = resolveSyms(tsym, keyU, pipe, colon, ik, ik.replace(/:/g, "|"), ik.replace(/\|/g, ":"), isinPart);
        if (!symbols.length && tsym) symbols = [tsym];
        if (!symbols.length) continue;
        // Apply same LTP to EVERY watchlist alias sharing this instrument (CNX500 + NIFTY 500, etc.)
        for (const sym of symbols) {
          applyTick(sym, last, previousClose, chg, chgPct);
        }
        // bare trading symbol if not already in the list
        if (tsym && !symbols.includes(tsym)) {
          applyTick(tsym, last, previousClose, chg, chgPct);
        }
      }
    }

    // Fyers array path
    const rows = Array.isArray(json?.d) ? json.d : (Array.isArray(json?.data?.d) ? json.data.d : null);
    if (rows) {
      for (const row of rows) {
        const n = String(row?.n || row?.symbol || "").toUpperCase();
        const v = row?.v || row || {};
        const last = Number(v.lp ?? v.last_price ?? v.ltp ?? row.lp);
        const previousClose = Number(v.prev_close_price ?? v.prev_close ?? v.previous_close ?? v.cp);
        const chg = Number(v.ch ?? v.change);
        const chgPct = Number(v.chp ?? v.change_percent);
        const bareN = n
          .replace(/^(NSE|BSE):/, "")
          .replace(/-(EQ|BE|BZ|SM|ST|SS|BL|IL|N1|N2|N3|Y1|Y2|Z1|Z2|A|B)$/i, "")
          .replace(/-INDEX$/i, "");
        let symbol =
          keyToSymbol[n] ||
          keyToSymbol[bareN] ||
          keyToSymbol["NSE:" + bareN + "-EQ"] ||
          keyToSymbol["BSE:" + bareN + "-EQ"] ||
          null;
        // If mapping missed, still fill when watchlist has this bare ticker
        if (!symbol && bareN) {
          const list = activeWatchlist();
          const hit = (list?.symbols || []).find((s) => String(s).toUpperCase().replace(/^(NSE|BSE):/, "").replace(/-EQ$/i, "") === bareN);
          if (hit) symbol = String(hit).toUpperCase();
          else symbol = bareN;
        }
        if (!symbol || !Number.isFinite(last)) continue;
        applyTick(symbol, last, previousClose, chg, chgPct);
        try {
          const bareSym = String(symbol).replace(/^(NSE|BSE):/, "").replace(/-(EQ|BE|BZ|SM|INDEX)$/i, "").toUpperCase();
          if (bareSym && /-(EQ|BE|BZ|SM|A)$/i.test(n)) {
            if (!state.fyersSeriesMap) state.fyersSeriesMap = {};
            if (state.fyersSeriesMap[bareSym] !== n) {
              state.fyersSeriesMap[bareSym] = n;
              clearTimeout(window.__tvupSeriesSave);
              window.__tvupSeriesSave = setTimeout(() => {
                try { chrome.storage.local.set({ tvup_fyers_series: state.fyersSeriesMap }); } catch (_) {}
              }, 2000);
            }
          }
        } catch (_) {}
        // also store under bare so row lookup works
        if (bareN && bareN !== symbol) applyTick(bareN, last, previousClose, chg, chgPct);
      }
      return;
    }

    // Legacy / Upstox object map path (result.data is already the map)
    const data = json?.data && !Array.isArray(json.data) && !json.data.d
      ? json.data
      : (json && !json.d && !Array.isArray(json) ? json : {});
    for (const [responseKey, quote] of Object.entries(data || {})) {
      if (!quote || typeof quote !== "object") continue;
      if (quote.last_price == null && quote.ltp == null && quote.last_traded_price == null) continue;

      const last = Number(quote.last_price ?? quote.last_traded_price ?? quote.ltp ?? quote.lp);
      if (!Number.isFinite(last)) continue;

      const ohlc = quote.ohlc || {};
      // Upstox: net_change = LTP - yesterday close (works after market close too)
      let net = Number(quote.net_change);
      if (!Number.isFinite(net)) net = Number(quote.change ?? quote.ch);

      let previousClose = Number(
        quote.prev_close_price ?? quote.previous_close ?? quote.cp ?? quote.close_price
      );
      if (!Number.isFinite(previousClose) || previousClose <= 0) {
        if (Number.isFinite(net)) previousClose = last - net;
        else previousClose = Number(ohlc.close);
      }

      let chg = Number.isFinite(net) ? net : NaN;
      if (!Number.isFinite(chg) && Number.isFinite(previousClose)) chg = last - previousClose;

      let chgPct = Number(
        quote.percentage_change ?? quote.percent ?? quote.pChange ?? quote.chp ?? quote.change_percent
      );
      if (!Number.isFinite(chgPct) && Number.isFinite(chg) && previousClose) {
        chgPct = (chg / previousClose) * 100;
      }

      const rk = String(responseKey || "").toUpperCase();
      const pipe = rk.replace(/:/g, "|");
      const colon = rk.replace(/\|/g, ":");
      const ik = String(quote.instrument_token || quote.instrument_key || "").toUpperCase();
      const tsym = String(quote.symbol || quote.trading_symbol || "").toUpperCase();
      const isin = (pipe.split("|")[1] || colon.split(":")[1] || "").toUpperCase();

      let symbol =
        keyToSymbol[tsym] ||
        keyToSymbol[rk] ||
        keyToSymbol[pipe] ||
        keyToSymbol[colon] ||
        keyToSymbol[ik] ||
        keyToSymbol[ik.replace(/:/g, "|")] ||
        keyToSymbol[ik.replace(/\|/g, ":")] ||
        keyToSymbol[isin] ||
        null;

      if (!symbol && tsym) symbol = tsym;
      if (!symbol) continue;

      applyTick(symbol, last, previousClose, chg, chgPct);
      if (tsym && tsym !== String(symbol).toUpperCase()) {
        applyTick(tsym, last, previousClose, chg, chgPct);
      }
    }
  }

  function formatPrice(value) {
    if (!Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatSigned(value) {
    if (!Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    if (number > 0) return "+" + number.toFixed(2);
    return number.toFixed(2);
  }

  function formatPercent(value) {
    if (!Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    if (number > 0) return "+" + number.toFixed(2) + "%";
    return number.toFixed(2) + "%";
  }

  function updateStatus(text, type) {
    const statusText = $("#tvup-status-text");
    const dot = $("#tvup-status-dot");
    const mini = $("#tvup-status-mini");
    if (statusText && text) statusText.textContent = text;
    if (dot) {
      dot.className = "tvup-status-dot";
      if (type === "online") dot.classList.add("online");
      else if (type === "error") dot.classList.add("error");
    }
    if (mini) {
      mini.title = text || "Live data status";
      mini.setAttribute("aria-label", text || "Live data status");
      mini.classList.toggle("tvup-status-online", type === "online");
      mini.classList.toggle("tvup-status-error", type === "error");
    }
  }

  function getDeepElements(selector) {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      try {
        if (root.querySelectorAll) root.querySelectorAll(selector).forEach((el) => out.push(el));
        const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of all) if (el.shadowRoot) visit(el.shadowRoot);
      } catch (_) {}
    };
    visit(document);
    return out.filter((el) => !el.closest || !el.closest("#tvup-root"));
  }

  function restoreBlankedChartSurfaces() {
    try {
      const candidates = document.querySelectorAll(
        "body > div, .layout, .layout__area--center, .chart-container, [class*='chart-container'], #js-category-content, .js-rootresizer__contents, canvas"
      );
      candidates.forEach((el) => {
        try {
          if (el.id && String(el.id).startsWith("tvup-")) return;
          const op = el.style?.opacity;
          if (op === "0" || op === "0 !important") {
            el.style.removeProperty("opacity");
            el.style.removeProperty("pointer-events");
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  function requestMainWorldSymbol(symbol, exchange = "NSE") {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve({ ok: false, reason: "runtime-unavailable" });
          return;
        }

        const requestId = `tvup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ ok: false, reason: "timeout" });
        }, 1800);

        const listener = (message) => {
          if (!message || message.type !== "TVUP_SET_SYMBOL_RESULT" || message.requestId !== requestId) return;
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(message.result || { ok: false, reason: "empty-result" });
        };

        let full = String(symbol || "").includes(":") ? String(symbol).toUpperCase() : `${exchange}:${symbol}`;
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({
          type: "TVUP_SET_SYMBOL",
          requestId,
          symbol: full
        }, () => {
          const err = chrome.runtime.lastError?.message || "";
          if (err && !/port closed|receiving end does not exist/i.test(err)) {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ ok: false, reason: err || "send-failed" });
          }
        });
      } catch (error) {
        resolve({ ok: false, reason: String(error?.message || error) });
      }
    });
  }

  function getCurrentTradingViewSymbol() {
    try {
      const urlSymbol = new URL(window.location.href).searchParams.get("symbol");
      if (urlSymbol) return String(urlSymbol).replace(/^NSE:/i, "").toUpperCase();
    } catch (_) {}
    return "";
  }

  function resolveTvCandidates(symbol) {
    const clean = String(symbol || "").toUpperCase().replace(/[^A-Z0-9&._:\- ]/g, "").trim();
    let bareIn = clean.replace(/^(NSE|BSE|INDEXBOM):/, "").replace(/-INDEX$/i, "").replace(/\s+/g, "");
    const bareSpaced = clean.replace(/^(NSE|BSE|INDEXBOM):/, "").replace(/-INDEX$/i, "").trim();
    const idx = NSE_INDICES.find((x) => {
      const a = String(x.trading_symbol || "").toUpperCase().replace(/\s+/g, "");
      const b = String(x.tv_symbol || "").toUpperCase().replace(/\s+/g, "");
      const fy = String(x.fyers || "").toUpperCase().replace(/^(NSE|BSE):/, "").replace(/-INDEX$/i, "");
      const aliases = (x.aliases || []).map((z) => String(z).toUpperCase().replace(/\s+/g, ""));
      const name = String(x.name || "").toUpperCase().replace(/\s+/g, "");
      return a === bareIn || b === bareIn || fy === bareIn || aliases.includes(bareIn)
        || a === clean.replace(/\s+/g, "") || b === clean.replace(/\s+/g, "")
        || name === bareIn || String(x.trading_symbol || "").toUpperCase() === bareSpaced
        || String(x.tv_symbol || "").toUpperCase() === bareSpaced;
    });
    if (idx) {
      const tv = String(idx.tv_symbol || idx.trading_symbol).toUpperCase();
      const exchange = idx.exchange || "NSE";
      const alts = [tv, String(idx.trading_symbol || "").toUpperCase()]
        .concat((idx.aliases || []).map((a) => String(a).toUpperCase()))
        .filter(Boolean);
      const uniq = [...new Set(alts)];
      return { exchange, candidates: uniq, fullForms: uniq.flatMap((t) => [`${exchange}:${t}`, t]) };
    }
    const exchange = "NSE";
    return { exchange, candidates: [bareIn || bareSpaced], fullForms: [`${exchange}:${bareIn || bareSpaced}`, bareIn || bareSpaced] };
  }

  async function openTradingViewSymbol(symbol) {
    const resolved = resolveTvCandidates(symbol);
    const { exchange, candidates } = resolved;
    if (!candidates.length) return;

    try {
      for (const clean of candidates) {
        updateStatus(`Loading ${clean}…`, "neutral");
        const mainWorldResult = await requestMainWorldSymbol(clean, exchange);
        if (mainWorldResult?.ok) {
          updateStatus(`Chart: ${clean}`, "online");
          return;
        }
      }
      const clean = candidates[0];

      const url = new URL(window.location.href);
      const full = `${exchange}:${clean}`;
      url.searchParams.set("symbol", full);
      window.history.pushState({ tvupSymbol: full }, "", url.toString());
      window.dispatchEvent(new PopStateEvent("popstate", { state: { tvupSymbol: full } }));
      updateStatus(`Chart: ${clean}`, "online");
    } catch (err) {
      updateStatus(`Chart switch failed: ${clean}`, "error");
    }
  }

  function bindAlertStorageSync() {
    try {
      if (!chrome?.storage?.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.tvup_fyers_auth_error) {
          state.fyersAuthError = String(changes.tvup_fyers_auth_error.newValue || "");
          if (state.fyersAuthError) {
            try { updateStatus("Upstox: invalid/expired token — Settings me naya API key daalo", "error"); } catch (_) {}
          }
        }
        if (changes.tvup_fyers_refresh_at) {
          state.fyersRefreshAt = Number(changes.tvup_fyers_refresh_at.newValue || 0) || 0;
        }
        if (!changes.tvup_alerts) return;
        const next = changes.tvup_alerts.newValue;
        if (!next || typeof next !== "object") return;
        state.alerts = next;
        try {
          for (const r of Object.values(state.alerts)) normalizeAlertRule(r);
        } catch (_) {}
        try { renderTable(); } catch (_) {}
        try {
          const bd = document.getElementById("tvup-alert-backdrop");
          if (bd && bd.classList.contains("tvup-pa-open")) renderAlertList(bd);
        } catch (_) {}
      });
    } catch (_) {}
  }


  function normalizeWatchlistSymbols() {
    let changed = false;
    for (const list of state.watchlists || []) {
      if (!list || !Array.isArray(list.symbols)) continue;
      const next = [];
      const seen = new Set();
      for (const raw of list.symbols) {
        let s = String(raw || "").toUpperCase().trim();
        if (!s) continue;
        s = s.replace(/^(NSE|BSE|INDEXBOM):/, "").replace(/-INDEX$/i, "");
        const idx = NSE_INDICES.find((x) => {
          const a = String(x.trading_symbol || "").toUpperCase();
          const b = String(x.tv_symbol || "").toUpperCase();
          const fy = String(x.fyers || "").toUpperCase().replace(/^(NSE|BSE):/, "").replace(/-INDEX$/i, "");
          const aliases = (x.aliases || []).map((z) => String(z).toUpperCase());
          return a === s || b === s || fy === s || aliases.includes(s);
        });
        if (idx) s = String(idx.tv_symbol || idx.trading_symbol).toUpperCase();
        if (/(ENH|ESG|LIQ1|EW$|LMS|QUALITY|MOMENTUM|BEES|IETF|MIDCAP_50|MIDCAP_150|SMLCAP_50|SMLCAP_250|MICROCAP|TOTAL_MKT|TOTAL MARKET)/i.test(s)) {
          changed = true;
          continue;
        }
        if (seen.has(s)) { changed = true; continue; }
        seen.add(s);
        if (s !== String(raw || "").toUpperCase()) changed = true;
        next.push(s);
      }
      list.symbols = next;
    }
    return changed;
  }

  async function init() {
    try {
      cleanupBrokenChartPush();
      try { forceChartRelayout(); } catch (_) {}
      try { restoreBlankedChartSurfaces(); } catch (_) {}
      try { restoreTvToolbarDom(); } catch (_) {}
      await loadState();
      try {
        if (normalizeWatchlistSymbols()) await saveState();
      } catch (_) {}
      try {
        if (state.alerts && typeof state.alerts === "object") {
          for (const r of Object.values(state.alerts)) normalizeAlertRule(r);
        }
      } catch (_) {}
      state.ui.hideTvToolbar = false;
      createUI();
      bindAlertStorageSync();
      try { setupChartSymbolSync(); } catch (_) {}

      if (state.token) {
        refreshMarketData();
      } else {
        updateStatus("Add Upstox API key in ⚙ Settings", "error");
      }
      // Keep UI in sync when cloud worker marks alerts triggered
      try { pullAlertsFromCloud(); } catch (_) {}
      try {
        setInterval(() => { try { pullAlertsFromCloud(); } catch (_) {} }, 45000);
      } catch (_) {}
    } catch (error) {
      console.error("TVUP initialization failed:", error);
    }
  }

  init();
})();