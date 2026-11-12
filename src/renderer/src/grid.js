import { clear, el, icon, IS_MAC } from './dom.js';
import { displayValue, editText, isNumericType } from '../../shared/dialect.js';
import { toTsv } from '../../shared/format.js';

const ROW_HEIGHT = 26;

const GUTTER_WIDTH = 48;

const MAX_AUTO_WIDTH = 300;

export function arraySource(rows) {
  return {
    rowCount: () => rows.length,
    value: (row, col) => rows[row][col],
    rowState: () => '',
    modified: () => false,
  };
}

export class Grid {
  constructor(opts = {}) {
    this.opts = opts;
    this.columns = [];
    this.source = arraySource([]);
    this.widths = {};
    this.hidden = new Set();
    this.visible = [];
    this.sort = [];
    this.active = { row: -1, col: 0 };
    this.selected = new Set();
    this.anchor = -1;
    this.range = [-1, -1];
    this.editor = null;
    this.head = el('div.grid-head');
    this.body = el('div.grid-body');
    this.empty = el('div.grid-empty');
    this.el = el('div.grid', { tabIndex: 0 }, this.head, this.body, this.empty);
    this.el.addEventListener('scroll', () => this.renderRows());
    this.el.addEventListener('keydown', (event) => this.onKey(event));
    this.el.addEventListener('copy', (event) => this.onCopy(event));
    this.el.addEventListener('paste', (event) => this.onPasteEvent(event));
    this.body.addEventListener('mousedown', (event) => this.onMouseDown(event));
    this.body.addEventListener('contextmenu', (event) => {
      const hit = this.hit(event);
      if (hit) {
        if (this.selected.has(hit.row)) {
          if (hit.col !== -1) this.setActive(hit.row, hit.col);
        } else this.select(hit.row, hit.col === -1 ? this.active.col : hit.col, {});
        if (this.opts.onContext) this.opts.onContext(event, hit);
      }
    });
    this.resizeObserver = new ResizeObserver(() => this.renderRows(true));
    this.resizeObserver.observe(this.el);
  }

  setData(columns, source, { keepPosition = false } = {}) {
    this.cancelEdit();
    const sameColumns =
      keepPosition &&
      columns.length === this.columns.length &&
      columns.every((column, index) => column.name === this.columns[index].name);
    this.columns = columns;
    this.source = source;
    if (sameColumns) this.clampSelection();
    else {
      this.active = { row: source.rowCount() ? 0 : -1, col: 0 };
      this.selected = new Set(source.rowCount() ? [0] : []);
      this.anchor = 0;
      this.el.scrollTop = 0;
      this.el.scrollLeft = 0;
    }
    this.layout();
  }

  clampSelection() {
    const count = this.source.rowCount();
    this.selected = new Set([...this.selected].filter((row) => row < count));
    if (this.active.row >= count) this.active.row = count - 1;
    if (this.active.row >= 0 && !this.selected.size) this.selected.add(this.active.row);
  }

  width(col) {
    const column = this.columns[col];
    if (this.widths[column.name]) return this.widths[column.name];
    let chars = column.name.length + 2;
    const sample = Math.min(this.source.rowCount(), 40);
    for (let row = 0; row < sample; row++) {
      const value = this.source.value(row, col);
      const len = value == null ? 4 : Math.min(displayValue(value).length, 44);
      if (len > chars) chars = len;
    }
    const width = Math.max(64, Math.min(360, Math.round(chars * 7.4 + 26)));
    this.widths[column.name] = width;
    return width;
  }

