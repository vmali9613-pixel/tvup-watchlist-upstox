
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_ADD_TO_WATCHLIST") return;
  const tabId = sender.tab?.id;
  let symbols = Array.isArray(message.symbols)
    ? message.symbols.map((s) => String(s || "").toUpperCase().trim()).filter(Boolean)
    : [];
  const TV_FREE_MAX = 30;
  const skippedOverLimit = Math.max(0, symbols.length - TV_FREE_MAX);
  if (symbols.length > TV_FREE_MAX) symbols = symbols.slice(0, TV_FREE_MAX);

  if (typeof tabId !== "number" || !symbols.length) {
    try {
      sendResponse({ ok: false, okCount: 0, failCount: symbols.length, skippedOverLimit, message: "no-tab" });
    } catch (_) {}
    return true;
  }

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [symbols],
    func: async (syms) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let okCount = 0;
      let failCount = 0;
      const failed = [];

      const outsideTvup = (el) => {
        try {
          if (!el) return false;
          if (el.closest && el.closest("#tvup-root, #tvup-menu, #tvup-add-popup, [id^='tvup-']")) return false;
          return true;
        } catch (_) {
          return true;
        }
      };
      const qAll = (sel) => {
        try { return [...document.querySelectorAll(sel)].filter(outsideTvup); }
        catch (_) { return []; }
      };
      const q = (sel) => qAll(sel)[0] || null;

      // Widget API first (no dialog)
      const discoverWidgets = () => {
        const candidates = [];
        const add = (value) => {
          if (!value || typeof value !== "object") return;
          if (!candidates.includes(value)) candidates.push(value);
        };
        [
          "tvWidget", "TradingViewWidget", "tradingViewWidget",
          "__tvWidget", "__TV_WIDGET__", "TVWidget", "widget"
        ].forEach((name) => { try { add(window[name]); } catch (_) {} });
        try { add(window.TradingView?.widget); } catch (_) {}
        try { add(window.TradingView); } catch (_) {}
        try {
          for (const key of Object.getOwnPropertyNames(window)) {
            if (!/widget|chart|tradingview|^tv/i.test(key)) continue;
            try { add(window[key]); } catch (_) {}
          }
        } catch (_) {}
        return candidates;
      };

      const getWatchListApi = (widget) => {
        if (!widget) return null;
        try {
          if (typeof widget.watchList === "function") {
            const wl = widget.watchList();
            if (wl) return wl;
          }
        } catch (_) {}
        try {
          if (widget.watchList && typeof widget.watchList === "object") return widget.watchList;
        } catch (_) {}
        return null;
      };

      for (const candidate of discoverWidgets()) {
        const wl = getWatchListApi(candidate);
        if (!wl) continue;
        try {
          if (typeof wl.addSymbols === "function") {
            await Promise.resolve(wl.addSymbols(syms));
            return { ok: true, okCount: syms.length, failCount: 0, failed: [], via: "widget-addSymbols" };
          }
          if (typeof wl.addList === "function") {
            await Promise.resolve(wl.addList(syms));
            return { ok: true, okCount: syms.length, failCount: 0, failed: [], via: "widget-addList" };
          }
          if (typeof wl.setList === "function" && typeof wl.getList === "function") {
            let existing = [];
            try {
              const g = await Promise.resolve(wl.getList());
              if (Array.isArray(g)) existing = g.map((x) => String(x).toUpperCase());
            } catch (_) {}
            const merged = [...existing];
            for (const s of syms) {
              if (!merged.includes(s)) merged.push(s);
            }
            await Promise.resolve(wl.setList(merged.slice(0, 30)));
            return { ok: true, okCount: syms.length, failCount: 0, failed: [], via: "widget-setList" };
          }
          if (typeof wl.add === "function") {
            for (const s of syms) {
              try {
                await Promise.resolve(wl.add(s));
                okCount++;
              } catch (_) {
                failCount++;
                failed.push(s);
              }
              await sleep(12);
            }
            return { ok: okCount > 0, okCount, failCount, failed, via: "widget-add" };
          }
        } catch (_) {
          okCount = 0;
          failCount = 0;
          failed.length = 0;
        }
      }

      // --- DOM path: dialog OPENS but stays off-screen (not visible) ---
      // TradingView mounts modals under #overlap-manager-root — park those, not the chart
      const styleId = "tvup-silent-add-style";
      try {
        let st = document.getElementById(styleId);
        if (!st) {
          st = document.createElement("style");
          st.id = styleId;
          document.documentElement.appendChild(st);
        }
        st.textContent = `
          /* Symbol search dialog + TV overlap portals — off-screen, still usable by JS */
          [data-name="symbol-search-dialog"],
          [data-name="symbol-search-dialog-content"],
          [data-name="symbol-search-items"],
          [data-name="symbol-search-input"],
          [data-name*="symbol-search"],
          div[data-dialog-name*="Symbol Search"],
          div[data-dialog-name="Symbol Search"],
          #overlap-manager-root > div {
            position: fixed !important;
            left: -14000px !important;
            top: 0 !important;
            right: auto !important;
            bottom: auto !important;
            opacity: 0.01 !important;
            transform: none !important;
            pointer-events: auto !important;
            max-width: 520px !important;
            max-height: 80vh !important;
          }
        `;
      } catch (_) {}

      const parkOffscreen = () => {
        const sels = [
          '[data-name="symbol-search-dialog"]',
          '[data-name="symbol-search-dialog-content"]',
          '[data-name="symbol-search-items"]',
          '[data-name="symbol-search-input"]',
          '[data-name*="symbol-search"]',
          '#overlap-manager-root > div'
        ];
        for (const sel of sels) {
          for (const el of qAll(sel)) {
            try {
              el.style.setProperty("position", "fixed", "important");
              el.style.setProperty("left", "-14000px", "important");
              el.style.setProperty("top", "0", "important");
              el.style.setProperty("right", "auto", "important");
              el.style.setProperty("bottom", "auto", "important");
              el.style.setProperty("opacity", "0.01", "important");
              el.style.setProperty("pointer-events", "auto", "important");
            } catch (_) {}
          }
        }
      };

      // Keep parking while transfer runs (no MutationObserver — light interval)
      let parkTimer = null;
      const startParkLoop = () => {
        parkOffscreen();
        if (parkTimer) return;
        parkTimer = setInterval(parkOffscreen, 45);
      };
      const stopParkLoop = () => {
        try { if (parkTimer) clearInterval(parkTimer); } catch (_) {}
        parkTimer = null;
      };

      const pressEscape = () => {
        try {
          const o = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
          document.dispatchEvent(new KeyboardEvent("keydown", o));
          document.dispatchEvent(new KeyboardEvent("keyup", o));
        } catch (_) {}
      };

      const clickSearchClose = () => {
        try {
          for (const root of qAll('[data-name*="symbol-search"], #overlap-manager-root')) {
            root.querySelectorAll(
              'button[aria-label="Close"], button[aria-label*="Close"], button[data-name="close"], [data-name="close"]'
            ).forEach((btn) => { try { btn.click(); } catch (_) {} });
          }
        } catch (_) {}
      };

      const cleanup = async () => {
        parkOffscreen();
        clickSearchClose();
        for (let i = 0; i < 8; i++) {
          pressEscape();
          clickSearchClose();
          parkOffscreen();
          await sleep(50);
        }
        stopParkLoop();
        await sleep(120);
        try {
          const st = document.getElementById(styleId);
          if (st) st.remove();
        } catch (_) {}
        for (let i = 0; i < 4; i++) {
          pressEscape();
          await sleep(40);
        }
      };

      const clickFirst = (sels) => {
        for (const sel of sels) {
          const el = q(sel);
          if (el) {
            try { el.click(); return el; } catch (_) {}
          }
        }
        return null;
      };

      const findSearchInput = () => {
        const sels = [
          '[data-name="symbol-search-input"] input',
          '[data-name="symbol-search-input"]',
          'input[placeholder*="Symbol"]',
          'input[placeholder*="symbol"]'
        ];
        for (const sel of sels) {
          for (const el of qAll(sel)) {
            if (el.tagName === "INPUT") return el;
            const inn = el.querySelector && el.querySelector("input");
            if (inn && outsideTvup(inn)) return inn;
          }
        }
        return null;
      };

      const openAdd = async () => {
        startParkLoop();
        clickFirst([
          '[data-name="add-symbol-button"]',
          'button[data-name="add-symbol-button"]',
          'button[aria-label="Add symbol"]',
          'button[aria-label*="Add symbol"]'
        ]);
        await sleep(50);
        parkOffscreen();
        return findSearchInput();
      };

      const setVal = (input, value) => {
        try { input.focus(); } catch (_) {}
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const pickResult = () => {
        const sels = [
          '[data-name="symbol-search-items"] [data-name="symbol-search-item"]',
          '[data-name="symbol-search-dialog-content"] [data-role="list-item"]',
          '[data-name="symbol-search-items"] [role="option"]',
          '[data-name="symbol-search-dialog-content"] [class*="item"]'
        ];
        for (const sel of sels) {
          const el = q(sel);
          if (el) return el;
        }
        return null;
      };

      try {
        startParkLoop();
        let input = await openAdd();

        for (let i = 0; i < syms.length; i++) {
          const s = syms[i];
          const isLast = i === syms.length - 1;
          try {
            if (!input || !document.contains(input) || !outsideTvup(input)) {
              input = await openAdd();
            }
            if (!input) {
              failCount++;
              failed.push(s);
              continue;
            }

            setVal(input, s);
            parkOffscreen();

            let result = null;
            for (let t = 0; t < 4; t++) {
              await sleep(40);
              parkOffscreen();
              result = pickResult();
              if (result) break;
            }

            if (result) {
              try { result.click(); } catch (_) {
                result.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              }
            } else {
              input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            }

            okCount++;
            parkOffscreen();
            await sleep(isLast ? 100 : 55);

            if (!isLast) {
              input = findSearchInput();
              if (!input) input = await openAdd();
            }
          } catch (_) {
            failCount++;
            failed.push(s);
            input = null;
            await sleep(40);
          }
        }

        await cleanup();
        return { ok: okCount > 0, okCount, failCount, failed, via: "dom-hidden" };
      } catch (e) {
        try { await cleanup(); } catch (_) {}
        return {
          ok: false,
          okCount,
          failCount: Math.max(failCount, syms.length - okCount),
          failed,
          message: String((e && e.message) || e)
        };
      }
    }
  }).then((results) => {
    const result = results && results[0] && results[0].result
      ? results[0].result
      : { ok: false, okCount: 0, failCount: symbols.length };
    result.skippedOverLimit = skippedOverLimit;
    try { sendResponse(result); } catch (_) {}
  }).catch(() => {
    try {
      sendResponse({ ok: false, okCount: 0, failCount: symbols.length, skippedOverLimit, message: "inject-failed" });
    } catch (_) {}
  });
  return true; // async sendResponse
});

















