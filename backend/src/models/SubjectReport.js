const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/**
 * A monitoring report on the whole monitored conversation for a period,
 * measured toward the report subject (see ReportProfile). `data` holds the
 * computed figures and text the four report formats render.
 */
const subjectReportSchema = new mongoose.Schema({
    id: { type: String, default: uuidv4, unique: true },
    title: { type: String, default: null },
    status: { type: String, enum: ['generating', 'ready', 'failed'], default: 'generating', index: true },
    error: { type: String, default: null },
    range_from: { type: Date, default: null },
    range_to: { type: Date, default: null },
    period_start: { type: Date, default: null },
    period_end: { type: Date, default: null },
    post_count: { type: Number, default: 0 },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    generated_by: { type: String, default: null },
    created_at: { type: Date, default: Date.now, index: true },
}, { collection: 'subject_reports' });

module.exports = mongoose.model('SubjectReport', subjectReportSchema);
