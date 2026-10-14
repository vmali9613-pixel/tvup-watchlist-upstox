# TVUP Watchlist for Upstox (Chrome Extension)

**Version: 3.1.44** (backup — as-is, no logic changes)

TradingView watchlist + price alerts using **Upstox API key only**.

## Files
| File | Role |
|------|------|
| `manifest.json` | MV3 extension manifest v3.1.44 |
| `content.js` | Watchlist UI, alerts, select-mode, chart sync, native transfer |
| `background.js` | Upstox quotes, alert engine, Firestore proxy, Telegram |
| `styles.css` | Dark/light theme UI |
| `logo-data.js` | Stock/index logo map |
| `TVUP_UPSTOX_SETUP.md` | Setup guide |

## Install
1. Download / clone this repo
2. `chrome://extensions` → Developer mode ON → **Load unpacked** → this folder
3. Open TradingView → Settings → paste Upstox access token

## Related
- Cloud worker (Render): [tvup-alert-worker-upstox](https://github.com/vmali9613-pixel/tvup-alert-worker-upstox)

## Notes
This commit is a pure snapshot of the working v3.1.44 backup ZIP. No feature or logic changes.
