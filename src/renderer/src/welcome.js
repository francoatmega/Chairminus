import { button, el, formatDuration, fuzzyScore, icon, invoke, IS_MAC, keys, setChildren } from './dom.js';
import {
  checkbox,
  confirmDialog,
  field,
  modal,
  promptDialog,
  select,
  showError,
  showMenu,
  showMenuBelow,
  toast,
} from './ui.js';
import { SAFE_MODES, safeModeLabel } from './safemode.js';
import { openSettings } from './settings.js';
import { LOGO_SVG } from '../../shared/logo.js';

const DRIVERS = [
  { value: 'postgres', label: 'PostgreSQL', short: 'Pg', port: 5432, color: '#336791' },
  { value: 'mysql', label: 'MySQL', short: 'My', port: 3306, color: '#e48e00' },
  { value: 'mariadb', label: 'MariaDB', short: 'Ma', port: 3306, color: '#8b5a2b' },
  { value: 'sqlite', label: 'SQLite', short: 'Sl', port: null, color: '#0f80cc' },
  { value: 'mongodb', label: 'MongoDB', short: 'Mg', port: 27017, color: '#3f9142' },
  { value: 'redis', label: 'Redis', short: 'Rd', port: 6379, color: '#c0392b' },
  { value: 'elasticsearch', label: 'Elasticsearch', short: 'Es', port: 9200, color: '#0b9e9a' },
  { value: 'opensearch', label: 'OpenSearch', short: 'Os', port: 9200, color: '#1f5fa8' },
  { value: 'neo4j', label: 'Neo4j', short: 'N4', port: 7687, color: '#2f7fd6' },
];

const SEARCH_DRIVERS = ['elasticsearch', 'opensearch'];

const DRIVER_HINTS = {
  postgres: { database: 'defaults to the user name' },
  mongodb: { database: 'defaults to test', startup: 'Optional statements, e.g.  db.runCommand({ ping: 1 })' },
  redis: {
    database: 'a number — defaults to 0',
    user: 'optional (ACL user)',
    startup: 'Optional commands, one per line, e.g.  CLIENT SETNAME reports',
  },
  elasticsearch: {
    user: 'empty when the password is an API key',
    password: 'Password or API key',
    startup: 'Optional requests, e.g.  GET /_cluster/health',
  },
  opensearch: {
    user: 'empty when the password is an API key',
    password: 'Password or API key',
    startup: 'Optional requests, e.g.  GET /_cluster/health',
  },
  neo4j: { database: 'defaults to the home database', startup: 'Optional Cypher, e.g.  RETURN 1;' },
};

const DRIVER_BY_ID = Object.fromEntries(DRIVERS.map((driver) => [driver.value, driver]));

const ENVIRONMENTS = [
  { value: '', label: 'None', color: '' },
  { value: 'local', label: 'Local', color: '#6b7280' },
  { value: 'development', label: 'Development', color: '#16a34a' },
  { value: 'testing', label: 'Testing', color: '#2563eb' },
  { value: 'staging', label: 'Staging', color: '#d97706' },
  { value: 'production', label: 'Production', color: '#dc2626' },
];

const SSL_MODES = [
  { value: 'disable', label: 'Disabled' },
  { value: 'prefer', label: 'Preferred (use TLS when the server offers it)' },
  { value: 'require', label: 'Required (no certificate check)' },
  { value: 'verify-ca', label: 'Verify CA' },
  { value: 'verify-full', label: 'Verify CA and host name' },
];

function connectionSubtitle(connection) {
  if (connection.driver === 'sqlite') return connection.path || '';
  const ssh = connection.ssh && connection.ssh.enabled ? `  ·  SSH ${connection.ssh.host}` : '';
  return `${connection.user ? connection.user + '@' : ''}${connection.host || 'localhost'}${connection.port ? ':' + connection.port : ''}${connection.database ? '/' + connection.database : ''}${ssh}`;
}

function urlScheme(connection) {
  const tls = connection.sslMode && connection.sslMode !== 'disable' && connection.sslMode !== 'prefer';
  switch (connection.driver) {
    case 'postgres':
      return 'postgresql';
    case 'mongodb':
      return connection.srv ? 'mongodb+srv' : 'mongodb';
    case 'redis':
      return tls ? 'rediss' : 'redis';
    case 'elasticsearch':
    case 'opensearch':
      return tls ? 'https' : 'http';
    case 'neo4j':
      return (
        (connection.scheme === 'neo4j' ? 'neo4j' : 'bolt') +
        (tls ? (connection.sslMode === 'require' ? '+ssc' : '+s') : '')
      );
    default:
      return connection.driver;
  }
}

