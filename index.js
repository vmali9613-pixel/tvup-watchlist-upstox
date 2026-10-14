/**
 * TVUP Alert Worker — Upstox v3.2.1 (hardened + extension-trigger late delivery)
 * Env: UPSTOX_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *      FIREBASE_PROJECT_ID, FIREBASE_API_KEY, INTERVAL_MS (optional)
 *
 * v3.1.0 fixes:
 *  - overlapping ticks (interval + /tick ping) no longer double-send
 *  - Telegram fail => alert stays ACTIVE and retries (pehle galat se "triggered" ho jata tha)
 *  - Firestore save ab merge + updateTime precondition se hota hai (extension ke naye alerts overwrite nahi hote)
 *  - save fail ho to pending queue me rehta hai, har tick retry (repeat alert nahi)
 *  - ek galat symbol poore batch ko kharab nahi karta (400 => split & isolate)
 *  - symbol master fail hone par cache nahi hota, 6h me refresh (naye IPO listing bhi mil jati hai)
 *  - Upstox token expiry par Telegram warning + env/Firestore dono token try
 *  - har network call par timeout; last price baseline Firestore me save (restart/sleep ke baad crossing miss nahi)
 */
const express = require("express");
const zlib = require("zlib");

const VERSION = "3.2.1";
const app = express();
app.use(express.json());

const INTERVAL_MS = Math.max(5000, Number(process.env.INTERVAL_MS || 20000));
const ENV_TOKEN = String(process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_API_KEY || "").trim();
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const FB_PROJECT = String(process.env.FIREBASE_PROJECT_ID || process.env.FB_PROJECT || "").trim();
const FB_KEY = String(process.env.FIREBASE_API_KEY || process.env.FB_API_KEY || "").trim();

const MIN5 = 5 * 60 * 1000;
// ALERT_MODE: "repeat" (default, har baar cross par alert) ya "once" (ek baar). Alert me repeat:false / once:true ho to wo once.
const ALERT_MODE = String(process.env.ALERT_MODE || "once").toLowerCase() === "once" ? "once" : "repeat";
const COOLDOWN_MS = Math.max(30, Number(process.env.REPEAT_COOLDOWN_SEC || 300)) * 1000;
function isRepeat(r) {
  if (r.repeat === false || r.once === true || String(r.mode || "").toLowerCase() === "once") return false;
  if (r.repeat === true) return true;
  return ALERT_MODE === "repeat";
}
const DAY7 = 7 * 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, opts = {}, ms = 15000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
const istNow = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
function num(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[,\u20b9\s]/g, "");
  return s === "" ? NaN : Number(s);
}

/* ------------------------------------------------------------------ state */
const LATE_CAP_MS = 3 * 3600 * 1000;   // itne purane extension-triggered alerts tak late delivery
const NOTIFIED = new Map();  // id -> ts jab Telegram bheja gaya (extension ke trigger ko duplicate na samjhe)
let BASE_TS = Date.now();    // isse purane triggered alerts ko worker ignore karta hai (purane alerts ka spam nahi)
const MEM = new Map();      // id -> { ltp, ts }       last seen price (baseline for crossing)
const PENDING = new Map();  // id -> { sig, at }       Telegram sent, Firestore "triggered" mark baaki
const RETRY = new Map();    // id -> { next, sig, last } condition hit ho chuki, Telegram deliver baaki
const NOTICE = new Map();   // key -> lastSentAt       throttled system warnings
const health = {
  startedAt: Date.now(), lastTickStart: 0, lastTickEnd: 0, lastOkTick: 0,
  active: 0, quotes: 0, unresolved: [], tokenOk: null, fsOk: null, tgOk: null,
  fired: 0, lastError: ""
};
let goodToken = "";

