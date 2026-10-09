/**
 * Reports for a tenant workspace event, computed with the Maharashtra report
 * engine (services/subjectReports/reportEngine.js) from the event's posts in
 * the tenant_posts collection. The posts and events are written by the
 * collection scripts in the Goa codebase; this side only reads them.
 *
 * Tone follows the engine's rule: toward the event subject, plus the axis
 * (event.briefing.axis_label, "the government" by default) read according to
 * the subject's alignment (event.briefing.subject_alignment: 'ally' counts
 * support for the axis as positive, 'opposition' as negative, anything else
 * ignores the axis).
 *
 * Every query here is pinned to the event's tenant_id.
 */

const TenantPost = require('../../models/tenant/TenantPost');
const TenantReport = require('../../models/tenant/TenantReport');
const {
    tone, toneDefinitions, computeStats, templateProse, footageOf, isPublicAccount,
} = require('../subjectReports/reportEngine');
const { expandReport } = require('../subjectReports/textClean');

const METHODOLOGY = [
    'Posts are public social-media posts collected for this event from the monitored searches, accounts and pages. A post found by more than one search is counted once.',
    'Each post is labelled for relevance, stance toward the subject, stance toward the axis named in the report, sentiment, narrative, claims and risk band. Posts not marked relevant are excluded from all figures; posts not yet analysed are counted separately.',
    'Tone is measured toward the report subject: positive supports them, negative criticises them, neutral is everything else. Where the subject has a stated alignment, the stance toward the axis counts as described in the report.',
    'Risk bands: critical and high are reserved for threats of violence, incitement, doxxing, impersonation and manipulated media; ordinary criticism stays low. An analyst\'s review of a band takes precedence over the model\'s.',
    'Engagement score = likes + 2×comments + 3×shares + views/10. Only outlets, public figures, organisations and accounts with 50,000+ followers are named; private individuals are never listed.',
    'Times are in IST.',
];

const QUALITATIVE_KEYS = ['narrative_summaries', 'allegation_themes', 'activity_notes', 'place_context', 'recommendations'];
const QUALITATIVE_SUMMARY_KEYS = ['what_happened', 'when_where', 'who_involved', 'why_attention'];

const SIGN = { ally: 1, opposition: -1 };
const alignmentOf = (event) => (event.briefing?.subject_alignment === 'ally' || event.briefing?.subject_alignment === 'opposition'
    ? event.briefing.subject_alignment : 'none');
const axisSignOf = (event) => SIGN[alignmentOf(event)] || 0;

/** The tone function for this event's posts (sets the axis sign the engine reads). */
const tenantTone = (event) => {
    const sign = axisSignOf(event);
    return (p) => tone({ ...p, analysis: { ...(p.analysis || {}), axis_sign: sign } });
};

/** Mongo filter selecting the posts of one tone for this event (same rule as tenantTone). */
const toneQuery = (event, key) => {
    const sign = axisSignOf(event);
    const S = 'analysis.stance_toward_subject';
    const P = 'analysis.stance_toward_protest';
    const posAxis = sign === 1 ? 'supportive' : sign === -1 ? 'critical' : null;
    const negAxis = sign === 1 ? 'critical' : sign === -1 ? 'supportive' : null;
    const positive = { $or: [{ [S]: 'supportive' }, ...(posAxis ? [{ [P]: posAxis, [S]: { $ne: 'critical' } }] : [])] };
    const negative = { $or: [{ [S]: 'critical' }, ...(negAxis ? [{ [P]: negAxis, [S]: { $ne: 'supportive' } }] : [])] };
    if (key === 'positive') return positive;
    if (key === 'negative') return negative;
    if (key === 'neutral') return { $nor: [positive, negative] };
    return null;
};

/** The event as the engine reads it. */
const eventView = (event) => {
    const alignment = alignmentOf(event);
    const axisLabel = event.briefing?.axis_label || 'the government';
    const subject = { ...(event.subject || {}), alignment };
    return {
        scope: 'leader',
        name: event.name,
        short_name: event.short_name || event.name,
        description: event.description || '',
        location: event.location || '',
        start_date: event.start_date || null,
        subject,
        axis_label: axisLabel,
        tone: toneDefinitions(subject.name || 'the subject', alignment, axisLabel),
        organisers: [],
        related_figures: event.related_figures || [],
        keywords: event.keywords || [],
        hashtags: event.hashtags || [],
        narratives: event.narratives || [],
        facts: event.facts || [],
        sources: event.sources || [],
        watch_items: event.watch_items || [],
        briefing: event.briefing || null,
        platforms_filter: [],
    };
};

const rangeFilter = (event, { from = null, to = null } = {}) => {
    const filter = { tenant_id: event.tenant_id, event_id: event.id };
    if (from || to) {
        filter.published_at = {};
        if (from) filter.published_at.$gte = new Date(from);
        if (to) filter.published_at.$lte = new Date(to);
    }
    return filter;
};

