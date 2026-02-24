// ═══════════════════════════════════════════════════════
//  TradeSense Pro — Cloudflare Worker Backend
//  Handles: Angel One auth, live quotes, CORS
//  Deploy at: https://dash.cloudflare.com → Workers
// ═══════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const ANGEL_BASE = "https://apiconnect.angelone.in";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/quote")   return await getQuote(url, env);
      if (path === "/candles") return await getCandles(url, env);
      if (path === "/vix")     return await getVix(env);
      if (path === "/health")  return ok({ status: "ok", time: new Date().toISOString() });
      return fail("Unknown route. Use /quote /candles /vix /health", 404);
    } catch (e) {
      return fail(`Server error: ${e.message}`, 500);
    }
  }
};

// ─── AUTH — cached in KV for 23h ───────────────────────
async function getToken(env) {
  const cached = await env.TRADESENSE_KV.get("angel_token");
  if (cached) return cached;

  const totp = await generateTOTP(env.ANGEL_TOTP_SECRET);

  const res = await fetch(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "Accept":           "application/json",
      "X-UserType":       "USER",
      "X-SourceID":       "WEB",
      "X-ClientLocalIP":  "127.0.0.1",
      "X-ClientPublicIP": "106.193.147.98",
      "X-MACAddress":     "fe80::216e:6507:4b90:3719",
      "X-PrivateKey":     env.ANGEL_API_KEY,
    },
    body: JSON.stringify({
      clientcode: env.ANGEL_CLIENT_ID,
      password:   env.ANGEL_PASSWORD,
      totp,
    }),
  });

  const data = await res.json();
  if (!data?.data?.jwtToken) throw new Error(`Login failed: ${data?.message || "check credentials"}`);

  const token = data.data.jwtToken;
  await env.TRADESENSE_KV.put("angel_token", token, { expirationTtl: 82800 });
  return token;
}

// ─── LIVE QUOTE ─────────────────────────────────────────
async function getQuote(url, env) {
  const symbol   = url.searchParams.get("symbol");
  const exchange = url.searchParams.get("exchange") || "NSE";
  if (!symbol) return fail("symbol required");

  const token = await getToken(env);

  const searchRes  = await fetch(
    `${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip?exchange=${exchange}&searchscrip=${symbol}`,
    { headers: aHeaders(token, env) }
  );
  const searchData = await searchRes.json();
  const scrip      = searchData?.data?.[0];
  if (!scrip) return fail(`Symbol not found: ${symbol}`);

  const quoteRes  = await fetch(`${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: "POST",
    headers: aHeaders(token, env),
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { [exchange]: [scrip.symboltoken] } }),
  });
  const quoteData = await quoteRes.json();
  const q         = quoteData?.data?.fetched?.[0];
  if (!q) return fail("Quote unavailable");

  return ok({
    symbol:      scrip.tradingsymbol,
    exchange,
    price:       +q.ltp,
    open:        +q.open,
    high:        +q.high,
    low:         +q.low,
    prevClose:   +q.close,
    volume:      +q.tradedVolume,
    change:      +q.netChange,
    changePct:   +q.percentChange,
    symboltoken: scrip.symboltoken,
  });
}

// ─── CANDLE DATA → VWAP + RSI ──────────────────────────
async function getCandles(url, env) {
  const symbol   = url.searchParams.get("symbol");
  const exchange = url.searchParams.get("exchange") || "NSE";
  const interval = url.searchParams.get("interval") || "TEN_MINUTE";
  if (!symbol) return fail("symbol required");

  const token = await getToken(env);

  const searchRes  = await fetch(
    `${ANGEL_BASE}/rest/secure/angelbroking/order/v1/searchScrip?exchange=${exchange}&searchscrip=${symbol}`,
    { headers: aHeaders(token, env) }
  );
  const searchData = await searchRes.json();
  const scrip      = searchData?.data?.[0];
  if (!scrip) return fail(`Symbol not found: ${symbol}`);

  const now  = new Date();
  const from = new Date(now);
  from.setHours(9, 15, 0, 0);

  const candleRes  = await fetch(
    `${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`,
    {
      method: "POST",
      headers: aHeaders(token, env),
      body: JSON.stringify({
        exchange,
        symboltoken: scrip.symboltoken,
        interval,
        fromdate: fmtDate(from),
        todate:   fmtDate(now),
      }),
    }
  );
  const candleData = await candleRes.json();
  const candles    = candleData?.data;
  if (!candles?.length) return fail("No candle data yet — market may be closed");

  // [timestamp, open, high, low, close, volume]
  let cumTPV = 0, cumVol = 0;
  const closes = [];
  for (const c of candles) {
    const [, , h, l, cl, v] = c;
    cumTPV += ((h + l + cl) / 3) * v;
    cumVol += v;
    closes.push(cl);
  }

  return ok({
    vwap: cumVol > 0 ? +(cumTPV / cumVol).toFixed(2) : closes.at(-1),
    rsi:  calcRSI(closes, 14),
  });
}

// ─── INDIA VIX ─────────────────────────────────────────
async function getVix(env) {
  // Fetch directly from NSE (no auth needed, server-side so no CORS)
  const res = await fetch("https://www.nseindia.com/api/allIndices", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":     "application/json",
      "Referer":    "https://www.nseindia.com/",
    },
  });
  const data    = await res.json();
  const vixData = data?.data?.find(i => i.index === "INDIA VIX");
  if (!vixData) return fail("VIX not found");

  return ok({
    vix:       +vixData.last,
    changePct: +vixData.percentChange,
    high:      +vixData.high,
    low:       +vixData.low,
  });
}

// ─── TOTP (Angel One 2FA) ──────────────────────────────
async function generateTOTP(secret) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const ch of clean) {
    const v = chars.indexOf(ch);
    if (v !== -1) bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));

  const counter     = Math.floor(Date.now() / 30000);
  const counterBuf  = new Uint8Array(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) { counterBuf[i] = tmp & 0xff; tmp >>>= 8; }

  const key  = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig  = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuf));
  const off  = sig[19] & 0xf;
  const code = ((sig[off] & 0x7f) << 24 | sig[off+1] << 16 | sig[off+2] << 8 | sig[off+3]) % 1_000_000;

  return code.toString().padStart(6, "0");
}

// ─── HELPERS ───────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : +((100 - 100 / (1 + ag / al)).toFixed(2));
}

function aHeaders(token, env) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    "X-UserType":    "USER",
    "X-SourceID":    "WEB",
    "X-PrivateKey":  env.ANGEL_API_KEY,
  };
}

function fmtDate(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ok(data)          { return new Response(JSON.stringify({ success: true, data }),          { headers: CORS }); }
function fail(msg, s = 400){ return new Response(JSON.stringify({ success: false, error: msg }),   { status: s, headers: CORS }); }
