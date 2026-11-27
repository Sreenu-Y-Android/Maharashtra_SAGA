# BluGate Integration Guide

> **For the agent reading this:** you are migrating an application that calls
> social-media data APIs **directly** (RapidAPI hosts or the official YouTube API)
> so that it calls them **through BluGate** instead. Follow the steps in order.
> Do not skip the inventory or the verification step. Everything you need —
> URLs, headers, every endpoint — is in this file.
>
> This guide was written from the working migration in **AP.Blura.Saga**
> (commits `953fb6e` and `240c412`), which has been running in production.
>
> **Optional add-on — direct fallback (§10).** After the migration works, an app can add a
> switchable fallback: when BluGate rate-limits or fails, the same call goes straight to the
> provider. It runs in the Blura SAGA Chhattisgarh and Goa apps. Everything needed — config,
> behaviour, code (Node and Python), offline tests — is in §10 and Appendices C–E.

---

## 0. Rules you must follow

1. **Change the transport, not the data handling.** BluGate returns the provider's
   response body unchanged. Parsing, normalisation and storage code must not change.
   If you find yourself rewriting a parser, stop — you've made a mistake upstream.
2. **Only call routes listed in [Appendix A](#appendix-a-full-endpoint-catalog).**
   A route not in the catalog does not exist on BluGate. Every call is metered and
   billed, including failed ones.
3. **Never send blank parameters.** Drop `null`, `undefined`, empty strings and `NaN`
   before every request (§3 does this for you).
4. **Never hard-code or log credentials.** They come from environment variables only.
   Do not print request headers. Do not commit `.env`.
5. **Don't migrate what isn't in BluGate.** If the app calls a RapidAPI service that
   is not one of the four platforms below (e.g. an LLM such as `chatgpt-42`, or
   `google-ai-mode`), leave it untouched and list it in your final report (§9).
6. **Keep a revert path.** Comment out the old RapidAPI variables in `.env` rather
   than deleting them. (If the app later adds the §10 fallback, these become its fallback keys.)
7. **One platform at a time.** Migrate, verify, then move to the next.

---

## 1. What BluGate is

BluGate is a metered gateway in front of four data providers. The application sends
every request to one base URL with one credential pair; BluGate forwards it to the
real provider and records usage against the calling client.

```
BEFORE                                         AFTER
app ──► twitter241.p.rapidapi.com              app ──► blugate.blurasaga.com/api/gateway/twitter
app ──► instagram120.p.rapidapi.com            app ──► blugate.blurasaga.com/api/gateway/instagram
app ──► facebook-scraper3.p.rapidapi.com       app ──► blugate.blurasaga.com/api/gateway/facebook
app ──► www.googleapis.com/youtube/v3          app ──► blugate.blurasaga.com/api/gateway/youtube
         (each with its own keys)                        (one key + one client code)
```

The **path and parameters after the prefix are identical** to the provider's own API.

---

## 2. Credentials and configuration

| Variable | Value | Notes |
|---|---|---|
| `BLUGATE_BASE_URL` | `https://blugate.blurasaga.com/api/gateway` | No trailing slash. Optional — use this as the default. |
| `BLUGATE_API_KEY` | *(secret, ask the user)* | Sent as `Authorization: Bearer <key>` |
| `BLUGATE_CLIENT_CODE` | *(ask the user)* | Sent as `x-client-id: <code>`. Identifies **which application** the usage is billed to. |
| `BLUGATE_FALLBACK_ENABLED` | `false` | **Optional, §10 only.** Turns on the direct-provider fallback. The fallback's own keys are listed in §10.2. |

**Ask the user for the key and client code — do not copy them from another project.**
Usage is tracked per client code, so each application should normally have its own.

Add to `.env` (and to `.env.example` with empty values):

```env
# BluGate gateway (routes YouTube, X/Twitter, Facebook, Instagram)
BLUGATE_BASE_URL=https://blugate.blurasaga.com/api/gateway
BLUGATE_API_KEY=
BLUGATE_CLIENT_CODE=
```

### Header change, per request

| | Before (RapidAPI) | After (BluGate) |
|---|---|---|
| Auth headers | `x-rapidapi-key: <key>`<br>`x-rapidapi-host: <host>` | `Authorization: Bearer <BLUGATE_API_KEY>`<br>`x-client-id: <BLUGATE_CLIENT_CODE>` |
| YouTube | `?key=<YOUTUBE_API_KEY>` query param, or the `googleapis` SDK | No `key` param. Plain HTTP GET with the two headers above. |

Remove `x-rapidapi-key` / `x-rapidapi-host` completely — do not send both sets.

---

## 3. Step 1 — Inventory the codebase

Run these searches from the repo root and write down **every** hit before editing anything:

```bash
# Direct RapidAPI hosts and headers
grep -rnE "p\.rapidapi\.com|x-rapidapi-(key|host)" --include=*.{js,ts,mjs,cjs,py} .
# RapidAPI env vars
grep -rnE "RAPIDAPI_[A-Z_]*" --include=*.{js,ts,mjs,cjs,py} .
grep -nE "RAPIDAPI_" .env .env.* 2>/dev/null
# Official YouTube Data API
grep -rnE "googleapis\.com/youtube|google\.youtube\(|from googleapiclient|YOUTUBE_API_KEY" --include=*.{js,ts,mjs,cjs,py} .
# Provider names used as hosts
grep -rnE "twitter241|instagram120|facebook-scraper3" --include=*.{js,ts,mjs,cjs,py} .
```

Classify each hit:

| Hit is… | Action |
|---|---|
| `twitter241`, `instagram120`, `facebook-scraper3`, or the YouTube Data API v3 | **Migrate** (§5) |
| Any other RapidAPI host (LLMs, `google-ai-mode`, etc.) | **Leave alone**, report it |
| Official X API via `twitter-api-v2` / `X_BEARER_TOKEN` for **posting** or actions | **Leave alone**, report it |
| Facebook Graph API with a user/page access token | **Leave alone**, report it |
| Scraping `youtube.com/@handle/live` or `/streams` pages | **Leave alone** — not a BluGate route |
| Key-rotation / multi-key logic for the migrated providers | **Remove** in §5 (BluGate is one credential) |

For every call you will migrate, note the **route** and **params** and check them
against [Appendix A](#appendix-a-full-endpoint-catalog). Flag any route that is
not in the catalog — do not migrate it blindly; tell the user.

---

## 4. Step 2 — Add one shared client

Create a single module that every platform service uses. Pick the language of the app.

### Node.js (axios) — this is the exact client running in AP.Blura.Saga

```js
// src/services/blugateClient.js
const axios = require('axios');

const DEFAULT_GATEWAY_BASE = 'https://blugate.blurasaga.com/api/gateway';
const GATEWAY_BASE = String(process.env.BLUGATE_BASE_URL || DEFAULT_GATEWAY_BASE)
    .trim().replace(/\/+$/, '');

const hasCredentials = () =>
    !!(process.env.BLUGATE_API_KEY && process.env.BLUGATE_CLIENT_CODE);

const getHeaders = () => {
    const apiKey = process.env.BLUGATE_API_KEY;
    const clientCode = process.env.BLUGATE_CLIENT_CODE;
    if (!apiKey || !clientCode) {
        throw new Error('BLUGATE_API_KEY / BLUGATE_CLIENT_CODE is not configured');
    }
    return { Authorization: `Bearer ${apiKey}`, 'x-client-id': clientCode };
};

// Drop null / undefined / '' / NaN so BluGate never receives blank params.
const cleanParams = (params) => {
    if (!params || typeof params !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        if (typeof v === 'number' && !Number.isFinite(v)) continue;
        out[k] = v;
    }
    return out;
};

// platform: 'twitter' | 'instagram' | 'facebook' | 'youtube'
const request = async (platform, { method = 'get', path = '', params, data, headers = {}, timeout = 30000 } = {}) => {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    return axios({
        method,
        url: `${GATEWAY_BASE}/${platform}/${cleanPath}`,
        params: cleanParams(params),
        data,
        timeout,
        headers: { ...getHeaders(), ...headers },
    });
};

const get  = (platform, path, params, opts = {}) => request(platform, { method: 'get',  path, params, ...opts });
const post = (platform, path, data,   opts = {}) => request(platform, { method: 'post', path, data,   ...opts });

module.exports = { GATEWAY_BASE, hasCredentials, getHeaders, cleanParams, request, get, post };
```

### Python (requests) — equivalent

```python
# blugate_client.py
import math, os, requests

GATEWAY_BASE = os.getenv("BLUGATE_BASE_URL", "https://blugate.blurasaga.com/api/gateway").strip().rstrip("/")

def has_credentials() -> bool:
    return bool(os.getenv("BLUGATE_API_KEY") and os.getenv("BLUGATE_CLIENT_CODE"))

def get_headers() -> dict:
    key, code = os.getenv("BLUGATE_API_KEY"), os.getenv("BLUGATE_CLIENT_CODE")
    if not key or not code:
        raise RuntimeError("BLUGATE_API_KEY / BLUGATE_CLIENT_CODE is not configured")
    return {"Authorization": f"Bearer {key}", "x-client-id": code}

def clean_params(params):
    if not params:
        return None
    out = {}
    for k, v in params.items():
        if v is None: continue
        if isinstance(v, str) and not v.strip(): continue
        if isinstance(v, float) and not math.isfinite(v): continue
        out[k] = v
    return out

def request(platform, path="", method="GET", params=None, json=None, timeout=30):
    url = f"{GATEWAY_BASE}/{platform}/{str(path).lstrip('/')}"
    resp = requests.request(method, url, params=clean_params(params), json=json,
                            headers=get_headers(), timeout=timeout)
    resp.raise_for_status()
    return resp.json()

def get(platform, path, params=None, **kw):  return request(platform, path, "GET",  params=params, **kw)
def post(platform, path, json=None, **kw):   return request(platform, path, "POST", json=json, **kw)
```

---

## 5. Step 3 — Migrate each platform

General recipe for every call site:

1. Replace the base URL with the gateway prefix for that platform.
2. Replace the auth headers with `getHeaders()` (or use `blugateClient.get/post`).
3. Keep the **same path, same params, same method**.
4. Keep the response handling exactly as it was.

### 5.1 X / Twitter (`twitter241`) — GET, query params

| | Value |
|---|---|
| Gateway prefix | `{BLUGATE_BASE_URL}/twitter` |
| Method | `GET` for every route |
| Params | Query string |

```js
// BEFORE
const res = await axios.get('https://twitter241.p.rapidapi.com/user', {
    params: { username: 'nasa' },
    headers: { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'x-rapidapi-host': 'twitter241.p.rapidapi.com' },
});

// AFTER
const res = await blugateClient.get('twitter', 'user', { username: 'nasa' });
// res.data has exactly the same shape as before
```

**Validate before calling.** X has the largest catalog and is the easiest place to
waste paid hits. Add a local table of `route → required params` (copy it from
Appendix A, X section) and reject a call **before sending it** if the route is
unknown or a required param is missing. AP.Blura.Saga does this in
`prepareXRequest()`:

```js
const X_REQUIRED = { 'user': ['username'], 'user-tweets': ['user', 'count'],
    'search': ['type', 'count', 'query'], 'comments': ['pid'], 'tweet-v2': ['pid'], /* …all others from Appendix A */ };

function prepareXRequest(route, params) {
    const name = String(route).replace(/^\/+/, '').split('?')[0];
    if (!(name in X_REQUIRED)) { const e = new Error(`Unknown BluGate X route /${name}`); e.code = 'BLUGATE_X_UNKNOWN_ENDPOINT'; throw e; }
    const cleaned = blugateClient.cleanParams(params) || {};
    const missing = X_REQUIRED[name].filter(p => !(p in cleaned));
    if (missing.length) { const e = new Error(`/${name} missing: ${missing.join(', ')}`); e.code = 'BLUGATE_X_MISSING_PARAMS'; throw e; }
    return { name, params: cleaned };
}
```

X gotchas:
- `user-tweets`, `user-replies`, `user-media`, `followers`, `followings` take **`user` = numeric `rest_id`**, not a username. Resolve it once with `GET /user?username=…` (`result.rest_id`) and cache it.
- `search` requires all three of `type` (`Top` / `Latest` / `People` / `Photos` / `Videos`), `count`, `query`.
- `/tweet` and `/likes` are marked deprecated — prefer `/tweet-v2`; keep `/tweet` only as a fallback.
- Routes like `/tweet-details`, `/tweet-retweets`, `/favoriters` **do not exist** on BluGate. If the old code has them as fallbacks, delete those fallbacks.

### 5.2 Instagram (`instagram120`) — mostly POST, JSON body

| | Value |
|---|---|
| Gateway prefix | `{BLUGATE_BASE_URL}/instagram` |
| Method | `POST` with JSON body for almost all routes (`/api/instagram/get` and `/api/instagram/hls` are GET) |
| Path | Keep the full `/api/instagram/...` path after the prefix |

```js
// BEFORE
const res = await axios.post('https://instagram120.p.rapidapi.com/api/instagram/posts',
    { username: 'natgeo', maxId: '' },
    { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'instagram120.p.rapidapi.com', 'Content-Type': 'application/json' } });

// AFTER
const res = await blugateClient.post('instagram', 'api/instagram/posts',
    { username: 'natgeo' },                       // omit maxId unless paginating
    { headers: { 'Content-Type': 'application/json' } });
// → POST https://blugate.blurasaga.com/api/gateway/instagram/api/instagram/posts
```

Instagram gotchas:
- **Validate usernames locally** before calling: `/^[A-Za-z0-9._]{1,30}$/`. Strip `@`, trailing `/`, and extract from `instagram.com/<name>` URLs. Free-text, URLs or blanks make the provider return 500 — and that hit is still billed.
- Do **not** retry a plain `500` — for Instagram it's deterministic (private/unknown account).
- There is **no search or hashtag route**. Only direct profile lookups.
- Paths like `/api/instagram/media`, `/media/info`, `/post/info`, `/user/info`, `/user/posts`, `/user/stories` **do not exist**. Use `mediaByShortcode`, `userInfo`, `posts`, `stories` instead.
- If the old code rotated multiple RapidAPI keys, delete the rotation — there is one BluGate credential.

### 5.3 Facebook (`facebook-scraper3`) — GET, query params

| | Value |
|---|---|
| Gateway prefix | `{BLUGATE_BASE_URL}/facebook` |
| Method | `GET` |
| Params | Query string |

```js
// BEFORE
const res = await axios.get('https://facebook-scraper3.p.rapidapi.com/page/posts', {
    params: { page_id: '100064', cursor },
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'facebook-scraper3.p.rapidapi.com' },
});

// AFTER
const res = await blugateClient.get('facebook', 'page/posts', { page_id: '100064', cursor }, { timeout: 20000 });
```

Facebook gotchas:
- Most page routes need a **numeric `page_id`**. Resolve a URL/slug once (`/page/page_id?url=…` or `/search/pages?query=…`) and **cache it** (AP.Blura.Saga caches for 6 hours).
- `cursor` is optional — `cleanParams` will drop it when empty, which is what you want on the first page.
- Group routes only work for **public** groups.

### 5.4 YouTube (YouTube Data API v3) — GET, query params, **no API key**

| | Value |
|---|---|
| Gateway prefix | `{BLUGATE_BASE_URL}/youtube` |
| Method | `GET` (reads) |
| Params | Same as Google's REST API: `part`, `id`, `q`, `type`, `maxResults`, `pageToken`, `channelId`, … |
| Remove | the `key=` param, `YOUTUBE_API_KEY`, and the `googleapis` SDK client |

```js
// BEFORE (googleapis SDK)
const { google } = require('googleapis');
const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
const { data } = await youtube.channels.list({ part: 'snippet,statistics', id: channelId });

// BEFORE (raw HTTP)
const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels',
    { params: { part: 'snippet,statistics', id: channelId, key: process.env.YOUTUBE_API_KEY } });

// AFTER
const { data } = await blugateClient.get('youtube', 'channels', { part: 'snippet,statistics', id: channelId });
// data.items[...] — identical shape
```

SDK → REST mapping: `youtube.<resource>.list(params)` becomes `GET /<resource>` with the same
params (`search.list` → `/search`, `videos.list` → `/videos`, `playlistItems.list` →
`/playlistItems`, `commentThreads.list` → `/commentThreads`, `channels.list` → `/channels`).
SDK array params (`part: ['snippet','statistics']`) must be joined with commas.

YouTube gotchas:
- The catalog lists the whole Data API, including write routes (`insert`, `update`, `delete`, `rate`, live chat moderation). Those need a user's OAuth token, and **only the read routes listed in §7 have been proven through BluGate**. Don't migrate write calls without asking the user.
- `/search` costs far more quota than other reads on Google's side — keep existing caching.
- Scraping `youtube.com/@handle/live` / `/streams` is not a BluGate route. Leave it.

---

## 6. Step 4 — Errors, retries, rate limits

There is **one** credential, so a rate-limit pauses that platform for the whole app.
Use these rules (they are what production runs):

| Response | Meaning | Do this |
|---|---|---|
| `429`, or `403` whose message mentions quota / limit / rate | Rate limited | Back off and retry. X: wait 5 s then 10 s, max 2 retries. Instagram: cool down 60 s, doubling per failure, max 10 min. Facebook: honour `Retry-After`, else cool down 90 s and fail fast during the cooldown. |
| `502` / `503` / `504` | Gateway or provider transient | Wait 2 s, retry once. |
| `404` | Route doesn't exist | **Don't retry.** Fix the path — check Appendix A. |
| `401` / `403` (not quota) | Credentials wrong or missing | **Don't retry.** Stop and tell the user. |
| `500` | Usually a bad input (e.g. private Instagram account) | **Don't retry.** Log and move on. |
| Other `4xx` | Bad params | **Don't retry.** Fix the call. |

**Gate features on credentials.** Wherever the app runs a scheduled scan or exposes
a feature that needs one of these platforms, check `hasCredentials()` first and skip
with a clear log line (`"BluGate credentials not configured. Skipping scan."`)
instead of throwing on every tick.

**Optional — non-English text.** If the app ingests Telugu or another non-Latin
script: the X provider sometimes returns a body whose UTF-8 was decoded as
Windows-1252 (text looks like `à°µà°°...`). It can't be repaired, but a retry
usually comes back clean. AP.Blura.Saga retries up to 2 times when it detects this.

---

## 7. Routes proven in production

These are the routes AP.Blura.Saga calls through BluGate today. Prefer them; anything
else in Appendix A is valid per the catalog but hasn't been exercised by us.

| Platform | Routes |
|---|---|
| X | `/user`, `/user-tweets`, `/search`, `/comments`, `/tweet-v2`, `/tweet` (fallback) |
| Instagram | `POST /api/instagram/posts`, `/profile`, `/userInfo`, `/stories`, `/mediaByShortcode` |
| Facebook | `/page/posts`, `/post/comments`, `/search/pages`, `/search/posts` |
| YouTube | `/search`, `/videos`, `/channels`, `/playlistItems`, `/commentThreads` |

---

## 8. Step 5 — Verify

### 8.1 Smoke-test the credentials (one billed hit each)

```bash
B=https://blugate.blurasaga.com/api/gateway
H1="Authorization: Bearer $BLUGATE_API_KEY"
H2="x-client-id: $BLUGATE_CLIENT_CODE"

curl -s -H "$H1" -H "$H2" "$B/youtube/search?part=snippet&q=news&type=channel&maxResults=1" | head -c 300; echo
curl -s -H "$H1" -H "$H2" "$B/twitter/user?username=nasa" | head -c 300; echo
curl -s -H "$H1" -H "$H2" -H "Content-Type: application/json" -X POST \
     -d '{"username":"instagram"}' "$B/instagram/api/instagram/userInfo" | head -c 300; echo
curl -s -H "$H1" -H "$H2" "$B/facebook/search/pages?query=nasa" | head -c 300; echo
```

Each should return provider JSON, not an auth error. Don't print the variables.

### 8.2 Prove nothing still goes direct

Re-run the §3 searches. The only remaining hits must be ones you deliberately left
(other RapidAPI products, posting APIs, commented-out `.env` lines).

### 8.3 Exercise the app

Run each migrated feature once (a scan, a search, a profile fetch) and check:
- data appears exactly as before (same fields, same counts);
- logs show no `404` (wrong route) and no `BLUGATE_X_*` validation errors;
- with `BLUGATE_API_KEY` unset, features skip cleanly instead of crashing.

Run the project's existing tests and fix anything you broke.

---

## 9. Step 6 — Clean up and report

Clean up:
- Comment out (don't delete) old `RAPIDAPI_*` and `YOUTUBE_API_KEY` lines in `.env`.
- Remove now-unused key-rotation code and the `googleapis` dependency if nothing else uses it.
- You may keep existing file names (e.g. `rapidApiXService.js`) to keep the diff small — say so in the report.

Report back to the user with:
1. Files changed, grouped by platform.
2. Routes migrated, and any that weren't in the catalog (and what you did about them).
3. Direct API calls you deliberately left alone, and why.
4. Smoke-test and app-test results — paste real output, don't summarise failures away.
5. Anything that needs the user: credentials, write/OAuth YouTube calls, unknown routes.
6. If you also added the §10 fallback: the items in §10.10.

---

## 10. Optional — direct-provider fallback when BluGate fails

> Added from the Blura SAGA **Chhattisgarh** and **Goa** apps (Nov 2026), where it runs in
> both. Do this only **after §5–§8 are done and BluGate works on its own.** With the switch
> off, the app behaves exactly as §1–§9 describe.

### 10.1 Why, and the trade-off

BluGate is one shared credential per client and throttles bursts
(`429 {"error":"Too many gateway requests","retryAfterSec":35}`). Under heavy collection that
stalls a platform. The fallback keeps collection running: when BluGate can't serve a call,
the **same path and params** go straight to the provider (RapidAPI, or Google for YouTube).
BluGate is a pass-through (§1), so the response body is identical and **no parser changes**.

Direct calls are billed by RapidAPI / Google, not BluGate, and bypass BluGate's per-client
usage tracking. That is why it is an **on/off switch**, off by default.

> This is the one deliberate exception to §8.2 ("prove nothing still goes direct"): direct calls
> are allowed **only** inside the shared client, **only** as a fallback, **only** when switched on.
> When you re-run the §3 searches after adding §10, the hits inside `blugateClient.js` (the
> `x-rapidapi-key` / `X-goog-api-key` headers and the default provider hosts) are expected;
> a hit anywhere else is a bypass to fix (§10.4).

### 10.2 Configuration — one block in `.env`

Keep every BluGate-related setting together in one block (Chhattisgarh and Goa do this),
so nobody has to hunt for the switch or the keys:

```env
# ══════════ BluGate: X / Facebook / Instagram / YouTube ══════════
# Every platform call goes through BluGate first. Restart the backend after changing anything here.

# 1. Gateway (primary route)
BLUGATE_BASE_URL=https://blugate.blurasaga.com/api/gateway
BLUGATE_API_KEY=
BLUGATE_CLIENT_CODE=

# 2. Direct fallback switch
# false = BluGate only. true = when BluGate rate-limits (429 / 403 quota), rejects auth (401/403),
# has a gateway error (502/503/504) or times out, the same call goes straight to the provider.
# A platform without its direct key (section 3) never falls back.
BLUGATE_FALLBACK_ENABLED=false
# BLUGATE_FALLBACK_COOLDOWN_SECONDS=60

# 3. Direct provider keys: used ONLY by the fallback. Uncomment a platform to let it fall back.
#    Hosts default to twitter241 / facebook-scraper3 / ig-downloader-api / googleapis.
# X / Twitter
# RAPIDAPI_KEY=
# RAPIDAPI_HOST=twitter241.p.rapidapi.com
# Facebook
# RAPIDAPI_FACEBOOK_KEY=
# RAPIDAPI_FACEBOOK_HOST=facebook-scraper3.p.rapidapi.com
# Instagram
# RAPIDAPI_INSTAGRAM_KEYS=
# RAPIDAPI_INSTAGRAM_HOST=ig-downloader-api.p.rapidapi.com
# YouTube
# YOUTUBE_API_KEY=
```

| Variable | Default | Meaning |
|---|---|---|
| `BLUGATE_FALLBACK_ENABLED` | `false` | `true` / `1` / `on` / `yes` turns the fallback on. Anything else = BluGate only. |
| `BLUGATE_FALLBACK_COOLDOWN_SECONDS` | `60` | How long a platform stays on direct after a BluGate rate limit, when BluGate gives no `retryAfterSec`. |
| `RAPIDAPI_KEY` / `RAPIDAPI_HOST` | host `twitter241.p.rapidapi.com` | X direct key. |
| `RAPIDAPI_FACEBOOK_KEY` / `_HOST` | key falls back to `RAPIDAPI_KEY`; host `facebook-scraper3.p.rapidapi.com` | Facebook direct key. |
| `RAPIDAPI_INSTAGRAM_KEYS` / `_HOST` | first key of a comma list; falls back to `RAPIDAPI_KEY`; host `ig-downloader-api.p.rapidapi.com` | Instagram direct key. See the note below. |
| `YOUTUBE_API_KEY` | base `https://www.googleapis.com/youtube/v3` (override `YOUTUBE_API_BASE_URL`) | YouTube direct key. |

**Instagram fallback host.** The Instagram fallback goes to `ig-downloader-api.p.rapidapi.com`,
a different RapidAPI listing from `instagram120`, which BluGate fronts (§1, §5.2). The fallback
re-sends the same `/api/instagram/...` path and JSON body, so before relying on it confirm the
key works with that host: `node scripts/check_platform_apis.js --direct` (§10.9). If an
Instagram direct call returns 404, that route doesn't exist on the fallback host; the error
surfaces as it would without the fallback.

If the app was migrated with §9 ("comment out, don't delete"), its old RapidAPI / YouTube lines
are already in `.env`, commented: move them into section 3 of the block. Ask the user which keys
are still valid — never copy keys from another project.

### 10.3 Behaviour

| BluGate result | Falls back? | Cooldown (platform stays on direct) |
|---|---|---|
| success | no | — |
| `429` | **yes, immediately** — do not sleep through BluGate's `retryAfterSec` | `retryAfterSec` / `Retry-After`, else `BLUGATE_FALLBACK_COOLDOWN_SECONDS`; max 15 min |
| `403` whose message mentions quota / limit / exceeded / rate | yes (treated as a rate limit) | as above |
| `401`, other `403`, or BluGate credentials missing | yes | 10 minutes |
| `502` / `503` / `504` | yes | none |
| timeout / network error (no response) | yes | none |
| `404` (route doesn't exist) | **no** — fails directly too, still billed | — |
| other `4xx` (bad params) | **no** | — |
| `500` (e.g. Instagram private/unknown account, §5.2) | **no** | — |

Further rules:
- **Per platform.** An X rate limit moves only X to direct; Facebook keeps using BluGate.
- **During a cooldown** calls go straight to the provider without touching BluGate; after it, BluGate is tried again.
- **No direct key for a platform → that platform never falls back** (BluGate only, even when switched on).
- **Switch off → exactly §6**, including BluGate's in-place 429 retry.
- **Direct fails too →** the error surfaces as before, so the caller's existing error handling (cooldowns, skip-and-log) still applies.
- Each response is tagged `response.provider = 'blugate' | 'direct'`; per-platform counts (`blugate`, `direct`, `fallbacks`, `directFailures`) are available from `getFallbackStats()`.

### 10.4 The one rule: a single choke point

The fallback lives in **one function, `call()`, in the shared client**. Every platform call in
the app must go through it (or through `get` / `post` / `request`, which use it). **A service
that builds its own `axios(...)` call from the gateway URL and `getHeaders()` silently bypasses
the fallback** — and the credential scrubbing (§10.7).

Find bypasses before writing any code:

```bash
# services that build their own gateway calls (must be converted to call())
grep -rnE "baseUrl\(|GATEWAY_BASE\}|getHeaders\(|responseOptions\(" --include=*.js src | grep -v blugateClient.js
# every axios call in platform services (check each one is not a provider/gateway call)
grep -rnE "axios(\.(get|post|request)|\()" --include=*.js src/services
```

Convert each one — **transport only, same path, same params, same response handling**:

```js
// BEFORE (bypasses the fallback)
const res = await axios.post(`${INSTAGRAM_BASE}${path}`, data, {
    headers: { ...blugateClient.getHeaders(), 'Content-Type': 'application/json' },
    timeout: 30000, ...blugateClient.responseOptions(),
});

// AFTER
const res = await blugateClient.call('instagram', {
    method: 'post', path, data,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
});
```

In Chhattisgarh / Goa the call sites that had to be converted were: the X service's central
request function (`method`, `url`, `params` → `call('twitter', { method, path, params, … })`),
Facebook `rapidGet`, Instagram `rapidPost`, a grievance X search and a media tweet lookup.
Calls already made through `blugateClient.get/post` (all YouTube calls) needed no change.
Leave alone anything that is not one of the four BluGate platforms (LLMs, Graph API with a
page token, public-page scraping, the app's own internal services).

Existing outer retry / cooldown logic in a service can stay: with the fallback on, a BluGate
429 never reaches it (the call already succeeded directly); with it off, it behaves as before.

### 10.5 Node.js implementation

Replace `src/services/blugateClient.js` with **[Appendix C](#appendix-c-nodejs-client-with-direct-fallback)**
verbatim. It is a superset of the §4 client — `get`, `post`, `request`, `getHeaders`,
`hasCredentials`, `cleanParams`, `GATEWAY_BASE` keep their signatures, so code written for §4
keeps working — and adds:

| Export | Purpose |
|---|---|
| `call(platform, { method, path, params, data, headers, timeout })` | The one place a platform call is made (BluGate → fallback). |
| `baseUrl(platform)`, `providerLabel()` | Gateway URL per platform; log label. |
| `fallbackEnabled()`, `directReady(platform)` | Switch state; whether a platform can fall back. |
| `fallbackReason(error)` | The decision in §10.3 (`'rate-limit'`, `'auth'`, `'gateway'`, `'network'` or `null`). |
| `scrubError(error)` | Redacts credentials on an error (§10.7). |
| `getFallbackStats()` | Per-platform counters and active cooldowns. |
| `callDirect(platform, opts)` | Diagnostics only (`check_platform_apis.js --direct`); refuses unless the fallback is ready. |
| `resetFallbackState()` | Tests only. |

It also keeps the BluGate helpers the Chhattisgarh/Goa apps needed in production:
`decodeBody`/`responseOptions` (BluGate sometimes labels plain JSON as gzip), `retryAfterMs`,
`isRateLimited`, `withRateLimitRetry`.

`hasCredentials(platform)` is now true when **either** BluGate is configured **or** that
platform's fallback is ready — so feature gates (§6) keep working on direct-only setups.

### 10.6 Python implementation

Equivalent client (same rules as §10.3; tested offline, 16 checks — Appendix E):

```python
# blugate_client.py: BluGate first, optional direct-provider fallback (Python equivalent of Appendix C)
import logging, math, os, re, time

import requests

log = logging.getLogger("blugate")
GATEWAY_BASE = os.getenv("BLUGATE_BASE_URL", "https://blugate.blurasaga.com/api/gateway").strip().rstrip("/")


class BluGateNotConfigured(RuntimeError):
    pass


def _first(v):
    return (v or "").strip().strip("\"'").split(",")[0].strip()


def _rapid(host, default, key):
    h = re.sub(r"^https?://", "", (host or "").strip().strip("\"'")).rstrip("/") or default
    return {"base": f"https://{h}", "host": h, "key": _first(key)}


# Hosts default to the providers BluGate fronts; keys come only from the environment.
DIRECT = {
    "twitter": lambda: _rapid(os.getenv("RAPIDAPI_HOST"), "twitter241.p.rapidapi.com", os.getenv("RAPIDAPI_KEY")),
    "facebook": lambda: _rapid(os.getenv("RAPIDAPI_FACEBOOK_HOST"), "facebook-scraper3.p.rapidapi.com",
                               os.getenv("RAPIDAPI_FACEBOOK_KEY") or os.getenv("RAPIDAPI_KEY")),
    "instagram": lambda: _rapid(os.getenv("RAPIDAPI_INSTAGRAM_HOST"), "ig-downloader-api.p.rapidapi.com",
                                os.getenv("RAPIDAPI_INSTAGRAM_KEY") or os.getenv("RAPIDAPI_INSTAGRAM_KEYS") or os.getenv("RAPIDAPI_KEY")),
    "youtube": lambda: {"base": (os.getenv("YOUTUBE_API_BASE_URL") or "https://www.googleapis.com/youtube/v3").strip().rstrip("/"),
                        "key": _first(os.getenv("YOUTUBE_API_KEY")), "google": True},
}


def fallback_enabled():
    return os.getenv("BLUGATE_FALLBACK_ENABLED", "").strip().lower() in ("true", "1", "on", "yes")


def direct_ready(platform):
    if not fallback_enabled() or platform not in DIRECT:
        return False
    d = DIRECT[platform]()
    return bool(d["key"] and d["base"])


def get_headers():
    key, code = os.getenv("BLUGATE_API_KEY"), os.getenv("BLUGATE_CLIENT_CODE")
    if not key or not code:
        raise BluGateNotConfigured("BLUGATE_API_KEY / BLUGATE_CLIENT_CODE is not configured")
    return {"Authorization": f"Bearer {key}", "x-client-id": code}


def _direct_headers(d):
    # YouTube's key goes in a header, never the URL, so it cannot end up in a logged URL.
    return {"X-goog-api-key": d["key"]} if d.get("google") else {"x-rapidapi-key": d["key"], "x-rapidapi-host": d["host"]}


def clean_params(params):
    if not params:
        return None
    out = {}
    for k, v in params.items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, float) and not math.isfinite(v):
            continue
        out[k] = v
    return out


_SENSITIVE = re.compile(r"^(authorization|x-client-id|x-rapidapi-key|x-goog-api-key)$", re.I)


def scrub(exc):
    """Redact credentials on the request attached to a requests exception before it leaves this module."""
    req = getattr(exc, "request", None)
    if req is not None and getattr(req, "headers", None) is not None:
        for name in list(req.headers.keys()):
            if _SENSITIVE.match(name):
                req.headers[name] = "[redacted]"
    return exc


def _reason(exc):
    """Why BluGate failed, for the fallback decision (None = not worth falling back)."""
    if isinstance(exc, BluGateNotConfigured):
        return "auth"
    resp = getattr(exc, "response", None)
    if resp is None:
        return "network" if isinstance(exc, requests.RequestException) else None
    s = resp.status_code
    msg = (resp.text or "")[:500].lower()
    if s == 429:
        return "rate-limit"
    if s == 403 and re.search(r"quota|limit|exceeded|rate", msg):
        return "rate-limit"
    if s in (401, 403):
        return "auth"
    if s in (502, 503, 504):
        return "gateway"
    return None  # 404, other 4xx, 500: not retried directly


def _retry_after(resp, default_s):
    v = 0.0
    try:
        v = float((resp.json() or {}).get("retryAfterSec") or 0)
    except Exception:
        pass
    if not v:
        try:
            v = float(resp.headers.get("Retry-After") or 0)
        except Exception:
            v = 0.0
    return v if v > 0 else default_s


_sticky, _stats = {}, {}


def _send(url, method, params, json, headers, timeout):
    r = requests.request(method, url, params=clean_params(params), json=json, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r


def call(platform, path="", method="GET", params=None, json=None, headers=None, timeout=30):
    """One platform call: BluGate first, the provider directly when the fallback is on and BluGate fails."""
    path = str(path).lstrip("/")
    headers = headers or {}
    st = _stats.setdefault(platform, {"blugate": 0, "direct": 0, "fallbacks": 0, "direct_failures": 0})
    can = direct_ready(platform)

    def direct(why):
        d = DIRECT[platform]()
        try:
            r = _send(f"{d['base']}/{path}", method, params, json, {**headers, **_direct_headers(d)}, timeout)
            st["direct"] += 1
            return r.json()
        except requests.RequestException as e:
            st["direct_failures"] += 1
            status = e.response.status_code if e.response is not None else "network"
            log.warning("[direct %s] fallback for /%s failed (%s) after BluGate %s", platform, path, status, why)
            raise scrub(e)

    if can and time.time() < _sticky.get(platform, 0):
        return direct("cooldown")
    try:
        r = _send(f"{GATEWAY_BASE}/{platform}/{path}", method, params, json, {**headers, **get_headers()}, timeout)
        st["blugate"] += 1
        return r.json()
    except (requests.RequestException, BluGateNotConfigured) as e:
        reason = _reason(e) if can else None
        if not reason:
            raise scrub(e)
        st["fallbacks"] += 1
        if reason == "rate-limit":
            cool = float(os.getenv("BLUGATE_FALLBACK_COOLDOWN_SECONDS") or 60)
            _sticky[platform] = time.time() + min(_retry_after(e.response, cool), 900)
        elif reason == "auth":
            _sticky[platform] = time.time() + 600
        status = e.response.status_code if getattr(e, "response", None) is not None else "network"
        log.warning("[BluGate %s] %s (%s) on /%s -> direct fallback", platform, reason, status, path)
        scrub(e)
        return direct(reason)


def get(platform, path, params=None, **kw):
    return call(platform, path, "GET", params=params, **kw)


def post(platform, path, json=None, **kw):
    return call(platform, path, "POST", json=json, **kw)
```

Note: unlike the Node client, this compact version has no in-place BluGate 429 retry when the
switch is off — wrap `call()` with your existing retry if the app relied on one.

### 10.7 Credential safety — no leakage

1. **Never log headers or keys.** Fallback log lines name the platform, reason, status and
   route only: `[BluGate twitter] rate-limit (429) on /search → direct fallback`.
2. **YouTube's key goes in the `X-goog-api-key` header, never `?key=`**, so it can't appear in
   a logged URL or an error message.
3. **Scrub every error that leaves the client.** Axios errors carry the request config
   (headers!) and the raw request; callers often `console.error(error)`. The client redacts
   `Authorization`, `x-client-id`, `x-rapidapi-key`, `x-goog-api-key` and `key`-like params on
   every thrown error. The Python client redacts the same headers on `exc.request`.
4. **No crossover.** BluGate requests never carry RapidAPI keys; direct requests never carry
   BluGate credentials (both asserted by the tests).
5. **Tests use fake secrets** and scan every log line and every thrown error for them, with a
   negative control proving the scan would catch a leak.
6. Don't commit `.env`; don't print it. To inspect it, mask values (`sed -E 's/=.*/=<hidden>/'`).

### 10.8 Test offline (nothing sent, nothing billed)

Copy **[Appendix D](#appendix-d-offline-fallback-test-nodejs)** to `scripts/test_blugate_fallback.js`
and run:

```bash
node scripts/test_blugate_fallback.js
# … 41 passed, 0 failed      (exit code 0)
```

It replaces axios's network adapter with a scripted fake, so it exercises the real client and
the real services without any network. It checks: switch off → never direct; every row of the
§10.3 table; same path/params/body on the direct call; the right credentials on each route;
the per-platform cooldown; no fallback without a direct key; `callDirect` refused when off;
the app's own services falling back through their own code; every log line and error free of
secrets, plus the negative control.

**Adapt section 12 of the test** to the app's services: it calls `rapidApiXService.rapidGet`,
`rapidApiFacebookService.searchPages`, `rapidApiInstagramService.fetchUserProfile` and
`youtube.service.searchChannels` (the Chhattisgarh/Goa names). Point each at one public
function of your X / Facebook / Instagram / YouTube services. Keep every other section as is.

For Python apps, **[Appendix E](#appendix-e-offline-fallback-test-python)** is the equivalent test.

### 10.9 Live check (billed — ask the user before running)

`scripts/check_platform_apis.js` (§8.1 as a script, in Chhattisgarh/Goa) takes `--direct`:

```bash
node scripts/check_platform_apis.js            # 4 calls through BluGate
node scripts/check_platform_apis.js --direct   # the same 4 calls straight to the providers,
                                               # using the fallback keys (needs the switch on)
```

`--direct` uses `blugateClient.callDirect()`; it prints only whether each key is set, never
its value. Then exercise the app once with `BLUGATE_FALLBACK_ENABLED=true` and confirm the
logs show `→ direct fallback` lines only when BluGate actually failed.

### 10.10 Report back (in addition to §9)

1. Call sites converted to `call()` (file + function), and the grep output proving no bypass remains.
2. The switch's state, and which platforms have a direct key (names only, never values).
3. The offline test output (paste it), and the `--direct` smoke test output if the user ran it.
4. Any direct calls you left alone and why (same rules as §3).

---

## Appendix A: Full endpoint catalog

Generated from `BluGate_Provider_Endpoints.xlsx` (sheet *All Provider Endpoints*), the
authoritative list of routes BluGate exposes. **\*** = required parameter.
Parameters are query-string unless marked _(body)_ (JSON body) or _(path)_.

Full URL = `{BLUGATE_BASE_URL}/{gateway prefix}{Path}` — e.g.
`https://blugate.blurasaga.com/api/gateway/twitter/user-tweets?user=11348282&count=20`.

### X / Twitter — `50` routes

- Gateway prefix: `{BLUGATE_BASE_URL}/twitter`
- Replaces: `twitter241.p.rapidapi.com`  (provider slug in catalog: `twitter241`)

#### Community Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search-community` | `query`**\***, `cursor` | Search community |
| GET | `/community-topics` | `cursor` | Get Community Topics |
| GET | `/explore-community-timeline` | `count`, `cursor` | Explore Community Timeline |
| GET | `/fetch-popular-community` | `cursor` | Fetch Popular Community |
| GET | `/community-members` | `communityId`**\***, `count`, `cursor` | Get Community Members by Community ID |
| GET | `/community-members-v2` | `communityId`**\***, `count`, `cursor` | Get Community Members by Community ID |
| GET | `/community-moderators` | `communityId`**\***, `cursor` | Get Community Moderators by Community ID |
| GET | `/community-tweets` | `communityId`**\***, `count`, `cursor` | Get Community Tweets by Community ID |
| GET | `/community-about` | `communityId`**\*** | Get Community About by Community Id |
| GET | `/community-details` | `communityId`**\*** | Get Community Details by Community ID |

#### Deprecated

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/likes` | `pid`**\***, `count`, `cursor` | Get Post Likes By Post ID (Deprecated) |
| GET | `/user-likes` | `user`**\***, `count`**\***, `cursor` | Get User Likes By ID You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/tweet` | `pid`**\*** | Get Tweet Details By Tweet ID (Deprecated) |
| GET | `/get-users-v2` | `users`**\*** | Get Users By IDs V2 |

#### Explore Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search` | `type`**\***, `count`**\***, `query`**\***, `cursor` | Search Twitter (Top, Latest, Videos, Photos and People) |
| GET | `/autocomplete` | `query`**\*** | Twitter Seach Query Autocomplete |
| GET | `/search-v2` | `type`**\***, `count`**\***, `query`**\***, `cursor` | Search Twitter (Top, Latest, Videos, Photos and People) |
| GET | `/search-v3` | `type`**\***, `count`**\***, `query`**\***, `cursor` | Search Twitter V3 |

#### Jobs Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/jobs-locations-suggest` | `query`**\*** | Suggest Job Locations |
| GET | `/jobs-search` | `query`**\***, `location`, `cursor` | Search Jobs |
| GET | `/job-details` | `id`**\*** | Get Job Details |

#### Lists Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search-lists` | `query`**\***, `cursor` | Search lists |
| GET | `/list-details` | `listId`**\*** | Get list details by listId |
| GET | `/list-timeline` | `listId`**\***, `count`, `cursor` | Get list timeline by listId |
| GET | `/list-followers` | `listId`**\***, `count`, `cursor` | Get List Followers by List ID |
| GET | `/list-members` | `listId`**\***, `count`, `cursor` | Get List Members by List ID |

#### Organization Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/org-affiliates` | `user`**\***, `count`, `cursor` | Get Organization Affiliates By ID You can get the user(rest_id) query from "Get User By Username" endpoint |

#### Posts Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/comments` | `pid`**\***, `count`, `cursor` | Get Post Comments By Post ID |
| GET | `/comments-v2` | `pid`**\***, `count`, `cursor` | Get Post Comments By Post ID V2 |
| GET | `/quotes` | `pid`**\***, `count`, `cursor` | Get Post Quotes By Post ID |
| GET | `/retweets` | `pid`**\***, `count`, `cursor` | Get Post Retweets By Post ID |
| GET | `/tweet-v2` | `pid`**\*** | Get Tweet Details By Tweet ID |
| GET | `/tweet-by-ids` | `ids`**\*** | Get Tweets Details By Tweet IDs |
| GET | `/tweet-by-ids-v2` | `ids`**\*** | Get Tweets Details By IDs V2 |

#### Spaces Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/spaces` | `id`**\*** | Get Space Details By ID |

#### Trends Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/trends-locations` | — | Get Available Trends Locations |
| GET | `/trends-by-location` | `woeid`**\*** | Get Trends By Location |

#### User Endpoint

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/user` | `username`**\*** | Gets a user by username |
| GET | `/get-users` | `users`**\*** | Get Users By IDs (Rest IDs) |
| GET | `/user-replies` | `user`**\***, `count`**\***, `cursor` | Get User Replies By ID You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/user-replies-v2` | `user`**\***, `count`**\***, `cursor` | Get User Replies By ID You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/user-media` | `user`**\***, `count`**\***, `cursor` | Get User Media By ID You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/user-tweets` | `user`**\***, `count`**\***, `cursor` | Get User Tweets By ID You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/followings` | `user`**\***, `count`**\***, `cursor` | Get User Followings By ID. You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/following-ids` | `username`**\***, `count`**\***, `cursor` | GET Following IDs by Username |
| GET | `/followers` | `user`**\***, `count`**\***, `cursor` | Get User Followers By ID. You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/verified-followers` | `user`**\***, `count`**\***, `cursor` | Get User Verified Followers By ID. You can get the user(rest_id) query from "Get User By Username" endpoint |
| GET | `/followers-ids` | `username`**\***, `count`**\***, `cursor` | GET Followers IDs by Username |
| GET | `/highlights` | `user`**\***, `count`, `cursor` | Get user highlights by ID |
| GET | `/about-account` | `username`**\*** | Get About Account |

### Instagram — `17` routes

- Gateway prefix: `{BLUGATE_BASE_URL}/instagram`
- Replaces: `instagram120.p.rapidapi.com`  (provider slug in catalog: `instagram120`)

#### Media & helpers

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/api/instagram/get` | `url`**\*** | Getting data bypassing CORS. |
| GET | `/api/instagram/hls` | `url`**\*** | HLS → MP4 converter helper. |
| POST | `/api/instagram/links` | `url`**\*** _(body)_ | Getting video / media download links from a public Instagram post or reel URL. |

#### Profile & content

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/api/instagram/profile` | `username`**\*** _(body)_ | Getting profile (often richer/alternate profile payload vs userInfo). |
| POST | `/api/instagram/userInfo` | `username` _(body)_, `userId` _(body)_ | Getting user info by user ID or username. |
| POST | `/api/instagram/mediaByShortcode` | `shortcode`**\*** _(body)_ | Getting a post/reel by shortcode. |
| POST | `/api/instagram/reels` | `username` _(body)_, `userId` _(body)_, `maxId` _(body)_ | Get Instagram reels by user ID or username. Optional maxId (end_cursor) paginates ~12 reels per page. |
| POST | `/api/instagram/posts` | `username` _(body)_, `userId` _(body)_, `maxId` _(body)_ | Get Instagram posts by user ID or username. Optional maxId (end_cursor) paginates ~12 posts per page. |

#### Stories & highlights

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/api/instagram/stories` | `username`**\*** _(body)_ | Getting active stories for an account. |
| POST | `/api/instagram/story` | `username`**\*** _(body)_, `storyId`**\*** _(body)_ | Getting a specific story by username and story ID. |
| POST | `/api/instagram/highlights` | `username`**\*** _(body)_ | Getting highlight reels (saved story collections) for a profile. |
| POST | `/api/instagram/highlightStories` | `highlightId`**\*** _(body)_ | Getting story items inside a specific highlight. |

#### Social / engagement

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/api/instagram/following` | `username` _(body)_, `userId` _(body)_, `maxId` _(body)_ | Get accounts that a user follows. |
| POST | `/api/instagram/followers` | `username` _(body)_, `userId` _(body)_, `maxId` _(body)_ | Get followers for a user. |
| POST | `/api/instagram/likers` | `url`**\*** _(body)_ | Get users who liked a post. |
| POST | `/api/instagram/comments` | `url`**\*** _(body)_, `maxId` _(body)_ | Get comments on a post. |
| POST | `/api/instagram/tagged` | `username` _(body)_, `userId` _(body)_, `maxId` _(body)_ | Get posts where a user is tagged. Confirm exact path in playground (tagged vs taggedPosts). |

### Facebook — `51` routes

- Gateway prefix: `{BLUGATE_BASE_URL}/facebook`
- Replaces: `facebook-scraper3.p.rapidapi.com`  (provider slug in catalog: `facebook-scraper3`)

#### Ads Library

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/ads/autocomplete` | `query`**\***, `country`**\*** | Get ads autocomplete suggestions |
| GET | `/ads/details` | `ad_archive_id`**\***, `country`**\***, `page_id`**\*** | Get ad details |
| GET | `/ads/details_id` | `ad_id`**\*** | Get ad details by just id. Might sometime breaks, use other endpoints in such case |
| GET | `/ads/search` | `query`**\***, `country`**\***, `active_status`**\***, `cursor` | Search for ads |
| GET | `/ads/page/search` | `page_id`**\***, `country`**\***, `active_status`**\***, `cursor`, `sort_by_new` | Search for given page ads |

#### Events

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/event/details` | `url`**\*** | Get events details |
| GET | `/event/details_id` | `event_id`**\*** | Get events details by event id |
| GET | `/page/events/future` | `page_id`**\***, `cursor` | Get all future events created by page |

#### Experimental

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search/hashtags` | `query`**\***, `cursor` | Search posts with hashtag |
| GET | `/search/groups` | `query`**\***, `cursor` | Searches for facebook groups |
| GET | `/post/reactions` | `post_id`**\***, `cursor` | Get post reactions |

#### Games

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/gaming/games` | `query`, `cursor` | Browse games. Use empty query for browse all games.Use cursor to get next page. |
| GET | `/gaming/live` | `query`, `cursor` | Get game live videosUse cursor to get next page. |

#### Groups

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/group/future_events` | `group_id`**\***, `cursor` | Get group future events. Only PUBLIC groups can be scrapped!If there are no post response, check if group is not private.Use cursor to ge… |
| GET | `/group/videos` | `group_id`**\***, `cursor` | Get group videosOnly PUBLIC groups can be scrapped!If there are no post response, check if group is not private.Use cursor to get next pa… |
| GET | `/group/photos` | `group_id`**\***, `cursor` | Get group photosOnly PUBLIC groups can be scrapped!If there are no post response, check if group is not private.Use cursor to get next pa… |
| GET | `/group/details` | `group_id`**\*** | Get group summary |
| GET | `/group/id` | `url`**\*** | Getting group facebook id |
| GET | `/group/posts` | `group_id`**\***, `cursor` | Get group posts. Only PUBLIC groups can be scrapped!If there are no post response, check if group is not private. |

#### Marketplace

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/marketplace/details` | `listing_id`**\*** | Get listing details |
| GET | `/marketplace/search` | `query`**\***, `cursor` | Search marketplace. Use cursor to get next page |

#### Pages

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/page/details` | `page_id`**\*** | Read page details |
| GET | `/page/page_id` | `url`**\*** | get page id from url |
| GET | `/page/posts` | `page_id`**\***, `cursor` | Read page posts (from recent) |
| GET | `/page/photos` | `page_id`**\***, `cursor` | Read page photos (from recent)Use cursor to get next page of results |
| GET | `/page/reviews` | `page_id`**\***, `cursor` | Get page reviews. Use cursor to get next page |
| GET | `/page/reels` | `reels_page_id`**\***, `cursor` | Get page reels by page id - use reels_page_id now |
| GET | `/page/events/future` | `page_id`**\***, `cursor` | Get all future events created by page |
| GET | `/page/events/past` | `page_id`**\***, `cursor` | Get all past events created by page.Use cursor to get next page of results. |
| GET | `/page/videos` | `delegate_page_id`**\***, `cursor` | Get page videos by page delegate id. YOU NEED TO USE DELEGATE ID, NOT PAGE ID. |
| GET | `/page/transparency` | `page_id`**\*** | Read page transparency info |

#### Posts and comments

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/post/comments` | `post_id`**\***, `cursor` | Get post comments. Use comment_id from post |
| GET | `/comment` | `comment_id`**\*** | Get comment by comment id |
| GET | `/post/comments_nested` | `comment_id`**\***, `cursor` | Get nested comments. You need to use legacy fb id |
| GET | `/post` | `post_id`, `url` | Get post details by url or post id. If both are set, post id is used. |
| GET | `/post/share` | `post_id`**\***, `cursor` | Get post reshares |

#### Profiles

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/profile/posts` | `profile_id`**\***, `cursor` | Read profile posts (from recent), if public |
| GET | `/profile/photos` | `profile_id`**\***, `cursor`, `collection_id` | Read profiles photos (from recent)Use cursor to get next page of results |
| GET | `/profile/details_url` | `url`**\*** | Get profile details by url |
| GET | `/profile/profile_id` | `url`**\*** | Get profile id by url |
| GET | `/profile/reels` | `reels_profile_id`**\***, `cursor` | Get profile reels. Get `reels_profile_id` from profile details endpoint |
| GET | `/profile/details_id` | `profile_id`**\*** | Get profiles details by id |

#### Search

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search/global` | `query`**\***, `cursor` | Performs facebook global search |
| GET | `/search/locations` | `query`**\*** | Search for facebook locations id.If you get strange results, try add country to query and/or try without diacritic |
| GET | `/search/videos` | `query`**\***, `cursor` | Performs facebook videos search |
| GET | `/search/posts` | `query`**\***, `cursor`, `start_date`, `end_date` | Performs facebook posts search |
| GET | `/search/places` | `query`**\***, `cursor` | Search for fb place |
| GET | `/search/pages` | `query`**\***, `cursor` | Searches for facebook pages |
| GET | `/search/events` | `query`**\***, `cursor`, `location_uid`, `start_date`, `end_date` | Searches for facebook events |
| GET | `/search/groups_posts` | `query`**\***, `cursor` | Searches group for posts |
| GET | `/search/people` | `query`**\***, `cursor` | Searches people |

### YouTube — `83` routes

- Gateway prefix: `{BLUGATE_BASE_URL}/youtube`
- Replaces: `www.googleapis.com/youtube/v3 (official Google API)`  (provider slug in catalog: `youtube-data-api-v3`)

#### members

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/members` | `part`**\***, `filterByMemberChannelId`, `hasAccessToLevel`, `maxResults`, `mode`, `pageToken` | Retrieves a list of members that match the request criteria for a channel. |

#### playlistItems

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/playlistItems` | `part`**\***, `onBehalfOfContentOwner` | Inserts a new resource into this collection. |
| PUT | `/playlistItems` | `part`**\***, `onBehalfOfContentOwner` | Updates an existing resource. |
| GET | `/playlistItems` | `part`**\***, `id`, `maxResults`, `onBehalfOfContentOwner`, `pageToken`, `playlistId`, `videoId` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/playlistItems` | `id`**\***, `onBehalfOfContentOwner` | Deletes a resource. |

#### liveStreams

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/liveStreams` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Inserts a new stream for the authenticated user. |
| PUT | `/liveStreams` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Updates an existing stream for the authenticated user. |
| GET | `/liveStreams` | `part`**\***, `id`, `maxResults`, `mine`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `pageToken` | Retrieve the list of streams associated with the given channel. -- |
| DELETE | `/liveStreams` | `id`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Deletes an existing stream for the authenticated user. |

#### videoAbuseReportReasons

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/videoAbuseReportReasons` | `part`**\***, `hl` | Retrieves a list of resources, possibly filtered. |

#### thumbnails

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/thumbnails/set` | `videoId`**\***, `onBehalfOfContentOwner` | As this is not an insert in a strict sense (it supports uploading/setting of a thumbnail for multiple videos, which doesn't result in cre… |

#### channels

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| PUT | `/channels` | `part`**\***, `onBehalfOfContentOwner` | Updates an existing resource. |
| GET | `/channels` | `part`**\***, `categoryId`, `forHandle`, `forUsername`, `hl`, `id`, `managedByMe`, `maxResults`, `mine`, `mySubscribers`, `onBehalfOfContentOwner`, `pageToken` | Retrieves a list of resources, possibly filtered. |

#### commentThreads

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/commentThreads` | `part`**\*** | Inserts a new resource into this collection. |
| GET | `/commentThreads` | `part`**\***, `allThreadsRelatedToChannelId`, `channelId`, `id`, `maxResults`, `moderationStatus`, `order`, `pageToken`, `postId`, `searchTerms`, `textFormat`, `videoId` | Retrieves a list of resources, possibly filtered. |

#### channelBanners

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/channelBanners/insert` | `channelId`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Inserts a new resource into this collection. |

#### videoCategories

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/videoCategories` | `part`**\***, `hl`, `id`, `regionCode` | Retrieves a list of resources, possibly filtered. |

#### abuseReports

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/abuseReports` | `part`**\*** | Inserts a new resource into this collection. |

#### captions

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| PUT | `/captions` | `part`**\***, `onBehalfOf`, `onBehalfOfContentOwner`, `sync` | Updates an existing resource. |
| GET | `/captions` | `part`**\***, `videoId`**\***, `id`, `onBehalfOf`, `onBehalfOfContentOwner` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/captions` | `id`**\***, `onBehalfOf`, `onBehalfOfContentOwner` | Deletes a resource. |
| POST | `/captions` | `part`**\***, `onBehalfOf`, `onBehalfOfContentOwner`, `sync` | Inserts a new resource into this collection. |
| GET | `/captions/{id}` | `id`**\*** _(path)_, `onBehalfOf`, `onBehalfOfContentOwner`, `tfmt`, `tlang` | Downloads a caption track. |

#### liveBroadcasts

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| PUT | `/liveBroadcasts` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Updates an existing broadcast for the authenticated user. |
| POST | `/liveBroadcasts/bind` | `id`**\***, `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `streamId` | Bind a broadcast to a stream. |
| POST | `/liveBroadcasts/cuepoint` | `id`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `part` | Insert cuepoints in a broadcast |
| POST | `/liveBroadcasts` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Inserts a new stream for the authenticated user. |
| GET | `/liveBroadcasts` | `part`**\***, `broadcastStatus`, `broadcastType`, `id`, `maxResults`, `mine`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `pageToken` | Retrieve the list of broadcasts associated with the given channel. |
| DELETE | `/liveBroadcasts` | `id`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Delete a given broadcast. |
| POST | `/liveBroadcasts/transition` | `broadcastStatus`**\***, `id`**\***, `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Transition a broadcast to a given status. |

#### playlists

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/playlists` | `part`**\***, `channelId`, `hl`, `id`, `maxResults`, `mine`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `pageToken` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/playlists` | `id`**\***, `onBehalfOfContentOwner` | Deletes a resource. |
| POST | `/playlists` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Inserts a new resource into this collection. |
| PUT | `/playlists` | `part`**\***, `onBehalfOfContentOwner` | Updates an existing resource. |

#### playlistImages

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/playlistImages` | `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `part` | Inserts a new resource into this collection. |
| PUT | `/playlistImages` | `onBehalfOfContentOwner`, `part` | Updates an existing resource. |
| GET | `/playlistImages` | `maxResults`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `pageToken`, `parent`, `part` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/playlistImages` | `id`, `onBehalfOfContentOwner` | Deletes a resource. |

#### i18nRegions

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/i18nRegions` | `part`**\***, `hl` | Retrieves a list of resources, possibly filtered. |

#### videos

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/videos` | `part`**\***, `autoLevels`, `notifySubscribers`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `stabilize` | Inserts a new resource into this collection. |
| GET | `/videos` | `part`**\***, `chart`, `hl`, `id`, `locale`, `maxHeight`, `maxResults`, `maxWidth`, `myRating`, `onBehalfOfContentOwner`, `pageToken`, `regionCode`, `videoCategoryId` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/videos` | `id`**\***, `onBehalfOfContentOwner` | Deletes a resource. |
| GET | `/videos/getRating` | `id`**\***, `onBehalfOfContentOwner` | Retrieves the ratings that the authorized user gave to a list of specified videos. |
| GET | `/videos:batchGetStats` | `id`, `onBehalfOfContentOwner`, `part` | Retrieves a batch of VideoStat resources, possibly filtered. BatchGetStats is intentionally not atomic to provide a better user experience. |
| PUT | `/videos` | `part`**\***, `onBehalfOfContentOwner` | Updates an existing resource. |
| POST | `/videos/rate` | `id`**\***, `rating`**\*** | Adds a like or dislike rating to a video or removes a rating from a video. |
| POST | `/videos/reportAbuse` | `onBehalfOfContentOwner` | Report abuse for a video. |

#### videoTrainability

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/videoTrainability` | `id` | Returns the trainability status of a video. |

#### i18nLanguages

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/i18nLanguages` | `part`**\***, `hl` | Retrieves a list of resources, possibly filtered. |

#### thirdPartyLinks

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/thirdPartyLinks` | `part`**\***, `externalChannelId` | Inserts a new resource into this collection. |
| PUT | `/thirdPartyLinks` | `part`**\***, `externalChannelId` | Updates an existing resource. |
| GET | `/thirdPartyLinks` | `part`**\***, `externalChannelId`, `linkingToken`, `type` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/thirdPartyLinks` | `linkingToken`**\***, `type`**\***, `externalChannelId`, `part` | Deletes a resource. |

#### comments

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/comments` | `part`**\*** | Inserts a new resource into this collection. |
| GET | `/comments` | `part`**\***, `id`, `maxResults`, `pageToken`, `parentId`, `textFormat` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/comments` | `id`**\*** | Deletes a resource. |
| POST | `/comments/markAsSpam` | `id`**\*** | Expresses the caller's opinion that one or more comments should be flagged as spam. |
| PUT | `/comments` | `part`**\*** | Updates an existing resource. |
| POST | `/comments/setModerationStatus` | `id`**\***, `moderationStatus`**\***, `banAuthor` | Sets the moderation status of one or more comments. |

#### liveChatModerators

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/liveChat/moderators` | `part`**\*** | Inserts a new resource into this collection. |
| GET | `/liveChat/moderators` | `liveChatId`**\***, `part`**\***, `maxResults`, `pageToken` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/liveChat/moderators` | `id`**\*** | Deletes a chat moderator. |

#### tests

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/tests` | `part`**\***, `externalChannelId`, `onBehalfOfContentOwnerChannel` | POST method. |

#### watermarks

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/watermarks/unset` | `channelId`**\***, `onBehalfOfContentOwner` | Allows removal of channel watermark. |
| POST | `/watermarks/set` | `channelId`**\***, `onBehalfOfContentOwner` | Allows upload of watermark image and setting it for a channel. |

#### channelSections

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/channelSections` | `part`**\***, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel` | Inserts a new resource into this collection. |
| PUT | `/channelSections` | `part`**\***, `onBehalfOfContentOwner` | Updates an existing resource. |
| GET | `/channelSections` | `part`**\***, `channelId`, `hl`, `id`, `mine`, `onBehalfOfContentOwner` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/channelSections` | `id`**\***, `onBehalfOfContentOwner` | Deletes a resource. |

#### liveChatMessages

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| POST | `/liveChat/messages/transition` | `id`, `status` | Transition a durable chat event. |
| POST | `/liveChat/messages` | `part`**\*** | Inserts a new resource into this collection. |
| GET | `/liveChat/messages` | `liveChatId`**\***, `part`**\***, `hl`, `maxResults`, `pageToken`, `profileImageSize` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/liveChat/messages` | `id`**\*** | Deletes a chat message. |

#### search

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/search` | `part`**\***, `channelId`, `channelType`, `eventType`, `forContentOwner`, `forDeveloper`, `forMine`, `location`, `locationRadius`, `maxResults`, `onBehalfOfContentOwner`, `order`, `pageToken`, `publishedAfter`, `publishedBefore`, `q`, `regionCode`, `relevanceLanguage`, `safeSearch`, `topicId`, `type`, `videoCaption`, `videoCategoryId`, `videoDefinition`, `videoDimension`, `videoDuration`, `videoEmbeddable`, `videoLicense`, `videoPaidProductPlacement`, `videoSyndicated`, `videoType` | Retrieves a list of search resources |

#### activities

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/activities` | `part`**\***, `channelId`, `home`, `maxResults`, `mine`, `pageToken`, `publishedAfter`, `publishedBefore`, `regionCode` | Retrieves a list of resources, possibly filtered. |

#### liveChatBans

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| DELETE | `/liveChat/bans` | `id`**\*** | Deletes a chat ban. |
| POST | `/liveChat/bans` | `part`**\*** | Inserts a new resource into this collection. |

#### subscriptions

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/subscriptions` | `part`**\***, `channelId`, `forChannelId`, `id`, `maxResults`, `mine`, `myRecentSubscribers`, `mySubscribers`, `onBehalfOfContentOwner`, `onBehalfOfContentOwnerChannel`, `order`, `pageToken` | Retrieves a list of resources, possibly filtered. |
| DELETE | `/subscriptions` | `id`**\*** | Deletes a resource. |
| POST | `/subscriptions` | `part`**\*** | Inserts a new resource into this collection. |

#### membershipsLevels

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/membershipsLevels` | `part`**\*** | Retrieves a list of all pricing levels offered by a creator to the fans. |

#### youtube

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/liveChat/messages/stream` | `hl`, `liveChatId`, `maxResults`, `pageToken`, `part`, `profileImageSize` | Allows a user to load live chat through a server-streamed RPC. |

#### superChatEvents

| Method | Path | Params (**\*** = required) | What it does |
|---|---|---|---|
| GET | `/superChatEvents` | `part`**\***, `hl`, `maxResults`, `pageToken` | Retrieves a list of resources, possibly filtered. |

---

## Appendix B: WhatsApp (in the catalog, not used by AP.Blura.Saga)

The catalog also lists two WhatsApp Cloud API routes. They have **not** been used
through BluGate by us and the gateway prefix (`/whatsapp`) is unconfirmed — check with
the user before using them.

| Method | Path | Params | What it does |
|---|---|---|---|
| GET | `/templates` | — | Lists the WhatsApp message templates this client may use |
| POST | `/messages/template` | `templateId`**\***, `to`**\***, `data` _(body)_ | Sends an approved WhatsApp template message |

---

## Appendix C: Node.js client with direct fallback

The exact `src/services/blugateClient.js` running in the Blura SAGA Chhattisgarh and Goa apps
(§10.5). Copy it verbatim; it needs only `axios` and Node's `zlib`.

```js
const axios = require('axios');
const zlib = require('zlib');

/**
 * Shared client for BluGate — the metered gateway that fronts YouTube,
 * Twitter/X, Facebook, and Instagram so API usage can be tracked per client.
 * Endpoint paths/params are identical to the underlying provider's own REST
 * API; only the base URL and auth headers differ.
 *
 * The valid routes per provider are listed in backend/BluGate_Provider_Endpoints.xlsx.
 *
 * ── Direct fallback (BLUGATE_FALLBACK_ENABLED) ───────────────────────────
 * BluGate is always tried first. When BLUGATE_FALLBACK_ENABLED=true and
 * BluGate fails with a rate limit (429, or 403 quota/limit), an auth error
 * (401/403, or missing BluGate credentials), a gateway error (502/503/504)
 * or a timeout/network error, the SAME path and params are sent straight to
 * the provider (RapidAPI, or Google for YouTube). BluGate is a pass-through,
 * so the response body is identical and no parser changes.
 *
 * Not retried directly: 404 (route does not exist), other 4xx (bad params)
 * and 500 (e.g. Instagram private/unknown account) — they would fail again
 * and still be billed.
 *
 * After a rate limit or auth error that platform stays on direct for a
 * cooldown (BluGate's retryAfterSec, else BLUGATE_FALLBACK_COOLDOWN_SECONDS,
 * default 60; 10 minutes after an auth error), then tries BluGate again.
 * Per platform.
 *
 * BLUGATE_FALLBACK_ENABLED=false (default): BluGate only, as before.
 * Secrets are never logged, and every error leaving this module has its
 * credentials removed.
 */

const DEFAULT_GATEWAY_BASE = 'https://blugate.blurasaga.com/api/gateway';

const GATEWAY_BASE = String(process.env.BLUGATE_BASE_URL || DEFAULT_GATEWAY_BASE).trim().replace(/\/+$/, '');

const PLATFORM_ALIASES = { x: 'twitter' };
const norm = (platform) => PLATFORM_ALIASES[platform] || platform;

/** Base URL for a platform's BluGate calls, e.g. baseUrl('twitter') + '/search-v2'. */
const baseUrl = (platform) => `${GATEWAY_BASE}/${norm(platform)}`;

const blugateConfigured = () => !!(process.env.BLUGATE_API_KEY && process.env.BLUGATE_CLIENT_CODE);

/** BluGate auth headers. The platform argument is accepted for callers' convenience. */
// eslint-disable-next-line no-unused-vars
const getHeaders = (_platform) => {
    const apiKey = process.env.BLUGATE_API_KEY;
    const clientCode = process.env.BLUGATE_CLIENT_CODE;

    if (!apiKey || !clientCode) {
        const err = new Error('BLUGATE_API_KEY / BLUGATE_CLIENT_CODE is not configured');
        err.code = 'BLUGATE_NOT_CONFIGURED';
        throw err;
    }

    return {
        Authorization: `Bearer ${apiKey}`,
        'x-client-id': clientCode
    };
};

/* ── direct providers (fallback only) ────────────────────────────────── */

const fallbackEnabled = () => /^(true|1|on|yes)$/i.test(String(process.env.BLUGATE_FALLBACK_ENABLED || '').trim());

/** Which route calls take, for logs. */
const providerLabel = () => (fallbackEnabled() ? 'BluGate (+ direct fallback)' : 'BluGate');

const unquote = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const firstKey = (...vals) => {
    for (const v of vals) {
        const k = unquote(v).split(',')[0].trim();
        if (k) return k;
    }
    return '';
};
const hostOr = (v, dflt) => unquote(v).replace(/^https?:\/\//i, '').replace(/\/+$/, '') || dflt;

// Default hosts of the direct (fallback) providers; .env can override them. Keys come only from .env.
const DIRECT = {
    twitter: () => { const host = hostOr(process.env.RAPIDAPI_HOST, 'twitter241.p.rapidapi.com'); return { host, base: `https://${host}`, key: firstKey(process.env.RAPIDAPI_KEY) }; },
    facebook: () => { const host = hostOr(process.env.RAPIDAPI_FACEBOOK_HOST, 'facebook-scraper3.p.rapidapi.com'); return { host, base: `https://${host}`, key: firstKey(process.env.RAPIDAPI_FACEBOOK_KEY, process.env.RAPIDAPI_KEY) }; },
    instagram: () => { const host = hostOr(process.env.RAPIDAPI_INSTAGRAM_HOST, 'ig-downloader-api.p.rapidapi.com'); return { host, base: `https://${host}`, key: firstKey(process.env.RAPIDAPI_INSTAGRAM_KEY, process.env.RAPIDAPI_INSTAGRAM_KEYS, process.env.RAPIDAPI_KEY) }; },
    youtube: () => ({ base: (unquote(process.env.YOUTUBE_API_BASE_URL) || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, ''), key: firstKey(process.env.YOUTUBE_API_KEY), google: true }),
};
const directOf = (platform) => (DIRECT[norm(platform)] ? DIRECT[norm(platform)]() : null);

/** True when the direct fallback is switched on and has a key for this platform. */
const directReady = (platform) => {
    if (!fallbackEnabled()) return false;
    const d = directOf(platform);
    return !!(d && d.key && d.base);
};

// YouTube's key goes in a header, never the URL, so it cannot end up in a logged URL.
const directHeaders = (d) => (d.google ? { 'X-goog-api-key': d.key } : { 'x-rapidapi-key': d.key, 'x-rapidapi-host': d.host });

/** True when calls for `platform` can be made: BluGate credentials, or a ready direct fallback. */
const hasCredentials = (platform) => blugateConfigured() || (platform ? directReady(platform) : Object.keys(DIRECT).some(directReady));

/* ── keeping secrets out of errors ───────────────────────────────────── */

const SENSITIVE_HEADER_RX = /^(authorization|x-client-id|x-rapidapi-key|x-goog-api-key)$/i;
const SENSITIVE_PARAM_RX = /^(key|api_key|apikey)$/i;

/** Remove credentials from an axios error before it leaves this module (callers log errors). */
const scrubError = (error) => {
    if (!error || typeof error !== 'object') return error;
    const scrubHeaders = (h) => {
        if (!h || typeof h !== 'object') return;
        for (const name of Object.keys(h)) if (SENSITIVE_HEADER_RX.test(name)) h[name] = '[redacted]';
    };
    for (const cfg of [error.config, error.response && error.response.config]) {
        if (!cfg) continue;
        scrubHeaders(cfg.headers);
        if (cfg.params && typeof cfg.params === 'object') {
            for (const p of Object.keys(cfg.params)) if (SENSITIVE_PARAM_RX.test(p)) cfg.params[p] = '[redacted]';
        }
    }
    for (const req of [error.request, error.response && error.response.request]) {
        if (req && typeof req._header === 'string') {
            req._header = req._header.replace(/^(authorization|x-client-id|x-rapidapi-key|x-goog-api-key):.*$/gim, '$1: [redacted]');
        }
    }
    return error;
};

/* ── fallback policy ─────────────────────────────────────────────────── */

const errorMessage = (error) => {
    const body = error && error.response && error.response.data;
    return String((body && ((body.error && body.error.message) || body.error || body.message)) || (error && error.message) || '').toLowerCase();
};

/** What kind of BluGate failure this is, for the fallback decision (null = not worth falling back). */
const fallbackReason = (error) => {
    if (error && error.code === 'BLUGATE_NOT_CONFIGURED') return 'auth';
    const res = error && error.response;
    if (!res) return 'network';                       // timeout, DNS, connection reset
    const status = res.status;
    if (status === 429) return 'rate-limit';
    if (status === 403 && /quota|limit|exceeded|rate/.test(errorMessage(error))) return 'rate-limit';
    if (status === 401 || status === 403) return 'auth';
    if (status === 502 || status === 503 || status === 504) return 'gateway';
    return null;                                      // 404, other 4xx, 500: not retried directly
};

const stickySeconds = () => {
    const v = Number(process.env.BLUGATE_FALLBACK_COOLDOWN_SECONDS);
    return Number.isFinite(v) && v > 0 ? v : 60;
};
const stickyUntil = {};      // platform → epoch ms until which calls go direct
const stats = {};            // platform → { blugate, direct, fallbacks, directFailures }
const statOf = (platform) => (stats[platform] = stats[platform] || { blugate: 0, direct: 0, fallbacks: 0, directFailures: 0 });

/** Counts per platform, for health endpoints and logs. */
const getFallbackStats = () => JSON.parse(JSON.stringify({ enabled: fallbackEnabled(), stats, stickyUntil }));

/** Test helper: clear cooldown windows and counters. */
const resetFallbackState = () => {
    for (const k of Object.keys(stickyUntil)) delete stickyUntil[k];
    for (const k of Object.keys(stats)) delete stats[k];
};

/**
 * Drop null / undefined / empty-string / NaN values so BluGate never receives
 * blank params (axios would otherwise send `count=NaN` or silently omit a
 * required param that resolved to null).
 */
const cleanParams = (params) => {
    if (!params || typeof params !== 'object') return undefined;
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        out[key] = value;
    }
    return out;
};

/**
 * BluGate labels responses `Content-Encoding: gzip` even when the body is
 * plain JSON, and axios then fails every call with "incorrect header check".
 * So we take the raw bytes and decompress only when the body really is
 * compressed (gzip magic 1f 8b; zlib 78 xx; brotli when labelled and valid),
 * then decode UTF-8 ourselves and parse JSON. Used by EVERY call (BluGate and
 * direct), so callers see the same body either way.
 */
const decodeBody = (data, headers) => {
    let buf = data;
    if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
    if (!Buffer.isBuffer(buf)) return data;

    const encoding = String((headers && (headers['content-encoding'] || (headers.get && headers.get('content-encoding')))) || '').toLowerCase();
    try {
        if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        else if (buf.length > 1 && buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1])) buf = zlib.inflateSync(buf);
        else if (encoding.includes('br') && buf[0] !== 0x7b && buf[0] !== 0x5b) buf = zlib.brotliDecompressSync(buf);
    } catch (_) { /* not actually compressed: use the bytes as they are */ }

    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (_) { return text; }
};

const responseOptions = () => ({
    decompress: false,
    responseType: 'arraybuffer',
    transformResponse: [decodeBody],
});

/**
 * BluGate throttles bursts with 429 {"error":"Too many gateway requests",
 * "retryAfterSec":35} (and a Retry-After header). How long to wait, in ms.
 */
const retryAfterMs = (error, fallbackMs = 5000) => {
    const res = error && error.response;
    const header = res && res.headers && Number(res.headers['retry-after']);
    const body = res && res.data && Number(res.data.retryAfterSec);
    const sec = Number.isFinite(body) && body > 0 ? body : (Number.isFinite(header) && header > 0 ? header : null);
    return sec ? sec * 1000 : fallbackMs;
};

/**
 * A short-lived BluGate gateway throttle, worth waiting out. A provider quota
 * (e.g. Google's "Quota exceeded ... per day", also sent as 429) resets only
 * the next day, so it is NOT retried.
 */
const isRateLimited = (error) => {
    const res = error && error.response;
    if (!res || res.status !== 429) return false;
    const body = res.data || {};
    const message = String((body.error && body.error.message) || body.error || body.message || '');
    if (/quota exceeded|per day/i.test(message)) return false;
    return true;
};

/**
 * Run a call, and on 429 wait as long as BluGate asks (capped) and retry.
 * Waits longer than `maxWaitMs` are not slept through: the error is rethrown
 * so the caller's own cooldown / next scheduler tick handles it.
 */
const withRateLimitRetry = async (fn, { retries = 2, maxWaitMs = 60000, label = 'BluGate' } = {}) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            if (!isRateLimited(error) || attempt >= retries) throw scrubError(error);
            const wait = retryAfterMs(error, 5000 * (attempt + 1));
            if (wait > maxWaitMs) throw scrubError(error);
            console.warn(`[${label}] 429 rate limited, retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries})`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
};

/* ── the one place a platform call is made ───────────────────────────── */

const viaBlugate = (platform, { method, path, params, data, headers, timeout }) => axios({
    method,
    url: `${baseUrl(platform)}/${path}`,
    params: cleanParams(params),
    data,
    timeout,
    headers: { ...headers, ...getHeaders(platform) },
    ...responseOptions(),
});

const viaDirect = (platform, { method, path, params, data, headers, timeout }) => {
    const d = directOf(platform);
    return axios({
        method,
        url: `${d.base}/${path}`,
        params: cleanParams(params),
        data,
        timeout,
        headers: { ...headers, ...directHeaders(d) },
        ...responseOptions(),
    });
};

const direct = async (platform, opts, why) => {
    const s = statOf(platform);
    try {
        const res = await viaDirect(platform, opts);
        s.direct += 1;
        res.provider = 'direct';
        return res;
    } catch (error) {
        s.directFailures += 1;
        console.warn(`[direct ${platform}] fallback for /${opts.path} failed (${error.response ? error.response.status : 'network'}) after BluGate ${why}`);
        throw scrubError(error);
    }
};

/**
 * Make one platform call: BluGate first, the provider directly when the
 * fallback is on and BluGate fails in a way worth falling back on.
 * opts: { method = 'get', path, params, data, headers, timeout = 30000 }
 * Resolves with the axios response; `response.provider` is 'blugate' or 'direct'.
 */
const call = async (platform, { method = 'get', path = '', params, data, headers = {}, timeout = 30000 } = {}) => {
    const p = norm(platform);
    const opts = { method, path: String(path || '').replace(/^\/+/, ''), params, data, headers, timeout };
    const canFallBack = directReady(p);

    // Inside a cooldown after a BluGate rate limit / auth failure: go direct.
    if (canFallBack && stickyUntil[p] && Date.now() < stickyUntil[p]) {
        return direct(p, opts, 'cooldown');
    }

    try {
        // With a fallback available, don't sleep through BluGate 429s: fall back at once.
        const res = canFallBack
            ? await viaBlugate(p, opts)
            : await withRateLimitRetry(() => viaBlugate(p, opts), { label: `BluGate ${p}` });
        statOf(p).blugate += 1;
        res.provider = 'blugate';
        return res;
    } catch (error) {
        const reason = canFallBack ? fallbackReason(error) : null;
        if (!reason) throw scrubError(error);

        statOf(p).fallbacks += 1;
        if (reason === 'rate-limit' || reason === 'auth') {
            const ms = reason === 'rate-limit' ? Math.min(retryAfterMs(error, stickySeconds() * 1000), 15 * 60 * 1000) : 10 * 60 * 1000;
            stickyUntil[p] = Date.now() + ms;
        }
        const status = error.response ? error.response.status : (error.code === 'BLUGATE_NOT_CONFIGURED' ? 'not configured' : 'network');
        console.warn(`[BluGate ${p}] ${reason} (${status}) on /${opts.path} → direct fallback`);
        scrubError(error);
        return direct(p, opts, reason);
    }
};

/** Diagnostics only (scripts/check_platform_apis.js --direct): call the provider directly. */
const callDirect = (platform, { method = 'get', path = '', params, data, headers = {}, timeout = 30000 } = {}) => {
    const p = norm(platform);
    if (!directReady(p)) return Promise.reject(new Error(`Direct fallback not ready for ${p} (BLUGATE_FALLBACK_ENABLED and the provider key are needed)`));
    return direct(p, { method, path: String(path || '').replace(/^\/+/, ''), params, data, headers, timeout }, 'diagnostic');
};

const request = (platform, opts = {}) => call(platform, opts);
const get = (platform, path, params, opts = {}) => call(platform, { method: 'get', path, params, ...opts });
const post = (platform, path, data, opts = {}) => call(platform, { method: 'post', path, data, ...opts });

module.exports = {
    retryAfterMs,
    isRateLimited,
    withRateLimitRetry,
    responseOptions,
    decodeBody,
    GATEWAY_BASE,
    baseUrl,
    providerLabel,
    hasCredentials,
    getHeaders,
    cleanParams,
    call,
    callDirect,
    request,
    get,
    post,
    fallbackEnabled,
    directReady,
    fallbackReason,
    scrubError,
    getFallbackStats,
    resetFallbackState,
};
```

## Appendix D: Offline fallback test (Node.js)

`scripts/test_blugate_fallback.js` from the same apps (§10.8). Run from the backend folder:
`node scripts/test_blugate_fallback.js`. No network, nothing billed. Adapt section 12 to your
own service functions; keep everything else.

```js
// Offline test of the BluGate → direct-RapidAPI fallback. No network: axios's adapter is replaced,
// so nothing is sent and nothing is billed. Fake secrets are used and scanned for leaks.
// Usage: node scripts/test_blugate_fallback.js   (offline: no network calls, nothing billed)
const path = require('path');
const util = require('util');
const dir = process.argv[2] || path.join(__dirname, '..');

const SECRETS = {
    BLUGATE_API_KEY: 'BGKEY-secret-1111', BLUGATE_CLIENT_CODE: 'BGCLIENT-secret-2222',
    RAPIDAPI_KEY: 'RAPIDX-secret-3333', RAPIDAPI_FACEBOOK_KEY: 'RAPIDFB-secret-4444',
    RAPIDAPI_INSTAGRAM_KEYS: 'RAPIDIG-secret-5555', YOUTUBE_API_KEY: 'YTKEY-secret-6666',
};
for (const k of ['RAPIDAPI_HOST', 'RAPIDAPI_FACEBOOK_HOST', 'RAPIDAPI_INSTAGRAM_HOST', 'RAPIDAPI_INSTAGRAM_KEY', 'YOUTUBE_API_BASE_URL', 'BLUGATE_BASE_URL', 'BLUGATE_FALLBACK_COOLDOWN_SECONDS']) delete process.env[k];
const setEnv = (over = {}) => {
    Object.assign(process.env, SECRETS);
    process.env.BLUGATE_FALLBACK_ENABLED = 'false';
    for (const [k, v] of Object.entries(over)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
};
setEnv();

/* capture every console line for the leak scan */
const logs = [];
for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
    console[m] = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 8 }))).join(' '));
}
const out = (s) => process.stdout.write(`${s}\n`);

/* fake network */
const axios = require(path.join(dir, 'node_modules/axios'));
const calls = [];
let script = () => ({ status: 200, body: {} });
const plain = (h) => (h && typeof h.toJSON === 'function' ? h.toJSON() : { ...(h || {}) });
axios.defaults.adapter = async (config) => {
    const u = new URL(config.url);
    const kind = /blugate\.blurasaga\.com$/.test(u.hostname) ? 'blugate' : 'direct';
    const rec = { kind, host: u.hostname, path: u.pathname, search: u.search, params: { ...(config.params || {}) }, method: config.method, headers: plain(config.headers), data: config.data };
    calls.push(rec);
    const r = script(rec);
    if (r.network) { const e = new axios.AxiosError('socket hang up', 'ECONNRESET', config, {}); throw e; }
    const response = { data: Buffer.from(JSON.stringify(r.body)), status: r.status, statusText: String(r.status), headers: { 'content-type': 'application/json', ...(r.headers || {}) }, config, request: {} };
    if (r.status >= 400) throw new axios.AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
    return response;
};

const bg = require(path.join(dir, 'src/services/blugateClient'));
const X = require(path.join(dir, 'src/services/rapidApiXService'));
const FB = require(path.join(dir, 'src/services/rapidApiFacebookService'));
const IG = require(path.join(dir, 'src/services/rapidApiInstagramService'));
const YT = require(path.join(dir, 'src/services/youtube.service'));

let pass = 0; let fail = 0; const thrown = [];
const ok = (name, cond, detail = '') => { if (cond) pass += 1; else fail += 1; out(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  -- ${detail}`}`); };
const reset = (over) => { setEnv(over); bg.resetFallbackState(); calls.length = 0; };
const attempt = async (fn) => { try { return { res: await fn() }; } catch (e) { thrown.push(e); return { err: e }; } };
const DIRECT_HOSTS = { twitter: 'twitter241.p.rapidapi.com', facebook: 'facebook-scraper3.p.rapidapi.com', instagram: 'ig-downloader-api.p.rapidapi.com', youtube: 'www.googleapis.com' };
const R429 = (sec) => ({ status: 429, body: { error: 'Too many gateway requests', retryAfterSec: sec } });
const blugateThen = (bgResp, directResp = { status: 200, body: { ok: 'direct' } }) => (rec) => (rec.kind === 'blugate' ? bgResp : directResp);

(async () => {
    out(`== ${dir}`);

    // 1. Switch OFF: a BluGate 429 never reaches a provider directly.
    reset();
    script = blugateThen(R429(0.01));
    let r = await attempt(() => bg.get('twitter', 'search', { type: 'Latest', count: 5, query: 'x' }));
    ok('off: BluGate 429 is returned as an error', !!r.err && r.err.response?.status === 429);
    ok('off: no direct call made', calls.every((c) => c.kind === 'blugate'), JSON.stringify(calls.map((c) => c.host)));
    ok('off: BluGate retried in place (3 attempts)', calls.length === 3, `calls=${calls.length}`);

    // 2. Switch ON, X rate-limited → same path and params sent to twitter241 directly.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen(R429(30), { status: 200, body: { from: 'direct' } });
    r = await attempt(() => bg.get('twitter', 'search', { type: 'Latest', count: 5, query: 'cm sai', empty: '' }));
    const d2 = calls.find((c) => c.kind === 'direct');
    ok('on: X 429 → direct fallback succeeds', r.res && r.res.provider === 'direct' && r.res.data.from === 'direct');
    ok('on: only 1 BluGate attempt (no sleeping through 429)', calls.filter((c) => c.kind === 'blugate').length === 1);
    ok('on: direct host is twitter241', d2 && d2.host === DIRECT_HOSTS.twitter);
    ok('on: same path and params (blanks dropped)', d2 && d2.path === '/search' && JSON.stringify(d2.params) === JSON.stringify({ type: 'Latest', count: 5, query: 'cm sai' }), JSON.stringify(d2 && d2.params));
    ok('on: direct carries RapidAPI key, not BluGate credentials', d2 && d2.headers['x-rapidapi-key'] === SECRETS.RAPIDAPI_KEY && d2.headers['x-rapidapi-host'] === DIRECT_HOSTS.twitter && !d2.headers.Authorization && !d2.headers['x-client-id']);
    const b2 = calls.find((c) => c.kind === 'blugate');
    ok('on: BluGate call carries no RapidAPI key', b2 && !b2.headers['x-rapidapi-key'] && b2.headers.Authorization === `Bearer ${SECRETS.BLUGATE_API_KEY}`);

    // 3. Sticky cooldown: the next X call goes direct without touching BluGate; other platforms unaffected.
    calls.length = 0;
    r = await attempt(() => bg.get('twitter', 'user', { username: 'nasa' }));
    ok('cooldown: next X call goes straight to direct', r.res && r.res.provider === 'direct' && calls.length === 1 && calls[0].kind === 'direct');
    calls.length = 0; script = () => ({ status: 200, body: { ok: 1 } });
    r = await attempt(() => bg.get('facebook', 'search/pages', { query: 'nasa' }));
    ok('cooldown is per platform: Facebook still uses BluGate', r.res && r.res.provider === 'blugate' && calls[0].kind === 'blugate');

    // 4. 404 and other 4xx are not retried directly.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen({ status: 404, body: { message: 'no route' } });
    r = await attempt(() => bg.get('facebook', 'page/nonexistent', { page_id: '1' }));
    ok('404: no fallback, one call, error returned', !!r.err && calls.length === 1 && calls[0].kind === 'blugate');
    calls.length = 0; script = blugateThen({ status: 400, body: { message: 'bad params' } });
    r = await attempt(() => bg.get('twitter', 'search', { type: 'Latest', count: 1, query: 'q' }));
    ok('400: no fallback', !!r.err && calls.length === 1);

    // 5. Instagram 500 (private/unknown account) is not retried directly.
    calls.length = 0; script = blugateThen({ status: 500, body: { message: 'user not found' } });
    r = await attempt(() => bg.post('instagram', 'api/instagram/userInfo', { username: 'nobody' }));
    ok('500: no fallback', !!r.err && calls.length === 1 && calls[0].kind === 'blugate');

    // 6. Network error / timeout → fallback. YouTube key goes in a header, never the URL.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = (rec) => (rec.kind === 'blugate' ? { network: true } : { status: 200, body: { items: [{ id: 'v1' }] } });
    r = await attempt(() => bg.get('youtube', 'search', { part: 'snippet', q: 'news', maxResults: 1 }));
    const d6 = calls.find((c) => c.kind === 'direct');
    ok('network error → YouTube direct fallback', r.res && r.res.provider === 'direct' && r.res.data.items.length === 1);
    ok('YouTube direct goes to googleapis /youtube/v3/search', d6 && d6.host === DIRECT_HOSTS.youtube && d6.path === '/youtube/v3/search');
    ok('YouTube key in X-goog-api-key header, not in URL/params', d6 && d6.headers['X-goog-api-key'] === SECRETS.YOUTUBE_API_KEY && !('key' in d6.params) && !d6.search.includes(SECRETS.YOUTUBE_API_KEY));
    ok('network error does not start a cooldown', !bg.getFallbackStats().stickyUntil.youtube);

    // 7. 502/503/504 → fallback; 401 → fallback with a 10-minute cooldown.
    for (const code of [502, 503, 504]) {
        reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = blugateThen({ status: code, body: {} });
        r = await attempt(() => bg.get('facebook', 'search/pages', { query: 'q' }));
        ok(`${code} → direct fallback`, r.res && r.res.provider === 'direct' && calls[1] && calls[1].host === DIRECT_HOSTS.facebook);
    }
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = blugateThen({ status: 401, body: { error: 'invalid key' } });
    r = await attempt(() => bg.get('facebook', 'search/pages', { query: 'q' }));
    const st = bg.getFallbackStats().stickyUntil.facebook;
    ok('401 → direct fallback + ~10 min cooldown', r.res && r.res.provider === 'direct' && st && st - Date.now() > 9 * 60 * 1000);
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = blugateThen({ status: 403, body: { message: 'Monthly quota exceeded' } });
    r = await attempt(() => bg.get('twitter', 'user', { username: 'nasa' }));
    ok('403 quota → treated as rate limit, direct fallback', r.res && r.res.provider === 'direct');

    // 8. BluGate credentials missing + fallback on → direct (no BluGate request at all).
    reset({ BLUGATE_FALLBACK_ENABLED: 'true', BLUGATE_API_KEY: null }); script = () => ({ status: 200, body: { ok: 1 } });
    r = await attempt(() => bg.get('twitter', 'user', { username: 'nasa' }));
    ok('no BluGate creds → direct', r.res && r.res.provider === 'direct' && calls.length === 1 && calls[0].kind === 'direct');
    reset({ BLUGATE_API_KEY: null });
    r = await attempt(() => bg.get('twitter', 'user', { username: 'nasa' }));
    ok('no BluGate creds + switch off → error, nothing sent', !!r.err && calls.length === 0);

    // 9. No direct key for the platform → no fallback even when switched on.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true', RAPIDAPI_INSTAGRAM_KEYS: null, RAPIDAPI_KEY: null });
    script = blugateThen(R429(0.01));
    r = await attempt(() => bg.post('instagram', 'api/instagram/userInfo', { username: 'natgeo' }));
    ok('no direct key → BluGate only, error returned', !!r.err && calls.every((c) => c.kind === 'blugate'));

    // 10. BluGate healthy + switch on → BluGate only.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = () => ({ status: 200, body: { ok: 1 } });
    r = await attempt(() => bg.get('youtube', 'videos', { part: 'snippet', id: 'a' }));
    ok('healthy BluGate: no direct call', r.res && r.res.provider === 'blugate' && calls.length === 1);

    // 11. Direct also fails → error surfaces (scrubbed).
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = blugateThen(R429(30), { status: 429, body: { message: 'You have exceeded the rate limit' } });
    r = await attempt(() => bg.get('twitter', 'user', { username: 'nasa' }));
    ok('direct fails too → error returned', !!r.err && r.err.response?.status === 429);
    ok('stats count the fallback and the failure', bg.getFallbackStats().stats.twitter.fallbacks === 1 && bg.getFallbackStats().stats.twitter.directFailures === 1);

    // 12. Service level: the real services fall back through their own code paths.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen(R429(30), { status: 200, body: { result: { timeline: { instructions: [] } } } });
    r = await attempt(() => X.rapidGet('search', { type: 'Latest', count: 5, query: 'cm sai' }));
    ok('X service rapidGet → direct', !r.err && calls.some((c) => c.kind === 'direct' && c.host === DIRECT_HOSTS.twitter && c.path === '/search'), r.err && r.err.message);

    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen(R429(30), { status: 200, body: { results: [{ name: 'NASA', facebook_id: '123' }] } });
    r = await attempt(() => FB.searchPages('nasa'));
    ok('Facebook service searchPages → direct', !r.err && calls.some((c) => c.kind === 'direct' && c.host === DIRECT_HOSTS.facebook && c.path === '/search/pages'), r.err && r.err.message);

    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen(R429(30), { status: 200, body: { result: { username: 'natgeo' } } });
    r = await attempt(() => IG.fetchUserProfile('natgeo'));
    const igd = calls.find((c) => c.kind === 'direct');
    ok('Instagram service fetchUserProfile → direct POST, same body', !r.err && igd && igd.host === DIRECT_HOSTS.instagram && igd.method === 'post' && String(igd.data).includes('natgeo'), r.err && r.err.message);

    reset({ BLUGATE_FALLBACK_ENABLED: 'true' });
    script = blugateThen(R429(30), { status: 200, body: { items: [] } });
    r = await attempt(() => YT.searchChannels('news'));
    ok('YouTube service searchChannels → direct', !r.err && calls.some((c) => c.kind === 'direct' && c.host === DIRECT_HOSTS.youtube), r.err && r.err.message);

    reset(); script = blugateThen(R429(0.01));
    r = await attempt(() => FB.searchPages('nasa'));
    ok('service with switch off: no direct call', calls.every((c) => c.kind === 'blugate'));

    // 12b. Diagnostics: callDirect only when switched on; off → rejected without any request.
    reset({ BLUGATE_FALLBACK_ENABLED: 'true' }); script = () => ({ status: 200, body: { ok: 1 } });
    r = await attempt(() => bg.callDirect('facebook', { path: 'search/pages', params: { query: 'nasa' } }));
    ok('callDirect (switch on) goes straight to the provider', r.res && calls.length === 1 && calls[0].host === DIRECT_HOSTS.facebook);
    reset();
    r = await attempt(() => bg.callDirect('facebook', { path: 'search/pages', params: { query: 'nasa' } }));
    ok('callDirect (switch off) is refused, nothing sent', !!r.err && calls.length === 0);

    // 12c. The other two migrated call sites load with the new client.
    let loadErr = null;
    try { require(path.join(dir, 'src/services/grievanceService')); require(path.join(dir, 'src/services/mediaAnalyzerService')); } catch (e) { loadErr = e; }
    ok('grievanceService and mediaAnalyzerService load', !loadErr, loadErr && loadErr.message);

    // 12d. Negative control: an UNSCRUBBED error does contain the secret, so the scan below can see leaks.
    reset(); script = () => ({ status: 401, body: {} });
    let raw = null;
    try { await axios({ url: 'https://blugate.blurasaga.com/api/gateway/twitter/user', headers: bg.getHeaders() }); } catch (e) { raw = e; }
    ok('negative control: raw axios error would leak the key', raw && util.inspect(raw, { depth: 10 }).includes(SECRETS.BLUGATE_API_KEY));
    ok('negative control: the same error after scrubError does not', raw && !util.inspect(bg.scrubError(raw), { depth: 10 }).includes(SECRETS.BLUGATE_API_KEY));

    // 13. Leak scan: no fake secret in any log line or any error that left the client.
    const haystack = logs.join('\n') + '\n' + thrown.map((e) => util.inspect(e, { depth: 10, showHidden: false })).join('\n') + '\n' + thrown.map((e) => { try { return JSON.stringify(e); } catch (_) { return ''; } }).join('\n');
    const leaked = Object.entries(SECRETS).filter(([, v]) => haystack.includes(v)).map(([k]) => k);
    ok(`leak scan: ${logs.length} log lines + ${thrown.length} errors contain no secret`, leaked.length === 0, `leaked: ${leaked.join(', ')}`);
    const fallbackLogs = logs.filter((l) => /direct fallback|\[direct /.test(l));
    ok('fallback is logged (route only, no secrets)', fallbackLogs.length > 0);
    out(`   e.g. log: ${fallbackLogs[0]}`);

    out(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write(`FATAL ${e.stack}\n`); process.exit(2); });
```

## Appendix E: Offline fallback test (Python)

Test for the §10.6 client. Put it next to `blugate_client.py` and run `python test_py_fallback.py`
(expects `16 passed, 0 failed`). It replaces `requests.request` with a scripted fake.

```python
# Offline test of blugate_client.py: requests.request is stubbed, nothing is sent.
import io, json, logging, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import requests

SECRETS = {"BLUGATE_API_KEY": "BGKEY-secret-1111", "BLUGATE_CLIENT_CODE": "BGCLIENT-secret-2222", "RAPIDAPI_KEY": "RAPIDX-secret-3333",
           "RAPIDAPI_FACEBOOK_KEY": "RAPIDFB-secret-4444", "RAPIDAPI_INSTAGRAM_KEYS": "RAPIDIG-secret-5555", "YOUTUBE_API_KEY": "YTKEY-secret-6666"}
os.environ.update(SECRETS)
import blugate_client as bg

calls, script = [], [lambda c: (200, {})]
logbuf = io.StringIO(); logging.basicConfig(stream=logbuf, level=logging.DEBUG)

def fake_request(method, url, params=None, json=None, headers=None, timeout=None):
    req = requests.Request(method, url, params=params, json=json, headers=headers).prepare()
    c = {"kind": "blugate" if "blugate.blurasaga.com" in url else "direct", "url": url, "params": dict(params or {}), "headers": dict(headers or {}), "json": json}
    calls.append(c)
    out = script[0](c)
    if out == "network":
        raise requests.ConnectionError("connection reset", request=req)
    status, body = out
    r = requests.Response(); r.status_code = status; r._content = (json_dumps := __import__("json").dumps)(body).encode(); r.request = req; r.url = req.url; r.headers["Content-Type"] = "application/json"
    return r
requests.request = fake_request

passed = failed = 0; errors = []
def ok(name, cond):
    global passed, failed
    passed += bool(cond); failed += (not cond); print(("PASS  " if cond else "FAIL  ") + name)
def reset(**env):
    os.environ.update(SECRETS); os.environ["BLUGATE_FALLBACK_ENABLED"] = "false"
    for k, v in env.items():
        if v is None: os.environ.pop(k, None)
        else: os.environ[k] = v
    bg._sticky.clear(); bg._stats.clear(); calls.clear()
def run(fn):
    try: return fn(), None
    except Exception as e: errors.append(e); return None, e
bg_then = lambda bgr, dr=(200, {"from": "direct"}): (lambda c: bgr if c["kind"] == "blugate" else dr)
R429 = (429, {"error": "Too many gateway requests", "retryAfterSec": 30})

reset(); script[0] = bg_then(R429)
_, e = run(lambda: bg.get("twitter", "search", {"type": "Latest", "count": 5, "query": "x"}))
ok("off: 429 raised, no direct call", e is not None and all(c["kind"] == "blugate" for c in calls))

reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = bg_then(R429)
res, e = run(lambda: bg.get("twitter", "search", {"type": "Latest", "count": 5, "query": "x", "blank": ""}))
d = next((c for c in calls if c["kind"] == "direct"), None)
ok("on: 429 -> direct result", res == {"from": "direct"})
ok("on: same path + params to twitter241", d and d["url"] == "https://twitter241.p.rapidapi.com/search" and d["params"] == {"type": "Latest", "count": 5, "query": "x"})
ok("on: direct has RapidAPI key only", d and d["headers"].get("x-rapidapi-key") == SECRETS["RAPIDAPI_KEY"] and "Authorization" not in d["headers"])
calls.clear(); res, e = run(lambda: bg.get("twitter", "user", {"username": "nasa"}))
ok("cooldown: next X call direct only", res and len(calls) == 1 and calls[0]["kind"] == "direct")

reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = bg_then((404, {"message": "no route"}))
_, e = run(lambda: bg.get("facebook", "nope"))
ok("404: no fallback", e is not None and len(calls) == 1)
reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = bg_then((500, {"message": "private"}))
_, e = run(lambda: bg.post("instagram", "api/instagram/userInfo", {"username": "a"}))
ok("500: no fallback", e is not None and len(calls) == 1)

reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = lambda c: "network" if c["kind"] == "blugate" else (200, {"items": [1]})
res, e = run(lambda: bg.get("youtube", "search", {"part": "snippet", "q": "n"}))
d = next((c for c in calls if c["kind"] == "direct"), None)
ok("network -> YouTube direct, key in header not URL", res and d and d["url"].startswith("https://www.googleapis.com/youtube/v3/search") and d["headers"].get("X-goog-api-key") == SECRETS["YOUTUBE_API_KEY"] and "key" not in d["params"])

for code in (502, 503, 504, 401):
    reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = bg_then((code, {}))
    res, e = run(lambda: bg.get("facebook", "search/pages", {"query": "q"}))
    ok(f"{code} -> direct", res == {"from": "direct"})

reset(BLUGATE_FALLBACK_ENABLED="true", BLUGATE_API_KEY=None); script[0] = lambda c: (200, {"ok": 1})
res, e = run(lambda: bg.get("twitter", "user", {"username": "nasa"}))
ok("no BluGate creds -> direct", res and len(calls) == 1 and calls[0]["kind"] == "direct")
reset(BLUGATE_FALLBACK_ENABLED="true", RAPIDAPI_INSTAGRAM_KEYS=None, RAPIDAPI_KEY=None); script[0] = bg_then(R429)
_, e = run(lambda: bg.post("instagram", "api/instagram/userInfo", {"username": "a"}))
ok("no direct key -> no fallback", e is not None and all(c["kind"] == "blugate" for c in calls))
reset(BLUGATE_FALLBACK_ENABLED="true"); script[0] = bg_then(R429, (429, {"message": "limit"}))
_, e = run(lambda: bg.get("twitter", "user", {"username": "nasa"}))
ok("direct also fails -> error raised", e is not None)

hay = logbuf.getvalue() + "\n".join(repr(x) + str(getattr(getattr(x, "request", None), "headers", "")) for x in errors)
ok("leak scan: logs + errors contain no secret", not any(v in hay for v in SECRETS.values()))
print(f"{passed} passed, {failed} failed"); sys.exit(1 if failed else 0)
```
