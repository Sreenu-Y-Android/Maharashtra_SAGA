/**
 * verticals — the client dataset tag carried by every document.
 *
 * ── THIS DEPLOYMENT ──────────────────────────────────────────────────
 * Maharashtra Political Watch. This project was split out of the Chhattisgarh
 * deployment, where Maharashtra had been a second vertical (`mh`) inside the
 * Chhattisgarh database. It now has its own code, database, logins and
 * processes, and holds Maharashtra data only.
 *
 * The `vertical` field and the scoping plugin are kept so the Maharashtra
 * code paths (which branch on `vertical === 'mh'`) behave exactly as they did
 * before the split. `mh` is the only vertical here and the default: anything
 * written without an explicit vertical is Maharashtra.
 *
 * ── NO CONTEXT MEANS NO FILTER, AND THAT IS INTENTIONAL ──────────────
 * Background collection, schedulers and CLI scripts run with no logged-in
 * user. They must see everything, or the Maharashtra sources would never be
 * polled. So `currentVerticals()` returns null outside a request and the
 * plugin applies no filter. Anything running outside a request that SHOULD be
 * scoped must say so itself with `runWithVerticals([...])` — the daily report
 * does exactly that.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

/** The deployment's own client. Everything in the database is this. */
const DEFAULT_VERTICAL = 'mh';

const VERTICALS = {
    mh: {
        key: 'mh',
        label: 'Maharashtra',
        state_name: 'Maharashtra',
        state_name_native: 'महाराष्ट्र',
        /** The resident client — this is the deployment's reason for existing. */
        is_host: true,
    },
};

const VERTICAL_KEYS = Object.keys(VERTICALS);
const isVertical = (v) => Object.prototype.hasOwnProperty.call(VERTICALS, String(v || ''));

/**
 * Per-request store. A mutable object is placed on the stack at the very top of
 * the request so that `protect()` can fill in the user's verticals later,
 * once the JWT has actually been resolved, without re-entering `run()`.
 */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a vertical context.
 *
 * ⚠ THE `await` IS LOAD-BEARING. A Mongoose query is lazy: `Model.find()`
 * builds a Query and runs nothing until it is awaited, and the `pre` hook that
 * applies the vertical filter fires at EXECUTION time, not construction time.
 *
 * So `storage.run(store, () => Model.find())` returns an unexecuted Query, the
 * store pops as `run()` returns, and the caller's `await` then executes it with
 * NO CONTEXT AND THEREFORE NO FILTER. That is not a hypothetical: it made the
 * isolation test report identical counts for both clients — every row visible
 * to everyone — while every unit-level check still passed.
 *
 * Awaiting inside the store makes the helper correct whether the callback
 * returns a value, a promise, or a lazy Query.
 */
const runWithVerticals = (verticals, fn) => storage.run(
    { verticals: normalize(verticals) },
    async () => fn(),
);

/** Open a store whose verticals are filled in later by the auth middleware. */
const runWithPendingVerticals = (fn) => storage.run({ verticals: null }, fn);

const setVerticals = (verticals) => {
    const store = storage.getStore();
    if (store) store.verticals = normalize(verticals);
};

/** null ⇒ unscoped (no request context). An array ⇒ scope to exactly these. */
const currentVerticals = () => {
    const store = storage.getStore();
    const v = store ? store.verticals : null;
    return Array.isArray(v) && v.length > 0 ? v : null;
};

function normalize(verticals) {
    if (!verticals) return null;
    const list = (Array.isArray(verticals) ? verticals : [verticals])
        .map((v) => String(v || '').trim().toLowerCase())
        .filter(isVertical);
    return list.length > 0 ? [...new Set(list)] : null;
}

/**
 * Which verticals a user may see.
 *
 * A user with nothing recorded gets the deployment's own vertical (`mh`).
 */
const verticalsForUser = (user) => normalize(user && user.verticals) || [DEFAULT_VERTICAL];

module.exports = {
    DEFAULT_VERTICAL,
    VERTICALS,
    VERTICAL_KEYS,
    isVertical,
    runWithVerticals,
    runWithPendingVerticals,
    setVerticals,
    currentVerticals,
    verticalsForUser,
};
