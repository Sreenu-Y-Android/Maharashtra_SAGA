// Offline test of SOCIAL_API_MODE=rapidapi (direct-only, used by the tenant collection scripts).
// No network: axios's adapter is replaced. Fake secrets are scanned for leaks.
// Usage: node scripts/test_social_api_mode.js
const path = require('path');
const util = require('util');

const SECRETS = { BLUGATE_API_KEY: 'BGKEY-secret-1111', BLUGATE_CLIENT_CODE: 'BGCLIENT-secret-2222', RAPIDAPI_KEY: 'RAPIDX-secret-3333', RAPIDAPI_FACEBOOK_KEY: 'RAPIDFB-secret-4444', RAPIDAPI_INSTAGRAM_KEYS: 'RAPIDIG-secret-5555' };
Object.assign(process.env, SECRETS, { SOCIAL_API_MODE: 'rapidapi', BLUGATE_FALLBACK_ENABLED: 'false', RAPIDAPI_INSTAGRAM_HOST: 'instagram120.p.rapidapi.com' });
for (const k of ['YOUTUBE_API_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_FACEBOOK_HOST']) delete process.env[k];

const logs = [];
for (const m of ['log', 'warn', 'error', 'info']) console[m] = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 6 }))).join(' '));
const out = (s) => process.stdout.write(`${s}\n`);

const axios = require(path.join(__dirname, '../node_modules/axios'));
const calls = [];
let script = () => ({ status: 200, body: { ok: 1 } });
axios.defaults.adapter = async (config) => {
    const u = new URL(config.url);
    const headers = config.headers && typeof config.headers.toJSON === 'function' ? config.headers.toJSON() : { ...(config.headers || {}) };
    calls.push({ host: u.hostname, path: u.pathname, headers, params: { ...(config.params || {}) } });
    const r = script();
    const response = { data: Buffer.from(JSON.stringify(r.body)), status: r.status, statusText: String(r.status), headers: { 'content-type': 'application/json' }, config, request: {} };
    if (r.status >= 400) throw new axios.AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
    return response;
};

const bg = require('../src/services/blugateClient');
let pass = 0; let fail = 0; const thrown = [];
const ok = (name, cond) => { if (cond) pass += 1; else fail += 1; out(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

(async () => {
    ok('MODE is rapidapi', bg.MODE === 'rapidapi');
    ok('providerLabel says direct', /RapidAPI \(direct\)/.test(bg.providerLabel()));

    let r = await bg.get('facebook', 'search/posts', { query: 'NDC', cursor: '' });
    ok('Facebook goes straight to facebook-scraper3, never BluGate', calls.length === 1 && calls[0].host === 'facebook-scraper3.p.rapidapi.com' && r.provider === 'direct');
    ok('direct call carries the RapidAPI key, not BluGate credentials', calls[0].headers['x-rapidapi-key'] === SECRETS.RAPIDAPI_FACEBOOK_KEY && !calls[0].headers.Authorization && !calls[0].headers['x-client-id']);
    ok('blank params dropped', !('cursor' in calls[0].params));

    calls.length = 0;
    await bg.post('instagram', 'api/instagram/reels', { username: 'x' });
    ok('Instagram goes to RAPIDAPI_INSTAGRAM_HOST (instagram120)', calls[0] && calls[0].host === 'instagram120.p.rapidapi.com');

    ok('hasCredentials(facebook) true from the direct key', bg.hasCredentials('facebook') === true);
    ok('hasCredentials(youtube) false without YOUTUBE_API_KEY', bg.hasCredentials('youtube') === false);
    calls.length = 0;
    try { await bg.get('youtube', 'search', { q: 'x' }); } catch (e) { thrown.push(e); }
    ok('YouTube without a key: error, nothing sent', thrown.length === 1 && thrown[0].code === 'DIRECT_NOT_CONFIGURED' && calls.length === 0);

    calls.length = 0; let n = 0;
    script = () => { n += 1; return n === 1 ? { status: 429, body: { retryAfterSec: 0.01 } } : { status: 200, body: { ok: 1 } }; };
    r = await bg.get('twitter', 'user', { username: 'nasa' });
    ok('direct 429 retried in place, then succeeds', r.status === 200 && calls.length === 2 && calls.every((c) => c.host === 'twitter241.p.rapidapi.com'));

    script = () => ({ status: 403, body: { message: 'You are not subscribed to this API.' } });
    try { await bg.get('twitter', 'user', { username: 'nasa' }); } catch (e) { thrown.push(e); }
    const hay = logs.join('\n') + thrown.map((e) => util.inspect(e, { depth: 10 })).join('\n');
    const leaked = Object.entries(SECRETS).filter(([, v]) => hay.includes(v)).map(([k]) => k);
    ok(`leak scan: ${logs.length} log lines + ${thrown.length} errors contain no secret`, leaked.length === 0);

    out(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write(`FATAL ${e.stack}\n`); process.exit(2); });
