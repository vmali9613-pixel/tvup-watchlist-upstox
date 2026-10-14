
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TVUP_ADD_TO_WATCHLIST") return;
  // NOTE: Full file uploaded via multi-part push - see release
  sendResponse({ ok: false });
  return true;
});
