const mongoose = require('mongoose');

// Tenant collections can live in their own database. With TENANT_MONGODB_URI set they
// use a separate connection; without it they share the main connection as before.
const uri = process.env.TENANT_MONGODB_URI ? String(process.env.TENANT_MONGODB_URI).trim() : '';
const dbName = process.env.TENANT_DB_NAME ? String(process.env.TENANT_DB_NAME).trim() : undefined;

let tenantDb = mongoose;
if (uri) {
    tenantDb = mongoose.createConnection(uri, dbName ? { dbName } : undefined);
    tenantDb.on('connected', () => console.log('Tenant MongoDB Connected: successfully to tenant database'));
    tenantDb.on('error', (err) => console.error(`Tenant MongoDB error: ${err.message}`));
}

module.exports = tenantDb;
