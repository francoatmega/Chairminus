import { button, clear, debounce, el, formatDuration, formatNumber, icon, invoke, keys, setChildren } from './dom.js';
import { confirmDialog, modal, segmented, select, showError, showMenu, showMenuBelow, sqlDialog, toast } from './ui.js';
import { confirmSend } from './safemode.js';
import { Grid } from './grid.js';
import { ANY_COLUMN, OPERATORS } from '../../shared/filters.js';
import { buildChangeStatements } from '../../shared/changes.js';
import { editText, isNumericType, isTextType, qualified, sameValue } from '../../shared/dialect.js';
import { toCsv, toInserts, toJson, toMarkdown, toTsv } from '../../shared/format.js';
import { joinStatements } from '../../shared/tokenizer.js';
import { exportDialog, importDialog } from './transfer.js';

const OPERATOR_BY_ID = Object.fromEntries(OPERATORS.map((operator) => [operator.id, operator]));

const PAGE_SIZES = [100, 300, 500, 1000, 5000];

const RAW_FILTERS = {
  mongodb: { label: 'Raw filter', prefix: 'FIND', placeholder: 'e.g.  { age: { $gt: 30 }, status: "open" }' },
  redis: { label: 'Key pattern', prefix: 'MATCH', placeholder: 'e.g.  user:*:session' },
  elasticsearch: {
    label: 'Query string',
    prefix: 'QUERY',
    placeholder: 'e.g.  status:open AND price:>10   (or a query as JSON)',
  },
  neo4j: { label: 'Raw Cypher', prefix: 'WHERE', placeholder: "e.g.  n.price > 10 AND n.status = 'open'" },
};

const STRUCTURE_LABELS = {
  mongodb: { columns: 'Fields', checks: 'Validator', ddl: 'Definition' },
  redis: { columns: 'Columns' },
  elasticsearch: { columns: 'Fields', ddl: 'Definition' },
  neo4j: { columns: 'Properties', checks: 'Constraints', ddl: 'Definition' },
};

export class TableTab {
  constructor(ws, { schema, name, kind = 'table', filters }) {
    this.ws = ws;
    this.type = 'table';
    this.schema = schema;
    this.name = name;
    this.objectKind = kind;
    this.title = name;
    this.icon = kind === 'table' ? 'table' : 'view';
    this.preview = true;
    this.mode = 'data';
    this.desc = null;
    this.columns = [];
    this.rows = [];
    this.offset = 0;
    this.limit = ws.settings.limitRows || 300;
    this.total = null;
    this.sort = [];
    this.filters = filters || [];
    this.draft = filters && filters.length ? filters.map((rule) => ({ ...rule })) : [];
    this.showFilters = !!(filters && filters.length);
    this.pending = { edits: new Map(), deleted: new Set(), inserted: [] };
    this.loadSeq = 0;
    this.structTab = 'columns';
    this.grid = new Grid({
      editable: kind === 'table',
      rowOffset: () => this.offset,
      onEdit: (row, index, text) => this.editCell(row, index, text),
      onEditLong: (row, index) => this.editInPopup(row, index),
      onOpen: (row, index) => this.editInPopup(row, index),
      onSort: (column, additive) => this.toggleSort(column, additive),
      onContext: (event, hit) => this.cellMenu(event, hit),
      onHeaderContext: (event, col) => this.headerMenu(event, col),
      onActivate: () => this.renderDetail(),
      onDelete: (selectedRows) => this.deleteRows(selectedRows),
      onPaste: (text) => this.pasteToSelection(text),
      onResize: () => this.saveViewState(),
      emptyText: 'No rows',
    });
    this.source = {
      rowCount: () => this.rows.length + this.pending.inserted.length,
      value: (row, index) => this.valueAt(row, index),
      rowState: (row) => (row >= this.rows.length ? 'inserted' : this.pending.deleted.has(row) ? 'deleted' : ''),
      modified: (row, col) => {
        const edits = row < this.rows.length && this.pending.edits.get(row);
        return !!edits && this.columns[col].name in edits;
      },
    };
    this.toolbar = el('div.tab-toolbar');
    this.filterBar = el('div.filter-bar');
    this.main = el('div.table-main');
    this.detail = el('div.detail-panel');
    this.footer = el('div.tab-footer');
    this.el = el(
      'div.tab-content.table-tab',
      this.toolbar,
      this.filterBar,
      el('div.table-split', this.main, this.detail),
      this.footer,
    );
    this.saveViewState = debounce(() => this.persistViewState(), 400);
    this.init();
  }

  get dirty() {
    const pending = this.pending;
    return pending.edits.size > 0 || pending.deleted.size > 0 || pending.inserted.length > 0;
  }

  get editable() {
    return this.objectKind === 'table';
  }

  get sql() {
    return this.ws.info.sql !== false;
  }

  get stateKey() {
    return `table/${this.ws.info.database}/${this.schema || ''}/${this.name}`;
  }

  async init() {
    this.renderToolbar();
    setChildren(this.main, el('div.loading', 'Loading…'));
    try {
      const [desc, viewState] = await Promise.all([
        invoke('db:describe', this.schema, this.name),
        invoke('viewstate:get', this.stateKey).catch(() => null),
      ]);
      this.desc = desc;
      this.objectKind = desc.kind || this.objectKind;
      this.grid.opts.editable = this.editable;
      if (viewState) {
        this.grid.widths = viewState.widths || {};
        this.grid.hidden = new Set(viewState.hidden || []);
        if (viewState.limit) this.limit = viewState.limit;
        if (!this.filters.length && viewState.filters && viewState.filters.length) {
          this.draft = viewState.filters.map((filter) => ({ ...filter }));
          this.filters = this.draft.map((rule) => ({ ...rule }));
          this.showFilters = true;
        }
      }
      this.renderFilters();
      await this.load();
    } catch (err) {
      setChildren(
        this.main,
        el(
          'div.error-box',
          el('b', 'Could not open this table'),
          el('pre', err.message),
          button('Retry', { onclick: () => this.init() }),
        ),
      );
    }
  }

