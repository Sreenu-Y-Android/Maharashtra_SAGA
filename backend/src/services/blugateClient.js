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
const providerLabel = () => (MODE === 'rapidapi' ? 'RapidAPI (direct)' : fallbackEnabled() ? 'BluGate (+ direct fallback)' : 'BluGate');

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

/**
 * Local addition (not in the guide's Appendix C): SOCIAL_API_MODE=rapidapi sends every
 * call straight to the provider and never touches BluGate. The tenant collection scripts
 * set it for workspaces that run on their own RapidAPI keys; the app itself leaves it
 * unset, so BluGate-first (+ optional fallback) applies.
 */
const MODE = String(process.env.SOCIAL_API_MODE || 'blugate').trim().toLowerCase() === 'rapidapi' ? 'rapidapi' : 'blugate';
const directOnly = () => MODE === 'rapidapi';
const directKeyed = (platform) => {
    const d = directOf(platform);
    return !!(d && d.key && d.base);
};

/** True when the direct fallback is switched on (or direct-only mode is set) and has a key for this platform. */
const directReady = (platform) => {
    if (!fallbackEnabled() && !directOnly()) return false;
    return directKeyed(platform);
};

// YouTube's key goes in a header, never the URL, so it cannot end up in a logged URL.
const directHeaders = (d) => (d.google ? { 'X-goog-api-key': d.key } : { 'x-rapidapi-key': d.key, 'x-rapidapi-host': d.host });

/** True when calls for `platform` can be made: BluGate credentials, or a ready direct fallback. */
const hasCredentials = (platform) => {
    if (directOnly()) return platform ? directKeyed(platform) : Object.keys(DIRECT).some(directKeyed);
    return blugateConfigured() || (platform ? directReady(platform) : Object.keys(DIRECT).some(directReady));
};

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

    // Direct-only mode (SOCIAL_API_MODE=rapidapi): the provider, with the usual in-place 429 retry.
    if (directOnly()) {
        if (!canFallBack) {
            const err = new Error(`No direct provider key configured for ${p} (SOCIAL_API_MODE=rapidapi)`);
            err.code = 'DIRECT_NOT_CONFIGURED';
            throw err;
        }
        return withRateLimitRetry(() => direct(p, opts, 'direct-only mode'), { label: `RapidAPI ${p}` });
    }

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
    MODE,
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
