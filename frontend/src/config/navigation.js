/**
 * The application's navigation — ONE definition, used by both the sidebar and
 * the Chief Minister's brief.
 *
 * These lists had drifted apart: the brief built its own set from the API's
 * module list, which pointed several entries at the same page (Mentions and
 * Grievance Resolution both to /grievances; Overview, Leader Tracking and
 * Amplifier Analysis all to /dashboard) and included two pages the sidebar had
 * commented out. Keeping one array means a page added or removed here shows up
 * in both places, and cannot be listed twice.
 *
 * `colour` is used by the brief's pills. The sidebar ignores it.
 */
import {
  Globe, Gauge, MessageSquare, Newspaper,
  AlertTriangle, BarChart3, CalendarDays, Settings,
} from 'lucide-react';

// The state map and Geo Intel pages are hidden in this deployment: their map,
// district and MLA data (src/data, public/*.geojson) still describe
// Chhattisgarh. Restore the two entries once Maharashtra data is in place.
export const APP_NAVIGATION = [
  { name: 'Intelligence Brief', href: '/cm-dashboard', icon: Gauge, colour: '#4f46e5' },
  // Overview hidden in this deployment (/dashboard redirects to the Intelligence Brief).
  // { name: 'Overview', href: '/dashboard', icon: LayoutDashboard, colour: '#4f46e5' },
  { name: 'Mentions', href: '/grievances', icon: MessageSquare, colour: '#2563eb' },
  { name: 'Web Articles', href: '/public-web-articles', icon: Newspaper, colour: '#7c3aed' },
  { name: 'Alerts', href: '/alerts', icon: AlertTriangle, colour: '#dc2626' },
  { name: 'Reports', href: '/intelligence-dashboard', icon: BarChart3, colour: '#b45309' },
  // AI Campaigns hidden in this deployment (page still exists at /ai-suggestions).
  // { name: 'AI Campaigns', href: '/ai-suggestions', icon: Sparkles, colour: '#c026d3' },
  { name: 'Events', href: '/events', icon: CalendarDays, colour: '#ea580c' },
  { name: 'Search', href: '/global-search', icon: Globe, colour: '#475569' },
  { name: 'Settings', href: '/settings', icon: Settings, colour: '#475569' },
];

export default APP_NAVIGATION;
