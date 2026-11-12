import { button, clear, debounce, el, formatDuration, fuzzyScore, icon, invoke, keys, setChildren } from './dom.js';
import {
  checkbox,
  confirmByName,
  confirmDialog,
  modal,
  promptDialog,
  quickPick,
  select,
  showError,
  showMenu,
  toast,
} from './ui.js';
import { confirmSend, safeModeLabel } from './safemode.js';
import { openSettings } from './settings.js';
import { arraySource, Grid } from './grid.js';
import { TableTab } from './table.js';
import { QueryTab } from './query.js';
import { exportDialog, importDialog } from './transfer.js';
import { objectStatements } from '../../shared/changes.js';

const DRIVER_LABELS = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  redis: 'Redis',
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
  neo4j: 'Neo4j',
};

const VOCABULARY = {
  mongodb: {
    tables: 'Collections',
    views: 'Views',
    truncate: 'Delete All Documents…',
    drop: 'Drop Collection…',
    truncated: 'Every document of this collection is deleted. This cannot be undone.',
  },
  redis: {
    tables: 'Keys',
    truncate: 'Flush Database…',
    truncated: 'Every key of this database is deleted. This cannot be undone.',
  },
  elasticsearch: {
    tables: 'Indices',
    views: 'Aliases',
    matviews: 'Data Streams',
    truncate: 'Delete All Documents…',
    drop: 'Delete Index…',
    truncated: 'Every document of this index is deleted. This cannot be undone.',
  },
  neo4j: {
    tables: 'Node Labels',
    views: 'Relationship Types',
    truncate: 'Delete All Nodes…',
    truncated: 'Every node with this label is deleted, together with its relationships. This cannot be undone.',
  },
};

const SECTIONS = [
  { key: 'tables', label: 'Tables', icon: 'table' },
  { key: 'views', label: 'Views', icon: 'view' },
  { key: 'matviews', label: 'Materialized Views', icon: 'view' },
  { key: 'functions', label: 'Functions', icon: 'fn' },
  { key: 'procedures', label: 'Procedures', icon: 'fn' },
  { key: 'sequences', label: 'Sequences', icon: 'seq' },
];

const LOG_LIMIT = 600;

export class Workspace {
  constructor(root, { settings, appInfo, sqlFile }) {
    this.root = root;
    this.settings = settings;
    this.appInfo = appInfo;
    this.sqlFile = sqlFile;
    this.info = null;
    this.schema = null;
    this.schemas = [];
    this.databases = [];
    this.objects = null;
    this.tabs = [];
    this.active = null;
    this.collapsed = new Set(['functions', 'procedures', 'sequences']);
    this.search = '';
    this.showDetail = false;
    this.showLog = false;
    this.showMeta = false;
    this.logEntries = [];
    this.state = { state: 'connecting', detail: '' };
    this.saveQueryTabs = debounce(() => this.persistQueryTabs(), 600);
    this.titlebar = el('div.titlebar');
    this.sidebar = el('div.sidebar');
    this.tabbar = el('div.tabbar');
    this.content = el('div.content');
    this.logPanel = el('div.log-panel');
    this.statusbar = el('div.statusbar');
    this.el = el(
      'div.workspace',
      this.titlebar,
      el('div.workspace-body', this.sidebar, el('div.workspace-main', this.tabbar, this.content, this.logPanel)),
      this.statusbar,
    );
    root.append(this.el);
    window.bridge.on('log', (entry) => this.addLog(entry));
    window.bridge.on('session:state', (state) => {
      this.state = state;
      this.renderStatus();
    });
    window.bridge.on('menu', (action) => this.handleMenu(action));
    window.bridge.on('settings:changed', (settings) => {
      this.settings = settings;
    });
    window.bridge.on('open-sql-file', (filePath) => this.openSqlFile(filePath));
    this.renderTitlebar();
    this.renderStatus();
    this.renderLog();
    this.connect();
  }

