/**
 * create_tenant_user.js
 * ─────────────────────────────────────────────────────────────────────
 * Creates (or updates) the login for an isolated tenant workspace in this
 * deployment. The user can then reach only /workspace and /api/tenant/*
 * (see src/config/tenancy.js and src/middleware/tenantGuard.js).
 *
 * The workspace row, events and posts (tenant_workspaces, tenant_events,
 * tenant_posts) are written by the Goa codebase's tenant scripts; this script
 * only manages the login.
 *
 * The password is read from TENANT_USER_PASSWORD (never a CLI argument, so it
 * is not left in shell history or process lists). An existing tenant user's
 * password is changed only with --reset-password. Refuses to touch an email
 * that belongs to a Maharashtra user or to another tenant.
 *
 *   TENANT_USER_PASSWORD='…' node scripts/tenant/create_tenant_user.js \
 *       --tenant gambia --email someone@example.com --name "Full Name" [--reset-password]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../../src/models/User');
const { DEFAULT_TENANT, tenantOf } = require('../../src/config/tenancy');
const { buildEmailLookup, normalizeEmail } = require('../../src/utils/authIdentity');

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
};

// 'viewer' is the least-privileged role; the tenant guard closes every
// Maharashtra page and API to the user regardless of role.
const TENANT_ROLE = 'viewer';

const main = async () => {
    const tenantId = String(arg('--tenant') || '').trim();
    const email = normalizeEmail(arg('--email') || '');
    const fullName = String(arg('--name') || '').trim();
    const resetPassword = process.argv.includes('--reset-password');
    if (!tenantId || !/^[a-z0-9_-]+$/i.test(tenantId)) throw new Error('--tenant is required (letters, digits, - and _)');
    if (tenantId === DEFAULT_TENANT) throw new Error(`--tenant must not be "${DEFAULT_TENANT}" (this deployment's own users)`);
    if (!email || !email.includes('@')) throw new Error('--email is required');
    if (!fullName) throw new Error('--name is required');
    const password = process.env.TENANT_USER_PASSWORD;

    const dbName = process.env.DB_NAME ? String(process.env.DB_NAME).trim() : undefined;
    await mongoose.connect(process.env.MONGODB_URI, dbName ? { dbName } : undefined);
    console.log(`database   ${mongoose.connection.name}`);

    let user = await User.findOne({ email: buildEmailLookup(email) });
    if (user && tenantOf(user) !== tenantId) {
        throw new Error(`${email} already exists in tenant "${tenantOf(user)}" — refusing to change it`);
    }
    if (!user) {
        if (!password) throw new Error('TENANT_USER_PASSWORD is required to create the user');
        user = await User.create({
            email,
            full_name: fullName,
            password: await bcrypt.hash(password, await bcrypt.genSalt(10)),
            role: TENANT_ROLE,
            tenant_id: tenantId,
            is_active: true,
        });
        console.log(`user       ${email}: created in tenant "${tenantId}" (${user.id})`);
    } else {
        user.full_name = fullName;
        user.role = TENANT_ROLE;
        user.tenant_id = tenantId;
        user.is_active = true;
        if (resetPassword) {
            if (!password) throw new Error('TENANT_USER_PASSWORD is required with --reset-password');
            user.password = await bcrypt.hash(password, await bcrypt.genSalt(10));
        }
        await user.save();
        console.log(`user       ${email}: updated in tenant "${tenantId}"${resetPassword ? ' (password reset)' : ''}`);
    }
};

main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
        console.error('create_tenant_user failed:', err.message);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
