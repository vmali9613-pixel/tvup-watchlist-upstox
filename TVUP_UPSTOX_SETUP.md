# TVUP for Upstox — new stack (scratch)

This package is a **new** Upstox-only build.
Do **not** mix it with the old Fyers extension / old Render service.

## What is different
- Upstox needs **only the API key** (access token) in Settings. Firebase fields are used only for mobile alerts.
- LTP + alerts use Upstox Market Quote API.
- Name: **TVUP Watchlist for Upstox**.

## 1) Chrome extension (PC)
1. chrome://extensions → Developer mode ON
2. Load unpacked → this folder (or unzip)
3. Open TradingView
4. Settings → paste **Upstox access token** → Save

Get token from: https://account.upstox.com / Upstox Developer Apps  
(Access token from your Upstox API app.)

## 2) New GitHub repo (do not reuse Fyers worker repo)
1. github.com → New repository → e.g. `tvup-alert-worker-upstox`
2. Upload: `worker_index.js`, `package.json`
3. Render start command: `node worker_index.js`

## 3) New Firebase project
1. console.firebase.google.com → Add project (new name)
2. Create Firestore database
3. Document path the worker expects: `tvup/alerts` with field `alertsJson` (string)
4. Copy Project ID
5. Web API key from Project settings

Use **new** project so old Fyers data is untouched.

## 4) New Render service
1. render.com → New Web Service → connect the **new** GitHub repo
2. Environment variables:
   - `UPSTOX_ACCESS_TOKEN` = same token as extension
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_API_KEY`
3. Keep this service **separate** from `tvup-alert-worker` (Fyers).
4. Optional: cron-job.org ping the Render URL every 5–10 min so free tier does not sleep.

## 5) Telegram
Same bot is fine, or create a new bot with @BotFather if you want a clean split.

## Laptop off
Alerts still run on **Render**, not on the laptop.


## Update karne ka sahi tarika (data na jaye)
Chrome har folder ko alag extension maanta hai, isliye naye folder se load karne par purani watchlists nahi dikhti.
1. `chrome://extensions` me TVUP kholo (Details) aur **Source** me jo purana folder path dikhta hai, wahi yaad rakho.
2. Naye zip ki files us **purane folder me overwrite** karo (same folder).
3. `chrome://extensions` me TVUP ke card pe **Reload** (gol arrow) dabao. Watchlists, flags, alerts sab waise hi rahenge.
4. Safety ke liye Settings -> Backup & Restore se kabhi-kabhi **Backup** download karke rakho. Naye folder se load karna pade to **Restore** se sab wapas aa jayega.
