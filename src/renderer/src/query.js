import { button, clear, debounce, el, formatDuration, formatNumber, icon, invoke, keys, setChildren } from './dom.js';
import { confirmDialog, modal, promptDialog, showError, showMenu, toast } from './ui.js';
import { confirmSend } from './safemode.js';
import { arraySource, Grid } from './grid.js';
import { createEditor } from './editor.js';
import {
  findVariables,
  joinStatements,
  splitStatements,
  statementAt,
  substituteVariables,
  variableFormat,
} from '../../shared/tokenizer.js';
import { formatSql } from '../../shared/sqlformat.js';
import { editText } from '../../shared/dialect.js';
import { toCsv, toJson, toMarkdown, toTsv } from '../../shared/format.js';
import { exportDialog } from './transfer.js';

let queryCounter = 0;

const FILE_EXTENSIONS = { neo4j: 'cypher', mongodb: 'js', redis: 'redis', elasticsearch: 'es' };

export class QueryTab {
  constructor(ws, { text = '', title, filePath } = {}) {
    this.ws = ws;
    this.type = 'query';
    this.icon = 'sql';
    this.title = title || `Query ${++queryCounter}`;
    this.filePath = filePath || null;
    this.results = [];
    this.activeResult = 0;
    this.running = false;
    this.variableValues = {};
    this.showHistory = false;
    this.toolbar = el('div.tab-toolbar');
    this.editorHost = el('div.editor-host');
    this.splitter = el('div.splitter');
    this.resultTabs = el('div.result-tabs');
    this.resultBody = el('div.result-body');
    this.resultFooter = el('div.tab-footer');
    this.resultPane = el('div.result-pane', this.resultTabs, this.resultBody, this.resultFooter);
    this.side = el('div.history-panel');
    this.el = el(
      'div.tab-content.query-tab',
      this.toolbar,
      el('div.query-split', el('div.query-main', this.editorHost, this.splitter, this.resultPane), this.side),
    );
    this.editor = createEditor({
      parent: this.editorHost,
      dialect: ws.info.dialect,
      doc: text,
      indent: ws.settings.indent,
      uppercase: ws.settings.uppercaseKeywords,
      onChange: () => {
        this.ws.saveQueryTabs();
      },
      onRun: () => this.runCurrent(),
      onRunAll: () => this.runAll(),
    });
    this.grid = new Grid({
      editable: false,
      onContext: (event, hit) => this.cellMenu(event, hit),
      onOpen: () => this.viewValue(),
      emptyText: 'The query returned no rows',
    });
    this.initSplitter();
    this.renderToolbar();
    this.renderResults();
    this.renderHistory();
    this.ws
      .completionSchema()
      .then((result) => this.editor.setSchema(result))
      .catch(() => {});
  }

  get text() {
    return this.editor.getText();
  }

  get dirty() {
    return false;
  }

  get dialect() {
    return this.ws.info.dialect;
  }

  get sql() {
    return this.ws.info.sql !== false;
  }

  get canExplain() {
    return this.sql || this.dialect === 'neo4j' || this.dialect === 'mongodb';
  }