  persistViewState() {
    invoke('viewstate:set', this.stateKey, {
      widths: this.grid.widths,
      hidden: [...this.grid.hidden],
      limit: this.limit,
      filters: this.filters,
    }).catch(() => {});
  }

  request() {
    return {
      schema: this.schema,
      table: this.name,
      filters: this.filters,
      sort: this.sort,
      columns: this.columnTypes(),
      primaryKey: this.desc.primaryKey,
    };
  }

  columnTypes() {
    const described = this.desc.columns.map((column) => ({ name: column.name, type: column.type }));
    if (this.sql) return described;
    const loaded = new Map(this.columns.map((column) => [column.name, column.type]));
    const known = new Set(described.map((column) => column.name));
    return [
      ...described.map((column) => ({ name: column.name, type: loaded.get(column.name) || column.type })),
      ...this.columns
        .filter((column) => !known.has(column.name))
        .map((column) => ({ name: column.name, type: column.type })),
    ];
  }

  async load({ keepPosition = false } = {}) {
    const loadSeq = ++this.loadSeq;
    this.setBusy(true);
    try {
      const page = await invoke('db:fetchPage', { ...this.request(), limit: this.limit, offset: this.offset });
      if (loadSeq !== this.loadSeq) return;
      const described = new Map(this.desc.columns.map((column) => [column.name, column]));
      this.columns = page.fields.map((field) => {
        const meta = described.get(field.name) || {};
        const fk = this.desc.foreignKeys.find(
          (foreignKey) => foreignKey.columns.length === 1 && foreignKey.columns[0] === field.name,
        );
        const type = this.sql ? meta.type || field.type : field.type || meta.type;
        return {
          name: field.name,
          type,
          pk: !!meta.pk,
          fk,
          comment: meta.comment,
          nullable: meta.nullable !== false,
          meta,
        };
      });
      this.rows = page.rows;
      this.loadMs = page.ms;
      this.pending = { edits: new Map(), deleted: new Set(), inserted: [] };
      this.grid.sort = this.sort;
      this.grid.setData(this.columns, this.source, { keepPosition });
      if (this.mode === 'data') setChildren(this.main, this.grid.el);
      this.afterChange();
      this.loadCount(loadSeq);
    } catch (err) {
      if (loadSeq !== this.loadSeq) return;
      setChildren(
        this.main,
        el(
          'div.error-box',
          el('b', 'The query failed'),
          el('pre', err.message),
          el(
            'div.row',
            button('Retry', { onclick: () => this.load() }),
            this.filters.length ? button('Clear filters', { onclick: () => this.clearFilters() }) : null,
          ),
        ),
      );
      this.renderFooter();
    } finally {
      if (loadSeq === this.loadSeq) this.setBusy(false);
    }
  }

  async loadCount(loadSeq, exact = false) {
    this.total = null;
    this.renderFooter();
    try {
      const total = await invoke('db:count', { ...this.request(), exact });
      if (loadSeq !== this.loadSeq) return;
      this.total = total;
    } catch {}
    this.renderFooter();
  }

  setBusy(busy) {
    this.busy = busy;
    this.el.classList.toggle('busy', busy);
  }

  async refresh() {
    if (await this.confirmDiscard()) {
      if (this.mode === 'structure') {
        this.desc = await invoke('db:describe', this.schema, this.name).catch(() => this.desc);
        this.renderStructure();
        return;
      }
      await this.load({ keepPosition: true });
    }
  }

  async confirmDiscard() {
    return this.dirty
      ? confirmDialog({
          title: 'Discard all changes?',
          message: keys('This table has edits that were not committed. Tip: commit them with ⌘S.'),
          confirmLabel: 'Discard',
          danger: true,
        })
      : true;
  }

  valueAt(row, index) {
    const name = this.columns[index].name;
    if (row >= this.rows.length) return this.pending.inserted[row - this.rows.length].values[name];
    const edits = this.pending.edits.get(row);
    return edits && name in edits ? edits[name] : this.rows[row][index];
  }

  rowObject(row) {
    const object = {};
    this.columns.forEach((column, index) => {
      object[column.name] = this.rows[row][index];
    });
    return object;
  }

  parseInput(text, column, previous) {
    if (text === '')
      return previous == null
        ? previous === undefined
          ? undefined
          : null
        : isTextType(column.type) || !column.type
          ? ''
          : null;
    if (
      this.ws.info.dialect !== 'postgres' &&
      (typeof previous == 'number' || isNumericType(column.type)) &&
      /^-?\d+(\.\d+)?$/.test(text)
    ) {
      const number = Number(text);
      if (Number.isSafeInteger(number) || (text.includes('.') && String(number) === text)) return number;
    }
    return !this.sql &&
      (typeof previous == 'boolean' || /^bool/i.test(column.type || '')) &&
      /^(true|false)$/i.test(text)
      ? text.toLowerCase() === 'true'
      : text;
  }

  setValue(row, index, label) {
    const name = this.columns[index].name;
    if (row >= this.rows.length) {
      const values = this.pending.inserted[row - this.rows.length].values;
      if (label === undefined) delete values[name];
      else values[name] = label;
      return;
    }
    if (this.pending.deleted.has(row)) return;
    const edits = this.pending.edits.get(row) || {};
    if (sameValue(this.rows[row][index], label) || (this.rows[row][index] === null && label === null))
      delete edits[name];
    else edits[name] = label;
    if (Object.keys(edits).length) this.pending.edits.set(row, edits);
    else this.pending.edits.delete(row);
  }

  editCell(row, index, text) {
    this.setValue(row, index, this.parseInput(text, this.columns[index], this.valueAt(row, index)));
    this.afterChange();
  }

