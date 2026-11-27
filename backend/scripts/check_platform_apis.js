/**
 * Live check of the four platforms (BluGate guide §8.1 / §10.9). BILLED: one call per platform.
 *
 *   node scripts/check_platform_apis.js            # 4 calls through BluGate
 *   node scripts/check_platform_apis.js --direct   # the same 4 calls straight to the providers,
 *                                                  # using the fallback keys (needs
 *                                                  # BLUGATE_FALLBACK_ENABLED=true)
 *
 * Prints only whether each credential is set, never its value.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const blugate = require('../src/services/blugateClient');

const direct = process.argv.includes('--direct');

const CHECKS = [
    { platform: 'youtube', label: 'YouTube /search', opts: { path: 'search', params: { part: 'snippet', q: 'news', type: 'channel', maxResults: 1 } }, ok: (d) => Array.isArray(d && d.items) },
    { platform: 'twitter', label: 'X /user', opts: { path: 'user', params: { username: 'nasa' } }, ok: (d) => !!(d && d.result) },
    { platform: 'instagram', label: 'Instagram /api/instagram/userInfo', opts: { method: 'post', path: 'api/instagram/userInfo', data: { username: 'instagram' }, headers: { 'Content-Type': 'application/json' } }, ok: (d) => !!d && typeof d === 'object' },
    { platform: 'facebook', label: 'Facebook /search/pages', opts: { path: 'search/pages', params: { query: 'nasa' } }, ok: (d) => Array.isArray(d && d.results) },
];

const isSet = (name) => (process.env[name] && String(process.env[name]).trim() ? 'set' : 'not set');

(async () => {
    console.log(`route        ${direct ? 'direct providers (fallback keys)' : 'BluGate'}  |  gateway ${blugate.GATEWAY_BASE}`);
    console.log(`credentials  BLUGATE_API_KEY ${isSet('BLUGATE_API_KEY')}, BLUGATE_CLIENT_CODE ${isSet('BLUGATE_CLIENT_CODE')}, `
        + `RAPIDAPI_KEY ${isSet('RAPIDAPI_KEY')}, RAPIDAPI_FACEBOOK_KEY ${isSet('RAPIDAPI_FACEBOOK_KEY')}, `
        + `RAPIDAPI_INSTAGRAM_KEYS ${isSet('RAPIDAPI_INSTAGRAM_KEYS')}, YOUTUBE_API_KEY ${isSet('YOUTUBE_API_KEY')}`);
    console.log(`fallback     ${blugate.fallbackEnabled() ? 'ON' : 'off'}`);

    let failed = 0;
    for (const c of CHECKS) {
        try {
            const res = direct ? await blugate.callDirect(c.platform, c.opts) : await blugate.call(c.platform, c.opts);
            const good = c.ok(res.data);
            if (!good) failed += 1;
            const preview = JSON.stringify(res.data).slice(0, 140);
            console.log(`${good ? 'OK  ' : 'ODD '} ${c.label.padEnd(36)} ${res.status} via ${res.provider}  ${preview}`);
        } catch (err) {
            failed += 1;
            const status = err.response ? err.response.status : (err.code || 'error');
            const body = err.response ? JSON.stringify(err.response.data).slice(0, 140) : err.message;
            console.log(`FAIL ${c.label.padEnd(36)} ${status}  ${body}`);
        }
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
    process.exit(failed ? 1 : 0);
})();