/* -------------------------------------------------------- symbol -> key */
const INDEX_UPSTOX = {
  NIFTY: "NSE_INDEX|Nifty 50", NIFTY50: "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank", NIFTYBANK: "NSE_INDEX|Nifty Bank",
  FINNIFTY: "NSE_INDEX|Nifty Fin Service", CNXFINANCE: "NSE_INDEX|Nifty Fin Service",
  NIFTY500: "NSE_INDEX|Nifty 500", CNX500: "NSE_INDEX|Nifty 500",
  NIFTY100: "NSE_INDEX|Nifty 100", CNX100: "NSE_INDEX|Nifty 100",
  NIFTY200: "NSE_INDEX|Nifty 200", CNX200: "NSE_INDEX|Nifty 200",
  CNXMIDCAP: "NSE_INDEX|Nifty Midcap 100", CNXSMALLCAP: "NSE_INDEX|Nifty Smallcap 100",
  CNXIT: "NSE_INDEX|Nifty IT", CNXAUTO: "NSE_INDEX|Nifty Auto",
  CNXFMCG: "NSE_INDEX|Nifty FMCG", CNXPHARMA: "NSE_INDEX|Nifty Pharma",
  CNXMETAL: "NSE_INDEX|Nifty Metal", CNXREALTY: "NSE_INDEX|Nifty Realty",
  CNXENERGY: "NSE_INDEX|Nifty Energy", CNXINFRA: "NSE_INDEX|Nifty Infra",
  INDIAVIX: "NSE_INDEX|India VIX",
  SENSEX: "BSE_INDEX|SENSEX", BANKEX: "BSE_INDEX|BANKEX"
};

let symbolKeyCache = null;
let masterLoadedAt = 0;
let masterTriedAt = 0;
let masterLoading = null;

async function loadSymbolKeyMap(force = false) {
  const fresh = symbolKeyCache && Date.now() - masterLoadedAt < 6 * 3600 * 1000;
  if (fresh && !force) return symbolKeyCache;
  // fail hone par baar-baar na maare: 2 min gap
  if (symbolKeyCache && Date.now() - masterTriedAt < 2 * 60 * 1000) return symbolKeyCache;
  if (masterLoading) return masterLoading;
  masterLoading = (async () => {
    masterTriedAt = Date.now();
    try {
      const res = await tfetch("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz", {}, 60000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // already-decoded ho to skip
      const parsed = JSON.parse(buf.toString("utf8"));
      const list = Array.isArray(parsed) ? parsed : (parsed.data || []);
      const map = new Map(Object.entries(INDEX_UPSTOX));
      for (const x of list) {
        const seg = String(x.segment || "");
        if (seg && seg !== "NSE_EQ" && seg !== "NSE_INDEX") continue;
        const sym = String(x.trading_symbol || "").toUpperCase();
        const ik = String(x.instrument_key || "").trim();
        if (sym && ik && !map.has(sym)) map.set(sym, ik);
      }
      if (map.size < 100) throw new Error("master too small " + map.size);
      symbolKeyCache = map;
      masterLoadedAt = Date.now();
      console.log("[Upstox] master:", map.size);
    } catch (e) {
      console.warn("[Upstox] master fail", e.message);
      if (!symbolKeyCache) symbolKeyCache = new Map(Object.entries(INDEX_UPSTOX)); // cache nahi, sirf temporary; masterLoadedAt=0 => retry
    } finally {
      masterLoading = null;
    }
    return symbolKeyCache;
  })();
  return masterLoading;
}

const VALID_KEY = /^(NSE|BSE)_EQ\|[A-Z0-9]{12}$|^(NSE|BSE)_INDEX\|.+$/i;

async function toKey(sym) {
  let s = String(sym || "").toUpperCase().trim();
  if (!s) return "";
  if (VALID_KEY.test(s)) return s;
  if (INDEX_UPSTOX[s]) return INDEX_UPSTOX[s];
  if (s.includes(":")) s = s.split(":").pop().trim();       // "NSE:RELIANCE" -> "RELIANCE"
  if (INDEX_UPSTOX[s]) return INDEX_UPSTOX[s];
  let map = await loadSymbolKeyMap();
  if (!map.has(s) && Date.now() - masterLoadedAt > 10 * 60 * 1000) {
    map = await loadSymbolKeyMap(true);                      // naya listing ho sakta hai
  }
  if (map.has(s)) return map.get(s);
  return "";                                                  // unresolved (galat key bhejne se behtar skip)
}

/* ------------------------------------------------------------- quotes */
function pickLtp(quotes, key, sym) {
  const tryKeys = [];
  const push = (k) => { if (k) tryKeys.push(String(k).toUpperCase()); };
  push(key);
  if (key) {
    push(key.replace(/:/g, "|"));
    push(key.replace(/\|/g, ":"));
    const part = key.split(/[|:]/).pop();
    push(part);
    push("NSE_EQ|" + part);
    push("NSE_EQ:" + part);
  }
  push(sym);
  for (const k of tryKeys) {
    if (Number.isFinite(quotes[k]) && quotes[k] > 0) return quotes[k];
  }
  return undefined;
}

function indexRows(body, out) {
  let n = 0;
  for (const [k, row] of Object.entries(body.data || {})) {
    const last = Number(row?.last_price);
    if (!Number.isFinite(last) || last <= 0) continue;
    n++;
    const ku = String(k).toUpperCase();
    out[ku] = last;
    out[ku.replace(/:/g, "|")] = last;
    out[ku.replace(/\|/g, ":")] = last;
    const ik = String(row.instrument_token || row.instrument_key || "").toUpperCase();
    if (ik) { out[ik] = last; out[ik.replace(/:/g, "|")] = last; }
    const tsym = String(row.symbol || "").toUpperCase();
    if (tsym) out[tsym] = last;
    const tail = (ku.split(":")[1] || ku.split("|")[1] || "").toUpperCase();
    if (tail) out[tail] = last;
  }
  return n;
}

// ek chunk; 401 => agla token; 400 => split karke galat key isolate
async function quoteChunk(chunk, tokens, out) {
  const url = "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" +
    chunk.map(encodeURIComponent).join(",");
  let authFail = false;
  for (const tok of tokens) {
    let res, body;
    try {
      res = await tfetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + tok } });
      if (res.status === 429) { await sleep(1500); res = await tfetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + tok } }); }
      body = await res.json().catch(() => ({}));
    } catch (e) {
      console.warn("[Upstox] fetch err", e.message);
      return { ok: false, authFail: false };
    }
    if (res.status === 401 || res.status === 403) {
      authFail = true;
      console.warn("[Upstox] auth", res.status, "token ...", tok.slice(-6));
      continue;
    }
    if (res.status === 400) {
      if (chunk.length > 1) {
        const mid = chunk.length >> 1;
        const a = await quoteChunk(chunk.slice(0, mid), tokens, out);
        const b = await quoteChunk(chunk.slice(mid), tokens, out);
        return { ok: a.ok || b.ok, authFail: a.authFail || b.authFail };
      }
      console.warn("[Upstox] invalid key skipped:", chunk[0]);
      return { ok: false, authFail: false };
    }
    if (!res.ok) {
      console.warn("[Upstox] HTTP", res.status, JSON.stringify(body).slice(0, 180));
      return { ok: false, authFail: false };
    }
    goodToken = tok;
    indexRows(body, out);
    return { ok: true, authFail: false };
  }
  return { ok: false, authFail };
}