  layout() {
    this.visible = this.columns.map((column, index) => index).filter((col) => !this.hidden.has(this.columns[col].name));
    this.lefts = [];
    let totalWidth = GUTTER_WIDTH;
    for (const col of this.visible) {
      this.lefts[col] = totalWidth;
      totalWidth += this.width(col);
    }
    this.totalWidth = totalWidth;
    clear(this.head);
    this.head.style.width = totalWidth + 'px';
    this.head.append(el('div.grid-corner', { style: { width: GUTTER_WIDTH + 'px' } }));
    for (const col of this.visible) {
      const column = this.columns[col];
      const sorted = this.sort.find((entry) => entry.column === column.name);
      const gridHcell = el(
        'div.grid-hcell',
        {
          style: { width: this.width(col) + 'px' },
          title: `${column.name}${column.type ? ' · ' + column.type : ''}${column.comment ? `\n` + column.comment : ''}`,
          onclick: (event) => {
            if (this.opts.onSort && !this.resizing) this.opts.onSort(column.name, event.shiftKey);
          },
          oncontextmenu: (event) => {
            if (this.opts.onHeaderContext) this.opts.onHeaderContext(event, col);
          },
        },
        column.pk ? el('span.hcell-key', { title: 'Primary key' }, icon('key', 11)) : null,
        column.fk ? el('span.hcell-key.fk', { title: `References ${column.fk.refTable}` }, icon('link', 11)) : null,
        el('span.hcell-name', column.name),
        column.type ? el('span.hcell-type', column.type) : null,
        sorted ? el('span.hcell-sort', sorted.dir === 'desc' ? '▼' : '▲') : null,
        el('span.hcell-resize', {
          onmousedown: (event) => this.startResize(event, col),
          onclick: (event) => event.stopPropagation(),
          ondblclick: (event) => {
            event.stopPropagation();
            this.autoSize(col);
          },
        }),
      );
      this.head.append(gridHcell);
    }
    this.renderRows(true);
  }

  refresh() {
    this.clampSelection();
    this.renderRows(true);
  }

  setSort(sort) {
    this.sort = sort || [];
    this.layout();
  }

  setHidden(hidden) {
    this.hidden = new Set(hidden);
    this.layout();
  }

  renderRows(force) {
    const count = this.source.rowCount();
    this.body.style.height = count * ROW_HEIGHT + 'px';
    this.body.style.width = this.totalWidth + 'px';
    this.empty.textContent = count ? '' : this.opts.emptyText || 'No rows';
    this.empty.style.display = count ? 'none' : '';
    const scrollTop = this.el.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
    const last = Math.min(count - 1, Math.ceil((scrollTop + this.el.clientHeight) / ROW_HEIGHT) + 6);
    if (!force && first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];
    const documentFragment = document.createDocumentFragment();
    for (let row = first; row <= last; row++) documentFragment.append(this.renderRow(row));
    const editor = this.editor && this.editor.el;
    clear(this.body);
    this.body.append(documentFragment);
    if (editor) this.body.append(editor);
  }

  renderRow(row) {
    const state = this.source.rowState(row);
    const gridRow = el('div.grid-row', {
      class: [row % 2 ? 'odd' : '', state, this.selected.has(row) ? 'selected' : ''].filter(Boolean).join(' '),
      style: { top: row * ROW_HEIGHT + 'px', width: this.totalWidth + 'px' },
    });
    gridRow.dataset.row = row;
    gridRow.append(
      el(
        'div.grid-num',
        { style: { width: GUTTER_WIDTH + 'px' } },
        state === 'inserted'
          ? '+'
          : state === 'deleted'
            ? '−'
            : String(row + 1 + (this.opts.rowOffset ? this.opts.rowOffset() : 0)),
      ),
    );
    for (const col of this.visible) {
      const value = this.source.value(row, col);
      const div = document.createElement('div');
      let cls = 'grid-cell';
      if (value === null) {
        cls += ' null';
        div.textContent = 'NULL';
      } else if (value === undefined) {
        cls += ' null';
        div.textContent = 'DEFAULT';
      } else {
        let text = displayValue(value);
        if (text.length > MAX_AUTO_WIDTH) text = text.slice(0, MAX_AUTO_WIDTH) + '…';
        if (text.includes(`\n`)) text = text.replace(/\r?\n/g, ' ↵ ');
        div.textContent = text;
        if (typeof value == 'number' || isNumericType(this.columns[col].type)) cls += ' num';
        else if (typeof value == 'object') cls += ' special';
      }
      if (this.source.modified(row, col)) cls += ' modified';
      if (row === this.active.row && col === this.active.col) cls += ' active';
      div.className = cls;
      div.style.width = this.width(col) + 'px';
      div.dataset.col = col;
      gridRow.append(div);
    }
    return gridRow;
  }

  hit(event) {
    const rowEl = event.target.closest('.grid-row');
    if (!rowEl) return null;
    const cellEl = event.target.closest('.grid-cell');
    return { row: Number(rowEl.dataset.row), col: cellEl ? Number(cellEl.dataset.col) : -1 };
  }

