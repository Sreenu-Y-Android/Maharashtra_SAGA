const mongoose = require('mongoose');

/**
 * Settings for the monitoring reports (one document, key "default"): whom the
 * reports are measured toward, the second stance axis, upcoming dates, tracked
 * facts, written guidance for the presentation format, and the preparer's
 * branding. Figures are never stored here; they are computed per report.
 */
const reportProfileSchema = new mongoose.Schema({
    key: { type: String, default: 'default', unique: true },
    // A leader from data/mh_leaders.json; name, role and aliases come from there.
    subject_leader_key: { type: String, default: 'mh-eknath-shinde' },
    // Overrides for the roster entry (optional).
    subject_name: { type: String, default: null },
    subject_role: { type: String, default: null },
    // The second stance axis, e.g. "the state government" (support for it counts toward positive tone).
    axis_label: { type: String, default: 'the state government' },
    watch_items: { type: [{ date: Date, description: String, status: { type: String, default: 'verified' } }], default: [] },
    facts: { type: [{ statement: String, status: { type: String, default: 'verified' }, claimed_by: String, sources: [String] }], default: [] },
    briefing: { type: mongoose.Schema.Types.Mixed, default: null },
    branding: { type: mongoose.Schema.Types.Mixed, default: null },
    updated_at: { type: Date, default: Date.now },
}, { collection: 'report_profiles' });

module.exports = mongoose.model('ReportProfile', reportProfileSchema);