  setCells(selectedRows, index, label) {
    for (const row of selectedRows) this.setValue(row, index, label);
    this.afterChange();
  }

  afterChange() {
    this.grid.refresh();
    this.renderToolbar();
    this.renderDetail();
    this.renderFooter();
    this.ws.tabChanged(this);
  }

  insertRow(values = {}) {
    if (!this.editable) return;
    this.pending.inserted.push({ values: { ...values } });
    const anchor = this.source.rowCount() - 1;
    this.grid.refresh();
    const col = this.grid.visible.find((col) => !this.columns[col].meta.autoIncrement) ?? this.grid.visible[0] ?? 0;
    this.grid.select(anchor, col, {});
    this.afterChange();
    this.grid.focus();
  }

  duplicateRows() {
    if (this.editable) {
      for (const row of this.grid.selectedRows()) {
        const values = {};
        this.columns.forEach((column, index) => {
          if (column.pk && column.meta.autoIncrement) return;
          const value = this.valueAt(row, index);
          if (value !== undefined) values[column.name] = value;
        });
        this.pending.inserted.push({ values });
      }
      this.afterChange();
    }
  }

  deleteRows(selectedRows) {
    if (!this.editable || !selectedRows.length) return;
    const inserted = selectedRows.filter((row) => row >= this.rows.length).sort((first, second) => second - first);
    for (const row of inserted) this.pending.inserted.splice(row - this.rows.length, 1);
    const existing = selectedRows.filter((row) => row < this.rows.length);
    const length = existing.length && existing.every((row) => this.pending.deleted.has(row));
    for (const row of existing)
      if (length) this.pending.deleted.delete(row);
      else {
        this.pending.deleted.add(row);
        this.pending.edits.delete(row);
      }
    this.afterChange();
  }

  pasteToSelection(text) {
    if (!this.editable || this.grid.active.row < 0) return;
    const col = this.grid.active.col;
    const clean = text.replace(/\r?\n$/, '');
    for (const row of this.grid.selectedRows())
      this.setValue(row, col, this.parseInput(clean, this.columns[col], this.valueAt(row, col)));
    this.afterChange();
  }

  async editInPopup(row, index) {
    const column = this.columns[index];
    const value = this.valueAt(row, index);
    const result = await modal(
      (close) => {
        const input = el('textarea.input.value-editor', {
          value: editText(value),
          spellcheck: false,
          autofocus: true,
          readOnly: !this.editable,
        });
        const formatJson = () => {
          try {
            input.value = JSON.stringify(JSON.parse(input.value), null, 2);
          } catch {
            toast('Not valid JSON', { error: true });
          }
        };
        return el(
          'div.dialog',
          el('h3', column.name, el('span.muted', `  ${column.type || ''}`)),
          input,
          el(
            'div.dialog-buttons',
            button('Format JSON', { onclick: formatJson }),
            this.editable && column.nullable ? button('Set NULL', { onclick: () => close({ value: null }) }) : null,
            el('div.spacer'),
            button(this.editable ? 'Cancel' : 'Close', { onclick: () => close(undefined) }),
            this.editable ? button('Apply', { primary: true, onclick: () => close({ value: input.value }) }) : null,
          ),
        );
      },
      { width: 620 },
    );
    if (result) {
      this.setValue(row, index, result.value === null ? null : this.parseInput(result.value, column, value));
      this.afterChange();
      this.grid.focus();
    }
  }

  changes() {
    const pending = this.pending;
    const changes = [];
    for (const [row, edits] of pending.edits)
      if (!pending.deleted.has(row)) changes.push({ type: 'update', original: this.rowObject(row), set: edits });
    for (const row of pending.deleted) changes.push({ type: 'delete', original: this.rowObject(row) });
    for (const inserted of pending.inserted) changes.push({ type: 'insert', values: inserted.values });
    return changes;
  }

  changeRequest(rowIdentity = false) {
    return {
      schema: this.schema,
      table: this.name,
      changes: this.changes(),
      rowIdentity,
      columns: this.columnTypes(),
      primaryKey: this.desc.primaryKey,
    };
  }

  previewStatements(rowIdentity = false) {
    const request = this.changeRequest(rowIdentity);
    return buildChangeStatements({
      ...request,
      dialect: this.ws.info.dialect,
      schema: this.ws.info.hasSchemas ? this.schema : null,
    }).map((statement) => statement.sql);
  }

  previewSql() {
    if (!this.dirty) {
      toast('There are no pending changes');
      return;
    }
    let statements;
    try {
      statements = this.previewStatements();
    } catch (err) {
      showError(err, 'These changes cannot be saved');
      return;
    }
    sqlDialog({
      title: this.sql ? 'Preview SQL' : 'Preview Changes',
      message:
        this.ws.info.transactional === false
          ? 'These statements are sent in this order when you commit. This database has no transaction to group them: if one fails, the ones before it stay applied.'
          : 'These statements are sent, in one transaction, when you commit.',
      sql: joinStatements(statements, this.ws.info.dialect),
      readOnly: true,
    });
  }

  async discard() {
    if (this.dirty && (await this.confirmDiscard())) {
      this.pending = { edits: new Map(), deleted: new Set(), inserted: [] };
      this.afterChange();
    }
  }

