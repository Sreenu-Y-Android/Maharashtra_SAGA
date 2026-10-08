import React, { useEffect, useState } from 'react';
import api from '../../lib/api';
import ReportsPanel from './ReportsPanel';

/**
 * "Monitoring Reports" tab of the Reports page: reports on the whole monitored
 * conversation for a period, measured toward the report subject (by default the
 * Deputy Chief Minister). Each report downloads as Presentation, Executive,
 * Detailed and Detailed + posts PDFs, or as Excel.
 */
const MonitoringReportsTab = () => {
  const [state, setState] = useState({ profile: null, workspace: null, error: null });

  useEffect(() => {
    api.get('/subject-reports/profile')
      .then(({ data }) => setState({ profile: data.profile, workspace: data.workspace, error: null }))
      .catch((err) => setState({ profile: null, workspace: null, error: err.response?.data?.message || 'Could not load the report settings' }));
  }, []);

  if (state.error) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{state.error}</div>;
  if (!state.profile) return <div className="py-16 text-center text-sm text-slate-500">Loading…</div>;
  const { subject, axis_label: axis } = state.profile;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        Reports cover every monitored post in the chosen period. Tone and stance are measured toward{' '}
        <b className="text-slate-900">{subject?.name}</b>{subject?.role ? `, ${subject.role}` : ''}, and toward {axis}.
      </div>
      <ReportsPanel workspace={state.workspace} />
    </div>
  );
};

export default MonitoringReportsTab;