"use strict";

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "TVUP_SET_SYMBOL") return;

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    // Cannot reply via tabs.sendMessage without a valid tab id.
    return;
  }

  const symbol = String(message.symbol || "").toUpperCase();

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (requestedSymbol) => {
      const wanted = String(requestedSymbol || "").toUpperCase();

      const getSymbolName = (value) => {
        try {
          if (!value) return "";
          if (typeof value === "string") return value.toUpperCase();
          if (typeof value === "object") {
            return String(
              value.ticker ||
              value.name ||
              value.full_name ||
              value.fullName ||
              value.symbol ||
              ""
            ).toUpperCase();
          }
        } catch (_) {}
        return "";
      };

      const usableWidget = (candidate) => {
        try {
          if (!candidate || typeof candidate !== "object") return null;
          if (typeof candidate.activeChart === "function") {
            const chart = candidate.activeChart();
            if (chart && typeof chart.setSymbol === "function") {
              return { widget: candidate, chart };
            }
          }
          if (typeof candidate.chart === "function") {
            const chart = candidate.chart();
            if (chart && typeof chart.setSymbol === "function") {
              return { widget: candidate, chart };
            }
          }
        } catch (_) {}
        return null;
      };

      const candidates = [];
      const add = (value) => {
        if (!value) return;
        if (!candidates.includes(value)) candidates.push(value);
      };

      // Common public/widget names.
      [
        "tvWidget",
        "TradingViewWidget",
        "tradingViewWidget",
        "__tvWidget",
        "__TV_WIDGET__",
        "TVWidget",
        "widget"
      ].forEach((name) => {
        try { add(window[name]); } catch (_) {}
      });

      // A few common namespaces.
      try { add(window.TradingView?.widget); } catch (_) {}
      try { add(window.TradingView); } catch (_) {}
      try { add(window.tv?.widget); } catch (_) {}

      // Search top-level window properties only. This avoids walking the huge
      // TradingView React object graph.
      try {
        for (const key of Object.getOwnPropertyNames(window)) {
          if (!/widget|chart|tradingview|tv/i.test(key)) continue;
          try { add(window[key]); } catch (_) {}
        }
      } catch (_) {}

      for (const candidate of candidates) {
        const found = usableWidget(candidate);
        if (!found) continue;

        // Try several symbol forms (with/without exchange, common aliases)
        const bare = wanted.replace(/^(NSE|BSE|NSE_INDEX|BSE_INDEX):/i, "");
        const exchange = (wanted.match(/^(NSE|BSE):/i) || [])[1] || "NSE";
        const forms = [];
        const pushForm = (s) => {
          const v = String(s || "").toUpperCase();
          if (v && !forms.includes(v)) forms.push(v);
        };
        pushForm(wanted);
        pushForm(bare);
        // BSE indices on TradingView use BSE:TICKER (INDEXBOM only valid for SENSEX)
        if (/^BSE$/i.test(exchange) || /^BSE:/i.test(wanted)) {
          pushForm(`BSE:${bare}`);
          if (bare === "SENSEX") pushForm(`INDEXBOM:SENSEX`);
        }
        if (/^INDEXBOM:/i.test(wanted) && bare !== "SENSEX") {
          pushForm(`BSE:${bare}`);
        }
        pushForm(`${exchange || "NSE"}:${bare}`);
        pushForm(`NSE:${bare}`);

        for (const form of forms) {
          try {
            const result = found.chart.setSymbol(form);
            if (result && typeof result.then === "function") {
              result.then(() => {
                window.dispatchEvent(new CustomEvent("tvup-mainworld-symbol-set", {
                  detail: { symbol: form, ok: true }
                }));
              }).catch(() => {});
            }
            return {
              ok: true,
              method: "activeChart.setSymbol",
              symbol: form,
              current: getSymbolName(
                typeof found.chart.symbol === "function" ? found.chart.symbol() : ""
              )
            };
          } catch (error) {
            try {
              if (typeof found.widget.setSymbol === "function") {
                found.widget.setSymbol(form, undefined, () => {});
                return { ok: true, method: "widget.setSymbol", symbol: form };
              }
            } catch (_) {}
          }
        }
      }

      return {
        ok: false,
        reason: "TradingView chart widget is not exposed to MAIN world"
      };
    },
    args: [symbol]
  }).then((results) => {
    const result = results?.[0]?.result || { ok: false, reason: "empty-execute-result" };
    chrome.tabs.sendMessage(tabId, {
      type: "TVUP_SET_SYMBOL_RESULT",
      requestId: message.requestId,
      result
    }).catch(() => {});
  }).catch((error) => {
    chrome.tabs.sendMessage(tabId, {
      type: "TVUP_SET_SYMBOL_RESULT",
      requestId: message.requestId,
      result: {
        ok: false,
        reason: String(error?.message || error || "executeScript-failed")
      }
    }).catch(() => {});
  });
});