  async commit(confirmed = false) {
    this.grid.commitEdit();
    if (!this.dirty || this.committing) return;
    let statements;
    try {
      statements = this.previewStatements(confirmed);
    } catch (err) {
      await showError(err, 'These changes cannot be saved');
      return;
    }
    if (await confirmSend(this.ws, statements, { confirmed })) {
      this.committing = true;
      this.setBusy(true);
      try {
        const result = await invoke('db:applyChanges', this.changeRequest(confirmed));
        if (result.ok) {
          toast(`${result.applied} ${result.applied === 1 ? 'change' : 'changes'} committed`);
          this.pending = { edits: new Map(), deleted: new Set(), inserted: [] };
          await this.load({ keepPosition: true });
          return;
        }
        if (result.applied) {
          await showError(
            new Error(
              `${result.reason === 'missing' ? 'A row no longer matches what was loaded — it was probably changed or deleted by someone else.' : result.error || 'A change was refused.'}\n\n${result.applied} ${result.applied === 1 ? 'change was' : 'changes were'} already saved before that, and this database cannot undo them. The rest was not applied. The table is reloaded now; make the remaining changes again.`,
            ),
            'The commit stopped part of the way',
          );
          this.pending = { edits: new Map(), deleted: new Set(), inserted: [] };
          await this.load({ keepPosition: true });
          return;
        }
        if (result.reason === 'multiple' && !confirmed && this.sql) {
          if (
            await sqlDialog({
              title: 'Nothing was saved',
              message: `This change would affect ${result.affected} rows, not one: the table has no primary key, and these rows are identical. Add a primary key, change the rows with a SQL query, or save again using the row’s physical identity, which changes only one of them.`,
              sql: this.previewStatements(true).join(`;\n`) + ';',
              confirmLabel: 'Save Again with Row Identity',
            })
          ) {
            this.committing = false;
            await this.commit(true);
          }
          return;
        }
        await showError(
          new Error(
            result.reason === 'missing'
              ? 'A row no longer matches what was loaded — it was probably changed or deleted by someone else. Nothing was saved. Refresh the table and try again.'
              : result.reason === 'error'
                ? result.error
                : `The change would affect ${result.affected} rows instead of one. Nothing was saved.`,
          ),
          'Nothing was saved',
        );
      } catch (err) {
        await showError(err, 'The commit failed — nothing was saved');
      } finally {
        this.committing = false;
        this.setBusy(false);
      }
    }
  }

  renderToolbar() {
    const dirty = this.dirty;
    const pendingCount = this.pending.edits.size + this.pending.deleted.size + this.pending.inserted.length;
    setChildren(
      this.toolbar,
      segmented(
        [
          { value: 'data', label: 'Data' },
          { value: 'structure', label: 'Structure' },
        ],
        this.mode,
        (mode) => this.setMode(mode),
      ),
      this.mode === 'data'
        ? [
            button('Filter', {
              icon: 'filter',
              small: true,
              title: keys('Filter rows (⌘F)'),
              onclick: () => this.toggleFilters(),
            }),
            this.filters.length
              ? el('span.badge', String(this.filters.filter((filter) => filter.enabled !== false).length))
              : null,
            button('Columns', {
              icon: 'columns',
              small: true,
              onclick: (event) => this.columnsMenu(event.currentTarget),
            }),
            this.editable
              ? button('Row', {
                  icon: 'plus',
                  small: true,
                  title: keys('Insert a row (⌘I)'),
                  onclick: () => this.insertRow(),
                })
              : null,
          ]
        : null,
      el('div.spacer'),
      dirty ? el('span.pending-note', `${pendingCount} pending ${pendingCount === 1 ? 'change' : 'changes'}`) : null,
      dirty ? button(this.sql ? 'Preview SQL' : 'Preview', { small: true, onclick: () => this.previewSql() }) : null,
      dirty ? button('Discard', { small: true, onclick: () => this.discard() }) : null,
      dirty
        ? button('Commit', { small: true, primary: true, title: keys('Commit changes (⌘S)'), onclick: () => this.commit() })
        : null,
      this.editable ? null : el('span.muted', this.readOnlyNote()),
      button('', { icon: 'download', small: true, title: keys('Export… (⌘E)'), onclick: () => this.export() }),
      this.editable && this.ws.info.canImport !== false
        ? button('', { icon: 'upload', small: true, title: 'Import…', onclick: () => this.import() })
        : null,
      button('', { icon: 'refresh', small: true, title: keys('Refresh (⌘R)'), onclick: () => this.refresh() }),
    );
  }

  readOnlyNote() {
    return this.desc && this.desc.note
      ? this.desc.note
      : this.ws.info.dialect === 'elasticsearch'
        ? this.objectKind === 'matview'
          ? 'Data stream — read only'
          : 'Alias — read only'
        : this.objectKind === 'matview'
          ? 'Materialized view — read only'
          : 'View — read only';
  }

  renderFooter() {
    if (this.mode !== 'data') {
      clear(this.footer);
      return;
    }
    const length = this.rows.length;
    const first = length ? this.offset + 1 : 0;
    const last = this.offset + length;
    let countEl = null;
    if (this.total)
      countEl = this.total.estimated
        ? el(
            'a.link',
            {
              title: 'This is the server’s estimate. Click for an exact count.',
              onclick: () => this.loadCount(this.loadSeq, true),
            },
            `of ~${formatNumber(this.total.count)}`,
          )
        : el('span', `of ${formatNumber(this.total.count)}`);
    const atEnd = length < this.limit || (this.total && !this.total.estimated && last >= this.total.count);
    const sizeSelect = select(
      PAGE_SIZES.includes(this.limit)
        ? PAGE_SIZES.map(String)
        : [...PAGE_SIZES, this.limit].sort((l, a) => l - a).map(String),
      String(this.limit),
      (l) => this.setLimit(Number(l)),
    );
    sizeSelect.classList.add('small');
    setChildren(
      this.footer,
      el('span.footer-rows', length ? `Rows ${formatNumber(first)}–${formatNumber(last)} ` : 'No rows ', countEl),
      this.filters.some((filter) => filter.enabled !== false) ? el('span.badge.soft', 'filtered') : null,
      this.pending.inserted.length ? el('span.muted', `+${this.pending.inserted.length} new`) : null,
      el('div.spacer'),
      this.loadMs !== undefined ? el('span.muted', formatDuration(this.loadMs)) : null,
      el('span.muted', 'Rows per page'),
      sizeSelect,
      button('', {
        icon: 'left',
        small: true,
        title: 'Previous page',
        disabled: this.offset === 0,
        onclick: () => this.page(-1),
      }),
      el('span.page-no', `Page ${Math.floor(this.offset / this.limit) + 1}`),
      button('', { icon: 'right', small: true, title: 'Next page', disabled: !!atEnd, onclick: () => this.page(1) }),
    );
  }