  async connect(given) {
    setChildren(this.content, el('div.center-message', el('div.spinner'), el('div', 'Connecting…')));
    try {
      this.info = await invoke('session:connect', given);
    } catch (err) {
      if (err.need) {
        const answer = await promptDialog({
          title:
            { password: 'Database password', sshPassword: 'SSH password', passphrase: 'Private key password' }[
              err.need
            ] || 'Password',
          message: err.message,
          password: true,
          confirmLabel: 'Connect',
        });
        if (answer !== undefined) return this.connect({ ...(given || {}), [err.need]: answer });
      }
      setChildren(
        this.content,
        el(
          'div.center-message',
          el('div.big-icon.danger-text', icon('db', 34)),
          el('h3', 'Could not connect'),
          el('pre.connect-error', err.need ? 'A password is required.' : err.message),
          el(
            'div.row',
            button('Try Again', { primary: true, onclick: () => this.connect() }),
            button('Connections', { onclick: () => window.close() }),
          ),
        ),
      );
      return;
    }
    clear(this.content);
    this.renderTitlebar();
    this.renderStatus();
    await this.loadNamespace();
    if (!this.restored) {
      this.restored = true;
      await this.restoreQueryTabs();
      if (this.sqlFile) this.openSqlFile(this.sqlFile);
    }
    if (!this.tabs.length) this.renderEmpty();
    return this.info;
  }

  async reconnect() {
    try {
      this.info = await invoke('session:connect');
      this.renderTitlebar();
      toast('Reconnected');
      await this.reloadObjects();
    } catch (err) {
      showError(err, 'Could not reconnect');
    }
  }

  async loadNamespace() {
    try {
      if (this.info.hasDatabases) this.databases = await invoke('db:databases');
      if (this.info.hasSchemas) {
        this.schemas = await invoke('db:schemas');
        const saved = await invoke('viewstate:get', `schema/${this.info.database}`).catch(() => null);
        const current = await invoke('db:currentSchema').catch(() => null);
        const names = this.schemas.map((schema) => schema.name);
        this.schema = names.includes(saved)
          ? saved
          : names.includes(current)
            ? current
            : names.find((name) => name === 'public') || names[0] || null;
      } else this.schema = null;
    } catch (err) {
      toast(err.message, { error: true });
    }
    invoke(
      'workspace:setTitle',
      `${this.info.name}${this.info.hasDatabases && this.info.database ? ' — ' + this.info.database : ''}`,
    );
    await this.reloadObjects();
  }

  async reloadObjects() {
    this.columnsPromise = null;
    try {
      this.objects = await invoke('db:objects', this.schema);
    } catch (err) {
      this.objects = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
      toast(err.message, { error: true });
    }
    this.renderSidebar();
    this.completionSchema()
      .then((result) => {
        for (const tab of this.tabs) if (tab.type === 'query') tab.editor.setSchema(result);
      })
      .catch(() => {});
  }

  completionSchema() {
    return this.info
      ? (this.columnsPromise || (this.columnsPromise = invoke('db:columns', this.schema).catch(() => ({}))),
        this.columnsPromise)
      : Promise.resolve({});
  }

  async switchDatabase(database) {
    if (database !== this.info.database) {
      if (!(await this.confirmCloseTables())) {
        this.renderSidebar();
        return;
      }
      try {
        this.info = await invoke('db:useDatabase', database);
        for (const tableTab of this.tabs.filter((tab) => tab.type === 'table')) this.removeTab(tableTab);
        this.renderTitlebar();
        this.renderStatus();
        await this.loadNamespace();
        if (!this.tabs.length) this.renderEmpty();
      } catch (err) {
        showError(err, `Could not switch to ${database}`);
        this.renderSidebar();
      }
    }
  }

  async switchSchema(schema) {
    this.schema = schema;
    invoke('viewstate:set', `schema/${this.info.database}`, schema).catch(() => {});
    await this.reloadObjects();
  }

  async confirmCloseTables() {
    return this.tabs.some((tab) => tab.type === 'table' && tab.dirty)
      ? confirmDialog({
          title: 'Discard all changes?',
          message: 'Some tables have edits that were not committed.',
          confirmLabel: 'Discard',
          danger: true,
        })
      : true;
  }