/* ========== Fyers auth: one-time setup → auto access token ========== */
async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fyersRefreshAccessToken(creds) {
  const appId = String(creds.appId || "").trim();
  const secret = String(creds.secret || "").trim();
  const refresh = String(creds.refreshToken || "").trim();
  const pin = String(creds.pin || "").trim();
  if (!appId || !secret || !refresh || !pin) {
    throw new Error("Upstox API key missing — open Settings and paste access token");
  }
  const appIdHash = await sha256Hex(appId + ":" + secret);
  const response = await fetch("https://api-t1.fyers.in/api/v3/validate-refresh-token", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      appIdHash,
      refresh_token: refresh,
      pin
    })
  });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  const access = body?.access_token || body?.data?.access_token || "";
  if (!response.ok || !access) {
    const msg = body?.message || body?.msg || `Fyers refresh failed (${response.status})`;
    try {
      await chrome.storage.local.set({ tvup_fyers_auth_error: String(msg) });
    } catch (_) {}
    throw new Error(msg);
  }
  const patch = {
    tvup_token: access,
    tvup_fyers_token_at: Date.now(),
    tvup_fyers_auth_error: ""
  };
  if (body.refresh_token) {
    patch.tvup_fyers_refresh = String(body.refresh_token);
    patch.tvup_fyers_refresh_at = Date.now();
  }
  await chrome.storage.local.set(patch);
  return access;
}

/** Returns stored Fyers App ID + API token (simple Upstox-style) */
async function ensureFyersAccessToken(force) {
  const saved = await chrome.storage.local.get([
    "tvup_token",
    "tvup_fyers_app_id",
    "tvup_fyers_secret",
    "tvup_fyers_refresh",
    "tvup_fyers_pin",
    "tvup_fyers_token_at"
  ]);
  const appId = String(saved.tvup_fyers_app_id || "").trim();
  let token = String(saved.tvup_token || "").trim();
  const secret = String(saved.tvup_fyers_secret || "").trim();
  const refresh = String(saved.tvup_fyers_refresh || "").trim();
  const pin = String(saved.tvup_fyers_pin || "").trim();
  const tokenAt = Number(saved.tvup_fyers_token_at || 0) || 0;
  // Fyers access tokens are short-lived (~1 day). Refresh proactively after 18h
  // or whenever force / missing token when refresh credentials exist.
  const ageMs = tokenAt ? (Date.now() - tokenAt) : 1e15;
  const needRefresh =
    !!force ||
    !token ||
    ageMs > 12 * 60 * 60 * 1000;

  if (needRefresh && appId && secret && refresh && pin) {
    try {
      token = await fyersRefreshAccessToken({
        appId,
        secret,
        refreshToken: refresh,
        pin
      });
    } catch (e) {
      if (!token) throw e;
      console.warn("[TVUP] Fyers refresh failed, using existing token", e?.message || e);
    }
  }

  if (!appId) throw new Error("Add Upstox API key in Settings");
  if (!token) {
    if (secret && refresh && pin) {
      throw new Error("Upstox token invalid — paste a new access token in Settings");
    }
    throw new Error("Add Upstox API key in Settings");
  }
  return { appId, token };
}


