/**
 * Renders a tenant workspace report's print view (/workspace/print/:id) to a
 * PDF with headless Chrome. The rendering itself (fresh Chrome per part,
 * memory waits, appendix slices, page numbers) is the Maharashtra monitoring
 * reports' (services/subjectReports/pdfService.js), and jobs run on its
 * one-at-a-time queue so the two never render at once on the shared server.
 *
 * Jobs are kept apart by tenant and user: a job is visible only to the user
 * of the tenant that queued it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const TenantEvent = require('../../models/tenant/TenantEvent');
const {
    enqueue, printPage, joinAndNumber, ensureMemory, APPENDIX_SLICE, MIN_FREE_MB_REPORT, MIN_FREE_MB_SLICE,
} = require('../subjectReports/pdfService');
const { toneCounts } = require('./tenantReportService');

const renderReportPdf = async ({ baseUrl, token, report, withPosts, executive = false, presentation = false }) => {
    const printUrl = (extra = '') => `${baseUrl}/workspace/print/${encodeURIComponent(report.id)}?pdf=1${extra}`;
    await ensureMemory(MIN_FREE_MB_REPORT);
    const format = presentation ? '&format=presentation' : executive ? '&format=executive' : '';
    const parts = [await printPage(printUrl(format), token, 120000)];

    if (withPosts) {
        const event = await TenantEvent.findOne({ tenant_id: report.tenant_id, id: report.event_id }).lean();
        if (!event) throw new Error('Event not found');
        const counts = await toneCounts(event, { from: report.range_from, to: report.range_to });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        let first = true;
        for (const tone of ['positive', 'negative', 'neutral']) {
            for (let skip = 0; skip < counts[tone]; skip += APPENDIX_SLICE) {
                await ensureMemory(MIN_FREE_MB_SLICE);
                const params = new URLSearchParams({
                    appendix: '1', tone, skip: String(skip), limit: String(APPENDIX_SLICE),
                    tone_total: String(counts[tone]), total: String(total), intro: first ? '1' : '0',
                });
                parts.push(await printPage(printUrl(`&${params}`), token, 180000));
                first = false;
            }
        }
    }
    // Slides carry their own numbers.
    return joinAndNumber(parts, { number: !presentation });
};

// ── Background jobs ──────────────────────────────────────────────────

const JOB_TTL_MS = 30 * 60000;
const jobs = new Map(); // id → { id, tenant_id, user_id, status, name, file, error, created_at }

const cleanupJobs = () => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
        if (job.created_at < cutoff && job.status !== 'running' && job.status !== 'queued') {
            if (job.file) fs.promises.unlink(job.file).catch(() => {});
            jobs.delete(id);
        }
    }
};

/** Queue a PDF render; returns the job (poll getJob, then read job.file when status is 'ready'). */
const startPdfJob = ({ tenantId, userId, name, ...opts }) => {
    cleanupJobs();
    const job = { id: crypto.randomUUID(), tenant_id: tenantId, user_id: userId, status: 'queued', name, file: null, error: null, created_at: Date.now() };
    jobs.set(job.id, job);
    enqueue(async () => {
        job.status = 'running';
        try {
            const pdf = await renderReportPdf(opts);
            job.file = path.join(os.tmpdir(), `tenant-pdf-${job.id}.pdf`);
            await fs.promises.writeFile(job.file, pdf);
            job.status = 'ready';
        } catch (err) {
            console.error('[tenant] PDF job failed:', err.message);
            job.status = 'failed';
            job.error = err.status ? err.message : 'Could not prepare the PDF';
        }
    });
    return job;
};

/** A job, only for the tenant user who created it. */
const getJob = (tenantId, userId, id) => {
    const job = jobs.get(id);
    return job && job.tenant_id === tenantId && job.user_id === userId ? job : null;
};

module.exports = { renderReportPdf, startPdfJob, getJob };