  async page(direction) {
    if (await this.confirmDiscard()) {
      this.offset = Math.max(0, this.offset + direction * this.limit);
      await this.load();
    }
  }

  async setLimit(limit) {
    if (!(await this.confirmDiscard())) {
      this.renderFooter();
      return;
    }
    this.limit = limit;
    this.offset = 0;
    this.saveViewState();
    await this.load();
  }

  async toggleSort(column, additive) {
    if (!(await this.confirmDiscard())) return;
    const current = this.sort.find((entry) => entry.column === column);
    const next = current ? (current.dir === 'asc' ? { column, dir: 'desc' } : null) : { column, dir: 'asc' };
    const others = additive ? this.sort.filter((entry) => entry.column !== column) : [];
    this.sort = next ? [...others, next] : others;
    this.offset = 0;
    await this.load();
  }

  async setSort(sort) {
    if (await this.confirmDiscard()) {
      this.sort = sort;
      this.offset = 0;
      await this.load();
    }
  }

  async setMode(mode) {
    if (mode !== this.mode) {
      if (mode === 'structure' && !(await this.confirmDiscard())) {
        this.renderToolbar();
        return;
      }
      this.mode = mode;
      this.el.classList.toggle('structure-mode', mode === 'structure');
      this.renderToolbar();
      this.renderFilters();
      this.renderDetail();
      this.renderFooter();
      if (mode === 'structure') this.renderStructure();
      else if (this.desc) {
        setChildren(this.main, this.grid.el);
        this.grid.layout();
      }
    }
  }

  toggleFilters() {
    this.showFilters = !this.showFilters;
    if (this.showFilters && !this.draft.length) this.draft.push(this.newRule());
    this.renderFilters();
    if (this.showFilters) {
      const firstValue = this.filterBar.querySelector('.filter-value');
      if (firstValue) firstValue.focus();
    } else this.grid.focus();
  }

  newRule(name) {
    return {
      column: name || ANY_COLUMN,
      op: name ? '=' : 'contains',
      value: '',
      value2: '',
      caseSensitive: false,
      enabled: true,
    };
  }