function toFyersQuoteSymbol(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s.startsWith("NSE_EQ|")) return "NSE:" + (s.split("|")[1] || "") + "-EQ";
  if (s.startsWith("BSE_EQ|")) return "BSE:" + (s.split("|")[1] || "") + "-EQ";
  if (s.startsWith("NSE_INDEX|")) {
    const name = (s.split("|")[1] || "").toUpperCase();
    const map = {
      "NIFTY 50": "NSE:NIFTY50-INDEX", "NIFTY BANK": "NSE:NIFTYBANK-INDEX",
      "NIFTY FIN SERVICE": "NSE:FINNIFTY-INDEX", "INDIA VIX": "NSE:INDIAVIX-INDEX"
    };
    if (map[name]) return map[name];
    return "NSE:" + name.replace(/\s+/g, "") + "-INDEX";
  }
  if (s.startsWith("BSE_INDEX|")) return "BSE:" + (s.split("|")[1] || "").replace(/\s+/g, "") + "-INDEX";
  if (/^(NSE|BSE):.+-(EQ|INDEX)$/i.test(s)) return s;
  const INDEX = {
    NIFTY:"NSE:NIFTY50-INDEX", NIFTY50:"NSE:NIFTY50-INDEX",
    BANKNIFTY:"NSE:NIFTYBANK-INDEX", NIFTYBANK:"NSE:NIFTYBANK-INDEX",
    FINNIFTY:"NSE:FINNIFTY-INDEX", CNXFINANCE:"NSE:FINNIFTY-INDEX",
    MIDCPNIFTY:"NSE:MIDCPNIFTY-INDEX", NIFTYMIDSELECT:"NSE:MIDCPNIFTY-INDEX",
    NIFTYNXT50:"NSE:NIFTYNXT50-INDEX", NIFTYNEXT50:"NSE:NIFTYNXT50-INDEX", NIFTYJR:"NSE:NIFTYNXT50-INDEX",
    NIFTY100:"NSE:NIFTY100-INDEX", CNX100:"NSE:NIFTY100-INDEX",
    NIFTY200:"NSE:NIFTY200-INDEX", CNX200:"NSE:NIFTY200-INDEX",
    NIFTY500:"NSE:NIFTY500-INDEX", CNX500:"NSE:NIFTY500-INDEX",
    NIFTYMIDCAP50:"NSE:NIFTYMIDCAP50-INDEX", MIDCAP50:"NSE:NIFTYMIDCAP50-INDEX",
    NIFTYMIDCAP100:"NSE:NIFTYMIDCAP100-INDEX", CNXMIDCAP:"NSE:NIFTYMIDCAP100-INDEX", MIDCAP100:"NSE:NIFTYMIDCAP100-INDEX",
    NIFTYMIDCAP150:"NSE:NIFTYMIDCAP150-INDEX", MIDCAP150:"NSE:NIFTYMIDCAP150-INDEX",
    NIFTYSMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50:"NSE:NIFTYSMLCAP50-INDEX",
    NIFTYSMLCAP100:"NSE:NIFTYSMLCAP100-INDEX", CNXSMALLCAP:"NSE:NIFTYSMLCAP100-INDEX", SMALLCAP100:"NSE:NIFTYSMLCAP100-INDEX",
    NIFTYSMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250:"NSE:NIFTYSMLCAP250-INDEX",
    NIFTYM150:"NSE:NIFTYMICROCAP250-INDEX", MICROCAP250:"NSE:NIFTYMICROCAP250-INDEX", NIFTYMICROCAP250:"NSE:NIFTYMICROCAP250-INDEX",
    NIFTYTOTALMKT:"NSE:NIFTYTOTALMKT-INDEX",
    CNXIT:"NSE:NIFTYIT-INDEX", CNXAUTO:"NSE:NIFTYAUTO-INDEX", CNXFMCG:"NSE:NIFTYFMCG-INDEX",
    CNXPHARMA:"NSE:NIFTYPHARMA-INDEX", CNXMETAL:"NSE:NIFTYMETAL-INDEX", CNXREALTY:"NSE:NIFTYREALTY-INDEX",
    CNXENERGY:"NSE:NIFTYENERGY-INDEX", CNXINFRA:"NSE:NIFTYINFRA-INDEX",
    
    NIFTYSMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250:"NSE:NIFTYSMLCAP250-INDEX",
    NIFTYSMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50:"NSE:NIFTYSMLCAP50-INDEX",
    NIFTYMIDSML400:"NSE:NIFTYMIDSML400-INDEX", MIDSML400:"NSE:NIFTYMIDSML400-INDEX",
    NIFTY_SMALLCAP_500:"NSE:NIFTYSMLCAP500-INDEX", NIFTYSMLCAP500:"NSE:NIFTYSMLCAP500-INDEX", SMALLCAP500:"NSE:NIFTYSMLCAP500-INDEX", SMLCAP500:"NSE:NIFTYSMLCAP500-INDEX",
INDIAVIX:"NSE:INDIAVIX-INDEX", SENSEX:"BSE:SENSEX-INDEX", BANKEX:"BSE:BANKEX-INDEX"
  };
  let bare = s.replace(/^(NSE|BSE|INDEXBOM):/, "").replace(/-EQ$/i, "").replace(/-INDEX$/i, "");
  if (INDEX[bare] || INDEX[s]) return INDEX[bare] || INDEX[s];
  const ALIAS = { HEG: "HEGAM" };
  if (ALIAS[bare]) bare = ALIAS[bare];
  if (/^[A-Z0-9._&-]+$/.test(bare)) return "NSE:" + bare + "-EQ";
  return s;
}

// Market quote proxy — Fyers API v3 (service worker avoids TradingView CORS)
let fyersQuoteCache = { at: 0, key: "", data: null };
const FYERS_QUOTE_CACHE_MS = 12000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_MARKET_QUOTE") return;
  (async () => {
    try {
      const token = String(message.token || "").trim();
      if (!token) throw new Error("Add Upstox API key in Settings");
      let keys = Array.isArray(message.instrumentKeys) ? message.instrumentKeys.map(String).filter(Boolean) : [];
      if (!keys.length && Array.isArray(message.symbols)) keys = message.symbols.map(String).filter(Boolean);
      keys = [...new Set(keys.filter(Boolean))];
      if (!keys.length) throw new Error("No symbols");

      // Upgrade ticker-style keys (NSE_EQ|RELIANCE) → real ISIN keys from Upstox master
      try {
        const list = await loadPublicNseInstruments();
        const bySym = new Map();
        const byKey = new Map();
        for (const item of list) {
          const sym = String(item.trading_symbol || "").toUpperCase();
          const ik = String(item.instrument_key || "").trim();
          if (sym && ik && !bySym.has(sym)) bySym.set(sym, ik);
          if (ik) byKey.set(ik.toUpperCase(), ik);
        }
        const fixed = [];
        for (const k of keys) {
          const ku = String(k).trim();
          if (!ku) continue;
          if (/^(NSE|BSE)_INDEX\|/i.test(ku)) { fixed.push(ku); continue; }
          if (/^(NSE|BSE)_EQ\|INE[A-Z0-9]+$/i.test(ku)) { fixed.push(ku); continue; }
          // NSE_EQ|SYMBOL or bare SYMBOL
          let bare = ku;
          if (/^(NSE|BSE)_EQ\|/i.test(ku)) bare = ku.split("|")[1] || "";
          bare = bare.replace(/-(EQ|BE)$/i, "").toUpperCase();
          if (bySym.has(bare)) fixed.push(bySym.get(bare));
          else if (byKey.has(ku.toUpperCase())) fixed.push(byKey.get(ku.toUpperCase()));
          else if (ku.includes("|")) fixed.push(ku); // leave as-is
        }
        keys = [...new Set(fixed.filter(Boolean))];
      } catch (e) {
        console.warn("[TVUP] key upgrade failed", e);
      }
      if (!keys.length) throw new Error("No valid Upstox instrument keys — check symbol names");

      const chunks = [];
      for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
      const merged = { status: "success", data: {} };
      let lastErr = "";
      for (let i = 0; i < chunks.length; i++) {
        if (i) await new Promise((r) => setTimeout(r, 80));
        const q = chunks[i].map((k) => encodeURIComponent(k)).join(",");
        const url = "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" + q;
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + token
          }
        });
        let body = null;
        try { body = await response.json(); } catch (_) {}
        if (response.status === 429) {
          lastErr = "Upstox rate limit (429)";
          continue;
        }
        if (response.status === 401 || /token|unauthor/i.test(String(body?.message || body?.errors || ""))) {
          throw new Error("Upstox API key invalid — paste a new access token in Settings");
        }
        if (!response.ok) {
          lastErr = (body && (body.message || body.error)) || ("HTTP " + response.status);
          continue;
        }
        const data = body?.data && typeof body.data === "object" ? body.data : {};
        Object.assign(merged.data, data);
      }
      const n = Object.keys(merged.data || {}).length;
      if (!n) throw new Error(lastErr || "Upstox returned 0 quotes — check API token or instrument keys");
      sendResponse({ ok: true, data: merged, provider: "upstox", count: n });
    } catch (error) {
      sendResponse({ ok: false, reason: String(error?.message || error || "Market quote failed") });
    }
  })();
  return true;
});