  initSplitter() {
    this.splitter.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const parentElement = this.splitter.parentElement;
      const onMove = (event) => {
        const rect = parentElement.getBoundingClientRect();
        const percent = Math.max(12, Math.min(88, ((event.clientY - rect.top) / rect.height) * 100));
        this.editorHost.style.flex = `0 0 ${percent}%`;
        this.grid.renderRows(true);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  renderToolbar() {
    setChildren(
      this.toolbar,
      this.running
        ? button('Cancel', {
            icon: 'stop',
            small: true,
            danger: true,
            title: keys('Cancel the running query (⌘.)'),
            onclick: () => this.cancel(),
          })
        : button('Run', {
            icon: 'play',
            small: true,
            primary: true,
            title: keys('Run the selection, or the statement under the cursor (⌘↩)'),
            onclick: () => this.runCurrent(),
          }),
      button('Run All', {
        icon: 'playAll',
        small: true,
        title: keys('Run every statement (⇧⌘↩)'),
        disabled: this.running,
        onclick: () => this.runAll(),
      }),
      this.canExplain
        ? button('Explain', {
            small: true,
            title: 'EXPLAIN the statement under the cursor',
            disabled: this.running,
            onclick: () => this.explain(),
          })
        : null,
      el('div.toolbar-sep'),
      this.sql
        ? button('Format', { icon: 'wand', small: true, title: keys('Format SQL (⇧⌘F)'), onclick: () => this.format() })
        : null,
      button('Favorite', {
        icon: 'star',
        small: true,
        title: 'Save this query as a favorite',
        onclick: () => this.saveFavorite(),
      }),
      el('div.spacer'),
      this.filePath ? el('span.muted.file-name', { title: this.filePath }, this.filePath.split('/').pop()) : null,
      button('History', {
        icon: 'history',
        small: true,
        title: keys('History and favorites (⌘Y)'),
        onclick: () => this.toggleHistory(),
      }),
    );
  }

  async fillVariables(sql) {
    const { variableFormat: format, variablesInStrings } = this.ws.settings;
    const dialect = this.ws.info.dialect;
    const names = findVariables(sql, format, dialect, variablesInStrings);
    if (!names.length) return sql;
    const values = await modal(
      (close) => {
        const inputs = names.map((name) =>
          el('input.input', { value: this.variableValues[name] ?? '', spellcheck: false, dataset: { name } }),
        );
        const collect = () => Object.fromEntries(inputs.map((input) => [input.dataset.name, input.value]));
        return el(
          'div.dialog',
          el('h3', 'Query variables'),
          el('p.dialog-text', "Values are inserted exactly as typed, so quote text yourself: 'like this'."),
          el(
            'div.form-grid',
            names.map((name, index) => [el('label.field-label.mono', name), inputs[index]]),
          ),
          el(
            'div.dialog-buttons',
            button('Cancel', { onclick: () => close(undefined) }),
            button('Run', { primary: true, onclick: () => close(collect()) }),
          ),
        );
      },
      { width: 480 },
    );
    return values
      ? (Object.assign(this.variableValues, values),
        substituteVariables(sql, values, format, dialect, variablesInStrings))
      : null;
  }

  runCurrent() {
    const selection = this.editor.selection();
    if (selection.trim()) return this.run(selection);
    const statement = statementAt(this.text, this.editor.cursor(), this.ws.info.dialect);
    if (!statement) {
      toast('Nothing to run');
      return;
    }
    return this.run(statement.text);
  }

  runAll() {
    return this.run(this.text);
  }

  explain() {
    const text = this.editor.selection().trim();
    const statement = text ? { text } : statementAt(this.text, this.editor.cursor(), this.ws.info.dialect);
    if (!statement || !this.canExplain) return;
    if (this.dialect === 'mongodb') {
      const body = statement.text.trim().replace(/;\s*$/, '');
      return this.run(/\.explain\([^)]*\)$/.test(body) ? body : `${body}.explain()`);
    }
    if (this.dialect === 'neo4j') return this.run('EXPLAIN ' + statement.text.replace(/^\s*(explain|profile)\s+/i, ''));
    const prefix = this.ws.info.dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
    return this.run(prefix + statement.text.replace(/^\s*explain\s+(query\s+plan\s+)?/i, ''));
  }

  async run(source, { rowLimit } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    let sql;
    let statements;
    try {
      sql = await this.fillVariables(source);
      if (sql === null) return;
      statements = splitStatements(sql, this.ws.info.dialect).map((statement) => statement.text);
      if (!statements.length) {
        toast('Nothing to run');
        return;
      }
      if (!(await confirmSend(this.ws, statements))) return;
    } finally {
      this.starting = false;
    }
    this.running = true;
    this.lastRun = { sql };
    this.renderToolbar();
    setChildren(this.resultTabs);
    setChildren(
      this.resultBody,
      el(
        'div.loading',
        el('div.spinner'),
        `Running ${statements.length === 1 ? 'query' : statements.length + ' statements'}…`,
      ),
    );
    clear(this.resultFooter);
    try {
      this.results = await invoke('db:run', {
        statements,
        rowLimit: rowLimit === undefined ? this.ws.settings.limitQueryRows : rowLimit,
      });
      const index = this.results.findIndex((result) => !result.ok);
      this.activeResult =
        index !== -1
          ? index
          : Math.max(0, this.results.map((result) => result.fields && result.fields.length > 0).lastIndexOf(true));
      if (
        this.results.some(
          (result) =>
            result.ok &&
            (result.schemaChanged || /^(CREATE|DROP|ALTER|RENAME)/i.test(result.command || result.sql.trim())),
        )
      )
        this.ws.reloadObjects();
    } catch (err) {
      this.results = [{ sql, ok: false, error: err.message, ms: 0 }];
      this.activeResult = 0;
    } finally {
      this.running = false;
      this.renderToolbar();
      this.renderResults();
      if (this.showHistory) this.renderHistory();
    }
  }

  async cancel() {
    try {
      await invoke('db:cancel');
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  renderResults() {
    const results = this.results;
    if (!results.length) {
      clear(this.resultTabs);
      clear(this.resultFooter);
      setChildren(
        this.resultBody,
        el(
          'div.result-empty',
          el('div', 'Results appear here.'),
          el(
            'div.muted',
            keys('⌘↩ runs the statement under the cursor  ·  ⇧⌘↩ runs everything  ·  variables like '),
            el(
              'code',
              { colon: ':name', dollar: '${name}', braces: '{{name}}' }[
                variableFormat(this.ws.settings.variableFormat, this.dialect)
              ],
            ),
            ' are asked for before running',
          ),
        ),
      );
      return;
    }
    setChildren(
      this.resultTabs,
      results.length > 1
        ? results.map((result, activeResult) =>
            el(
              'button.result-tab',
              {
                type: 'button',
                class: [activeResult === this.activeResult ? 'active' : '', result.ok ? '' : 'failed'].join(' '),
                title: result.sql,
                onclick: () => {
                  this.activeResult = activeResult;
                  this.renderResults();
                },
              },
              result.ok
                ? result.fields && result.fields.length
                  ? `Result ${activeResult + 1}`
                  : result.command || `Statement ${activeResult + 1}`
                : 'Error',
            ),
          )
        : null,
    );
    this.resultTabs.style.display = results.length > 1 ? '' : 'none';
    const current = results[this.activeResult] || results[0];
    if (!current.ok) {
      setChildren(
        this.resultBody,
        el(
          'div.error-box',
          el('b', 'The statement failed'),
          el('pre', current.error),
          el('pre.failed-sql', current.sql),
        ),
      );
      setChildren(
        this.resultFooter,
        el('span.danger-text', 'Error'),
        el('div.spacer'),
        el('span.muted', formatDuration(current.ms)),
      );
      return;
    }
    if (!current.fields || !current.fields.length) {
      setChildren(
        this.resultBody,
        el(
          'div.result-message',
          icon('check', 18),
          el(
            'div',
            current.message
              ? current.message
              : current.affected !== null && current.affected !== undefined
                ? `${formatNumber(current.affected)} ${current.affected === 1 ? 'row' : 'rows'} affected`
                : `${current.command || 'Statement'} completed`,
          ),
          el('pre.muted', current.sql.length > 400 ? current.sql.slice(0, 400) + '…' : current.sql),
        ),
      );
      setChildren(this.resultFooter, el('span', 'OK'), el('div.spacer'), el('span.muted', formatDuration(current.ms)));
      return;
    }
    this.grid.setData(
      current.fields.map((field) => ({ name: field.name, type: field.type })),
      arraySource(current.rows),
    );
    setChildren(this.resultBody, this.grid.el);
    this.grid.layout();
    setChildren(
      this.resultFooter,
      el('span', `${formatNumber(current.rows.length)} ${current.rows.length === 1 ? 'row' : 'rows'}`),
      current.truncated ? el('span.badge.soft', `limited to ${formatNumber(current.rows.length)}`) : null,
      current.truncated
        ? el('a.link', { onclick: () => this.run(current.sql, { rowLimit: 0 }) }, 'Load all rows')
        : null,
      current.message ? el('span.muted', current.message) : null,
      el('div.spacer'),
      el('span.muted', formatDuration(current.ms)),
      button('', { icon: 'download', small: true, title: keys('Export this result… (⌘E)'), onclick: () => this.export() }),
    );
  }

  currentResult() {
    const result = this.results[this.activeResult];
    return result && result.ok && result.fields && result.fields.length ? result : null;
  }

  copyRows(format) {
    const currentResult = this.currentResult();
    if (!currentResult) return;
    const names = currentResult.fields.map((field) => field.name);
    const rows = this.grid.selectedRows().map((row) => currentResult.rows[row]);
    const text =
      format === 'csv'
        ? toCsv(names, rows)
        : format === 'json'
          ? toJson(names, rows, { inflate: !this.sql })
          : format === 'markdown'
            ? toMarkdown(names, rows)
            : toTsv(rows);
    invoke('clipboard:write', text);
    toast(`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} copied`);
  }

  viewValue() {
    const currentResult = this.currentResult();
    const { row, col } = this.grid.active;
    if (!currentResult || row < 0) return;
    const value = currentResult.rows[row][col];
    modal(
      (close) =>
        el(
          'div.dialog',
          el('h3', currentResult.fields[col].name, el('span.muted', `  ${currentResult.fields[col].type || ''}`)),
          el('textarea.input.value-editor', {
            value: value === null ? 'NULL' : editText(value),
            readOnly: true,
            spellcheck: false,
          }),
          el(
            'div.dialog-buttons',
            button('Copy', {
              onclick: () => {
                invoke('clipboard:write', editText(value));
                toast('Copied');
              },
            }),
            el('div.spacer'),
            button('Close', { primary: true, onclick: () => close() }),
          ),
        ),
      { width: 620 },
    );
  }

  cellMenu(event, hit) {
    const currentResult = this.currentResult();
    if (!currentResult) return;
    const col = hit.col === -1 ? this.grid.active.col : hit.col;
    showMenu(event, [
      {
        label: 'Copy Cell Value',
        hint: keys('⌘C'),
        onclick: () => invoke('clipboard:write', editText(currentResult.rows[hit.row][col])),
      },
      {
        label: 'Copy Rows As',
        submenu: [
          { label: 'Tab-separated', onclick: () => this.copyRows('tsv') },
          { label: 'CSV', onclick: () => this.copyRows('csv') },
          { label: 'JSON', onclick: () => this.copyRows('json') },
          { label: 'Markdown Table', onclick: () => this.copyRows('markdown') },
        ],
      },
      { label: 'Copy Column Name', onclick: () => invoke('clipboard:write', currentResult.fields[col].name) },
      '-',
      { label: 'View Value…', onclick: () => this.viewValue() },
      { label: 'Export Result…', onclick: () => this.export() },
    ]);
  }

  export() {
    const currentResult = this.currentResult();
    if (!currentResult) {
      toast('There is no result to export');
      return;
    }
    exportDialog(this.ws, {
      title: 'Export result',
      page: { names: currentResult.fields.map((field) => field.name), rows: currentResult.rows },
      defaultName: 'result',
    });
  }

  format() {
    if (!this.sql) {
      toast('Formatting is available for SQL');
      return;
    }
    const selection = this.editor.selection();
    const options = {
      dialect: this.ws.info.dialect,
      indent: this.ws.settings.indent,
      uppercase: this.ws.settings.uppercaseKeywords,
    };
    if (selection.trim()) this.editor.insert(formatSql(selection, options).replace(/\n$/, ''));
    else if (this.text.trim()) this.editor.setText(formatSql(this.text, options));
  }

  async saveFavorite() {
    const sql = (this.editor.selection().trim() || this.text).trim();
    if (!sql) {
      toast('Write a query first');
      return;
    }
    const name = await promptDialog({
      title: 'Save as favorite',
      message: 'Favorites are available in every connection.',
      placeholder: 'Name',
      confirmLabel: 'Save',
      validate: (value) => (value.trim() ? null : 'Enter a name'),
    });
    if (name) {
      await invoke('favorites:save', { name: name.trim(), sql });
      toast('Favorite saved');
      if (this.showHistory) this.renderHistory();
    }
  }

  async saveAs() {
    const ext = FILE_EXTENSIONS[this.dialect] || 'sql';
    const filePath = await invoke('dialog:save', {
      defaultPath: this.filePath || `${this.title}.${ext}`,
      filters: [
        { name: this.sql ? 'SQL' : 'Query', extensions: [ext] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (filePath)
      try {
        await invoke('file:writeText', filePath, this.text);
        this.filePath = filePath;
        this.title = filePath.split('/').pop();
        this.renderToolbar();
        this.ws.renderTabs();
        toast('Saved');
      } catch (err) {
        showError(err);
      }
  }

  toggleHistory() {
    this.showHistory = !this.showHistory;
    this.renderHistory();
  }

  async renderHistory() {
    this.side.style.display = this.showHistory ? '' : 'none';
    if (!this.showHistory) return;
    this.historyMode = this.historyMode || 'history';
    const historyList = el('div.history-list');
    const input = el('input.input.small', {
      placeholder: 'Search…',
      spellcheck: false,
      value: this.historySearch || '',
    });
    const modeTab = (historyMode, label) =>
      el(
        'button.result-tab',
        {
          type: 'button',
          class: this.historyMode === historyMode ? 'active' : '',
          onclick: () => {
            this.historyMode = historyMode;
            this.renderHistory();
          },
        },
        label,
      );
    const refresh = async () => {
      this.historySearch = input.value;
      const needle = input.value.trim().toLowerCase();
      let items;
      try {
        if (this.historyMode === 'history') items = await invoke('history:search', needle);
        else
          items = (await invoke('favorites:list'))
            .filter(
              (favorite) =>
                !needle || favorite.name.toLowerCase().includes(needle) || favorite.sql.toLowerCase().includes(needle),
            )
            .reverse();
      } catch (err) {
        setChildren(historyList, el('div.muted.pad', err.message));
        return;
      }
      if (!items.length) {
        setChildren(
          historyList,
          el(
            'div.muted.pad',
            this.historyMode === 'history' ? 'No queries yet' : 'No favorites yet — save one with the Favorite button',
          ),
        );
        return;
      }
      const snippet = (sql) =>
        joinStatements([sql.replace(/\s+$/, '')], this.dialect) + (this.dialect === 'elasticsearch' ? `\n\n` : `\n`);
      setChildren(
        historyList,
        items.map((item) =>
          el(
            'div.history-item',
            {
              class: item.ok === false ? 'failed' : '',
              title: 'Click to insert into the editor',
              onclick: () => this.editor.insert(snippet(item.sql)),
              oncontextmenu: (event) =>
                showMenu(event, [
                  { label: 'Insert into Editor', onclick: () => this.editor.insert(snippet(item.sql)) },
                  { label: 'Run', onclick: () => this.run(item.sql) },
                  { label: 'Copy', onclick: () => invoke('clipboard:write', item.sql) },
                  this.historyMode === 'favorites' && '-',
                  this.historyMode === 'favorites' && {
                    label: 'Delete Favorite',
                    danger: true,
                    onclick: async () => {
                      await invoke('favorites:delete', item.id);
                      refresh();
                    },
                  },
                ]),
            },
            item.name ? el('div.history-name', icon('star', 11), item.name) : null,
            el('div.history-sql', item.sql.length > 220 ? item.sql.slice(0, 220) + '…' : item.sql),
            item.ts
              ? el(
                  'div.history-meta',
                  new Date(item.ts).toLocaleString(),
                  ' · ',
                  item.ok === false ? 'failed' : formatDuration(item.ms),
                )
              : null,
          ),
        ),
      );
    };
    input.addEventListener('input', debounce(refresh, 150));
    setChildren(
      this.side,
      el(
        'div.history-head',
        modeTab('history', 'History'),
        modeTab('favorites', 'Favorites'),
        el('div.spacer'),
        this.historyMode === 'history'
          ? button('', {
              icon: 'trash',
              small: true,
              title: 'Clear this connection’s history',
              onclick: async () => {
                if (
                  await confirmDialog({
                    title: 'Clear the query history?',
                    message: 'This removes the history of this connection.',
                    confirmLabel: 'Clear',
                    danger: true,
                  })
                ) {
                  await invoke('history:clear');
                  refresh();
                }
              },
            })
          : null,
        button('', { icon: 'close', small: true, onclick: () => this.toggleHistory() }),
      ),
      el('div.history-search', input),
      historyList,
    );
    refresh();
  }

  handle(action) {
    switch (action) {
      case 'run-current':
        return this.runCurrent();
      case 'run-all':
        return this.runAll();
      case 'cancel-query':
        return this.cancel();
      case 'format':
        return this.format();
      case 'find':
        return this.editor.find();
      case 'history':
        return this.toggleHistory();
      case 'favorite':
        return this.saveFavorite();
      case 'save-query':
        return this.saveAs();
      case 'export':
        return this.export();
      case 'refresh':
        return this.lastRun ? this.run(this.lastRun.sql) : undefined;
      default:
        return;
    }
  }

  activate() {
    this.editor.focus();
    this.grid.renderRows(true);
  }

  destroy() {
    this.editor.destroy();
    this.grid.destroy();
  }
}
