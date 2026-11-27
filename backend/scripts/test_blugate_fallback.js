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