  onMouseDown(event) {
    if (event.button !== 0 || (this.editor && this.editor.el.contains(event.target))) return;
    const hit = this.hit(event);
    if (hit) {
      this.commitEdit();
      this.select(hit.row, hit.col === -1 ? this.active.col : hit.col, {
        toggle: IS_MAC ? event.metaKey : event.ctrlKey,
        extend: event.shiftKey,
      });
      this.focus();
      if (event.detail === 2 && hit.col !== -1 && !(IS_MAC ? event.metaKey : event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        if (this.opts.editable) this.startEdit(hit.row, hit.col);
        else if (this.opts.onOpen) this.opts.onOpen(hit.row, hit.col);
      }
    }
  }

  select(anchor, col, { toggle, extend } = {}) {
    if (extend && this.anchor >= 0) {
      const [from, to] = [Math.min(this.anchor, anchor), Math.max(this.anchor, anchor)];
      this.selected = new Set();
      for (let row = from; row <= to; row++) this.selected.add(row);
    } else if (toggle) {
      if (this.selected.has(anchor) && this.selected.size > 1) this.selected.delete(anchor);
      else this.selected.add(anchor);
      this.anchor = anchor;
    } else {
      this.selected = new Set([anchor]);
      this.anchor = anchor;
    }
    this.setActive(anchor, col);
  }

  setActive(row, col) {
    this.active = { row, col };
    this.paintSelection();
    this.reveal(row, col);
    if (this.opts.onActivate) this.opts.onActivate(row, col);
  }

  paintSelection() {
    for (const child of this.body.children) {
      if (child.dataset.row === undefined) continue;
      const row = Number(child.dataset.row);
      child.classList.toggle('selected', this.selected.has(row));
      const previous = child.querySelector('.grid-cell.active');
      if (previous) previous.classList.remove('active');
      if (row === this.active.row) {
        const cell = child.querySelector(`.grid-cell[data-col="${this.active.col}"]`);
        if (cell) cell.classList.add('active');
      }
    }
  }

  reveal(row, col) {
    const viewport = this.el;
    const offsetHeight = this.head.offsetHeight;
    const scrollTop = row * ROW_HEIGHT;
    if (scrollTop < viewport.scrollTop) viewport.scrollTop = scrollTop;
    else if (scrollTop + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight - offsetHeight)
      viewport.scrollTop = scrollTop + ROW_HEIGHT - viewport.clientHeight + offsetHeight;
    if (this.lefts[col] === undefined) return;
    const left = this.lefts[col];
    const width = this.width(col);
    if (left - GUTTER_WIDTH < viewport.scrollLeft) viewport.scrollLeft = left - GUTTER_WIDTH;
    else if (left + width > viewport.scrollLeft + viewport.clientWidth)
      viewport.scrollLeft = left + width - viewport.clientWidth;
  }

  selectedRows() {
    return [...this.selected].sort((e, t) => e - t);
  }

  focus() {
    this.el.focus({ preventScroll: true });
  }

  onKey(event) {
    if (this.editor) return;
    const count = this.source.rowCount();
    if (!count) return;
    const { row, col } = this.active;
    const index = this.visible.indexOf(col);
    const page = Math.max(1, Math.floor(this.el.clientHeight / ROW_HEIGHT) - 2);
    const move = (anchor, col) => {
      event.preventDefault();
      anchor = Math.max(0, Math.min(count - 1, anchor));
      this.select(anchor, col, { extend: event.shiftKey });
    };
    const visibleAt = (index) => this.visible[Math.max(0, Math.min(this.visible.length - 1, index))];
    if (event.metaKey || event.ctrlKey) {
      if (event.key === 'a') {
        event.preventDefault();
        this.selected = new Set(Array.from({ length: count }, (h, row) => row));
        this.paintSelection();
      } else if (event.key === 'ArrowUp') move(0, col);
      else if (event.key === 'ArrowDown') move(count - 1, col);
      return;
    }
    switch (event.key) {
      case 'ArrowUp':
        move(row - 1, col);
        break;
      case 'ArrowDown':
        move(row + 1, col);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.select(row, visibleAt(index - 1), {});
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.select(row, visibleAt(index + 1), {});
        break;
      case 'Tab':
        event.preventDefault();
        this.select(row, visibleAt(index + (event.shiftKey ? -1 : 1)), {});
        break;
      case 'PageUp':
        move(row - page, col);
        break;
      case 'PageDown':
        move(row + page, col);
        break;
      case 'Home':
        event.preventDefault();
        this.select(row, visibleAt(0), {});
        break;
      case 'End':
        event.preventDefault();
        this.select(row, visibleAt(this.visible.length - 1), {});
        break;
      case 'Enter':
      case 'F2':
        event.preventDefault();
        this.startEdit(row, col);
        break;
      case 'Backspace':
      case 'Delete':
        if (this.opts.onDelete) {
          event.preventDefault();
          this.opts.onDelete(this.selectedRows());
        }
        break;
      default:
        if (event.key.length === 1 && !event.altKey && this.opts.editable) {
          event.preventDefault();
          this.startEdit(row, col, event.key);
        }
    }
  }

  onCopy(event) {
    if (this.editor || this.active.row < 0) return;
    const selectedRows = this.selectedRows();
    const text =
      selectedRows.length > 1
        ? toTsv(selectedRows.map((row) => this.visible.map((col) => this.source.value(row, col) ?? null)))
        : editText(this.source.value(this.active.row, this.active.col));
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }

  onPasteEvent(event) {
    if (!(this.editor || !this.opts.onPaste)) {
      event.preventDefault();
      this.opts.onPaste(event.clipboardData.getData('text/plain'));
    }
  }

  startEdit(row, col, key) {
    if (
      !this.opts.editable ||
      row < 0 ||
      this.lefts[col] === undefined ||
      this.source.rowState(row) === 'deleted' ||
      (this.opts.canEdit && !this.opts.canEdit(row, col))
    )
      return;
    const original = editText(this.source.value(row, col));
    if (key === undefined && (original.length > 160 || original.includes(`\n`)) && this.opts.onEditLong) {
      this.opts.onEditLong(row, col);
      return;
    }
    this.cancelEdit();
    const gridEditor = el('input.grid-editor', {
      value: key !== undefined ? key : original,
      spellcheck: false,
      style: {
        left: this.lefts[col] + 'px',
        top: row * ROW_HEIGHT + 'px',
        width: this.width(col) + 'px',
        height: ROW_HEIGHT + 'px',
      },
    });
    this.editor = { el: gridEditor, row, col, original };
    gridEditor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitEdit();
        this.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelEdit();
        this.focus();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        this.commitEdit();
        const next = this.visible.indexOf(col) + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < this.visible.length) {
          this.select(row, this.visible[next], {});
          this.startEdit(row, this.visible[next]);
        } else this.focus();
      }
    });
    gridEditor.addEventListener('blur', () => this.commitEdit());
    this.body.append(gridEditor);
    gridEditor.focus();
    if (key === undefined) gridEditor.select();
  }

  commitEdit() {
    const editor = this.editor;
    if (!editor) return;
    this.editor = null;
    const value = editor.el.value;
    editor.el.remove();
    if (value !== editor.original && this.opts.onEdit) this.opts.onEdit(editor.row, editor.col, value);
    this.renderRows(true);
  }

  cancelEdit() {
    const editor = this.editor;
    if (editor) {
      this.editor = null;
      editor.el.remove();
    }
  }

  startResize(event, col) {
    event.preventDefault();
    event.stopPropagation();
    const clientX = event.clientX;
    const startWidth = this.width(col);
    const name = this.columns[col].name;
    this.resizing = true;
    const onMove = (event) => {
      this.widths[name] = Math.max(40, startWidth + event.clientX - clientX);
      this.layout();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setTimeout(() => {
        this.resizing = false;
      }, 0);
      if (this.opts.onResize) this.opts.onResize(name, this.widths[name]);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  autoSize(col) {
    const name = this.columns[col].name;
    let chars = name.length + 4;
    const sample = Math.min(this.source.rowCount(), 300);
    for (let row = 0; row < sample; row++) {
      const value = this.source.value(row, col);
      chars = Math.max(chars, value == null ? 4 : Math.min(displayValue(value).length, 120));
    }
    this.widths[name] = Math.round(chars * 7.4 + 26);
    this.layout();
    if (this.opts.onResize) this.opts.onResize(name, this.widths[name]);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.el.remove();
  }
}