function connectionUrl(connection) {
  if (connection.driver === 'sqlite') return `sqlite://${connection.path}`;
  const scheme = urlScheme(connection);
  const auth = connection.user ? encodeURIComponent(connection.user) + '@' : '';
  const port =
    connection.driver === 'mongodb' && connection.srv
      ? ''
      : `:${connection.port || DRIVER_BY_ID[connection.driver].port}`;
  const database = SEARCH_DRIVERS.includes(connection.driver)
    ? ''
    : `/${encodeURIComponent(connection.database || '')}`;
  const query =
    connection.driver === 'mongodb'
      ? [
          connection.authSource ? `authSource=${encodeURIComponent(connection.authSource)}` : '',
          connection.options || '',
        ]
          .filter(Boolean)
          .join('&')
      : '';
  const rest = `${auth}${connection.host || 'localhost'}${port}${database}${query ? '?' + query : ''}`;
  return connection.ssh && connection.ssh.enabled
    ? `${scheme}+ssh://${connection.ssh.user ? encodeURIComponent(connection.ssh.user) + '@' : ''}${connection.ssh.host}:${connection.ssh.port || 22}/${rest}`
    : `${scheme}://${rest}`;
}

const TABS = [
  { id: 'connections', label: 'Connections', icon: 'db', search: 'Search for connection…' },
  { id: 'favorites', label: 'Favorites', icon: 'star', search: 'Search favorites…' },
  { id: 'history', label: 'History', icon: 'history', search: 'Search query history…' },
  { id: 'snippets', label: 'Snippets', icon: 'sql', search: 'Search snippets…' },
];

const RECENT_LIMIT = 6;

