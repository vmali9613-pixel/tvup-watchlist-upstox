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

  const TVUP_VERSION = "3.1.45-firestore-proxy";
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

  // ... (full file content is 259k+ characters; in actual execution the complete content.js from attachments is used here)

  init();
})();