async function fetchQuotes(keys, tokens) {
  const out = {};
  if (!tokens.length || !keys.length) return { out, authFail: !tokens.length, any: false };
  let authFail = false, any = false;
  for (let i = 0; i < keys.length; i += 50) {
    const r = await quoteChunk(keys.slice(i, i + 50), tokens, out);
    if (r.ok) any = true;
    if (r.authFail) authFail = true;
  }
  return { out, authFail, any };
}

/* ----------------------------------------------------------- telegram */
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn("[Telegram] missing credentials");
    health.tgError = "TELEGRAM_BOT_TOKEN ya TELEGRAM_CHAT_ID Render Environment me nahi hai";
    health.tgOk = false;
    return false;
  }
  const clean = (x) => String(x).split(TG_TOKEN).join("***");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await tfetch(
        "https://api.telegram.org/bot" + encodeURIComponent(TG_TOKEN) + "/sendMessage",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }
      );
      if (res.ok) { console.log("[Telegram] ok"); health.tgOk = true; health.tgError = ""; return true; }
      const t = await res.text().catch(() => "");
      console.warn("[Telegram] fail", res.status, t.slice(0, 160));
      health.tgError = res.status + " " + clean(t).slice(0, 160);
      if (res.status === 429) {
        let wait = 3;
        try { wait = Number(JSON.parse(t).parameters.retry_after) || 3; } catch (_) {}
        await sleep(Math.min(wait, 20) * 1000);
      } else if (res.status >= 400 && res.status < 500) {
        break; // token/chat galat — retry bekaar
      } else {
        await sleep(1000 * attempt);
      }
    } catch (e) {
      console.warn("[Telegram] err", clean(e.message));
      health.tgError = "network: " + clean(e.message);
      await sleep(1000 * attempt);
    }
  }
  health.tgOk = false;
  return false;
}

async function notice(key, text, everyMs = 6 * 3600 * 1000) {
  if (Date.now() - (NOTICE.get(key) || 0) < everyMs) return;
  NOTICE.set(key, Date.now() - everyMs + Math.min(everyMs, 10 * 60 * 1000)); // fail ho to 10 min baad retry
  if (await sendTelegram(text)) NOTICE.set(key, Date.now());
}