  renderTitlebar() {
    const info = this.info;
    setChildren(
      this.titlebar,
      el(
        'div.titlebar-info',
        el('span.conn-name', info ? info.name : 'Chairminus'),
        info && info.environment
          ? el('span.env-tag', { style: { background: info.color || 'var(--accent)' } }, info.environment)
          : null,
        info && info.safeMode
          ? el('span.safe-tag', { title: safeModeLabel(info.safeMode) }, icon('lock', 11), safeModeLabel(info.safeMode))
          : null,
        info && info.replica ? el('span.safe-tag', 'replica') : null,
      ),
      el('div.spacer'),
      info
        ? [
            button('Query', { icon: 'sql', small: true, title: keys('New query (⌘T)'), onclick: () => this.newQuery() }),
            button('', {
              icon: 'search',
              small: true,
              title: keys('Open anything (⌘P)'),
              onclick: () => this.openAnything(),
            }),
            button('', { icon: 'detail', small: true, title: keys('Row detail (⇧⌘D)'), onclick: () => this.toggleDetail() }),
            button('', { icon: 'terminal', small: true, title: keys('Console log (⇧⌘C)'), onclick: () => this.toggleLog() }),
            button('', {
              icon: 'gear',
              small: true,
              title: keys('Settings (⌘,)'),
              onclick: () => openSettings(this.appInfo),
            }),
          ]
        : null,
    );
  }

  renderStatus() {
    const state = this.state;
    const info = this.info;
    const label =
      {
        connected: 'Connected',
        connecting: 'Connecting…',
        reconnecting: 'Reconnecting…',
        disconnected: 'Disconnected',
      }[state.state] || state.state;
    setChildren(
      this.statusbar,
      el('span.status-dot', { class: state.state }),
      el('span', { title: state.detail || '' }, label),
      state.state === 'disconnected' && info ? el('a.link', { onclick: () => this.reconnect() }, 'Reconnect') : null,
      info
        ? el('span.muted', `${info.product || DRIVER_LABELS[info.driver] || info.driver} ${info.version || ''}`)
        : null,
      info && info.hasDatabases ? el('span.muted', info.database) : null,
      info && this.schema ? el('span.muted', this.schema) : null,
      el('div.spacer'),
      this.statusText ? el('span.muted', this.statusText) : null,
    );
  }