  renderFilters() {
    if (!this.showFilters || this.mode !== 'data' || !this.desc) {
      clear(this.filterBar);
      this.filterBar.style.display = 'none';
      return;
    }
    this.filterBar.style.display = '';
    const columnOptions = [
      { value: ANY_COLUMN, label: 'Any column' },
      ...this.columnTypes().map((column) => ({ value: column.name, label: column.name })),
    ];
    const raw = RAW_FILTERS[this.ws.info.dialect] || {
      label: 'Raw SQL',
      prefix: 'WHERE',
      placeholder: "e.g.  price > 10 AND status = 'open'",
    };
    const rows = this.draft.map((rule, index) => {
      const o = OPERATOR_BY_ID[rule.op] || OPERATOR_BY_ID['='];
      const onEnter = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.applyFilters();
        }
      };
      const input = el('input.input.small.filter-value', {
        value: rule.value ?? '',
        spellcheck: false,
        placeholder: o.raw ? raw.placeholder : rule.op === 'in' || rule.op === 'not_in' ? 'a, b, c' : 'value',
        oninput: (event) => {
          rule.value = event.target.value;
        },
        onkeydown: onEnter,
      });
      const secondInput = o.two
        ? el('input.input.small.filter-value2', {
            value: rule.value2 ?? '',
            placeholder: 'and',
            oninput: (event) => {
              rule.value2 = event.target.value;
            },
            onkeydown: onEnter,
          })
        : null;
      const hasCase = ['contains', 'not_contains', 'prefix', 'suffix'].includes(rule.op);
      const columnSelect = select(columnOptions, rule.column, (column) => {
        rule.column = column;
      });
      const operatorSelect = select(
        OPERATORS.map((operator) => ({ value: operator.id, label: operator.raw ? raw.label : operator.label })),
        rule.op,
        (op) => {
          rule.op = op;
          this.renderFilters();
        },
      );
      columnSelect.classList.add('small');
      operatorSelect.classList.add('small');
      return el(
        'div.filter-rule',
        el('input', {
          type: 'checkbox',
          checked: rule.enabled !== false,
          title: 'Use this rule',
          onchange: (event) => {
            rule.enabled = event.target.checked;
          },
        }),
        o.raw ? el('span.filter-raw-label', raw.prefix) : columnSelect,
        operatorSelect,
        o.none ? el('div.filter-value-none') : input,
        secondInput,
        hasCase
          ? el(
              'button.btn.small.toggle',
              {
                type: 'button',
                class: rule.caseSensitive ? 'on' : '',
                title: 'Match case',
                onclick: () => {
                  rule.caseSensitive = !rule.caseSensitive;
                  this.renderFilters();
                },
              },
              'Aa',
            )
          : null,
        button('', {
          icon: 'minus',
          small: true,
          title: 'Remove this rule',
          onclick: () => {
            this.draft.splice(index, 1);
            if (!this.draft.length) this.draft.push(this.newRule());
            this.renderFilters();
          },
        }),
        button('', {
          icon: 'plus',
          small: true,
          title: 'Add a rule',
          onclick: () => {
            this.draft.splice(index + 1, 0, this.newRule());
            this.renderFilters();
          },
        }),
      );
    });
    setChildren(
      this.filterBar,
      rows,
      el(
        'div.filter-actions',
        button('Apply', { small: true, primary: true, onclick: () => this.applyFilters() }),
        button('Clear', { small: true, onclick: () => this.clearFilters() }),
        button(this.sql ? 'SQL' : 'Query', {
          small: true,
          icon: 'sql',
          title: 'Show the query these rules produce',
          onclick: () => this.previewFilterSql(),
        }),
        el('span.muted', 'Rules are combined with AND'),
      ),
    );
  }

  async applyFilters() {
    if (await this.confirmDiscard()) {
      this.filters = this.draft.filter((rule) => OPERATOR_BY_ID[rule.op]).map((rule) => ({ ...rule }));
      this.offset = 0;
      this.saveViewState();
      this.renderToolbar();
      await this.load();
    }
  }

  async clearFilters() {
    this.draft = [this.newRule()];
    this.renderFilters();
    if (this.filters.length) {
      this.filters = [];
      this.offset = 0;
      this.saveViewState();
      this.renderToolbar();
      await this.load();
    }
  }

  async previewFilterSql() {
    try {
      const sql = await invoke('db:filterPreview', {
        ...this.request(),
        filters: this.draft,
        limit: this.limit,
        offset: this.offset,
      });
      sqlDialog({ title: 'Filter query', sql, readOnly: true });
    } catch (err) {
      showError(err);
    }
  }

  filterBy(name, op, value) {
    const rule = { ...this.newRule(name), op, value: value === null ? '' : editText(value) };
    this.draft = this.draft.filter((existing) => existing.value !== '' || OPERATOR_BY_ID[existing.op].none);
    this.draft.push(rule);
    this.showFilters = true;
    this.renderFilters();
    this.applyFilters();
  }

  copyRows(format) {
    const selectedRows = this.grid.selectedRows();
    const visible = this.grid.visible;
    const names = visible.map((col) => this.columns[col].name);
    const rows = selectedRows.map((row) => visible.map((index) => this.valueAt(row, index) ?? null));
    const dialect = this.ws.info.dialect;
    const text =
      format === 'csv'
        ? toCsv(names, rows)
        : format === 'json'
          ? toJson(names, rows, { inflate: !this.sql })
          : format === 'markdown'
            ? toMarkdown(names, rows)
            : format === 'sql'
              ? toInserts(dialect, this.ws.info.hasSchemas ? this.schema : null, this.name, names, rows)
              : toTsv(rows);
    invoke('clipboard:write', text);
    toast(`${selectedRows.length} ${selectedRows.length === 1 ? 'row' : 'rows'} copied`);
  }

  cellMenu(event, hit) {
    const selectedRows = this.grid.selectedRows();
    const many = selectedRows.length > 1;
    const index = hit.col === -1 ? this.grid.active.col : hit.col;
    const column = this.columns[index];
    const value = this.valueAt(hit.row, index);
    const deleted = hit.row < this.rows.length && this.pending.deleted.has(hit.row);
    const editable = this.editable && !deleted;
    const label = this.ws.info.dialect === 'sqlite' ? "datetime('now')" : 'NOW()';
    showMenu(event, [
      {
        label: 'Copy Cell Value',
        hint: keys('⌘C'),
        onclick: () => {
          invoke('clipboard:write', editText(value));
        },
      },
      {
        label: many ? `Copy ${selectedRows.length} Rows As` : 'Copy Row As',
        submenu: [
          { label: 'Tab-separated', onclick: () => this.copyRows('tsv') },
          { label: 'CSV', onclick: () => this.copyRows('csv') },
          { label: 'JSON', onclick: () => this.copyRows('json') },
          this.sql && { label: 'SQL INSERT', onclick: () => this.copyRows('sql') },
          { label: 'Markdown Table', onclick: () => this.copyRows('markdown') },
        ],
      },
      { label: 'Copy Column Name', onclick: () => invoke('clipboard:write', column.name) },
      '-',
      editable && { label: 'Edit in Popup…', onclick: () => this.editInPopup(hit.row, index) },
      !editable && { label: 'View Value…', onclick: () => this.editInPopup(hit.row, index) },
      editable && {
        label: 'Set Value',
        submenu: [
          { label: 'NULL', disabled: !column.nullable, onclick: () => this.setCells(selectedRows, index, null) },
          { label: 'Empty string', onclick: () => this.setCells(selectedRows, index, '') },
          this.sql && { label: 'DEFAULT', onclick: () => this.setCells(selectedRows, index, { __expr: 'DEFAULT' }) },
          this.sql && { label, onclick: () => this.setCells(selectedRows, index, { __expr: label }) },
          this.sql && {
            label: 'CURRENT_DATE',
            onclick: () => this.setCells(selectedRows, index, { __expr: 'CURRENT_DATE' }),
          },
          column.meta.enumValues && '-',
          ...(column.meta.enumValues || [])
            .slice(0, 30)
            .map((label) => ({ label, onclick: () => this.setCells(selectedRows, index, label) })),
        ],
      },
      editable && {
        label: 'Paste to Selected Cells',
        onclick: async () => this.pasteToSelection(await invoke('clipboard:read')),
      },
      '-',
      {
        label: 'Filter by This Value',
        onclick: () =>
          value === null ? this.filterBy(column.name, 'null', null) : this.filterBy(column.name, '=', value),
      },
      column.fk &&
        value !== null &&
        value !== undefined && {
          label: `Go to ${column.fk.refTable}`,
          onclick: () =>
            this.ws.openTable(column.fk.refSchema || this.schema, column.fk.refTable, 'table', {
              pin: true,
              filters: [{ column: column.fk.refColumns[0], op: '=', value: editText(value), enabled: true }],
            }),
        },
      this.editable && '-',
      this.editable && { label: 'Insert Row', hint: keys('⌘I'), onclick: () => this.insertRow() },
      this.editable && {
        label: many ? 'Duplicate Rows' : 'Duplicate Row',
        hint: keys('⌘D'),
        onclick: () => this.duplicateRows(),
      },
      this.editable && {
        label: deleted ? 'Restore Row' : many ? `Delete ${selectedRows.length} Rows` : 'Delete Row',
        hint: '⌫',
        danger: !deleted,
        onclick: () => this.deleteRows(selectedRows),
      },
    ]);
  }

  headerMenu(event, t) {
    const column = this.columns[t];
    const sorted = this.sort.find((entry) => entry.column === column.name);
    showMenu(event, [
      {
        label: 'Sort Ascending',
        checked: sorted && sorted.dir === 'asc',
        onclick: () => this.setSort([{ column: column.name, dir: 'asc' }]),
      },
      {
        label: 'Sort Descending',
        checked: sorted && sorted.dir === 'desc',
        onclick: () => this.setSort([{ column: column.name, dir: 'desc' }]),
      },
      { label: 'Remove Sort', disabled: !this.sort.length, onclick: () => this.setSort([]) },
      '-',
      {
        label: 'Filter with Column',
        onclick: () => {
          this.draft.push(this.newRule(column.name));
          this.showFilters = true;
          this.renderFilters();
          const inputs = this.filterBar.querySelectorAll('.filter-value');
          if (inputs.length) inputs[inputs.length - 1].focus();
        },
      },
      { label: 'Copy Column Name', onclick: () => invoke('clipboard:write', column.name) },
      {
        label: 'Copy All Column Values',
        onclick: () => {
          invoke('clipboard:write', this.rows.map((row, index) => editText(this.valueAt(index, t))).join(`\n`));
          toast('Column values copied');
        },
      },
      '-',
      {
        label: 'Hide This Column',
        onclick: () => {
          this.grid.hidden.add(column.name);
          this.grid.layout();
          this.saveViewState();
        },
      },
      {
        label: 'Expand Columns to Fit Content',
        onclick: () => {
          this.grid.visible.forEach((col) => this.grid.autoSize(col));
          this.saveViewState();
        },
      },
      {
        label: 'Reset Column Widths',
        onclick: () => {
          this.grid.widths = {};
          this.grid.layout();
          this.saveViewState();
        },
      },
    ]);
  }

  columnsMenu(currentTarget) {
    const hidden = this.grid.hidden;
    showMenuBelow(currentTarget, [
      {
        label: 'Show All Columns',
        disabled: !hidden.size,
        onclick: () => {
          this.grid.setHidden([]);
          this.saveViewState();
        },
      },
      '-',
      ...this.columns.map((column) => ({
        label: column.name,
        checked: !hidden.has(column.name),
        onclick: () => {
          if (hidden.has(column.name)) hidden.delete(column.name);
          else if (this.grid.visible.length > 1) hidden.add(column.name);
          this.grid.layout();
          this.saveViewState();
        },
      })),
    ]);
  }

  renderDetail() {
    const showDetail = this.ws.showDetail && this.mode === 'data';
    this.detail.style.display = showDetail ? '' : 'none';
    if (!showDetail) return;
    const row = this.grid.active.row;
    if (row < 0 || row >= this.source.rowCount()) {
      setChildren(this.detail, el('div.detail-empty', 'Select a row to see its fields'));
      return;
    }
    const state = this.source.rowState(row);
    const fields = this.columns.map((column, index) => {
      const value = this.valueAt(row, index);
      const input = el('textarea.input.detail-value', {
        value: editText(value),
        rows: 1,
        spellcheck: false,
        placeholder: value === null ? 'NULL' : value === undefined ? 'DEFAULT' : 'EMPTY',
        readOnly: !this.editable || state === 'deleted',
        class: this.source.modified(row, index) ? 'modified' : '',
      });
      const autoGrow = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(180, input.scrollHeight + 2) + 'px';
        input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
      };
      input.addEventListener('input', () => {
        autoGrow();
        this.setValue(
          row,
          index,
          this.parseInput(
            input.value,
            column,
            this.valueAt(row, index) ?? (row < this.rows.length ? this.rows[row][index] : undefined),
          ),
        );
        input.classList.toggle('modified', this.source.modified(row, index));
        this.grid.refresh();
        this.renderToolbar();
        this.ws.tabChanged(this);
      });
      requestAnimationFrame(autoGrow);
      return el(
        'div.detail-field',
        el(
          'div.detail-label',
          column.pk ? icon('key', 11) : null,
          el('span.detail-name', column.name),
          el('span.detail-type', column.type || ''),
        ),
        input,
      );
    });
    const scrollTop = this.detail.scrollTop;
    setChildren(
      this.detail,
      el(
        'div.detail-head',
        state === 'inserted' ? 'New row' : `Row ${this.offset + row + 1}`,
        state === 'deleted' ? el('span.badge.danger', 'will be deleted') : null,
      ),
      fields,
    );
    this.detail.scrollTop = scrollTop;
  }

  renderStructure() {
    const desc = this.desc;
    if (!desc) return;
    const sql = this.sql;
    const labels = STRUCTURE_LABELS[this.ws.info.dialect] || {};
    const tabs = [
      { value: 'columns', label: `${labels.columns || 'Columns'} ${desc.columns.length}` },
      sql || desc.indexes.length ? { value: 'indexes', label: `Indexes ${desc.indexes.length}` } : null,
      sql ? { value: 'fks', label: `Foreign Keys ${desc.foreignKeys.length}` } : null,
      sql ? { value: 'triggers', label: `Triggers ${desc.triggers.length}` } : null,
      desc.checks && desc.checks.length
        ? { value: 'checks', label: `${labels.checks || 'Checks'} ${desc.checks.length}` }
        : null,
      sql || labels.ddl ? { value: 'ddl', label: labels.ddl || 'DDL' } : null,
    ].filter(Boolean);
    const structBody = el('div.struct-body');
    const simpleTable = (headers, rows) =>
      el(
        'table.simple-table',
        el(
          'thead',
          el(
            'tr',
            headers.map((header) => el('th', header)),
          ),
        ),
        el(
          'tbody',
          rows.length
            ? rows.map((row) =>
                el(
                  'tr',
                  row.map((cell) => el('td', cell)),
                ),
              )
            : el('tr', el('td.muted', { colSpan: headers.length }, 'None')),
        ),
      );
    const show = async (structTab) => {
      this.structTab = structTab;
      if (structTab === 'columns')
        setChildren(
          structBody,
          simpleTable(
            ['#', 'Column', 'Type', 'Nullable', 'Default', 'Key', 'Extra', 'Comment'],
            desc.columns.map((column, index) => [
              String(index + 1),
              el('b', column.name),
              el('code', column.type),
              column.nullable ? 'yes' : el('span.badge.soft', 'NOT NULL'),
              column.default === null || column.default === undefined
                ? el('span.muted', '—')
                : el('code', String(column.default)),
              column.pk
                ? el('span.badge', 'PK')
                : desc.foreignKeys.some((foreignKey) => foreignKey.columns.includes(column.name))
                  ? el('span.badge.soft', 'FK')
                  : '',
              [
                column.autoIncrement ? 'auto increment' : '',
                column.generated ? 'generated' : '',
                column.collation || '',
              ]
                .filter(Boolean)
                .join(', '),
              column.comment || '',
            ]),
          ),
        );
      else if (structTab === 'indexes')
        setChildren(
          structBody,
          simpleTable(
            ['Name', 'Columns', 'Unique', 'Method', 'Definition'],
            desc.indexes.map((index) => [
              el('b', index.name),
              index.columns.join(', '),
              index.primary ? el('span.badge', 'PRIMARY') : index.unique ? el('span.badge.soft', 'UNIQUE') : 'no',
              index.method || '',
              el('code', index.definition || ''),
            ]),
          ),
        );
      else if (structTab === 'fks')
        setChildren(
          structBody,
          simpleTable(
            ['Name', 'Columns', 'References', 'Definition'],
            desc.foreignKeys.map((foreignKey) => [
              el('b', foreignKey.name),
              foreignKey.columns.join(', '),
              el(
                'a.link',
                {
                  onclick: () =>
                    this.ws.openTable(foreignKey.refSchema || this.schema, foreignKey.refTable, 'table', { pin: true }),
                },
                `${foreignKey.refTable} (${foreignKey.refColumns.join(', ')})`,
              ),
              el('code', foreignKey.definition || ''),
            ]),
          ),
        );
      else if (structTab === 'triggers')
        setChildren(
          structBody,
          simpleTable(
            ['Name', 'Definition'],
            desc.triggers.map((trigger) => [el('b', trigger.name), el('pre.cell-pre', trigger.definition || '')]),
          ),
        );
      else if (structTab === 'checks')
        setChildren(
          structBody,
          simpleTable(
            ['Name', 'Definition'],
            desc.checks.map((check) => [el('b', check.name), el('code', check.definition || '')]),
          ),
        );
      else {
        setChildren(structBody, el('div.loading', 'Loading…'));
        try {
          const text = await invoke('db:ddl', this.schema, this.name, this.objectKind);
          if (this.structTab !== 'ddl') return;
          setChildren(
            structBody,
            el(
              'div.ddl-actions',
              button('Copy', {
                small: true,
                onclick: () => {
                  invoke('clipboard:write', text);
                  toast(`${labels.ddl || 'DDL'} copied`);
                },
              }),
              button('Open in Query Editor', {
                small: true,
                onclick: () => this.ws.newQuery(text, `${this.name} DDL`),
              }),
            ),
            el('pre.ddl', text),
          );
        } catch (err) {
          setChildren(structBody, el('div.error-box', el('pre', err.message)));
        }
      }
    };
    setChildren(this.main, el('div.struct', el('div.struct-tabs', segmented(tabs, this.structTab, show)), structBody));
    show(tabs.some((tab) => tab.value === this.structTab) ? this.structTab : 'columns');
  }

  export() {
    const names = this.grid.visible.map((col) => this.columns[col].name);
    const selectedRows = this.grid.selectedRows();
    exportDialog(this.ws, {
      title: `Export ${this.name}`,
      table: {
        schema: this.schema,
        name: this.name,
        filters: this.filters,
        sort: this.sort,
        columnNames: this.grid.hidden.size ? names : null,
      },
      page: this.rows.length
        ? {
            names,
            rows: this.rows.map((row, index) => this.grid.visible.map((col) => this.valueAt(index, col) ?? null)),
          }
        : null,
      selection:
        selectedRows.length > 1
          ? {
              names,
              rows: selectedRows.map((row) => this.grid.visible.map((index) => this.valueAt(row, index) ?? null)),
            }
          : null,
      defaultName: this.name,
    });
  }

  async import() {
    if (!(await this.confirmDiscard())) return;
    const imported = await importDialog(this.ws, { schema: this.schema, table: this.name, columns: this.desc.columns });
    if (imported) this.load();
  }

  handle(action) {
    switch (action) {
      case 'commit':
        return this.commit();
      case 'preview':
        return this.previewSql();
      case 'discard':
        return this.discard();
      case 'refresh':
        return this.refresh();
      case 'insert-row':
        return this.mode === 'data' && this.insertRow();
      case 'duplicate-row':
        return this.mode === 'data' && this.duplicateRows();
      case 'delete-row':
        return this.mode === 'data' && this.deleteRows(this.grid.selectedRows());
      case 'find':
        return this.mode === 'data' && this.toggleFilters();
      case 'toggle-structure':
        return this.setMode(this.mode === 'data' ? 'structure' : 'data');
      case 'export':
        return this.export();
      case 'import':
        return this.editable && this.ws.info.canImport !== false && this.import();
      default:
        return;
    }
  }

  activate() {
    this.renderDetail();
    if (this.mode === 'data') {
      this.grid.renderRows(true);
      this.grid.focus();
    }
  }

  describeTarget() {
    return qualified(this.ws.info.dialect, this.ws.info.hasSchemas ? this.schema : null, this.name);
  }

  destroy() {
    this.grid.destroy();
  }
}
