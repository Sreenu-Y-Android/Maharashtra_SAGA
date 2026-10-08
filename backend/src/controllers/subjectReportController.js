/**
 * Monitoring reports on the whole monitored conversation for a period,
 * measured toward the report subject (ReportProfile). Four formats render
 * from one report: presentation, executive, detailed, detailed + posts.
 */

const SubjectReport = require('../models/SubjectReport');
const ReportProfile = require('../models/ReportProfile');
const MH = require('../data/mh_leaders.json');
const { completeReport, tone, footageOf, isPublicAccount } = require('../services/subjectReports/reportEngine');
const { loadPosts } = require('../services/subjectReports/postAdapter');
const { startPdfJob, getJob } = require('../services/subjectReports/pdfService');
const { expand } = require('../services/subjectReports/textClean');

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error('[subjectReports]', err);
    res.status(500).json({ message: 'Something went wrong' });
});

const userId = (req) => String(req.user?.id || req.user?._id || '');

/** The profile (created with defaults on first use) and the subject's roster entry. */
const loadProfile = async () => {
    let profile = await ReportProfile.findOne({ key: 'default' }).lean();
    if (!profile) profile = (await ReportProfile.create({ key: 'default' })).toObject();
    const leader = (MH.leaders || []).find((l) => l.key === profile.subject_leader_key) || null;
    return { profile, leader };
};