/* -------------------------------------------------------------- logic */
function condKind(cond) {
  const c = String(cond || "crossing").toLowerCase().replace(/[\s-]+/g, "_");
  if (/(^|_)(up|upward|upside|rising|above|greater|gt|higher|over)(_|$)|^>/.test(c)) return "up";
  if (/(^|_)(down|downward|downside|falling|below|less|lt|lower|under)(_|$)|^</.test(c)) return "down";
  return "cross";
}

function shouldFire(prev, last, target, cond, arm, firedBefore) {
  if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(target)) return false;
  const eps = Math.max(0.10, Math.abs(target) * 0.0002);
  if (Math.abs(last - target) <= eps) {
    if (Number.isFinite(prev)) return Math.abs(prev - target) > eps;  // bahar se target par aaya
    return !firedBefore;  // naya alert, price pehle se target par (market band me last price daal kar test) => turant
  }
  // baseline: pichla price, nahi to alert lagate waqt ka price (armPrice)
  const base = Number.isFinite(prev) ? prev : (Number.isFinite(arm) && arm > 0 ? arm : NaN);
  const k = condKind(cond);
  if (k === "up") {
    if (!Number.isFinite(base)) return last >= target - eps;
    return base < target - eps && last >= target - eps;
  }
  if (k === "down") {
    if (!Number.isFinite(base)) return last <= target + eps;
    return base > target + eps && last <= target + eps;
  }
  if (!Number.isFinite(base)) return false;
  return (base < target - eps && last >= target - eps) ||
         (base > target + eps && last <= target + eps);
}

function isActive(r) {
  if (!r || typeof r !== "object") return false;
  const st = String(r.status || "active").toLowerCase();
  if (st === "paused" || st === "triggered" || st === "stopped") return false;
  if (r.armed === false) return false;
  // Once-mode: already fired → never check again (even if Firestore mark lagged)
  if (!isRepeat(r)) {
    const lt = num(r.lastTriggeredAt);
    if (Number.isFinite(lt) && lt > 0) return false;
  }
  return true;
}

const sigOf = (r) => `${String(r.symbol || "").toUpperCase()}|${num(r.price)}|${String(r.condition || "")}`;

/* ---------------------------------------------------------- firestore */
function fsUrl(docName, pairs = []) {
  const q = new URLSearchParams(pairs);
  if (FB_KEY && FB_KEY !== "direct") q.set("key", FB_KEY);
  const qs = q.toString();
  return `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/tvup/${docName}` +
    (qs ? "?" + qs : "");
}

async function loadDoc() {
  if (!FB_PROJECT) { console.warn("[FS] no FIREBASE_PROJECT_ID"); return { ok: false, alerts: {}, token: "" }; }
  try {
    const res = await tfetch(fsUrl("alerts"));
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) return { ok: true, found: false, fields: [], alerts: {}, token: "", updateTime: "" };
    if (!res.ok) {
      console.warn("[FS] HTTP", res.status, JSON.stringify(body).slice(0, 160));
      return { ok: false, alerts: {}, token: "" };
    }
    const fields = body.fields || {};
    let alerts = {}, parseOk = true;
    const raw = fields.alertsJson?.stringValue;
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && typeof p === "object" && !Array.isArray(p)) alerts = p; else parseOk = false;
      } catch (_) { parseOk = false; }
    }
    const token = String(fields.upstoxToken?.stringValue || "").trim();
    return { ok: parseOk, found: true, fields: Object.keys(fields), alerts, token, updateTime: body.updateTime || "" };
  } catch (e) {
    console.warn("[FS] load", e.message);
    return { ok: false, alerts: {}, token: "" };
  }
}

// "ok" | "conflict" | "fail"
async function patchAlerts(alerts, updateTime) {
  const pairs = [["updateMask.fieldPaths", "alertsJson"], ["updateMask.fieldPaths", "updatedAt"]];
  if (updateTime) pairs.push(["currentDocument.updateTime", updateTime]);
  try {
    const res = await tfetch(fsUrl("alerts", pairs), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          alertsJson: { stringValue: JSON.stringify(alerts) },
          updatedAt: { integerValue: String(Date.now()) }
        }
      })
    });
    if (res.ok) return "ok";
    const t = await res.text().catch(() => "");
    console.warn("[FS] save", res.status, t.slice(0, 160));
    if (res.status === 409 || (res.status === 400 && /FAILED_PRECONDITION/.test(t))) return "conflict";
    return "fail";
  } catch (e) {
    console.warn("[FS] save err", e.message);
    return "fail";
  }
}

