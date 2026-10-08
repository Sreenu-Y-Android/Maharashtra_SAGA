const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');
const c = require('../controllers/subjectReportController');

const router = express.Router();

// The Reports page (/intelligence-dashboard) owns these reports.
router.use(protect, requireAnyPageAccess(['/intelligence-dashboard', '/unified-reports']));

router.get('/profile', c.getProfile);
router.get('/posts/export', c.exportPosts);
router.get('/pdf-jobs/:jobId', c.getPdfJob);
router.get('/pdf-jobs/:jobId/file', c.downloadPdfJob);
router.get('/', c.listReports);
router.post('/', c.createReport);
router.get('/:reportId', c.getReport);
router.post('/:reportId/pdf', c.startReportPdf);

module.exports = router;
