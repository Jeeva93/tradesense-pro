# TradeSense Pro — Complete Setup Guide
## Angel One SmartAPI + Cloudflare Worker

---

## STEP 1 — Get Angel One SmartAPI Credentials (FREE)

1. Go to **smartapi.angelbroking.com**
2. Click **Sign Up** → register with your Angel One broker account
3. Create a new app → give it any name e.g. "TradeSense"
4. You will get:
   - ✅ **API Key** (looks like: `abc123xyz`)
   - ✅ **Client ID** (your Angel One login ID)
   - ✅ **Password** (your Angel One trading password)
5. Enable **TOTP** in your Angel One account:
   - Go to Angel One app → Profile → Enable TOTP
   - Scan the QR code with Google Authenticator
   - **Save the secret key shown** (32-character code) — this is your `TOTP_SECRET`

---

## STEP 2 — Deploy Cloudflare Worker

### Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### Create KV Namespace (for token caching)
```bash
wrangler kv:namespace create TRADESENSE_KV
```
Copy the `id` it gives you and paste it in `wrangler.toml`

### Set Secrets (NEVER hardcode these)
```bash
wrangler secret put ANGEL_API_KEY
# → paste your API key when prompted

wrangler secret put ANGEL_CLIENT_ID
# → paste your client ID

wrangler secret put ANGEL_PASSWORD
# → paste your password

wrangler secret put ANGEL_TOTP_SECRET
# → paste your 32-char TOTP secret
```

### Deploy
```bash
wrangler deploy
```

Your worker will be live at:
```
https://tradesense-api.YOUR-CLOUDFLARE-NAME.workers.dev
```

---

## STEP 3 — Connect Frontend to Worker

Open `index.html` and find this line near the top of the script:
```javascript
const WORKER_URL = 'https://tradesense-api.YOUR-NAME.workers.dev';
```

Replace `YOUR-NAME` with your actual Cloudflare subdomain.

Then push `index.html` to your GitHub repo — done!

---

## STEP 4 — Test It

Open your GitHub Pages URL and search for any stock.
The flow is now:

```
User searches stock
    ↓
index.html calls YOUR Cloudflare Worker (no CORS issues)
    ↓
Worker authenticates with Angel One (server-side, secure)
    ↓
Worker returns: price, VWAP, RSI, VIX
    ↓
TradeSense analyses and shows signal + AI insight
```

---

## Cloudflare Worker Free Tier Limits

| Metric          | Free Limit        | Notes                        |
|-----------------|-------------------|------------------------------|
| Requests/day    | 100,000           | Enough for ~1000 users/day   |
| CPU time        | 10ms/request      | Our worker uses ~2ms         |
| KV reads        | 100,000/day       | Token read = 1 KV read       |
| KV writes       | 1,000/day         | Token refresh = 1 write/24h  |

**Paid plan** ($5/month) = 10 million requests/day — handles massive scale.

---

## Monetization Ideas

- **Free**: 5 analyses/day
- **Pro ₹299/month**: Unlimited analyses + alerts
- **Premium ₹799/month**: Portfolio tracking + options chain

Gate features in `index.html` → collect payments via Razorpay/Stripe.

---

## Troubleshooting

**"Login failed: check credentials"**
→ Double-check ANGEL_CLIENT_ID and ANGEL_PASSWORD secrets

**"TOTP invalid"**
→ Your server clock must be accurate. Cloudflare Workers use UTC — this is automatic.

**"Symbol not found"**
→ Use exact NSE trading symbol e.g. `RELIANCE` not `Reliance Industries`

**"No candle data yet"**
→ Market is closed. Worker returns previous session data from /quote instead.

---

## Files in This Package

| File          | Purpose                                    |
|---------------|--------------------------------------------|
| `worker.js`   | Cloudflare Worker — deploy this to CF      |
| `wrangler.toml` | Worker config — update KV namespace ID   |
| `index.html`  | Frontend — host on GitHub Pages            |
| `SETUP.md`    | This guide                                 |
