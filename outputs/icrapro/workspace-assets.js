// Classic scripts share the workspace state. Load definitions before the
// dashboard state and application entry point, which render the first page.
const workspaceScripts = [
  'profit-rules.js',
  'phone-format.js',
  'personnel.js',
  'settings.js',
  'workspace-audit.js',
  'workspace-search.js',
  'parking-fees.js',
  'document-types.js',
  'districts.js',
  'workspace-access.js',
  'workspace-communications.js',
  'workspace-reminders.js',
  'client-records.js',
  'document-records.js',
  'form-inputs.js',
  'borrower-sheet.js',
  'finance-operations.js',
  'workspace-accounting.js',
  'workspace-reports.js',
  'dashboard.js',
  'app.js',
];

if (typeof module !== 'undefined') module.exports = workspaceScripts;