let publicNseInstruments = null;
let publicNsePromise = null;

async function loadPublicNseInstruments() {
  if (Array.isArray(publicNseInstruments) && publicNseInstruments.length > 100) return publicNseInstruments;
  if (publicNsePromise) return publicNsePromise;
  publicNsePromise = (async () => {
    // Upstox public master FIRST — has real instrument_key (NSE_EQ|ISIN)
    try {
      const url = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
      const response = await fetch(url, { cache: "force-cache" });
      if (response.ok && typeof DecompressionStream === "function") {
        const bytes = await response.arrayBuffer();
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(stream).text();
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
        const out = [];
        for (const x of list) {
          const seg = String(x?.segment || "");
          if (seg !== "NSE_EQ" && seg !== "NSE_INDEX") continue;
          const sym = String(x.trading_symbol || "").toUpperCase().trim();
          const ik = String(x.instrument_key || "").trim();
          if (!sym || !ik) continue;
          out.push({
            trading_symbol: sym,
            tv_symbol: sym,
            name: x.name || sym,
            short_name: x.short_name || sym,
            segment: seg,
            exchange: "NSE",
            instrument_type: x.instrument_type || (seg === "NSE_INDEX" ? "INDEX" : "EQ"),
            instrument_key: ik,
            isin: x.isin || ""
          });
        }
        if (out.length > 100) {
          publicNseInstruments = out;
          console.log("[TVUP] Upstox master loaded", out.length);
          return publicNseInstruments;
        }
      }
    } catch (e) {
      console.warn("[TVUP] Upstox master failed", e);
    }

    // BSE equities (optional)
    try {
      const url = "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz";
      const response = await fetch(url, { cache: "force-cache" });
      if (response.ok && typeof DecompressionStream === "function") {
        const bytes = await response.arrayBuffer();
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(stream).text();
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
        const extra = [];
        for (const x of list) {
          const seg = String(x?.segment || "");
          if (seg !== "BSE_EQ" && seg !== "BSE_INDEX") continue;
          const sym = String(x.trading_symbol || "").toUpperCase().trim();
          const ik = String(x.instrument_key || "").trim();
          if (!sym || !ik) continue;
          extra.push({
            trading_symbol: sym,
            tv_symbol: sym,
            name: x.name || sym,
            short_name: x.short_name || sym,
            segment: seg,
            exchange: "BSE",
            instrument_type: x.instrument_type || "EQ",
            instrument_key: ik,
            isin: x.isin || ""
          });
        }
        if (Array.isArray(publicNseInstruments) && publicNseInstruments.length) {
          publicNseInstruments = publicNseInstruments.concat(extra);
        } else if (extra.length) {
          publicNseInstruments = extra;
        }
      }
    } catch (_) {}

    if (!Array.isArray(publicNseInstruments)) publicNseInstruments = [];
    return publicNseInstruments;
  })();
  try { return await publicNsePromise; }
  finally { publicNsePromise = null; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_SEARCH_PUBLIC_INSTRUMENTS") return;
  const q = String(message.query || "").trim().toUpperCase();
  (async () => {
    try {
      if (!q) throw new Error("Enter a stock symbol");
      const list = await loadPublicNseInstruments();
      const starts = [];
      const contains = [];
      for (const item of list) {
        const sym = String(item.trading_symbol || "").toUpperCase();
        const name = String(item.name || "").toUpperCase();
        const short = String(item.short_name || "").toUpperCase();
        if (!sym || !(sym.includes(q) || name.includes(q) || short.includes(q))) continue;
        (sym.startsWith(q) ? starts : contains).push(item);
      }
      starts.sort((a,b) => String(a.trading_symbol).localeCompare(String(b.trading_symbol)));
      contains.sort((a,b) => String(a.trading_symbol).localeCompare(String(b.trading_symbol)));
      sendResponse({ ok: true, data: starts.concat(contains).slice(0, 20) });
    } catch (error) {
      sendResponse({ ok: false, reason: String(error?.message || error || "Instrument search failed") });
    }
  })();
  return true;
});

// Resolve trading symbols → instrument_key using the public NSE master.
// Avoids CORS (content scripts cannot reliably fetch api.upstox.com from the
// TradingView origin) and does not require a user access token.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_RESOLVE_INSTRUMENT_KEYS") return;
  const symbols = Array.isArray(message.symbols)
    ? message.symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
    : [];
  (async () => {
    try {
      if (!symbols.length) {
        sendResponse({ ok: true, data: {} });
        return;
      }
      const list = await loadPublicNseInstruments();
      const bySymbol = new Map();
      for (const item of list) {
        const sym = String(item.trading_symbol || "").toUpperCase();
        if (sym && item.instrument_key && !bySymbol.has(sym)) {
          bySymbol.set(sym, String(item.instrument_key));
        }
      }
      const data = {};
      for (const sym of symbols) {
        if (bySymbol.has(sym)) data[sym] = bySymbol.get(sym);
      }
      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({
        ok: false,
        reason: String(error?.message || error || "Instrument key resolve failed")
      });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "TVUP_SEARCH_INSTRUMENTS") return;

  const requestId = message.requestId;
  const query = String(message.query || "").trim().toUpperCase().slice(0, 50);

  (async () => {
    try {
      if (!query) throw new Error("Enter a stock symbol");
      const list = await loadPublicNseInstruments();
      const starts = [];
      const contains = [];
      for (const item of list) {
        const sym = String(item.trading_symbol || "").toUpperCase();
        const name = String(item.name || "").toUpperCase();
        const short = String(item.short_name || "").toUpperCase();
        if (!sym || !(sym.includes(query) || name.includes(query) || short.includes(query))) continue;
        (sym.startsWith(query) ? starts : contains).push(item);
      }
      starts.sort((a, b) => String(a.trading_symbol).localeCompare(String(b.trading_symbol)));
      contains.sort((a, b) => String(a.trading_symbol).localeCompare(String(b.trading_symbol)));
      let data = starts.concat(contains).slice(0, 20);
      // Always allow exact typed symbol even if master miss
      if (!data.length && /^[A-Z0-9_&-]{1,20}$/.test(query)) {
        data = [{
          trading_symbol: query,
          tv_symbol: query,
          name: query,
          short_name: query,
          segment: "NSE_EQ",
          exchange: "NSE",
          instrument_type: "EQ"
        }];
      }
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "TVUP_SEARCH_INSTRUMENTS_RESULT",
          requestId,
          result: { ok: true, data }
        }).catch(() => {});
      }
    } catch (error) {
      const q = query;
      const fallback = /^[A-Z0-9_&-]{1,20}$/.test(q) ? [{
        trading_symbol: q, tv_symbol: q, name: q, short_name: q,
        segment: "NSE_EQ", exchange: "NSE", instrument_type: "EQ"
      }] : [];
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "TVUP_SEARCH_INSTRUMENTS_RESULT",
          requestId,
          result: fallback.length
            ? { ok: true, data: fallback }
            : { ok: false, reason: String(error?.message || error || "Search failed") }
        }).catch(() => {});
      }
    }
  })();

  return true;
});


