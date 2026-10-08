/**
 * Creates or updates the monitoring-report profile from a JSON spec: whom the
 * reports are measured toward, the second stance axis, upcoming dates, tracked
 * facts, written guidance for the presentation format, and branding.
 *
 *   node scripts/subjectReports/setup_report_profile.js --spec scripts/subjectReports/profile.json
 *
 * Optionally generate a report straight away (IST dates):
 *   ... --generate 2026-10-01 2026-10-08
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const mongoose = require('mongoose');
const ReportProfile = require('../../src/models/ReportProfile');
const SubjectReport = require('../../src/models/SubjectReport');
const MH = require('../../src/data/mh_leaders.json');
const { completeReport } = require('../../src/services/subjectReports/reportEngine');

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
};

const main = async () => {
    const specPath = arg('--spec');
    if (!specPath) throw new Error('--spec is required');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const leader = MH.leaders.find((l) => l.key === spec.subject_leader_key);
    if (!leader) throw new Error(`No leader "${spec.subject_leader_key}" in data/mh_leaders.json`);

    await mongoose.connect(process.env.MONGODB_URI, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : undefined);
    const profile = await ReportProfile.findOneAndUpdate(
        { key: 'default' },
        { $set: { ...spec, key: 'default', updated_at: new Date() } },
        { upsert: true, new: true },
    ).lean();
    console.log(`profile: subject ${leader.name} (${leader.role}); axis "${profile.axis_label}"`);

    const gi = process.argv.indexOf('--generate');
    if (gi !== -1) {
        const day = (v, end) => new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);
        const from = day(process.argv[gi + 1], false);
        const to = day(process.argv[gi + 2], true);
        const report = await SubjectReport.create({ title: profile.subject_name || leader.name, status: 'generating', range_from: from, range_to: to, generated_by: 'cli' });
        await completeReport(report.id, { profile, leader, from, to });
        const done = await SubjectReport.findOne({ id: report.id }).select('status post_count error').lean();
        console.log(`report ${report.id}: ${done.status}, ${done.post_count} relevant posts${done.error ? ` (${done.error})` : ''}`);
    }
};

main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
        console.error('setup failed:', err.message);
        await mongoose.disconnect();
        process.exit(1);
    });
