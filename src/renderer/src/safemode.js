import { button, el, invoke } from './dom.js';
import { modal, sqlDialog } from './ui.js';
import { isReadOnlyBatch, joinStatements } from '../../shared/tokenizer.js';

export const SAFE_MODES = [
  { value: 0, label: 'Silent', detail: 'Send queries without asking' },
  { value: 1, label: 'Alert — every query', detail: 'Confirm before sending any query' },
  {
    value: 2,
    label: 'Alert — writes only',
    detail: 'Confirm before sending anything that is not read-only (SELECT, EXPLAIN, SHOW and the like)',
  },
  { value: 3, label: 'Safe — every query', detail: 'Ask for the database password before any query' },
  {
    value: 4,
    label: 'Safe — writes only',
    detail: 'Ask for the password before anything that is not read-only (SELECT, EXPLAIN, SHOW and the like)',
  },
];

export function safeModeLabel(safeMode) {
  return (SAFE_MODES[safeMode] || SAFE_MODES[0]).label;
}

export async function confirmSend(ws, statements, options = {}) {
  const mode = Number(ws.info.safeMode) || 0;
  if (mode === 0 || !statements.length) return true;
  const readOnly = isReadOnlyBatch(statements, ws.info.dialect);
  if ((mode === 2 || mode === 4) && readOnly) return true;
  const sql = joinStatements(statements, ws.info.dialect);
  return (mode === 3 || mode === 4) && ws.info.dialect !== 'sqlite'
    ? ws.settings.touchIdForSafeMode &&
      ws.appInfo.touchId &&
      (await invoke('session:touchId', `send statements to “${ws.info.name}”`))
      ? true
      : askPassword(ws, sql)
    : options.confirmed
      ? true
      : sqlDialog({
          title: 'Send to the server?',
          message: `Are you sure you want to send ${statements.length === 1 ? 'this statement' : 'these statements'} to “${ws.info.name}”?`,
          sql,
          confirmLabel: 'Send',
        });
}

function askPassword(ws, sql) {
  return modal(
    (close) => {
      const input = el('input.input', { type: 'password', autofocus: true, placeholder: 'Database password' });
      const fieldError = el('div.field-error');
      const submit = async () => {
        if (await invoke('session:verifyPassword', input.value)) close(true);
        else {
          fieldError.textContent = 'Incorrect password';
          input.select();
        }
      };
      return el(
        'div.dialog',
        el('h3', 'Safe mode'),
        el('p.dialog-text', `Enter the database password for “${ws.info.name}” to confirm this action.`),
        el('pre.sql-preview', sql),
        input,
        fieldError,
        el(
          'div.dialog-buttons',
          button('Cancel', { onclick: () => close(false) }),
          button('Confirm', { primary: true, onclick: submit }),
        ),
      );
    },
    { width: 600 },
  ).then((result) => result === true);
}