/* ========== Telegram push (extension-side, so it still works after local trigger) ========== */
async function getTelegramConfig() {
  try {
    const s = await chrome.storage.local.get(["tvup_telegram_token", "tvup_telegram_chat_id"]);
    const token = String(s.tvup_telegram_token || "").trim();
    const chatId = String(s.tvup_telegram_chat_id || "").trim();
    return { token, chatId };
  } catch (_) {
    return { token: "", chatId: "" };
  }
}

async function sendTelegramMessage(text, retries) {
  const { token, chatId } = await getTelegramConfig();
  if (!token || !chatId) {
    console.warn("[TVUP] Telegram skipped: missing tvup_telegram_token or tvup_telegram_chat_id in storage");
    return { ok: false, reason: "missing-credentials" };
  }
  const attempts = Math.max(1, Number(retries) || 1);
  let lastErr = "unknown";
  for (let i = 0; i < attempts; i++) {
    try {
      const url = "https://api.telegram.org/bot" + encodeURIComponent(token) + "/sendMessage";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text || "").slice(0, 3500),
          disable_web_page_preview: true
        })
      });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (!res.ok || body?.ok === false) {
        lastErr = body?.description || ("HTTP " + res.status);
        console.warn("[TVUP] Telegram send failed", lastErr, "try", i + 1);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        continue;
      }
      console.log("[TVUP] Telegram sent");
      return { ok: true };
    } catch (e) {
      lastErr = String(e?.message || e);
      console.warn("[TVUP] Telegram error", lastErr);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return { ok: false, reason: lastErr };
}

/* ========== Phase 2: Background Price Alert Engine ========== */
const TVUP_ALERT_ALARM = "tvup-alert-tick";
const TVUP_ALERT_PREV_KEY = "tvup_alert_prev_ltp";

function normalizeCond(c) {
  const v = String(c || "").toLowerCase();
  if (v === "below" || v === "crossing_down" || v === "down") return "crossing_down";
  if (v === "above" || v === "crossing_up" || v === "up") return "crossing_up";
  return "crossing";
}

function condLabel(c) {
  const n = normalizeCond(c);
  if (n === "crossing_up") return "Crossing Up";
  if (n === "crossing_down") return "Crossing Down";
  return "Crossing";
}