  renderSidebar() {
    const info = this.info;
    if (!info) {
      clear(this.sidebar);
      return;
    }
    const pickers = [];
    if (info.hasDatabases && this.databases.length) {
      const databases = this.databases
        .filter((database) => !database.system)
        .concat(this.databases.filter((database) => database.system));
      const databaseSelect = select(
        databases.map((entry) => ({ value: entry.name, label: entry.system ? `${entry.name}  (system)` : entry.name })),
        info.database,
        (database) => this.switchDatabase(database),
      );
      databaseSelect.title = keys('Database (⌘K)');
      pickers.push(el('div.picker', icon('db'), databaseSelect));
    }
    if (info.hasSchemas && this.schemas.length) {
      const schemas = this.schemas
        .filter((schema) => !schema.system)
        .concat(this.schemas.filter((schema) => schema.system));
      const schemaSelect = select(
        schemas.map((entry) => ({ value: entry.name, label: entry.system ? `${entry.name}  (system)` : entry.name })),
        this.schema,
        (schema) => this.switchSchema(schema),
      );
      schemaSelect.title = 'Schema';
      pickers.push(el('div.picker', icon('folder'), schemaSelect));
    }
    const input = el('input.input.small.sidebar-search', {
      placeholder: 'Filter…',
      value: this.search,
      spellcheck: false,
    });
    const sidebarList = el('div.sidebar-list');
    input.addEventListener('input', () => {
      this.search = input.value;
      this.renderObjectList(sidebarList);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        this.search = '';
        this.renderObjectList(sidebarList);
      }
    });
    setChildren(
      this.sidebar,
      el(
        'div.sidebar-top',
        pickers,
        el(
          'div.sidebar-search-row',
          input,
          button('', {
            icon: 'refresh',
            small: true,
            title: 'Reload the object list',
            onclick: () => this.reloadObjects(),
          }),
        ),
      ),
      sidebarList,
    );
    this.renderObjectList(sidebarList);
  }

  renderObjectList(sidebarList) {
    const query = this.search.trim();
    const objects = this.objects || {};
    const vocabulary = VOCABULARY[this.info.dialect] || {};
    const activeName =
      this.active && this.active.type === 'table' && this.active.schema === this.schema ? this.active.name : null;
    const rows = [];
    for (const section of SECTIONS) {
      let items = objects[section.key] || [];
      if (query) items = items.filter((item) => fuzzyScore(query, item.name) >= 0);
      if (!items.length && (query || section.key !== 'tables')) continue;
      const collapsed = !query && this.collapsed.has(section.key);
      rows.push(
        el(
          'div.section-head',
          {
            class: collapsed ? 'closed' : '',
            onclick: () => {
              if (collapsed) this.collapsed.delete(section.key);
              else this.collapsed.add(section.key);
              this.renderObjectList(sidebarList);
            },
          },
          icon('chevronDown', 10),
          el('span', vocabulary[section.key] || section.label),
          el('span.section-count', String(items.length)),
        ),
      );
      if (!collapsed) {
        if (!items.length)
          rows.push(el('div.sidebar-empty', `No ${(vocabulary[section.key] || section.label).toLowerCase()}`));
        for (const object of items) {
          const isRelation = ['table', 'view', 'matview'].includes(object.kind);
          rows.push(
            el(
              'div.sidebar-item',
              {
                class: isRelation && object.name === activeName ? 'active' : '',
                title: object.comment || (object.args !== undefined ? `${object.name}(${object.args})` : object.name),
                onclick: () =>
                  isRelation ? this.openTable(this.schema, object.name, object.kind) : this.showDefinition(object),
                ondblclick: () => {
                  if (isRelation) this.openTable(this.schema, object.name, object.kind, { pin: true });
                },
                oncontextmenu: (event) => this.objectMenu(event, object),
              },
              icon(section.icon),
              el('span.sidebar-name', object.name),
              object.args ? el('span.sidebar-args', `(${object.args})`) : null,
            ),
          );
        }
      }
    }
    setChildren(
      sidebarList,
      rows.length
        ? rows
        : el(
            'div.sidebar-empty',
            query ? 'Nothing matches' : this.info.sql ? 'This schema is empty' : 'Nothing here yet',
          ),
    );
  }

  objectMenu(event, object) {
    const isRelation = ['table', 'view', 'matview'].includes(object.kind);
    const sql = this.info.sql;
    const vocabulary = VOCABULARY[this.info.dialect] || {};
    const statements = isRelation
      ? objectStatements(this.info.dialect, this.info.hasSchemas ? this.schema : null, object.name, object.kind)
      : {};
    const copy = (text, what) => {
      invoke('clipboard:write', text);
      toast(`${what} copied`);
    };
    if (!isRelation) {
      showMenu(event, [
        { label: 'Show Definition', onclick: () => this.showDefinition(object) },
        { label: 'Copy Name', onclick: () => copy(object.name, 'Name') },
      ]);
      return;
    }
    const isTable = object.kind === 'table';
    showMenu(event, [
      { label: 'Open', onclick: () => this.openTable(this.schema, object.name, object.kind, { pin: true }) },
      {
        label: 'Open Structure',
        onclick: () => this.openTable(this.schema, object.name, object.kind, { pin: true, structure: true }),
      },
      '-',
      { label: 'Copy Name', onclick: () => copy(object.name, 'Name') },
      {
        label: sql ? 'Copy SELECT Statement' : 'Copy Query',
        onclick: () => copy(statements.select, sql ? 'SELECT statement' : 'Query'),
      },
      { label: sql ? 'New Query on This Table' : 'New Query on This', onclick: () => this.newQuery(statements.query) },
      '-',
      {
        label: 'Export…',
        onclick: () =>
          exportDialog(this, {
            title: `Export ${object.name}`,
            defaultName: object.name,
            table: { schema: this.schema, name: object.name, filters: [], sort: [], columnNames: null },
          }),
      },
      isTable &&
        this.info.canImport && {
          label: 'Import…',
          onclick: async () => {
            const desc = await invoke('db:describe', this.schema, object.name).catch(() => null);
            if (
              await importDialog(this, { schema: this.schema, table: object.name, columns: desc ? desc.columns : [] })
            )
              this.refreshTable(object.name);
          },
        },
      (statements.truncate || statements.drop) && '-',
      statements.truncate && {
        label: vocabulary.truncate || 'Truncate…',
        danger: true,
        onclick: () => this.destroyObject(object, 'truncate'),
      },
      statements.drop && {
        label: isTable ? vocabulary.drop || 'Drop Table…' : 'Drop View…',
        danger: true,
        onclick: () => this.destroyObject(object, 'drop'),
      },
    ]);
  }

  async destroyObject(object, action) {
    const vocabulary = VOCABULARY[this.info.dialect] || {};
    const statement = objectStatements(
      this.info.dialect,
      this.info.hasSchemas ? this.schema : null,
      object.name,
      object.kind,
    )[action];
    if (!statement) return;
    const verb =
      (action === 'drop' ? vocabulary.drop : vocabulary.truncate) || (action === 'drop' ? 'Drop' : 'Truncate');
    if (!(
      !(await confirmByName({
        title: this.info.sql ? `${verb} ${object.name}?` : `${object.name}: ${verb.replace(/…$/, '').toLowerCase()}?`,
        message:
          action === 'drop'
            ? 'The object and everything in it are removed. This cannot be undone.'
            : vocabulary.truncated || 'Every row of this table is deleted. This cannot be undone.',
        name: object.name,
        confirmLabel: verb.replace(/…$/, ''),
      })) || !(await confirmSend(this, [statement], { confirmed: true }))
    ))
      try {
        const result = await invoke('db:run', { statements: [statement] });
        if (!result[0].ok) throw new Error(result[0].error);
        toast(action === 'drop' ? `${object.name} dropped` : `${object.name} emptied`);
        if (action !== 'drop' && !this.info.sql) await this.reloadObjects();
        if (action === 'drop') {
          for (const openTab of this.tabs.filter(
            (tab) => tab.type === 'table' && tab.name === object.name && tab.schema === this.schema,
          ))
            this.removeTab(openTab);
          await this.reloadObjects();
        } else this.refreshTable(object.name);
      } catch (err) {
        showError(err);
      }
  }

  refreshTable(name) {
    for (const tab of this.tabs)
      if (tab.type === 'table' && tab.name === name && tab.schema === this.schema && !tab.dirty)
        tab.load({ keepPosition: true });
  }

  async showDefinition(object) {
    try {
      const text = await invoke('db:ddl', this.schema, object.name, object.kind, { oid: object.oid });
      this.newQuery(text, object.name);
    } catch (err) {
      showError(err);
    }
  }

  async openTable(schema, name, kind = 'table', { pin = false, filters, structure = false } = {}) {
    let active =
      !filters && this.tabs.find((tab) => tab.type === 'table' && tab.schema === schema && tab.name === name);
    if (!active) {
      const preview = this.tabs.find((tab) => tab.type === 'table' && tab.preview && !tab.dirty);
      active = new TableTab(this, { schema, name, kind, filters });
      if (preview && !pin) {
        const index = this.tabs.indexOf(preview);
        preview.destroy();
        preview.el.remove();
        this.tabs[index] = active;
      } else this.tabs.push(active);
    }
    if (pin) active.preview = false;
    this.activate(active);
    if (structure) active.setMode('structure');
    return active;
  }

  newQuery(text = '', title, filePath) {
    const queryTab = new QueryTab(this, { text, title, filePath });
    this.tabs.push(queryTab);
    this.activate(queryTab);
    this.saveQueryTabs();
    return queryTab;
  }

  async openSqlFile(filePath) {
    try {
      const text = await invoke('file:readText', filePath);
      this.newQuery(text, filePath.split('/').pop(), filePath);
    } catch (err) {
      showError(
        new Error(`${err.message}\nIf the file is a database dump, run it with File ▸ Import instead.`),
        'Could not open the file',
      );
    }
  }

  activate(active) {
    this.active = active;
    for (const tab of this.tabs)
      if (tab.el.parentElement === this.content && tab !== active) tab.el.style.display = 'none';
    if (active) {
      if (active.el.parentElement !== this.content) {
        if (!this.tabs.some((tab) => tab.el.parentElement === this.content)) clear(this.content);
        this.content.append(active.el);
      }
      active.el.style.display = '';
      active.activate();
    }
    this.renderTabs();
    const sidebarList = this.sidebar.querySelector('.sidebar-list');
    if (sidebarList) this.renderObjectList(sidebarList);
  }

  async closeTab(tab = this.active) {
    if (!tab) {
      window.close();
      return;
    }
    if (!(tab.type === 'table' && tab.dirty && !(await tab.confirmDiscard()))) {
      this.removeTab(tab);
      if (!this.tabs.length) this.renderEmpty();
    }
  }

  removeTab(tab) {
    const index = this.tabs.indexOf(tab);
    if (index !== -1) {
      this.tabs.splice(index, 1);
      tab.destroy();
      tab.el.remove();
      if (this.active === tab) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] || null);
      else this.renderTabs();
      this.tabChanged();
      if (tab.type === 'query') this.saveQueryTabs();
    }
  }

  tabChanged() {
    this.renderTabs();
    invoke(
      'workspace:setDirty',
      this.tabs.some((tab) => tab.dirty),
    ).catch(() => {});
  }

  renderTabs() {
    setChildren(
      this.tabbar,
      this.tabs.map((tab) =>
        el(
          'div.tab',
          {
            class: [tab === this.active ? 'active' : '', tab.preview ? 'preview' : ''].join(' '),
            title:
              tab.type === 'table'
                ? `${tab.schema ? tab.schema + '.' : ''}${tab.name}${tab.preview ? ' — double-click to keep this tab' : ''}`
                : tab.filePath || tab.title,
            onmousedown: (event) => {
              if (event.button === 0 && !event.target.closest('.tab-close')) this.activate(tab);
            },
            ondblclick: () => {
              if (tab.preview) {
                tab.preview = false;
                this.renderTabs();
              }
            },
            onauxclick: (event) => {
              if (event.button === 1) this.closeTab(tab);
            },
            oncontextmenu: (event) =>
              showMenu(event, [
                { label: 'Close', hint: keys('⌘W'), onclick: () => this.closeTab(tab) },
                {
                  label: 'Close Others',
                  disabled: this.tabs.length < 2,
                  onclick: async () => {
                    for (const other of [...this.tabs]) if (other !== tab) await this.closeTab(other);
                  },
                },
                tab.type === 'query' && {
                  label: 'Rename…',
                  onclick: async () => {
                    const title = await promptDialog({ title: 'Rename tab', value: tab.title });
                    if (title && title.trim()) {
                      tab.title = title.trim();
                      this.renderTabs();
                      this.saveQueryTabs();
                    }
                  },
                },
              ]),
          },
          icon(tab.icon, 13),
          el('span.tab-title', tab.title),
          tab.dirty ? el('span.tab-dirty', { title: 'Uncommitted changes' }) : null,
          el('span.tab-close', { title: keys('Close (⌘W)'), onclick: () => this.closeTab(tab) }, icon('close', 10)),
        ),
      ),
      el(
        'button.tab-new',
        { type: 'button', title: keys('New query (⌘T)'), onclick: () => this.newQuery() },
        icon('plus', 13),
      ),
    );
  }

  renderEmpty() {
    setChildren(
      this.content,
      el(
        'div.center-message.empty-state',
        el('div.big-icon', icon('table', 40)),
        el('h3', this.info ? this.info.name : ''),
        el(
          'div.muted',
          this.info && !this.info.sql
            ? 'Pick an item on the left, or start with a query.'
            : 'Pick a table on the left, or start with a query.',
        ),
        el(
          'div.row',
          button('New Query', { icon: 'sql', primary: true, onclick: () => this.newQuery() }),
          button('Open Anything', { icon: 'search', onclick: () => this.openAnything() }),
        ),
      ),
    );
  }

  persistQueryTabs() {
    if (!this.info) return;
    const saved = this.tabs
      .filter((tab) => tab.type === 'query' && !tab.filePath && tab.text.trim())
      .map((queryTab) => ({ title: queryTab.title, text: queryTab.text }));
    invoke('viewstate:set', 'queryTabs', saved.length ? saved : null).catch(() => {});
  }

  async restoreQueryTabs() {
    const saved = await invoke('viewstate:get', 'queryTabs').catch(() => null);
    for (const entry of saved || []) this.newQuery(entry.text, entry.title);
  }

  toggleDetail() {
    this.showDetail = !this.showDetail;
    for (const tab of this.tabs) if (tab.type === 'table') tab.renderDetail();
    if (this.active && this.active.type === 'table') this.active.grid.renderRows(true);
  }

  toggleLog() {
    this.showLog = !this.showLog;
    this.renderLog();
  }

  addLog(entry) {
    this.logEntries.push(entry);
    if (this.logEntries.length > LOG_LIMIT) this.logEntries.splice(0, this.logEntries.length - LOG_LIMIT);
    if (this.showLog && (this.showMeta || !entry.meta)) {
      const list = this.logPanel.querySelector('.log-list');
      if (list) {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
        for (list.append(this.logRow(entry)); list.children.length > LOG_LIMIT;) list.firstChild.remove();
        if (atBottom) list.scrollTop = list.scrollHeight;
      }
    }
  }

  logRow(entry) {
    const oneLine = entry.sql.replace(/\s+/g, ' ').trim();
    return el(
      'div.log-row',
      {
        class: [entry.error ? 'failed' : '', entry.meta ? 'meta' : ''].join(' '),
        title: entry.error ? `${entry.sql}\n\n${entry.error}` : entry.sql,
        oncontextmenu: (event) =>
          showMenu(event, [
            { label: 'Copy Statement', onclick: () => invoke('clipboard:write', entry.sql) },
            { label: 'Open in Query Editor', onclick: () => this.newQuery(entry.sql) },
          ]),
      },
      el('span.log-time', new Date(entry.ts).toLocaleTimeString('en-GB')),
      el('span.log-ms', formatDuration(entry.ms)),
      el('span.log-sql', oneLine.length > 500 ? oneLine.slice(0, 500) + '…' : oneLine),
      entry.params && entry.params.length ? el('span.log-params', JSON.stringify(entry.params).slice(0, 160)) : null,
      entry.error ? el('span.log-error', entry.error.split(`\n`)[0]) : null,
    );
  }

  renderLog() {
    this.logPanel.style.display = this.showLog ? '' : 'none';
    if (!this.showLog) return;
    const logList = el(
      'div.log-list',
      this.logEntries.filter((logEntry) => this.showMeta || !logEntry.meta).map((entry) => this.logRow(entry)),
    );
    setChildren(
      this.logPanel,
      el(
        'div.log-head',
        el('b', 'Console'),
        el('span.muted', 'Every statement sent to the server'),
        el('div.spacer'),
        checkbox('Show metadata queries', this.showMeta, (showMeta) => {
          this.showMeta = showMeta;
          this.renderLog();
        }),
        button('Clear', {
          small: true,
          onclick: () => {
            this.logEntries = [];
            this.renderLog();
          },
        }),
        button('', { icon: 'close', small: true, onclick: () => this.toggleLog() }),
      ),
      logList,
    );
    logList.scrollTop = logList.scrollHeight;
  }

  async processList() {
    if (!this.info.canProcessList) {
      toast('This connection has no process list');
      return;
    }
    const grid = new Grid({ editable: false, emptyText: 'No other sessions' });
    let data = null;
    const refresh = async () => {
      try {
        data = await invoke('db:processList');
        grid.setData(
          data.fields.map((field) => ({ name: field.name, type: '' })),
          arraySource(data.rows),
          { keepPosition: true },
        );
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    await modal(
      (close) => {
        const kill = async () => {
          const row = grid.active.row;
          if (!data || row < 0) return;
          const id = data.rows[row][data.idColumn];
          const statement = data.killStatement
            ? data.killStatement.replace('{id}', id)
            : this.info.dialect === 'postgres'
              ? `SELECT pg_terminate_backend(${id})`
              : `KILL ${id}`;
          if (
            (await confirmDialog({
              title: `End session ${id}?`,
              message: 'Its running statement is stopped and its transaction is rolled back.',
              confirmLabel: 'End Session',
              danger: true,
            })) &&
            (await confirmSend(this, [statement], { confirmed: true }))
          ) {
            try {
              await invoke('db:kill', id);
              toast(`Session ${id} ended`);
            } catch (err) {
              toast(err.message, { error: true });
            }
            refresh();
          }
        };
        refresh();
        return el(
          'div.dialog.process-dialog',
          el('h3', 'Process list'),
          el('div.process-grid', grid.el),
          el(
            'div.dialog-buttons',
            button('End Session', { danger: true, onclick: kill }),
            el('div.spacer'),
            button('Refresh', { icon: 'refresh', onclick: refresh }),
            button('Close', { primary: true, onclick: () => close() }),
          ),
        );
      },
      { width: 900 },
    );
    grid.destroy();
  }

  async openAnything() {
    if (!this.info) return;
    const objects = this.objects || {};
    const items = [];
    for (const section of SECTIONS)
      for (const object of objects[section.key] || [])
        items.push({
          label: object.name,
          detail: section.label.replace(/s$/, ''),
          icon: section.icon,
          value: { object },
        });
    for (const database of this.databases)
      if (database.name !== this.info.database)
        items.push({ label: database.name, detail: 'Switch database', icon: 'db', value: { database: database.name } });
    const commands = [
      ['New Query', 'new-query'],
      ['Refresh', 'refresh'],
      ['Toggle Console Log', 'toggle-log'],
      ['Toggle Row Detail', 'toggle-detail'],
      ['Process List', 'process-list'],
      ['Import…', 'import'],
      ['Reconnect', 'reconnect'],
      ['Settings…', 'settings'],
    ];
    for (const [label, action] of commands)
      items.push({ label, detail: 'Command', icon: 'chevron', value: { action } });
    const picked = await quickPick(items, { placeholder: 'Open a table, view, function, database or command…' });
    if (picked) {
      if (picked.object) {
        if (['table', 'view', 'matview'].includes(picked.object.kind))
          this.openTable(this.schema, picked.object.name, picked.object.kind, { pin: true });
        else this.showDefinition(picked.object);
      } else if (picked.database) this.switchDatabase(picked.database);
      else this.handleMenu(picked.action);
    }
  }

  async pickDatabase() {
    if (!this.info.hasDatabases) {
      toast('This connection has a single database');
      return;
    }
    const picked = await quickPick(
      this.databases.map((database) => ({
        label: database.name,
        detail: database.name === this.info.database ? 'current' : database.system ? 'system' : '',
        icon: 'db',
        value: database.name,
      })),
      { placeholder: 'Switch to database…' },
    );
    if (picked) this.switchDatabase(picked);
  }

  handleMenu(action) {
    if (!(document.querySelector('.overlay') && action !== 'settings')) {
      if (!this.info) return action === 'settings' ? openSettings(this.appInfo) : undefined;
      switch (action) {
        case 'settings':
          return openSettings(this.appInfo);
        case 'new-query':
          return this.newQuery();
        case 'close-tab':
          return this.closeTab();
        case 'open-anything':
          return this.openAnything();
        case 'toggle-log':
          return this.toggleLog();
        case 'toggle-detail':
          return this.toggleDetail();
        case 'process-list':
          return this.processList();
        case 'switch-database':
          return this.pickDatabase();
        case 'reconnect':
          return this.reconnect();
        case 'next-tab':
        case 'prev-tab': {
          if (this.tabs.length < 2) return;
          const index = this.tabs.indexOf(this.active);
          return this.activate(
            this.tabs[(index + (action === 'next-tab' ? 1 : this.tabs.length - 1)) % this.tabs.length],
          );
        }
        case 'import':
          return this.active && this.active.type === 'table'
            ? this.active.handle('import')
            : importDialog(this, { schema: this.schema }).then((result) => {
                if (result) this.reloadObjects();
              });
        default:
          return this.active ? this.active.handle(action) : undefined;
      }
    }
  }
}