// Fresh doc padho, sirf triggered alerts par status badlo, precondition ke saath likho (extension ka data safe)
async function flushPending() {
  if (!PENDING.size) return true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await loadDoc();
    if (!doc.ok) return false;
    const marked = [];
    for (const [id, p] of [...PENDING]) {
      const r = doc.alerts[id];
      if (!r || sigOf(r) !== p.sig) { PENDING.delete(id); continue; }                  // delete/edit
      if (p.repeat) {
        r.lastTriggeredAt = p.at;                                                       // alert ACTIVE hi rehta hai
        r.triggerCount = (Number(r.triggerCount) || 0) + 1;
      } else {
        if (!isActive(r)) { PENDING.delete(id); continue; }                             // already done
        r.status = "triggered"; r.armed = false; r.lastTriggeredAt = p.at;
      }
      marked.push(id);
    }
    if (!marked.length) return true;
    const res = await patchAlerts(doc.alerts, doc.updateTime);
    if (res === "ok") { marked.forEach((id) => PENDING.delete(id)); console.log("[FS] marked:", marked.length); return true; }
    if (res === "fail") return false;
    await sleep(300 + attempt * 300); // conflict: extension ne beech me likha, dobara merge
  }
  return false;
}

/* baseline persistence (restart / Render sleep ke baad crossing miss na ho) */
let stateFails = 0, stateOffUntil = 0, lastStateSave = 0;
async function loadState() {
  if (!FB_PROJECT) return;
  try {
    const res = await tfetch(fsUrl("workerState"));
    if (!res.ok) return;
    const body = await res.json().catch(() => ({}));
    const bt = Number(body.fields?.baselineTs?.integerValue);
    if (Number.isFinite(bt) && bt > 0) BASE_TS = bt;
    try {
      const nj = JSON.parse(body.fields?.notifiedJson?.stringValue || "{}");
      for (const [id, ts] of Object.entries(nj)) if (Number.isFinite(ts)) NOTIFIED.set(id, ts);
    } catch (_) {}
    const p = JSON.parse(body.fields?.stateJson?.stringValue || "{}");
    for (const [id, v] of Object.entries(p)) {
      if (v && Number.isFinite(v.ltp) && Date.now() - v.ts < DAY7) MEM.set(id, { ltp: v.ltp, ts: v.ts });
    }
    console.log("[State] baseline restored:", MEM.size);
  } catch (e) { console.warn("[State] load", e.message); }
}
async function saveState(force = false) {
  if (!FB_PROJECT || Date.now() < stateOffUntil) return;
  if (!force && Date.now() - lastStateSave < 60000) return;
  lastStateSave = Date.now();
  try {
    const obj = {};
    for (const [id, v] of MEM) obj[id] = { ltp: v.ltp, ts: v.ts };
    const nobj = {};
    for (const [id, ts] of NOTIFIED) { if (Date.now() - ts < 2 * 24 * 3600 * 1000) nobj[id] = ts; else NOTIFIED.delete(id); }
    const res = await tfetch(fsUrl("workerState", [["updateMask.fieldPaths", "stateJson"], ["updateMask.fieldPaths", "notifiedJson"], ["updateMask.fieldPaths", "baselineTs"]]), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        stateJson: { stringValue: JSON.stringify(obj) },
        notifiedJson: { stringValue: JSON.stringify(nobj) },
        baselineTs: { integerValue: String(BASE_TS) }
      } })
    });
    if (res.ok) { stateFails = 0; return; }
    throw new Error("HTTP " + res.status);
  } catch (e) {
    if (++stateFails >= 3) { stateOffUntil = Date.now() + 3600 * 1000; stateFails = 0; console.warn("[State] save off 1h:", e.message); }
  }
}

/* --------------------------------------------------------------- tick */
let ticking = false, tickStartedAt = 0;

async function tick() {
  if (ticking && Date.now() - tickStartedAt < 120000) return { skipped: "busy" };
  ticking = true; tickStartedAt = Date.now();
  health.lastTickStart = tickStartedAt;
  try { return await tickInner(); }
  catch (e) { health.lastError = String(e.message || e); console.warn("[Tick] error", e); return { error: health.lastError }; }
  finally { ticking = false; health.lastTickEnd = Date.now(); }
}