const subjectMatcher = (profile, leader) => {
    const aliases = [...new Set([...(leader?.aliases || []), leader?.name].filter(Boolean))];
    return {
        key: profile.subject_leader_key,
        rx: aliases.length ? new RegExp(aliases.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : /$^/,
    };
};

const parseDay = (value, endOfDay) => {
    if (!value) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`)
        : new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
};
const istDate = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) : null);

/** GET /profile — who the reports are measured toward, and the preparer's branding. */
const getProfile = async (req, res) => {
    const { profile, leader } = await loadProfile();
    res.json({
        profile: {
            subject: { key: profile.subject_leader_key, name: profile.subject_name || leader?.name, role: profile.subject_role || leader?.role },
            axis_label: profile.axis_label,
            branding: profile.branding || null,
        },
        workspace: { name: profile.subject_name || leader?.name || 'Monitoring', branding: profile.branding || null },
    });
};

/** GET / — reports, newest first. */
const listReports = async (req, res) => {
    const reports = await SubjectReport.find({})
        .select('-_id id title status error range_from range_to period_start period_end post_count created_at')
        .sort({ created_at: -1 }).limit(50).lean();
    res.json({ reports });
};

/** GET /:reportId */
const getReport = async (req, res) => {
    const report = await SubjectReport.findOne({ id: req.params.reportId }).select('-_id -__v').lean();
    if (!report) return res.status(404).json({ message: 'Report not found' });
    res.json({ report });
};

let generating = false;

/** POST / {from?, to?} — build a report for a period, in the background. */
const createReport = async (req, res) => {
    const from = parseDay(req.body?.from, false);
    const to = parseDay(req.body?.to, true);
    if (from === undefined || to === undefined) return res.status(400).json({ message: 'Invalid date' });
    if (from && to && from > to) return res.status(400).json({ message: '"From" must be before "To"' });
    if (generating) return res.status(409).json({ message: 'A report is already being generated' });
    const { profile, leader } = await loadProfile();
    const report = await SubjectReport.create({
        title: profile.subject_name || leader?.name || 'Monitoring report',
        status: 'generating', range_from: from, range_to: to, generated_by: userId(req),
    });
    generating = true;
    completeReport(report.id, { profile, leader, from, to })
        .catch((err) => console.error('[subjectReports] report failed:', err.message))
        .finally(() => { generating = false; });
    res.status(202).json({ report: { id: report.id, status: report.status, range_from: from, range_to: to } });
};

/** GET /posts/export?from&to[&tone&skip&limit] — the period's relevant posts (Excel and the PDF appendix). */
const exportPosts = async (req, res) => {
    const from = parseDay(req.query.from, false);
    const to = parseDay(req.query.to, true);
    if (from === undefined || to === undefined) return res.status(400).json({ message: 'Invalid date' });
    if (req.query.tone && !['positive', 'negative', 'neutral'].includes(req.query.tone)) return res.status(400).json({ message: 'Invalid tone' });
    const { profile, leader } = await loadProfile();
    let posts = (await loadPosts({ from, to }, subjectMatcher(profile, leader)))
        .filter((p) => p.analysis.status === 'done' && p.analysis.is_relevant);
    if (req.query.tone) posts = posts.filter((p) => tone(p) === req.query.tone);
    posts.sort((a, b) => (new Date(b.published_at || 0) - new Date(a.published_at || 0)) || String(b._id).localeCompare(String(a._id)));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit, 10) || 50000));
    res.json({
        posts: posts.slice(skip, skip + limit).map((p) => ({
            published_at: p.published_at,
            platform: p.platform,
            post_type: p.post_type,
            account: p.author_name,
            handle: p.author_handle,
            text: p.text,
            url: p.url,
            likes: p.metrics?.likes ?? null,
            comments: p.metrics?.comments ?? null,
            shares: p.metrics?.shares ?? null,
            views: p.metrics?.views ?? null,
            tone: tone(p),
            sentiment: p.analysis.sentiment,
            stance_toward_subject: p.analysis.stance_toward_subject,
            stance_toward_protest: p.analysis.stance_toward_protest,
            category: p.analysis.category,
            narratives: p.analysis.topic || '',
            target: p.analysis.target,
            risk_band: p.analysis.risk_band,
            summary: expand(p.analysis.summary),
            language: p.language,
            footage: footageOf(p),
            public_account: isPublicAccount(p),
        })),
    });
};

/**
 * POST /:reportId/pdf {posts?, format?} — queue the report as a PDF file: format
 * "presentation", "executive" or the detailed report (optionally with every post).
 */
const startReportPdf = async (req, res) => {
    const report = await SubjectReport.findOne({ id: req.params.reportId })
        .select('id title status range_from range_to period_start period_end').lean();
    if (!report) return res.status(404).json({ message: 'Report not found' });
    if (report.status !== 'ready') return res.status(409).json({ message: 'The report is not ready yet' });
    // The page is opened at this fixed address (never one taken from the request), signed in with the caller's token.
    const baseUrl = process.env.SUBJECT_REPORT_BASE_URL;
    if (!baseUrl) return res.status(503).json({ message: 'PDF download is not configured' });
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const presentation = req.body?.format === 'presentation';
    const executive = req.body?.format === 'executive';
    const withPosts = Boolean(req.body?.posts) && !presentation;
    const { profile, leader } = await loadProfile();
    const name = `${String(report.title || 'report').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')}`
        + `_${istDate(report.range_from || report.period_start) || 'start'}_to_${istDate(report.range_to || report.period_end) || 'latest'}`
        + `${executive ? '_executive' : ''}${presentation ? '_presentation' : ''}${withPosts ? '_with_posts' : ''}.pdf`;
    const job = startPdfJob({
        userId: userId(req), name,
        baseUrl: baseUrl.replace(/\/+$/, ''), token, report, subject: subjectMatcher(profile, leader), withPosts, executive, presentation,
    });
    res.status(202).json({ job: { id: job.id, status: job.status } });
};

/** GET /pdf-jobs/:jobId */
const getPdfJob = async (req, res) => {
    const job = getJob(userId(req), req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Download not found or expired' });
    res.json({ job: { id: job.id, status: job.status, error: job.error, name: job.name } });
};

/** GET /pdf-jobs/:jobId/file */
const downloadPdfJob = async (req, res) => {
    const job = getJob(userId(req), req.params.jobId);
    if (!job || job.status !== 'ready' || !job.file) return res.status(404).json({ message: 'Download not found or expired' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${job.name}"`, 'Cache-Control': 'no-store' });
    res.sendFile(job.file);
};

module.exports = {
    getProfile: wrap(getProfile),
    listReports: wrap(listReports),
    getReport: wrap(getReport),
    createReport: wrap(createReport),
    exportPosts: wrap(exportPosts),
    startReportPdf: wrap(startReportPdf),
    getPdfJob: wrap(getPdfJob),
    downloadPdfJob: wrap(downloadPdfJob),
};
