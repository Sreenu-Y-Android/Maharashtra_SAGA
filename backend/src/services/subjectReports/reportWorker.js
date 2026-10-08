/**
 * Builds one monitoring report in a child process, so a long period (e.g. "All
 * time": 15,000+ posts) never blocks the API process. Forked by the controller;
 * receives the job over IPC, writes the result to subject_reports, and exits.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const mongoose = require('mongoose');
const { completeReport } = require('./reportEngine');

process.once('message', async (job) => {
    let code = 0;
    try {
        await mongoose.connect(process.env.MONGODB_URI, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : undefined);
        await completeReport(job.reportId, job.options);
    } catch (err) {
        console.error('[subjectReports] worker failed:', err.message);
        code = 1;
    } finally {
        await mongoose.disconnect().catch(() => {});
        process.exit(code);
    }
});
