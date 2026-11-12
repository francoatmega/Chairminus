import { button, el, invoke, IS_MAC } from './dom.js';
import { checkbox, field, modal, select, toast } from './ui.js';
import { SAFE_MODES } from './safemode.js';

export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

let settingsOpen = false;

export async function openSettings(appInfo) {
  if (settingsOpen) return;
  settingsOpen = true;
  const settings = await invoke('settings:get');
  const save = async (patch) => {
    Object.assign(settings, patch);
    try {
      await invoke('settings:set', patch);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const numberInput = (key, min, max) =>
    el('input.input', {
      type: 'number',
      min,
      max,
      value: settings[key],
      onchange: (event) => {
        const number = Math.round(Number(event.target.value));
        if (number >= min && number <= max) save({ [key]: number });
        else event.target.value = settings[key];
      },
    });
  await modal(
    (close) =>
      el(
        'div.dialog.settings',
        el('h3', 'Settings'),
        el(
          'div.settings-body',
          el('h4', 'General'),
          field(
            'Appearance',
            select(
              [
                { value: 'auto', label: 'Match the system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ],
              settings.theme,
              (theme) => save({ theme }),
            ),
          ),
          el('h4', 'Security'),
          field(
            'Safe mode for new connections',
            select(
              SAFE_MODES.map((safeMode) => ({ value: safeMode.value, label: safeMode.label })),
              settings.defaultSafeMode,
              (value) => save({ defaultSafeMode: Number(value) }),
            ),
            'Alert modes ask for confirmation; Safe modes ask for the database password. Each connection can override this.',
          ),
          appInfo.touchId
            ? checkbox('Unlock Safe mode with Touch ID', settings.touchIdForSafeMode, (touchIdForSafeMode) =>
                save({ touchIdForSafeMode }),
              )
            : null,
          el(
            'p.muted',
            appInfo.encryption
              ? IS_MAC
                ? 'Passwords are encrypted with a key kept in the macOS Keychain.'
                : 'Passwords are encrypted with a key protected by your Windows account.'
              : 'Encrypted storage is not available on this system, so passwords cannot be saved.',
          ),
          el('h4', 'Tables'),
          field('Rows per page', numberInput('limitRows', 10, 100000)),
          field(
            'Estimate row counts above',
            numberInput('estimateThreshold', 0, 1000000000),
            'Bigger tables show the server’s estimate first; click the count for an exact number.',
          ),
          checkbox(
            'Log original values when updating or deleting rows',
            settings.logOriginalValues,
            (logOriginalValues) => save({ logOriginalValues }),
          ),
          el('h4', 'Query editor'),
          field(
            'Rows returned by a query',
            numberInput('limitQueryRows', 10, 1000000),
            'A result that is cut short offers to load everything.',
          ),
          field(
            'Variable syntax',
            select(
              [
                { value: 'colon', label: ':name' },
                { value: 'dollar', label: '${name}' },
                { value: 'braces', label: '{{name}}' },
              ],
              settings.variableFormat,
              (variableFormat) => save({ variableFormat }),
            ),
          ),
          checkbox('Look for variables inside quoted strings', settings.variablesInStrings, (variablesInStrings) =>
            save({ variablesInStrings }),
          ),
          checkbox('Upper-case keywords when formatting', settings.uppercaseKeywords, (uppercaseKeywords) =>
            save({ uppercaseKeywords }),
          ),
          field(
            'Indent',
            select(
              [
                { value: '  ', label: '2 spaces' },
                { value: '    ', label: '4 spaces' },
                { value: '\t', label: 'Tab' },
              ],
              settings.indent,
              (indent) => save({ indent }),
            ),
          ),
          el('h4', 'History'),
          field(
            'Keep query history for',
            select(
              [
                { value: 30, label: '1 month' },
                { value: 90, label: '3 months' },
                { value: 365, label: '1 year' },
                { value: 730, label: '2 years' },
                { value: 1095, label: '3 years' },
                { value: 0, label: 'Forever' },
              ],
              settings.historyRetentionDays,
              (value) => save({ historyRetentionDays: Number(value) }),
            ),
            'Older queries are removed the next time the app starts.',
          ),
          el('p.muted.about', `Chairminus ${appInfo.version} · data in ${appInfo.dataDir}`),
        ),
        el('div.dialog-buttons', button('Done', { primary: true, onclick: () => close() })),
      ),
    { width: 520 },
  );
  settingsOpen = false;
}