function formatInr(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function ensureAlertAlarm() {
  try {
    await chrome.alarms.create(TVUP_ALERT_ALARM, { periodInMinutes: 1 });
  } catch (_) {}
}

async function resolveKeysForSymbols(symbols) {
  // Returns map TRADING_SYM → Fyers symbol string
  const out = {};
  const INDEX_FYERS = {
    NIFTY:"NSE:NIFTY50-INDEX", NIFTY50:"NSE:NIFTY50-INDEX",
    BANKNIFTY:"NSE:NIFTYBANK-INDEX", NIFTYBANK:"NSE:NIFTYBANK-INDEX",
    FINNIFTY:"NSE:FINNIFTY-INDEX", CNXFINANCE:"NSE:FINNIFTY-INDEX",
    MIDCPNIFTY:"NSE:MIDCPNIFTY-INDEX", NIFTYMIDSELECT:"NSE:MIDCPNIFTY-INDEX",
    NIFTYNXT50:"NSE:NIFTYNXT50-INDEX", NIFTYNEXT50:"NSE:NIFTYNXT50-INDEX", NIFTYJR:"NSE:NIFTYNXT50-INDEX",
    NIFTY100:"NSE:NIFTY100-INDEX", CNX100:"NSE:NIFTY100-INDEX",
    NIFTY200:"NSE:NIFTY200-INDEX", CNX200:"NSE:NIFTY200-INDEX",
    NIFTY500:"NSE:NIFTY500-INDEX", CNX500:"NSE:NIFTY500-INDEX",
    NIFTYMIDCAP50:"NSE:NIFTYMIDCAP50-INDEX", MIDCAP50:"NSE:NIFTYMIDCAP50-INDEX",
    NIFTYMIDCAP100:"NSE:NIFTYMIDCAP100-INDEX", CNXMIDCAP:"NSE:NIFTYMIDCAP100-INDEX", MIDCAP100:"NSE:NIFTYMIDCAP100-INDEX",
    NIFTYMIDCAP150:"NSE:NIFTYMIDCAP150-INDEX", MIDCAP150:"NSE:NIFTYMIDCAP150-INDEX",
    NIFTYSMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50:"NSE:NIFTYSMLCAP50-INDEX",
    NIFTYSMLCAP100:"NSE:NIFTYSMLCAP100-INDEX", CNXSMALLCAP:"NSE:NIFTYSMLCAP100-INDEX", SMALLCAP100:"NSE:NIFTYSMLCAP100-INDEX",
    NIFTYSMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250:"NSE:NIFTYSMLCAP250-INDEX",
    NIFTYM150:"NSE:NIFTYMICROCAP250-INDEX", MICROCAP250:"NSE:NIFTYMICROCAP250-INDEX", NIFTYMICROCAP250:"NSE:NIFTYMICROCAP250-INDEX",
    NIFTYTOTALMKT:"NSE:NIFTYTOTALMKT-INDEX",
    CNXIT:"NSE:NIFTYIT-INDEX", CNXAUTO:"NSE:NIFTYAUTO-INDEX", CNXFMCG:"NSE:NIFTYFMCG-INDEX",
    CNXPHARMA:"NSE:NIFTYPHARMA-INDEX", CNXMETAL:"NSE:NIFTYMETAL-INDEX", CNXREALTY:"NSE:NIFTYREALTY-INDEX",
    CNXENERGY:"NSE:NIFTYENERGY-INDEX", CNXINFRA:"NSE:NIFTYINFRA-INDEX",
    
    NIFTYSMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMLCAP250:"NSE:NIFTYSMLCAP250-INDEX", SMALLCAP250:"NSE:NIFTYSMLCAP250-INDEX",
    NIFTYSMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMLCAP50:"NSE:NIFTYSMLCAP50-INDEX", SMALLCAP50:"NSE:NIFTYSMLCAP50-INDEX",
    NIFTYMIDSML400:"NSE:NIFTYMIDSML400-INDEX", MIDSML400:"NSE:NIFTYMIDSML400-INDEX",
    NIFTY_SMALLCAP_500:"NSE:NIFTYSMLCAP500-INDEX", NIFTYSMLCAP500:"NSE:NIFTYSMLCAP500-INDEX", SMALLCAP500:"NSE:NIFTYSMLCAP500-INDEX", SMLCAP500:"NSE:NIFTYSMLCAP500-INDEX",
INDIAVIX:"NSE:INDIAVIX-INDEX", SENSEX:"BSE:SENSEX-INDEX", BANKEX:"BSE:BANKEX-INDEX"
  };
  for (const raw of symbols || []) {
    const sym = String(raw || "").toUpperCase().replace(/^(NSE|BSE|INDEXBOM):/, "").trim();
    if (!sym) continue;
    const INDEX_UPSTOX = {
      NIFTY:"NSE_INDEX|Nifty 50", NIFTY50:"NSE_INDEX|Nifty 50",
      BANKNIFTY:"NSE_INDEX|Nifty Bank", NIFTYBANK:"NSE_INDEX|Nifty Bank",
      FINNIFTY:"NSE_INDEX|Nifty Fin Service", CNXFINANCE:"NSE_INDEX|Nifty Fin Service",
      MIDCPNIFTY:"NSE_INDEX|NIFTY MID SELECT", NIFTYMIDSELECT:"NSE_INDEX|NIFTY MID SELECT", NIFTY_MID_SELECT:"NSE_INDEX|NIFTY MID SELECT",
      NIFTYNXT50:"NSE_INDEX|Nifty Next 50", NIFTYJR:"NSE_INDEX|Nifty Next 50",
      NIFTY500:"NSE_INDEX|Nifty 500", CNX500:"NSE_INDEX|Nifty 500", "NIFTY 500":"NSE_INDEX|Nifty 500",
      NIFTYSMLCAP500:"NSE_INDEX|Nifty Smallcap 500", NIFTY_SMALLCAP_500:"NSE_INDEX|Nifty Smallcap 500",
      CNXMIDCAP:"NSE_INDEX|NIFTY MIDCAP 100", NIFTYMIDCAP100:"NSE_INDEX|NIFTY MIDCAP 100", MIDCAP100:"NSE_INDEX|NIFTY MIDCAP 100",
      CNXSMALLCAP:"NSE_INDEX|NIFTY SMLCAP 100", NIFTYSMLCAP100:"NSE_INDEX|NIFTY SMLCAP 100", SMLCAP100:"NSE_INDEX|NIFTY SMLCAP 100",
      NIFTYSMLCAP250:"NSE_INDEX|NIFTY SMLCAP 250", SMLCAP250:"NSE_INDEX|NIFTY SMLCAP 250", SMALLCAP250:"NSE_INDEX|NIFTY SMLCAP 250",
      NIFTYSMLCAP50:"NSE_INDEX|NIFTY SMLCAP 50", SMLCAP50:"NSE_INDEX|NIFTY SMLCAP 50", SMALLCAP50:"NSE_INDEX|NIFTY SMLCAP 50",
      NIFTYMIDSML400:"NSE_INDEX|NIFTY MIDSML 400", MIDSML400:"NSE_INDEX|NIFTY MIDSML 400",
      CNXIT:"NSE_INDEX|Nifty IT", CNXAUTO:"NSE_INDEX|Nifty Auto",
      CNXFMCG:"NSE_INDEX|Nifty FMCG", CNXPHARMA:"NSE_INDEX|Nifty Pharma",
      CNXMETAL:"NSE_INDEX|Nifty Metal", CNXREALTY:"NSE_INDEX|Nifty Realty",
      CNXENERGY:"NSE_INDEX|Nifty Energy", CNXINFRA:"NSE_INDEX|Nifty Infra",
      CNXMEDIA:"NSE_INDEX|Nifty Media", CNXPSE:"NSE_INDEX|Nifty PSE",
      CNXPSUBANK:"NSE_INDEX|Nifty PSU Bank", NIFTYPVTBANK:"NSE_INDEX|Nifty Pvt Bank",
      NIFTY_CEMENT:"NSE_INDEX|Nifty Cement", NIFTYCEMENT:"NSE_INDEX|Nifty Cement",
      NIFTY_CHEMICALS:"NSE_INDEX|Nifty Chemicals", NIFTYCHEMICALS:"NSE_INDEX|Nifty Chemicals",
      CNXCONSUMPTION:"NSE_INDEX|Nifty Consumption", NIFTYCONSUMPTION:"NSE_INDEX|Nifty Consumption",
      INDIAVIX:"NSE_INDEX|India VIX",
      SENSEX:"BSE_INDEX|SENSEX", BANKEX:"BSE_INDEX|BANKEX", BANK:"BSE_INDEX|BANKEX"
    };
    if (INDEX_UPSTOX[sym]) {
      out[sym] = INDEX_UPSTOX[sym];
    } else if (sym.includes("-INDEX") || sym.endsWith("INDEX")) {
      out[sym] = sym.includes(":") ? sym : ("NSE:" + sym);
    } else {
      out[sym] = "NSE:" + sym + "-EQ";
    }
  }
  return out;
}

async function fetchLtpMap(appId, token, symbolMap) {
  const keys = [...new Set(Object.values(symbolMap || {}).filter(Boolean))];
  const out = {};
  if (!token || !keys.length) return out;
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const q = chunk.map((k) => encodeURIComponent(k)).join(",");
    const url = "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" + q;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", Authorization: "Bearer " + token }
      });
      const body = await response.json();
      const data = body?.data || {};
      for (const [k, row] of Object.entries(data)) {
        const last = Number(row?.last_price);
        if (!Number.isFinite(last)) continue;
        out[String(k).toUpperCase()] = last;
        out[String(k).replace(":", "|").toUpperCase()] = last;
      }
    } catch (_) {}
  }
  return out;
}

function isCross(prev, last, target, cond) {
  if (!Number.isFinite(prev) || !Number.isFinite(last) || !Number.isFinite(target)) return false;
  const eps = Math.max(0.005, Math.abs(target) * 1e-8);
  if (cond === "crossing_up") return prev < target - eps && last >= target - eps;
  if (cond === "crossing_down") return prev > target + eps && last <= target + eps;
  return (
    (prev < target - eps && last >= target - eps) ||
    (prev > target + eps && last <= target + eps)
  );
}