function timeAgo(ts) {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

function connectionColor(connection) {
  return connection.color || (DRIVER_BY_ID[connection.driver] || DRIVERS[0]).color;
}

export class Welcome {
  constructor(root, { settings, appInfo }) {
    this.settings = settings;
    this.appInfo = appInfo;
    this.connections = [];
    this.search = '';
    this.selected = null;
    this.collapsed = new Set();
    this.tab = 'connections';
    this.sideCollapsed = new Set();
    this.historyRows = [];
    this.snippets = [];

    const brandLogo = el('div.home-logo');
    brandLogo.innerHTML = LOGO_SVG;
    this.sideLists = el('div.home-side-lists');
    this.tabBar = el('nav.home-tabs');
    this.list = el('div.home-body', { tabIndex: 0 });
    this.searchInput = el('input.home-search-input', { spellcheck: false });
    this.el = el(
      'div.home',
      el(
        'aside.home-side',
        el('div.home-brand', brandLogo, el('span.home-name', 'Chairminus')),
        button('New Connection', { icon: 'plus', primary: true, onclick: () => this.edit(null) }),
        this.sideLists,
        el(
          'div.home-side-foot',
          el('button.home-side-link', { type: 'button', onclick: () => this.fromUrl() }, icon('link'), 'New from URL…'),
          el('button.home-side-link', { type: 'button', onclick: () => this.openFile() }, icon('folder'), 'Open SQLite file…'),
          el('div.home-side-version', `Version ${appInfo.version}`),
        ),
      ),
      el(
        'main.home-main',
        el(
          'header.home-bar',
          this.tabBar,
          el('div.spacer'),
          el(
            'label.home-search',
            icon('search', 13),
            this.searchInput,
            el('span.home-search-key', IS_MAC ? '⌘K' : 'Ctrl K'),
          ),
          button('', {
            icon: 'chevronDown',
            small: true,
            title: 'Import or export connections',
            onclick: (event) =>
              showMenuBelow(event.currentTarget, [
                { label: 'Import Connections…', onclick: () => this.importConnections() },
                {
                  label: 'Export Connections…',
                  disabled: !this.connections.length,
                  onclick: () => this.exportConnections(),
                },
              ]),
          }),
          button('', { icon: 'gear', small: true, title: keys('Settings (⌘,)'), onclick: () => openSettings(appInfo) }),
        ),
        this.list,
      ),
    );
    root.append(this.el);
    this.searchInput.addEventListener('input', () => {
      this.search = this.searchInput.value;
      this.render();
    });
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.searchInput.value) {
        this.searchInput.value = this.search = '';
        this.render();
      } else if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) this.onKey(event);
    });
    this.list.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('keydown', (event) => {
      if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('.overlay')) {
        event.preventDefault();
        this.searchInput.focus();
        this.searchInput.select();
      }
    });
    window.bridge.on('connections:changed', () => this.load());
    window.bridge.on('menu', (action) => {
      if (action === 'settings') openSettings(appInfo);
      else if (action === 'close-tab' && !document.querySelector('.overlay')) window.close();
    });
    window.bridge.on('settings:changed', (settings) => {
      this.settings = settings;
    });
    window.addEventListener('focus', () => {
      if (this.tab === 'history' || this.tab === 'snippets') this.loadTab();
    });
    this.renderTabs();
    this.load();
  }

  async load() {
    try {
      this.connections = await invoke('conn:list');
    } catch (err) {
      showError(err);
    }
    this.renderSide();
    this.render();
  }

  setTab(tab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.searchInput.value = this.search = '';
    this.renderTabs();
    this.loadTab();
  }

  // History and snippets live outside the connection list and are read when their tab opens.
  async loadTab() {
    try {
      if (this.tab === 'history') this.historyRows = await invoke('history:recent', '', 300);
      else if (this.tab === 'snippets') this.snippets = await invoke('favorites:list');
    } catch (err) {
      showError(err);
    }
    this.render();
  }

  renderTabs() {
    const tab = TABS.find((t) => t.id === this.tab);
    this.searchInput.placeholder = tab.search;
    setChildren(
      this.tabBar,
      TABS.map((t) =>
        el(
          'button.home-tab',
          { type: 'button', title: t.label, class: t.id === this.tab ? 'active' : '', onclick: () => this.setTab(t.id) },
          icon(t.icon, 14),
          el('span.home-tab-label', t.label),
        ),
      ),
    );
  }

  renderSide() {
    const section = (name, iconName, items, emptyText) => {
      const closed = this.sideCollapsed.has(name);
      return el(
        'section.home-side-section',
        el(
          'button.home-side-head',
          {
            type: 'button',
            class: closed ? 'closed' : '',
            onclick: () => {
              if (closed) this.sideCollapsed.delete(name);
              else this.sideCollapsed.add(name);
              this.renderSide();
            },
          },
          icon(iconName, 14),
          el('span', name),
          el('span.spacer'),
          icon('chevronDown', 10),
        ),
        closed
          ? null
          : items.length
            ? items.map((connection) =>
                el(
                  'button.home-side-item',
                  {
                    type: 'button',
                    title: `${connection.name}\n${connectionSubtitle(connection)}`,
                    onclick: () => this.open(connection),
                    oncontextmenu: (event) => this.menu(event, connection),
                  },
                  el('span.home-dot', { style: `background: ${connectionColor(connection)}` }),
                  el('span.home-side-name', connection.name),
                ),
              )
            : el('div.home-side-empty', emptyText),
      );
    };
    const favorites = this.connections
      .filter((connection) => connection.favorite)
      .sort((a, b) => a.name.localeCompare(b.name));
    const recents = this.connections
      .filter((connection) => connection.lastOpenedAt)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, RECENT_LIMIT);
    setChildren(
      this.sideLists,
      section('Favorites', 'star', favorites, 'Star a connection to pin it here'),
      section('Recents', 'history', recents, 'Connections you open show up here'),
    );
  }

  visible(connections = this.connections) {
    const query = this.search.trim();
    return connections
      .map((connection) => ({
        c: connection,
        score: query
          ? Math.max(
              fuzzyScore(query, connection.name),
              fuzzyScore(query, connectionSubtitle(connection)),
              fuzzyScore(query, connection.group || ''),
            )
          : 0,
      }))
      .filter((scored) => scored.score >= 0)
      .sort((first, second) =>
        query
          ? second.score - first.score
          : (first.c.group || '').localeCompare(second.c.group || '') || first.c.name.localeCompare(second.c.name),
      )
      .map((scored) => scored.c);
  }

  hero() {
    const logo = el('div.home-hero-logo');
    logo.innerHTML = LOGO_SVG;
    return el(
      'div.home-hero',
      logo,
      el('h1', 'Welcome to Chairminus'),
      el('p', 'Browse, query and edit your databases, from PostgreSQL to Neo4j, in one place.'),
      button('Create a new connection', { icon: 'plus', primary: true, onclick: () => this.edit(null) }),
    );
  }

  // With no connections yet, every engine gets a chip that starts the form with it already chosen.
  engines() {
    return el(
      'div.home-engines',
      DRIVERS.map((driver) =>
        el(
          'button.home-engine',
          {
            type: 'button',
            style: `--engine: ${driver.color}`,
            onclick: () => this.edit(null, { driver: driver.value, port: driver.port }),
          },
          el('span.home-engine-mark', driver.short),
          el('span', driver.label),
        ),
      ),
    );
  }

  card(connection) {
    const driver = DRIVER_BY_ID[connection.driver] || DRIVERS[0];
    return el(
      'div.home-card',
      {
        class: connection.id === this.selected ? 'selected' : '',
        style: `--engine: ${driver.color}`,
        dataset: { id: connection.id },
        onclick: () => {
          this.selected = connection.id;
          this.paintSelection();
        },
        ondblclick: () => this.open(connection),
        oncontextmenu: (event) => {
          this.selected = connection.id;
          this.paintSelection();
          this.menu(event, connection);
        },
      },
      el(
        'div.home-card-head',
        el('span.home-card-engine', driver.label),
        connection.environment
          ? el('span.env-tag', { style: { background: connection.color || 'var(--accent)' } }, connection.environment)
          : null,
        Number(connection.safeMode)
          ? el('span.safe-tag', { title: safeModeLabel(Number(connection.safeMode)) }, icon('lock', 10))
          : null,
        el(
          'button.home-star',
          {
            type: 'button',
            class: connection.favorite ? 'on' : '',
            title: connection.favorite ? 'Remove from favorites' : 'Add to favorites',
            onclick: (event) => {
              event.stopPropagation();
              this.toggleFavorite(connection);
            },
            ondblclick: (event) => event.stopPropagation(),
          },
          icon('star', 13),
        ),
      ),
      el('div.home-card-name', { title: connection.name }, connection.name),
      el('div.home-card-sub', { title: connectionSubtitle(connection) }, connectionSubtitle(connection)),
      el(
        'div.home-card-actions',
        button('Connect', {
          small: true,
          primary: true,
          onclick: (event) => {
            event.stopPropagation();
            this.open(connection);
          },
        }),
        button('', {
          icon: 'chevronDown',
          small: true,
          title: 'More actions',
          onclick: (event) => {
            event.stopPropagation();
            this.selected = connection.id;
            this.paintSelection();
            showMenuBelow(event.currentTarget, this.menuItems(connection));
          },
        }),
      ),
    );
  }

  toggleFavorite(connection) {
    invoke('conn:setFavorite', connection.id, !connection.favorite).catch(showError);
  }

  render() {
    if (this.tab === 'history') return this.renderHistory();
    if (this.tab === 'snippets') return this.renderSnippets();
    const favoritesOnly = this.tab === 'favorites';
    const pool = favoritesOnly ? this.connections.filter((connection) => connection.favorite) : this.connections;
    const visible = this.visible(pool);
    const searching = !!this.search.trim();
    if (!this.connections.length) {
      setChildren(this.list, this.hero(), el('h2.home-heading', 'Start with an engine'), this.engines());
      return;
    }
    if (favoritesOnly && !pool.length) {
      setChildren(
        this.list,
        this.empty('star', 'No favorites yet', 'Use the star on a connection card to keep it here and in the sidebar.'),
      );
      return;
    }
    const head = favoritesOnly || searching ? [] : [this.hero()];
    if (!visible.length) {
      setChildren(this.list, head, this.empty('search', `Nothing matches “${this.search.trim()}”`));
      return;
    }
    if (!visible.some((conn) => conn.id === this.selected)) this.selected = visible[0].id;
    const grouped = !searching && visible.some((conn) => conn.group);
    if (!grouped) {
      setChildren(
        this.list,
        head,
        el('h2.home-heading', favoritesOnly ? 'Favorites' : searching ? 'Results' : 'All connections', el('span.home-count', String(visible.length))),
        el('div.home-grid', visible.map((connection) => this.card(connection))),
      );
      return;
    }
    const sections = [];
    for (const connection of visible) {
      const name = connection.group || 'Ungrouped';
      if (!sections.length || sections[sections.length - 1].name !== name) sections.push({ name, items: [] });
      sections[sections.length - 1].items.push(connection);
    }
    setChildren(
      this.list,
      head,
      sections.map(({ name, items }) => {
        const collapsed = this.collapsed.has(name);
        return el(
          'section.home-section',
          el(
            'button.home-heading.home-section-head',
            {
              type: 'button',
              class: collapsed ? 'closed' : '',
              onclick: () => {
                if (collapsed) this.collapsed.delete(name);
                else this.collapsed.add(name);
                this.render();
              },
            },
            icon('chevronDown', 10),
            el('span', name),
            el('span.home-count', String(items.length)),
          ),
          collapsed ? null : el('div.home-grid', items.map((connection) => this.card(connection))),
        );
      }),
    );
  }

  empty(iconName, title, text) {
    return el('div.home-empty', el('div.big-icon', icon(iconName, 34)), el('h3', title), text ? el('p.muted', text) : null);
  }

  renderHistory() {
    const needle = this.search.trim().toLowerCase();
    const byId = Object.fromEntries(this.connections.map((connection) => [connection.id, connection]));
    const rows = this.historyRows.filter(
      (entry) =>
        byId[entry.connId] &&
        (!needle || entry.sql.toLowerCase().includes(needle) || byId[entry.connId].name.toLowerCase().includes(needle)),
    );
    if (!rows.length) {
      setChildren(
        this.list,
        needle
          ? this.empty('search', `Nothing matches “${this.search.trim()}”`)
          : this.empty('history', 'No queries yet', 'Queries you run in any connection are listed here.'),
      );
      return;
    }
    setChildren(
      this.list,
      el('h2.home-heading', 'Recent queries', el('span.home-count', String(rows.length))),
      el(
        'div.home-rows',
        rows.map((entry) => {
          const connection = byId[entry.connId];
          return el(
            'div.home-row',
            { title: entry.error || '' },
            el('span.home-dot', { style: `background: ${entry.ok === false ? 'var(--danger)' : 'var(--ok)'}` }),
            el(
              'div.home-row-text',
              el('div.home-row-code', entry.sql.replace(/\s+/g, ' ').trim()),
              el(
                'div.home-row-meta',
                el('span.home-row-conn', { style: `--engine: ${connectionColor(connection)}` }, connection.name),
                entry.db ? ` · ${entry.db}` : '',
                ` · ${timeAgo(entry.ts)}`,
                entry.ms != null ? ` · ${formatDuration(entry.ms)}` : '',
              ),
            ),
            el(
              'div.home-row-actions',
              button('Copy', { small: true, onclick: () => this.copy(entry.sql) }),
              button('Connect', { small: true, onclick: () => this.open(connection) }),
            ),
          );
        }),
      ),
    );
  }

  renderSnippets() {
    const needle = this.search.trim().toLowerCase();
    const rows = this.snippets
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.sql.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) {
      setChildren(
        this.list,
        needle
          ? this.empty('search', `Nothing matches “${this.search.trim()}”`)
          : this.empty('sql', 'No snippets yet', 'Save a query as a favorite in the query editor and it shows up here.'),
      );
      return;
    }
    setChildren(
      this.list,
      el('h2.home-heading', 'Snippets', el('span.home-count', String(rows.length))),
      el(
        'div.home-rows',
        rows.map((snippet) =>
          el(
            'div.home-row',
            el('span.home-row-icon', icon('sql', 14)),
            el(
              'div.home-row-text',
              el('div.home-row-title', snippet.name),
              el('div.home-row-code', snippet.sql.replace(/\s+/g, ' ').trim()),
            ),
            el(
              'div.home-row-actions',
              button('Copy', { small: true, onclick: () => this.copy(snippet.sql) }),
              button('', {
                icon: 'trash',
                small: true,
                title: 'Delete snippet',
                onclick: async () => {
                  if (
                    await confirmDialog({
                      title: `Delete “${snippet.name}”?`,
                      message: 'The saved query is removed from every connection.',
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    await invoke('favorites:delete', snippet.id).catch(showError);
                    this.loadTab();
                  }
                },
              }),
            ),
          ),
        ),
      ),
    );
  }

  copy(text) {
    invoke('clipboard:write', text);
    toast('Copied to the clipboard');
  }

  paintSelection() {
    for (const item of this.list.querySelectorAll('.home-card'))
      item.classList.toggle('selected', item.dataset.id === this.selected);
  }

  onKey(event) {
    if (this.tab === 'history' || this.tab === 'snippets') return;
    const cards = [...this.list.querySelectorAll('.home-card')];
    const at = cards.findIndex((card) => card.dataset.id === this.selected);
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 'up', ArrowDown: 'down' };
    if (event.key in moves && (event.target === this.list || event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (!cards.length) return;
      const from = Math.max(0, at);
      let target = from;
      const move = moves[event.key];
      if (typeof move === 'number') target = from + move;
      else {
        // Up/down jumps to the card closest in x on the previous or next row.
        const here = cards[from].getBoundingClientRect();
        const candidates = cards
          .map((card, i) => ({ i, box: card.getBoundingClientRect() }))
          .filter(({ box }) => (move === 'down' ? box.top > here.top + 1 : box.top < here.top - 1));
        if (candidates.length) {
          const rowTop =
            move === 'down'
              ? Math.min(...candidates.map(({ box }) => box.top))
              : Math.max(...candidates.map(({ box }) => box.top));
          const row = candidates.filter(({ box }) => Math.abs(box.top - rowTop) < 1);
          target = row.reduce((best, c) =>
            Math.abs(c.box.left - here.left) < Math.abs(best.box.left - here.left) ? c : best,
          ).i;
        }
      }
      const next = cards[Math.max(0, Math.min(cards.length - 1, target))];
      this.selected = next.dataset.id;
      this.paintSelection();
      next.scrollIntoView({ block: 'nearest' });
      return;
    }
    const connection = at === -1 ? null : this.connections.find((conn) => conn.id === this.selected);
    if (event.key === 'Enter' && connection) {
      event.preventDefault();
      this.open(connection);
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && event.target === this.list && connection)
      this.remove(connection);
  }

  open(connection) {
    invoke('workspace:open', connection.id).catch(showError);
  }

  menu(event, connection) {
    showMenu(event, this.menuItems(connection));
  }

  menuItems(connection) {
    return [
      { label: 'Connect', onclick: () => this.open(connection) },
      { label: 'Edit…', onclick: () => this.edit(connection) },
      { label: 'Duplicate', onclick: () => invoke('conn:duplicate', connection.id).catch(showError) },
      {
        label: 'Copy as URL',
        onclick: () => {
          invoke('clipboard:write', connectionUrl(connection));
          toast('URL copied (without the password)');
        },
      },
      '-',
      { label: 'Delete…', danger: true, onclick: () => this.remove(connection) },
    ];
  }

  async remove(connection) {
    if (
      await confirmDialog({
        title: `Delete “${connection.name}”?`,
        message:
          'The connection, its saved passwords and its query history are removed. The database itself is not touched.',
        confirmLabel: 'Delete',
        danger: true,
      })
    )
      invoke('conn:delete', connection.id).catch(showError);
  }

  async fromUrl() {
    let parsed;
    if (!(
      !(await promptDialog({
        title: 'New connection from URL',
        placeholder: 'postgresql://user:password@host:5432/database',
        confirmLabel: 'Continue',
        message:
          'PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, Redis, Neo4j and Elasticsearch / OpenSearch (http, https) URLs are understood, including the +ssh form.',
        validate: async (url) => {
          try {
            parsed = await invoke('conn:parseUrl', url);
            return null;
          } catch (err) {
            return err.message;
          }
        },
      })) || !parsed
    ))
      this.edit(null, parsed.connection, { password: parsed.password, sshPassword: parsed.sshPassword });
  }

  async openFile() {
    const file = await invoke('dialog:open', {
      filters: [
        { name: 'SQLite databases', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (file) invoke('workspace:openFile', file).catch(showError);
  }

  async importConnections() {
    const file = await invoke('dialog:open', { filters: [{ name: 'Chairminus connections', extensions: ['json'] }] });
    if (file)
      try {
        toast(`${await invoke('conn:import', file)} connections imported — passwords are not part of the file`);
      } catch (err) {
        showError(err);
      }
  }

  async exportConnections() {
    const file = await invoke('dialog:save', {
      defaultPath: 'chairminus-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (file)
      try {
        toast(`${await invoke('conn:export', file)} connections exported, without passwords`);
      } catch (err) {
        showError(err);
      }
  }

  edit(existing, preset = {}, presetSecrets = {}) {
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          driver: 'postgres',
          name: '',
          host: 'localhost',
          port: 5432,
          user: '',
          database: '',
          passwordMode: 'store',
          sslMode: 'prefer',
          safeMode: this.settings.defaultSafeMode || 0,
          environment: '',
          group: '',
          ...preset,
        };
    draft.ssh = { enabled: false, host: '', port: 22, user: '', auth: 'password', keyPath: '', ...(draft.ssh || {}) };
    const entered = { ...presetSecrets };
    const groups = [...new Set(this.connections.map((connection) => connection.group).filter(Boolean))];
    return modal(
      (close) => {
        const connForm = el('div.conn-form');
        const formStatus = el('div.form-status');
        const textInput = (key, opts = {}) =>
          el('input.input', {
            value: (opts.obj || draft)[key] ?? '',
            placeholder: opts.placeholder || '',
            spellcheck: false,
            type: opts.type || 'text',
            oninput: (event) => {
              (opts.obj || draft)[key] = opts.number
                ? event.target.value === ''
                  ? ''
                  : Number(event.target.value)
                : event.target.value;
            },
          });
        const secretInput = (key, isSaved, hint) =>
          el('input.input', {
            type: 'password',
            value: entered[key] ?? '',
            placeholder: isSaved ? '•••••••• (saved — type to replace)' : hint || '',
            oninput: (event) => {
              entered[key] = event.target.value;
            },
          });
        const filePicker = (key, obj, filters) => {
          const input = textInput(key, { obj, placeholder: 'Choose a file…' });
          return el(
            'div.file-pick',
            input,
            button('Choose…', {
              small: true,
              onclick: async () => {
                const chosen = await invoke('dialog:open', { filters, properties: ['openFile', 'showHiddenFiles'] });
                if (chosen) {
                  obj[key] = chosen;
                  input.value = chosen;
                }
              },
            }),
          );
        };
        const render = () => {
          const isSqlite = draft.driver === 'sqlite';
          const hints = DRIVER_HINTS[draft.driver] || {};
          const A = draft.driver === 'mongodb' && draft.srv;
          const rows = [
            el(
              'div.form-row',
              field('Name', textInput('name', { placeholder: 'My database' })),
              field(
                'Type',
                select(DRIVERS, draft.driver, (driver) => {
                  const previous = DRIVER_BY_ID[draft.driver];
                  draft.driver = driver;
                  if (DRIVER_BY_ID[driver].port && (!draft.port || draft.port === (previous && previous.port)))
                    draft.port = DRIVER_BY_ID[driver].port;
                  render();
                }),
              ),
            ),
            el(
              'div.form-row',
              field(
                'Group',
                el('input.input', {
                  value: draft.group || '',
                  placeholder: 'Optional',
                  list: 'conn-groups',
                  oninput: (event) => {
                    draft.group = event.target.value;
                  },
                }),
              ),
              field(
                'Environment',
                select(ENVIRONMENTS, draft.environment || '', (environment) => {
                  draft.environment = environment;
                  draft.color = ENVIRONMENTS.find((env) => env.value === environment).color;
                }),
              ),
              field(
                'Safe mode',
                select(
                  SAFE_MODES.map((safeMode) => ({ value: safeMode.value, label: safeMode.label })),
                  Number(draft.safeMode) || 0,
                  (value) => {
                    draft.safeMode = Number(value);
                    render();
                  },
                ),
              ),
            ),
            Number(draft.safeMode) ? el('p.field-hint.block', SAFE_MODES[Number(draft.safeMode)].detail + '.') : null,
            el(
              'datalist',
              { id: 'conn-groups' },
              groups.map((group) => el('option', { value: group })),
            ),
            el('div.form-sep'),
          ];
          if (isSqlite) {
            const pathInput = textInput('path', { placeholder: '/path/to/database.sqlite' });
            rows.push(
              field(
                'Database file',
                el(
                  'div.file-pick',
                  pathInput,
                  button('Choose…', {
                    small: true,
                    onclick: async () => {
                      const path = await invoke('dialog:open', {
                        filters: [
                          { name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
                          { name: 'All files', extensions: ['*'] },
                        ],
                      });
                      if (path) {
                        draft.path = path;
                        draft.create = false;
                        pathInput.value = path;
                        if (!draft.name) {
                          draft.name = path.split('/').pop();
                          render();
                        }
                      }
                    },
                  }),
                  button('New…', {
                    small: true,
                    title: 'Create an empty database file',
                    onclick: async () => {
                      const path = await invoke('dialog:save', { defaultPath: 'database.sqlite' });
                      if (path) {
                        draft.path = path;
                        draft.create = true;
                        pathInput.value = path;
                        if (!draft.name) {
                          draft.name = path.split('/').pop();
                          render();
                        }
                      }
                    },
                  }),
                ),
              ),
              checkbox('Open read-only', draft.readOnly, (readOnly) => {
                draft.readOnly = readOnly;
              }),
            );
          } else {
            rows.push(
              el(
                'div.form-row',
                field('Host', textInput('host', { placeholder: A ? 'cluster0.example.mongodb.net' : 'localhost' })),
                A ? null : el('div.narrow', field('Port', textInput('port', { number: true, type: 'number' }))),
              ),
              el(
                'div.form-row',
                field('User', textInput('user', { placeholder: hints.user || '' })),
                SEARCH_DRIVERS.includes(draft.driver)
                  ? null
                  : field('Database', textInput('database', { placeholder: hints.database || 'optional' })),
              ),
              draft.driver === 'mongodb'
                ? el(
                    'div.form-row',
                    field('Authentication database', textInput('authSource', { placeholder: 'defaults to admin' })),
                    field(
                      'Options',
                      textInput('options', { placeholder: 'e.g.  replicaSet=rs0&readPreference=secondary' }),
                    ),
                  )
                : null,
              draft.driver === 'mongodb'
                ? checkbox(
                    'Look the servers up by SRV record (mongodb+srv, as MongoDB Atlas gives it)',
                    !!draft.srv,
                    (srv) => {
                      draft.srv = srv;
                      render();
                    },
                  )
                : null,
              draft.driver === 'neo4j'
                ? el(
                    'div.medium',
                    field(
                      'Protocol',
                      select(
                        [
                          { value: 'bolt', label: 'bolt — this server only' },
                          { value: 'neo4j', label: 'neo4j — follow the cluster routing' },
                        ],
                        draft.scheme || 'bolt',
                        (scheme) => {
                          draft.scheme = scheme;
                        },
                      ),
                    ),
                  )
                : null,
              el(
                'div.form-row',
                field(
                  hints.password || 'Password',
                  draft.passwordMode === 'ask'
                    ? el('input.input', { disabled: true, placeholder: 'Asked when connecting' })
                    : draft.passwordMode === 'command'
                      ? textInput('passwordCommand', { placeholder: 'e.g.  op read op://vault/db/password' })
                      : secretInput('password', existing && existing.hasPassword),
                ),
                el(
                  'div.medium',
                  field(
                    '\xA0',
                    select(
                      [
                        { value: 'store', label: IS_MAC ? 'Save in Keychain' : 'Save encrypted' },
                        { value: 'ask', label: 'Ask every time' },
                        { value: 'command', label: 'Run a command' },
                      ],
                      draft.passwordMode || 'store',
                      (passwordMode) => {
                        draft.passwordMode = passwordMode;
                        render();
                      },
                    ),
                  ),
                ),
              ),
              draft.passwordMode === 'command'
                ? el(
                    'p.field-hint.block',
                    'The command runs on this computer before connecting; its output is used as the password.',
                  )
                : null,
              field(
                'TLS',
                select(SSL_MODES, draft.sslMode || 'prefer', (sslMode) => {
                  draft.sslMode = sslMode;
                  render();
                }),
              ),
            );
            if (draft.sslMode === 'verify-ca' || draft.sslMode === 'verify-full' || draft.sslCa || draft.sslCert) {
              const certFilters = [
                { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'key'] },
                { name: 'All files', extensions: ['*'] },
              ];
              rows.push(
                el(
                  'div.form-row',
                  field('CA certificate', filePicker('sslCa', draft, certFilters)),
                  field('Client certificate', filePicker('sslCert', draft, certFilters)),
                  field('Client key', filePicker('sslKey', draft, certFilters)),
                ),
              );
            }
            rows.push(
              el('div.form-sep'),
              checkbox('Connect over SSH', draft.ssh.enabled, (enabled) => {
                draft.ssh.enabled = enabled;
                render();
              }),
            );
            if (draft.ssh.enabled)
              rows.push(
                el(
                  'div.form-row',
                  field('SSH host', textInput('host', { obj: draft.ssh, placeholder: 'bastion.example.com' })),
                  el('div.narrow', field('Port', textInput('port', { obj: draft.ssh, number: true, type: 'number' }))),
                  field('SSH user', textInput('user', { obj: draft.ssh })),
                ),
                el(
                  'div.form-row',
                  el(
                    'div.medium',
                    field(
                      'Sign in with',
                      select(
                        [
                          { value: 'password', label: 'Password' },
                          { value: 'key', label: 'Private key' },
                        ],
                        draft.ssh.auth,
                        (auth) => {
                          draft.ssh.auth = auth;
                          render();
                        },
                      ),
                    ),
                  ),
                  draft.ssh.auth === 'key'
                    ? [
                        field(
                          'Private key',
                          filePicker('keyPath', draft.ssh, [{ name: 'All files', extensions: ['*'] }]),
                        ),
                        field(
                          'Key password',
                          secretInput('passphrase', existing && existing.hasPassphrase, 'If the key has one'),
                        ),
                      ]
                    : field(
                        'SSH password',
                        secretInput('sshPassword', existing && existing.hasSshPassword, 'Empty uses the SSH agent'),
                      ),
                ),
              );
          }
          rows.push(
            el('div.form-sep'),
            field(
              'Run after connecting',
              el('textarea.input.startup-sql', {
                value: draft.startupSql || '',
                spellcheck: false,
                placeholder: hints.startup || 'Optional SQL, e.g.  SET search_path TO app;',
                oninput: (event) => {
                  draft.startupSql = event.target.value;
                },
              }),
            ),
          );
          setChildren(connForm, rows);
        };
        const payload = () => {
          const conn = { ...draft, name: (draft.name || '').trim() };
          if (conn.driver === 'sqlite') delete conn.ssh;
          if (conn.driver !== 'mongodb') {
            delete conn.srv;
            delete conn.authSource;
            delete conn.options;
          }
          if (conn.driver !== 'neo4j') delete conn.scheme;
          if (SEARCH_DRIVERS.includes(conn.driver)) conn.database = '';
          const secrets = {};
          for (const key of ['password', 'sshPassword', 'passphrase'])
            if (entered[key] !== undefined) secrets[key] = entered[key];
          return { conn, secrets };
        };
        const setStatus = (text, kind) => {
          formStatus.textContent = text;
          formStatus.className = 'form-status ' + (kind || '');
        };
        const test = async () => {
          setStatus('Testing…');
          try {
            const info = await invoke('conn:test', payload());
            setStatus(`Connected — server version ${info.version}`, 'ok');
          } catch (err) {
            setStatus(err.message, 'bad');
          }
        };
        const save = async (thenOpen) => {
          try {
            const connection = await invoke('conn:save', payload());
            close(connection);
            if (thenOpen) this.open(connection);
          } catch (err) {
            setStatus(err.message, 'bad');
          }
        };
        render();
        return el(
          'div.dialog',
          el('h3', existing ? `Edit ${existing.name}` : 'New connection'),
          connForm,
          formStatus,
          el(
            'div.dialog-buttons',
            button('Test', { onclick: test }),
            el('div.spacer'),
            button('Cancel', { onclick: () => close(undefined) }),
            button('Save', { onclick: () => save(false) }),
            button(existing ? 'Save & Connect' : 'Connect', { primary: true, onclick: () => save(true) }),
          ),
        );
      },
      { width: 640 },
    );
  }
}
