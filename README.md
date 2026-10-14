# TVUP Watchlist for Upstox (Chrome Extension)

**Version: 3.1.44** — backup snapshot (as-is, **no logic / feature changes**)

TradingView watchlist + price alerts using **Upstox API key only**.

## Repo status

| File | On GitHub |
|------|-----------|
| `manifest.json` | Yes (v3.1.44) |
| `TVUP_UPSTOX_SETUP.md` | Yes |
| `README.md` | Yes |
| `background.js` | **Upload from ZIP** (large) |
| `content.js` | **Upload from ZIP** (large) |
| `styles.css` | **Upload from ZIP** (large) |
| `logo-data.js` | **Upload from ZIP** (large) |

### Complete upload (1 minute)
1. Open: https://github.com/vmali9613-pixel/tvup-watchlist-upstox
2. Click **Add file → Upload files**
3. From your `TVUP_v3_1_44_Backup.zip` extract folder, drag these 4 files:
   - `background.js`
   - `content.js`
   - `styles.css`
   - `logo-data.js`
4. Commit message: `TVUP v3.1.44 full files as-is`
5. **Commit changes**

(Large JS/CSS files exceed automated push size limits; web upload is the safe as-is path.)

## Install extension
1. Download ZIP / clone this repo (after upload complete)
2. `chrome://extensions` → Developer mode ON → **Load unpacked** → this folder
3. TradingView → Settings → paste **Upstox access token** → Save

## Related
- Cloud worker (Render): https://github.com/vmali9613-pixel/tvup-alert-worker-upstox

## Version analysis (v3.1.44)

- **Name:** TVUP Watchlist for Upstox
- **Internal tag:** `3.1.44-firestore-proxy`
- **Manifest:** MV3, service worker `background.js`
- **Data:** Upstox Market Quote API (LTP / Chg / Chg%)
- **Cloud:** Firestore project default `tvup-watchlist-for-upstox` + Telegram
- **Features (unchanged):** watchlist sections, drag-drop, select-mode → native TV transfer (background dialog park), multi alerts, chart↔row border sync, keyboard nav, logos

No feature or logic was modified for this GitHub snapshot.
