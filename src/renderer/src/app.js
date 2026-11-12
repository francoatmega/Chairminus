import { el, invoke, IS_MAC } from './dom.js';
import { applyTheme } from './settings.js';
import { Welcome } from './welcome.js';
import { Workspace } from './workspace.js';

async function main() {
  // Lets the styles leave room for the macOS traffic lights, which sit over the page.
  document.documentElement.classList.add(IS_MAC ? 'mac' : 'not-mac');
  const params = new URLSearchParams(location.search);
  const [settings, appInfo] = await Promise.all([invoke('settings:get'), invoke('app:info')]);
  let theme = settings.theme;
  applyTheme(theme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(theme));
  window.bridge.on('settings:changed', (next) => {
    theme = next.theme;
    applyTheme(theme);
  });
  const root = document.getElementById('app');
  if (params.get('view') === 'workspace')
    window.app = new Workspace(root, { settings, appInfo, sqlFile: params.get('sql') });
  else window.app = new Welcome(root, { settings, appInfo });
}

main().catch((err) => {
  document.getElementById('app').append(el('pre.fatal', `Chairminus could not start:\n${err.stack || err.message}`));
});