async function showAlertNotification(sym, rule, last) {
  const title = "TVUP Price Alert";
  const message = `${sym} ${condLabel(rule.condition)} ₹${formatInr(rule.price)} (now ₹${formatInr(last)})`;
  try {
    await chrome.notifications.create("tvup-alert-" + sym + "-" + Date.now(), {
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      title,
      message,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.warn("[TVUP] notification failed", e);
  }
}

async function runAlertEngine() {
  try {
    const saved = await chrome.storage.local.get([
      "tvup_alerts",
      "tvup_token",
      "tvup_fyers_app_id",
      "tvup_fyers_secret",
      "tvup_fyers_refresh",
      "tvup_fyers_pin",
      "tvup_fyers_token_at",
      TVUP_ALERT_PREV_KEY
    ]);
    const alerts = saved.tvup_alerts && typeof saved.tvup_alerts === "object" ? saved.tvup_alerts : {};
    const token = String(saved.tvup_token || "").trim();
    const prevMap = saved[TVUP_ALERT_PREV_KEY] && typeof saved[TVUP_ALERT_PREV_KEY] === "object"
      ? saved[TVUP_ALERT_PREV_KEY]
      : {};

    // Multi-alert: entries are { id: { id, symbol, price, ... } } (legacy: key was symbol)
    const activeRules = Object.entries(alerts).filter(([, r]) =>
      r && r.status !== "paused" && r.armed !== false && r.status !== "triggered"
    );
    if (!activeRules.length) return;
    let appId = String(saved.tvup_fyers_app_id || "").trim();
    try {
      const tokSaved = await chrome.storage.local.get(["tvup_token"]);
      const ensured = { appId: "", token: String(tokSaved.tvup_token || "") };
      appId = ensured.appId || appId;
      token = ensured.token || token;
    } catch (e) {
      console.log("[TVUP] alert engine: Fyers auth failed", e?.message || e);
      return;
    }
    if (!token || !appId) {
      console.log("[TVUP] alert engine: missing Fyers credentials");
      return;
    }

    const activeSyms = [...new Set(activeRules.map(([k, r]) =>
      String(r.symbol || k).toUpperCase()
    ))];

    const keyMap = await resolveKeysForSymbols(activeSyms);
    const ltpMap = await fetchLtpMap(appId, token, keyMap);
    const now = Date.now();
    let changed = false;

    for (const [aid, rule] of activeRules) {
      if (!rule) continue;
      const sym = String(rule.symbol || aid).toUpperCase();
      const id = String(rule.id || aid);
      rule.id = id;
      rule.symbol = sym;
      const last = Number(ltpMap[sym]);
      if (!Number.isFinite(last)) continue;
      const prevRaw = prevMap[id];
      const prev = Number(prevRaw);
      const target = Number(rule.price);
      const cond = normalizeCond(rule.condition);
      if (!Number.isFinite(prev)) {
        prevMap[id] = last;
        continue;
      }
      const hit = isCross(prev, last, target, cond);
      prevMap[id] = last;
      if (!hit) continue;
      if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < 60000) continue;
      rule.lastTriggeredAt = now;
      rule.armed = false;
      rule.status = "triggered";
      alerts[id] = rule;
      // clean legacy key if different
      if (aid !== id && alerts[aid] === rule) {
        /* same ref stored under both */
      } else if (aid !== id && alerts[aid]) {
        delete alerts[aid];
        alerts[id] = rule;
      }
      changed = true;
      await showAlertNotification(sym, rule, last);
      try {
        const condRaw = normalizeCond(rule.condition);
        const condStr = String(condRaw || "crossing").replace(/_/g, " ");
        const tmsg =
          "🎯 Price Alert Hit!\n\n" +
          "📈 Symbol: " + sym + "\n" +
          "💰 Price: ₹" + formatInr(last) + "\n" +
          "🎯 Target: ₹" + formatInr(rule.price) + "\n" +
          "⚙️ Condition: " + condStr;
        await sendTelegramMessage(tmsg);
      } catch (_) {}
    }

    const payload = { [TVUP_ALERT_PREV_KEY]: prevMap };
    if (changed) payload.tvup_alerts = alerts;
    await chrome.storage.local.set(payload);
  } catch (err) {
    console.warn("[TVUP] alert engine error", err);
  }
}


/* ========== Permanent Firestore cloud defaults (no console hack) ========== */
const TVUP_CLOUD_DEFAULTS = {
  tvup_fb_project: "tvup-watchlist-for-upstox",
  tvup_fb_api_key: "direct"
};

async function ensureCloudDefaults() {
  try {
    const cur = await chrome.storage.local.get([
      "tvup_fb_project",
      "tvup_fb_api_key"
    ]);
    const patch = {};
    if (!String(cur.tvup_fb_project || "").trim()) {
      patch.tvup_fb_project = TVUP_CLOUD_DEFAULTS.tvup_fb_project;
    }
    if (!String(cur.tvup_fb_api_key || "").trim()) {
      patch.tvup_fb_api_key = TVUP_CLOUD_DEFAULTS.tvup_fb_api_key;
    }
    if (Object.keys(patch).length) {
      await chrome.storage.local.set(patch);
      console.log("[TVUP] Cloud defaults saved", patch);
    }
  } catch (e) {
    console.warn("[TVUP] ensureCloudDefaults failed", e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureCloudDefaults();
  ensureAlertAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  ensureCloudDefaults();
  ensureAlertAlarm();
});
ensureCloudDefaults();
ensureAlertAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === TVUP_ALERT_ALARM) runAlertEngine();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_ALERTS_CHANGED") return;
  ensureAlertAlarm();
  runAlertEngine().then(() => sendResponse({ ok: true })).catch((e) => {
    sendResponse({ ok: false, reason: String(e?.message || e) });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_TELEGRAM_NOTIFY") return;
  (async () => {
    try {
      const text = String(message.text || message.message || "").trim();
      if (!text) throw new Error("empty message");
      const retries = Number(message.retries) > 0 ? Number(message.retries) : 2;
      const result = await sendTelegramMessage(text, retries);
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, reason: String(e?.message || e) });
    }
  })();
  return true;
});




/* ========== Firestore proxy (content-script CORS bypass) ========== */
async function firestoreRequest(method, projectId, apiKey, bodyFields) {
  const pid = String(projectId || "tvup-watchlist-for-upstox").trim() || "tvup-watchlist-for-upstox";
  let url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/tvup/alerts`;
  const key = String(apiKey || "").trim();
  if (key && key !== "direct") url += `?key=${encodeURIComponent(key)}`;

  const opts = { method: method || "GET", cache: "no-store" };
  if (method === "PATCH" && bodyFields) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify({ fields: bodyFields });
  }
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: res.ok, status: res.status, json, text: text ? text.slice(0, 400) : "" };
  } catch (e) {
    // Network / offline — soft fail, do not throw
    return { ok: false, status: 0, reason: String(e && e.message ? e.message : e) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.type !== "TVUP_FIRESTORE_SYNC" && message.type !== "TVUP_FIRESTORE_PULL")) return;
  (async () => {
    try {
      const store = await chrome.storage.local.get(["tvup_fb_project", "tvup_fb_api_key"]);
      const projectId = String(message.projectId || store.tvup_fb_project || "tvup-watchlist-for-upstox").trim();
      const apiKey = String(message.apiKey || store.tvup_fb_api_key || "direct").trim();
      if (message.type === "TVUP_FIRESTORE_SYNC") {
        const result = await firestoreRequest("PATCH", projectId, apiKey, message.fields || {});
        sendResponse(result);
      } else {
        const result = await firestoreRequest("GET", projectId, apiKey, null);
        sendResponse(result);
      }
    } catch (e) {
      sendResponse({ ok: false, status: 0, reason: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

