export const GRIEVANCE_ADMIN_EMAIL = 'sreenu@gmail.com';

// Logins that see every post but may NOT delete posts or edit their sentiment /
// risk / stance — even as super-admins. The backend refuses the same actions
// for them (middleware/viewOnlyPosts.js keeps the same list).
export const VIEW_ONLY_POST_EMAILS = ['maharashtra@blurasaga.com'];

// Who can edit sentiment / delete grievances, alerts and RSS articles.
// The designated admin email OR any super-admin — so it works for every admin
// account on the server, not just one hardcoded address — except the
// view-only logins above.
export const canManageRestrictedGrievanceUi = (user) => {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (VIEW_ONLY_POST_EMAILS.includes(email)) return false;
  if (email === GRIEVANCE_ADMIN_EMAIL) return true;
  const role = String(user.role || '').trim().toLowerCase();
  return user.is_super_admin === true || role === 'superadmin' || role === 'super_admin';
};
