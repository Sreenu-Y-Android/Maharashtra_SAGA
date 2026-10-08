/**
 * viewOnlyPosts — logins that can see every post but must not delete posts or
 * change their sentiment / risk / stance, even though they are super-admins.
 *
 * The frontend hides the controls (lib/grievanceUiPermissions.js keeps the
 * same list); this is the server-side half, so the actions are refused even
 * when called directly. Must run after `protect`, which sets req.user.
 */
const VIEW_ONLY_POST_EMAILS = new Set(['maharashtra@blurasaga.com']);

const isViewOnlyForPosts = (user) => VIEW_ONLY_POST_EMAILS.has(String(user?.email || '').trim().toLowerCase());

const denyViewOnlyPostEdits = (req, res, next) => {
    if (isViewOnlyForPosts(req.user)) {
        return res.status(403).json({ message: 'This login is view-only for posts: delete and edit are disabled.' });
    }
    return next();
};

module.exports = { VIEW_ONLY_POST_EMAILS, isViewOnlyForPosts, denyViewOnlyPostEdits };