/** Build the report document for posts published in [from, to]. */
const buildReportData = async (event, { from = null, to = null } = {}) => {
    if (!event.tenant_id) throw new Error('event has no tenant_id');
    const filter = rangeFilter(event, { from, to });
    // Full documents only for labelled relevant posts; the rest are needed just for the
    // collected/pending/excluded counts, so they are loaded with a few small fields.
    const [used, others] = await Promise.all([
        TenantPost.find({ ...filter, 'analysis.status': 'done', 'analysis.is_relevant': true }).select('-matched_queries -__v').lean(),
        TenantPost.find({ ...filter, $nor: [{ 'analysis.status': 'done', 'analysis.is_relevant': true }] })
            .select('platform post_type published_at analysis.status analysis.is_relevant').lean(),
    ]);
    const sign = axisSignOf(event);
    const posts = used.concat(others);
    posts.forEach((p) => { p.analysis = { ...(p.analysis || {}), axis_sign: sign }; });

    const view = eventView(event);
    const stats = computeStats(view, posts);
    const prose = templateProse(view, stats);

    // Qualitative analyst text (written once for the event) is carried into every report;
    // figure-bearing text only into the whole-event report while the data still matches it.
    const review = event.analyst_review || {};
    const analyst = review.prose || {};
    const ranged = Boolean(from || to);
    const snapshotMatches = !ranged && review.basis_relevant_posts === stats.totals.relevant;
    QUALITATIVE_KEYS.forEach((k) => { if (analyst[k]) prose[k] = analyst[k]; });
    if (analyst.executive_summary) {
        prose.executive_summary = { ...prose.executive_summary };
        QUALITATIVE_SUMMARY_KEYS.forEach((k) => { if (analyst.executive_summary[k]) prose.executive_summary[k] = analyst.executive_summary[k]; });
    }
    let bottomLine = prose.bottom_line;
    let bottomLineSource = 'generated';
    if (snapshotMatches) {
        if (analyst.attention) prose.attention = analyst.attention;
        if (analyst.executive_summary?.social_discussion) prose.executive_summary.social_discussion = analyst.executive_summary.social_discussion;
        if (review.bottom_line) { bottomLine = review.bottom_line; bottomLineSource = 'analyst'; }
    }

    return {
        stats,
        data: expandReport({
            version: 2,
            kind: 'subject_monitoring',
            generated_at: new Date(),
            prose_source: review.prose ? 'template+analyst' : 'template',
            range: { from: from ? new Date(from) : null, to: to ? new Date(to) : null },
            event: view,
            bottom_line: bottomLine,
            bottom_line_source: bottomLineSource,
            analyst_review: review.reviewed_at ? {
                reviewed_at: review.reviewed_at,
                reviewed_by: review.reviewed_by,
                risk_assessment: snapshotMatches ? review.risk_assessment : null,
                notes: snapshotMatches ? review.notes : [],
            } : null,
            attention: prose.attention,
            executive_summary: prose.executive_summary,
            activity_notes: prose.activity_notes || {},
            place_context: prose.place_context || {},
            narrative_summaries: prose.narrative_summaries || {},
            allegation_themes: prose.allegation_themes || [],
            recommendations: prose.recommendations,
            stats,
            methodology: METHODOLOGY,
            collection: { last_collected_at: event.last_collected_at || null, last_summary: null },
        }),
    };
};

const reportFields = (event, stats, data, range) => ({
    title: event.short_name || event.name,
    range_from: range.from ? new Date(range.from) : null,
    range_to: range.to ? new Date(range.to) : null,
    period_start: stats.totals.first_post_at,
    period_end: stats.totals.last_post_at,
    post_count: stats.totals.relevant,
    data,
});

/** Fill in a report row created earlier with status 'generating'. */
const completeReport = async (event, reportId, { from = null, to = null } = {}) => {
    try {
        const { stats, data } = await buildReportData(event, { from, to });
        await TenantReport.updateOne(
            { tenant_id: event.tenant_id, id: reportId },
            { $set: { status: 'ready', error: null, ...reportFields(event, stats, data, { from, to }) } },
        );
    } catch (err) {
        await TenantReport.updateOne({ tenant_id: event.tenant_id, id: reportId }, { $set: { status: 'failed', error: err.message } });
        throw err;
    }
};

/**
 * Relevant posts per tone in [from, to], for slicing the PDF appendix. Uses the
 * same filters as the posts export's tone slices, so the slices line up.
 */
const toneCounts = async (event, { from = null, to = null } = {}) => {
    const base = { ...rangeFilter(event, { from, to }), 'analysis.is_relevant': true };
    const keys = ['positive', 'negative', 'neutral'];
    const counts = await Promise.all(keys.map((k) => TenantPost.countDocuments({ ...base, $and: [toneQuery(event, k)] })));
    return Object.fromEntries(keys.map((k, i) => [k, counts[i]]));
};

module.exports = {
    tenantTone, toneQuery, toneCounts, eventView, buildReportData, completeReport, footageOf, isPublicAccount,
};