async function tickInner() {
  const t0 = Date.now();
  if (PENDING.size) await flushPending();

  const doc = await loadDoc();
  health.fsOk = doc.ok;
  if (!doc.ok) {
    console.warn(`[Tick] ${istNow()} Firestore unavailable — skip`);
    health.fsFails = (health.fsFails || 0) + 1;
    if (health.fsFails >= 10) await notice("fs", "\u26a0\ufe0f TVUP worker: Firestore se alerts nahi mil rahe (project/key/rules check karo). Alerts abhi check nahi ho rahe.");
    return { ok: false };
  }
  health.fsFails = 0;
  const { alerts } = doc;

  const tokens = [...new Set([goodToken, doc.token.length > 20 ? doc.token : "", ENV_TOKEN].filter(Boolean))];

  for (const id of [...MEM.keys()]) if (!(id in alerts)) MEM.delete(id);
  for (const id of [...RETRY.keys()]) if (!(id.replace(/^late:/, "") in alerts)) RETRY.delete(id);

  const active = Object.entries(alerts).filter(([id, r]) => isActive(r) && !PENDING.has(id));
  health.active = active.length;
  const ev = {};
  for (const [id, r] of Object.entries(alerts)) {
    const act = isActive(r);
    ev[id] = {
      id, symbol: r?.symbol, target: num(r?.price), armPrice: num(r?.armPrice), condition: r?.condition,
      status: r?.status || "active", armed: r?.armed !== false,
      decision: act ? (PENDING.has(id) ? "Telegram gaya, Firestore mark baaki" : "?") : "inactive (" + (r?.status || "armed=false") + ") - worker ise check nahi karta"
    };
  }
  // extension ne jo alerts khud "triggered" kar diye par Telegram nahi gaya => worker bhejega
  const late = Object.entries(alerts).filter(([id, r]) => {
    if (isActive(r) || PENDING.has(id)) return false;
    if (String(r?.status || "").toLowerCase() !== "triggered") return false;
    const lt = num(r.lastTriggeredAt);
    if (!Number.isFinite(lt) || lt < BASE_TS || Date.now() - lt > LATE_CAP_MS) return false;
    const n = NOTIFIED.get(id);
    if (n !== undefined && lt <= n + 120000) return false;   // already bheja (extension ka mark 2 min ke andar)
    const rt = RETRY.get("late:" + id);
    if (rt && rt.next > Date.now()) return false;
    return true;
  }).slice(0, 5);
  const lateIds = new Set(late.map(([id]) => id));
  for (const [id, r] of Object.entries(alerts)) {
    if (isActive(r)) continue;
    const lt = num(r?.lastTriggeredAt);
    if (lateIds.has(id)) ev[id].decision = "extension ne trigger kiya - Telegram bhej raha hoon";
    else if (String(r?.status || "").toLowerCase() === "triggered" && Number.isFinite(lt) && lt < BASE_TS) ev[id].decision = "purana triggered alert (ignore)";
    else if (NOTIFIED.has(id)) ev[id].decision = "triggered - Telegram bhej diya gaya";
  }
  health.lastEval = Object.values(ev);
  health.lastEvalAt = Date.now();
  if (!active.length && !late.length) {
    const st = {};
    for (const r of Object.values(alerts)) {
      const k = String(r?.status || "active").toLowerCase() + (r?.armed === false ? "/disarmed" : "");
      st[k] = (st[k] || 0) + 1;
    }
    health.docFound = doc.found; health.alertsTotal = Object.keys(alerts).length;
    console.log(`[Tick] ${istNow()} active=0 | project=${FB_PROJECT} doc=${doc.found === false ? "NOT-FOUND" : "found"} ` +
      `total=${health.alertsTotal} ${JSON.stringify(st)}`);
    health.lastOkTick = Date.now();
    return { ok: true, active: 0 };
  }

  const keyOf = {};
  const unresolved = [];
  for (const [id, r] of [...active, ...late]) {
    const sym = String(r.symbol || "").toUpperCase();
    let key = String(r.instrumentKey || r.instrument_key || "").trim();
    if (!VALID_KEY.test(key)) key = await toKey(sym);
    if (!key) { if (!lateIds.has(id)) { unresolved.push(sym || id); ev[id].decision = "symbol Upstox me nahi mila"; } continue; }
    keyOf[id] = key;
  }
  health.unresolved = [...new Set(unresolved)];
  if (unresolved.length) {
    console.warn("[Key] unresolved:", health.unresolved.join(","));
    await notice("unres:" + health.unresolved.join(","), "\u26a0\ufe0f TVUP worker: ye symbol Upstox me nahi mile, alert check nahi ho raha: " + health.unresolved.join(", "), 24 * 3600 * 1000);
  }

  const keys = [...new Set(Object.values(keyOf))];
  const { out: quotes, authFail, any } = await fetchQuotes(keys, tokens);
  health.tokenOk = any ? true : (authFail || !tokens.length ? false : health.tokenOk);
  if (!any && (authFail || !tokens.length)) {
    await notice("token", "\u26a0\ufe0f TVUP worker: Upstox access token expire/invalid hai. Extension Settings me naya token daalo (Upstox token roz subah ~3:30 AM expire hota hai). Tab tak alerts band rahenge.");
  }

  const toFire = [];
  let got = 0;
  for (const [id, r] of active) {
    const key = keyOf[id];
    if (!key) continue;
    const sym = String(r.symbol || "").toUpperCase();
    const last = pickLtp(quotes, key, sym);
    if (!Number.isFinite(last)) { console.warn("[Check] no price", sym); ev[id].decision = "Upstox se price nahi mila"; continue; }
    got++;
    const target = num(r.price);
    const mem = MEM.get(id);
    const prev = mem && Number.isFinite(mem.ltp) ? mem.ltp : NaN;
    MEM.set(id, { ltp: last, ts: Date.now() });
    const sig = sigOf(r);
    let retry = RETRY.get(id);
    if (retry && retry.sig !== sig) { RETRY.delete(id); retry = null; }  // user ne alert edit kar diya
    ev[id].ltp = last; ev[id].prevLtp = Number.isFinite(prev) ? prev : null;
    if (retry) {
      if (retry.next > Date.now()) { ev[id].decision = "Telegram retry wait"; continue; } // backoff chal raha hai
    } else {
      const lt = num(r.lastTriggeredAt);
      // Once alerts: never fire twice (memory + lastTriggeredAt)
      if (!isRepeat(r)) {
        if (NOTIFIED.has(id)) { ev[id].decision = "already notified (once)"; continue; }
        if (Number.isFinite(lt) && lt > 0) { ev[id].decision = "already triggered (once)"; continue; }
      } else if (Number.isFinite(lt) && Date.now() - lt < COOLDOWN_MS) {
        ev[id].decision = "cooldown (pichla alert abhi gaya)"; continue;
      }
      if (!shouldFire(prev, last, target, r.condition, num(r.armPrice), Number.isFinite(lt))) { ev[id].decision = "wait: price abhi target cross/touch nahi hua"; continue; }
    }
    ev[id].decision = retry ? "RETRY-FIRE" : "FIRE";
    console.log("[Check]", id.slice(0, 12), sym, "ltp=", last, "tgt=", target, retry ? "RETRY-FIRE" : "FIRE");
    toFire.push({ id, r, sym, last, target, sig, repeat: isRepeat(r) });
  }
  health.quotes = got;
  for (const e of Object.values(ev).filter((x) => x.ltp !== undefined || x.decision.startsWith("symbol") || x.decision.startsWith("Upstox")).slice(0, 12)) {
    console.log(`[Eval] ${e.symbol} tgt=${e.target} ltp=${e.ltp ?? "-"} prev=${e.prevLtp ?? "-"} arm=${e.armPrice} => ${e.decision}`);
  }
  console.log(`[Tick] ${istNow()} active=${active.length} keys=${keys.length} prices=${got} fire=${toFire.length} ${Date.now() - t0}ms`);

  for (const it of toFire) {
    const msg =
      "\ud83c\udfaf Price Alert Hit!\n\n" +
      "\ud83d\udcc8 Symbol: " + it.sym + "\n" +
      "\ud83d\udcb0 Price: \u20b9" + it.last + "\n" +
      "\ud83c\udfaf Target: \u20b9" + it.target + "\n" +
      "\u2699\ufe0f Condition: " + String(it.r.condition || "crossing").replace(/_/g, " ");
    const ok = await sendTelegram(msg);
    if (ok) {
      health.fired++;
      NOTIFIED.set(it.id, Date.now());
      RETRY.delete(it.id);
      PENDING.set(it.id, { sig: it.sig, at: Date.now(), repeat: it.repeat });
      console.log("[TRIGGER ok]", it.sym);
    } else {
      RETRY.set(it.id, { next: Date.now() + 30000, sig: it.sig, last: it.last }); // ACTIVE rehta hai, 30s baad dobara bhejenge
      console.log("[TRIGGER tg-fail, will retry]", it.sym);
    }
    await sleep(400);
  }
  let lateSent = 0;
  for (const [id, r] of late) {
    const sym = String(r.symbol || "").toUpperCase();
    const key = keyOf[id];
    const last = key ? pickLtp(quotes, key, sym) : undefined;
    const lt = num(r.lastTriggeredAt);
    const msg =
      "\ud83c\udfaf Price Alert Hit!\n\n" +
      "\ud83d\udcc8 Symbol: " + sym + "\n" +
      "\ud83d\udcb0 Price: \u20b9" + (Number.isFinite(last) ? last : "-") + "\n" +
      "\ud83c\udfaf Target: \u20b9" + num(r.price) + "\n" +
      "\u2699\ufe0f Condition: " + String(r.condition || "crossing").replace(/_/g, " ") + "\n" +
      "\ud83d\udd52 " + new Date(lt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    if (await sendTelegram(msg)) {
      NOTIFIED.set(id, Date.now()); lateSent++; health.fired++;
      console.log("[LATE-DELIVERY ok]", sym);
    } else {
      RETRY.set("late:" + id, { next: Date.now() + 30000, sig: "", last: 0 });
      console.log("[LATE-DELIVERY tg-fail, retry]", sym);
    }
    await sleep(400);
  }
  if (PENDING.size) await flushPending();
  await saveState(toFire.length > 0 || lateSent > 0);
  health.lastOkTick = Date.now();
  return { ok: true, active: active.length, fired: toFire.length, lateSent };
}

/* ------------------------------------------------------------- server */
app.get("/", (_req, res) => {
  res.json({
    ok: true, service: "TVUP Alert Worker (Upstox)", version: VERSION, intervalMs: INTERVAL_MS,
    hasToken: Boolean(ENV_TOKEN || goodToken), hasTelegram: Boolean(TG_TOKEN && TG_CHAT),
    firebaseProject: FB_PROJECT || null
  });
});
app.get("/health", (_req, res) => res.send("ok"));
app.get("/status", (_req, res) => {
  res.json({
    version: VERSION, alertMode: ALERT_MODE, uptimeSec: Math.round((Date.now() - health.startedAt) / 1000),
    lastTickAgoSec: health.lastTickEnd ? Math.round((Date.now() - health.lastTickEnd) / 1000) : null,
    lastOkTickAgoSec: health.lastOkTick ? Math.round((Date.now() - health.lastOkTick) / 1000) : null,
    active: health.active, pricesFetched: health.quotes, unresolvedSymbols: health.unresolved,
    upstoxTokenOk: health.tokenOk, firestoreOk: health.fsOk, telegramOk: health.tgOk, telegramError: health.tgError || null,
    docFound: health.docFound ?? null, alertsTotal: health.alertsTotal ?? null, pendingMarks: PENDING.size, totalFired: health.fired, lastError: health.lastError || null
  });
});
app.get("/debug", (_req, res) => {
  res.json({
    version: VERSION, project: FB_PROJECT, alertMode: ALERT_MODE,
    evaluatedAgoSec: health.lastEvalAt ? Math.round((Date.now() - health.lastEvalAt) / 1000) : null,
    alerts: health.lastEval || []
  });
});
let lastTgTest = 0;
app.get("/test-telegram", async (_req, res) => {
  if (Date.now() - lastTgTest < 15000) return res.json({ ok: false, error: "15 sec baad dobara try karo" });
  lastTgTest = Date.now();
  const ok = await sendTelegram("\u2705 TVUP worker test message v" + VERSION + "\n" + istNow());
  res.json({ ok, hasBotToken: Boolean(TG_TOKEN), hasChatId: Boolean(TG_CHAT), error: ok ? null : (health.tgError || "unknown") });
});
app.get("/tick", async (_req, res) => {
  try { res.json({ ok: true, ...(await tick()) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

function start() {
  process.on("unhandledRejection", (e) => console.warn("[unhandledRejection]", e));
  process.on("uncaughtException", (e) => console.warn("[uncaughtException]", e));
  app.listen(process.env.PORT || 3000, async () => {
    console.log(`TVUP Alert Worker (Upstox) v${VERSION} running, interval`, INTERVAL_MS);
    loadSymbolKeyMap().catch(() => {});
    await loadState();
    const loop = async () => {
      await tick().catch((e) => console.warn(e));
      setTimeout(loop, INTERVAL_MS);
    };
    loop();
    // watchdog: loop kisi wajah se ruk jaye to restart
    setInterval(() => {
      if (!ticking && Date.now() - (health.lastTickStart || 0) > INTERVAL_MS * 6) {
        console.warn("[Watchdog] tick stalled — kicking");
        tick().catch(() => {});
      }
    }, 60000);
  });
}

if (require.main === module) start();
module.exports = { shouldFire, condKind, tick, toKey, pickLtp, PENDING, MEM, flushPending };
