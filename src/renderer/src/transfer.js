import { button, el, formatNumber, invoke, IS_MAC, setChildren } from './dom.js';
import { checkbox, confirmDialog, field, modal, select, showError, toast } from './ui.js';
import { confirmSend } from './safemode.js';
import { quoteIdent } from '../../shared/dialect.js';
import { importStatement } from '../../shared/changes.js';

const EXPORT_FORMATS = [
  { value: 'csv', label: 'CSV', ext: 'csv' },
  { value: 'json', label: 'JSON', ext: 'json' },
  { value: 'sql', label: 'SQL', ext: 'sql' },
  { value: 'markdown', label: 'Markdown', ext: 'md' },
];

const SCRIPT_EXTENSIONS = {
  neo4j: ['cypher', 'cql'],
  mongodb: ['js', 'mongodb'],
  redis: ['redis'],
  elasticsearch: ['es'],
};

const DELIMITERS = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

function progressOverlay(title, onCancel) {
  const progressText = el('div.progress-text', 'Starting…');
  const overlay = el(
    'div.overlay',
    el(
      'div.modal.progress-modal',
      el('h3', title),
      el('div.progress-bar', el('div.progress-fill')),
      progressText,
      el('div.dialog-buttons', button('Cancel', { onclick: onCancel })),
    ),
  );
  document.body.append(overlay);
  const unsubscribe = window.bridge.on('transfer:progress', (progress) => {
    progressText.textContent =
      progress.rows !== undefined
        ? `${formatNumber(progress.rows)} rows`
        : `${formatNumber(progress.statements)} of ${formatNumber(progress.total)} statements`;
  });
  return () => {
    unsubscribe();
    overlay.remove();
  };
}

export function exportDialog(ws, source) {
  const opts = {
    scope: source.table ? 'table' : 'page',
    format: 'csv',
    csv: { delimiter: ',', quoteMode: 'needed', header: true, nullAsEmpty: true, lineBreak: `\n` },
    includeStructure: true,
    includeContent: true,
    dropIfExists: false,
  };
  const formats =
    ws.info.sql === false ? EXPORT_FORMATS.filter((exportFormat) => exportFormat.value !== 'sql') : EXPORT_FORMATS;
  return modal(
    (close) => {
      const formStack = el('div.form-stack');
      const filtered =
        source.table && source.table.filters && source.table.filters.some((filter) => filter.enabled !== false);
      const scopes = [
        source.table && { value: 'table', label: filtered ? 'Every row matching the filters' : 'The whole table' },
        source.page && { value: 'page', label: `Loaded rows (${formatNumber(source.page.rows.length)})` },
        source.selection && {
          value: 'selection',
          label: `Selected rows (${formatNumber(source.selection.rows.length)})`,
        },
      ].filter(Boolean);
      const renderOptions = () => {
        const controls = [];
        if (opts.format === 'csv')
          controls.push(
            field(
              'Delimiter',
              select(DELIMITERS, opts.csv.delimiter, (delimiter) => {
                opts.csv.delimiter = delimiter;
              }),
            ),
            field(
              'Quotes',
              select(
                [
                  { value: 'needed', label: 'Only when needed' },
                  { value: 'always', label: 'Always' },
                ],
                opts.csv.quoteMode,
                (quoteMode) => {
                  opts.csv.quoteMode = quoteMode;
                },
              ),
            ),
            field(
              'Line break',
              select(
                [
                  { value: `\n`, label: 'LF (Unix, macOS)' },
                  {
                    value: `\r
`,
                    label: 'CRLF (Windows)',
                  },
                ],
                opts.csv.lineBreak,
                (lineBreak) => {
                  opts.csv.lineBreak = lineBreak;
                },
              ),
            ),
            checkbox('First line has the column names', opts.csv.header, (header) => {
              opts.csv.header = header;
            }),
            checkbox('Write NULL as an empty value', opts.csv.nullAsEmpty, (nullAsEmpty) => {
              opts.csv.nullAsEmpty = nullAsEmpty;
            }),
          );
        else if (opts.format === 'sql' && opts.scope === 'table')
          controls.push(
            checkbox('Include the table structure (CREATE TABLE)', opts.includeStructure, (includeStructure) => {
              opts.includeStructure = includeStructure;
            }),
            checkbox('Include the rows (INSERT)', opts.includeContent, (includeContent) => {
              opts.includeContent = includeContent;
            }),
            checkbox('Add DROP TABLE IF EXISTS', opts.dropIfExists, (dropIfExists) => {
              opts.dropIfExists = dropIfExists;
            }),
          );
        else if (opts.format === 'sql') controls.push(el('p.muted', 'Rows are written as INSERT statements.'));
        setChildren(formStack, controls);
      };
      const run = async () => {
        const format = EXPORT_FORMATS.find((exportFormat) => exportFormat.value === opts.format);
        const filePath = await invoke('dialog:save', {
          defaultPath: `${source.defaultName}.${format.ext}`,
          filters: [{ name: format.label, extensions: [format.ext] }],
        });
        if (!filePath) return;
        const overlay = progressOverlay('Exporting…', () => invoke('db:cancel').catch(() => {}));
        try {
          let result;
          if (opts.scope === 'table')
            result = await invoke('export:table', {
              schema: source.table.schema,
              table: source.table.name,
              filters: source.table.filters,
              sort: source.table.sort,
              columnNames: source.table.columnNames,
              format: opts.format,
              csv: opts.csv,
              filePath,
              includeStructure: opts.includeStructure,
              includeContent: opts.includeContent,
              dropIfExists: opts.dropIfExists,
            });
          else {
            const rows = opts.scope === 'selection' ? source.selection : source.page;
            result = await invoke('export:rows', {
              filePath,
              format: opts.format,
              names: rows.names,
              rows: rows.rows,
              csv: opts.csv,
              dialect: ws.info.dialect,
              schema: source.table && ws.info.hasSchemas ? source.table.schema : null,
              table: source.table ? source.table.name : source.defaultName,
            });
          }
          overlay();
          close(true);
          if (
            await confirmDialog({
              title: 'Export finished',
              message: `${formatNumber(result.rows)} rows written to ${filePath}`,
              confirmLabel: IS_MAC ? 'Show in Finder' : 'Show in Folder',
              cancelLabel: 'Done',
            })
          )
            invoke('shell:showItem', filePath);
        } catch (err) {
          overlay();
          showError(err, 'The export failed');
        }
      };
      renderOptions();
      return el(
        'div.dialog',
        el('h3', source.title),
        el(
          'div.form-stack',
          field(
            'Rows',
            select(scopes, opts.scope, (scope) => {
              opts.scope = scope;
              renderOptions();
            }),
          ),
          field(
            'Format',
            select(formats, opts.format, (format) => {
              opts.format = format;
              renderOptions();
            }),
          ),
        ),
        formStack,
        el(
          'div.dialog-buttons',
          button('Cancel', { onclick: () => close(false) }),
          button('Export…', { primary: true, onclick: run }),
        ),
      );
    },
    { width: 440 },
  );
}

const MATCH_MODES = [
  { value: 'name-ci', label: 'By name (ignore case)' },
  { value: 'name', label: 'By name' },
  { value: 'order', label: 'By order' },
];

function matchColumns(mode, sourceNames, targetColumns) {
  return sourceNames.map((name, index) =>
    mode === 'order'
      ? targetColumns[index] || ''
      : mode === 'name'
        ? targetColumns.includes(name)
          ? name
          : ''
        : targetColumns.find((target) => target.toLowerCase() === String(name).trim().toLowerCase()) || '',
  );
}

const cleanColumnName = (name, index) =>
  String(name || '')
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '') || `column_${index + 1}`;

export async function importDialog(ws, dest = {}) {
  const isSql = ws.info.sql !== false;
  const scriptExtensions = isSql ? ['sql'] : SCRIPT_EXTENSIONS[ws.info.dialect] || [];
  const dataExtensions = ws.info.canImport === false ? [] : ['csv', 'tsv', 'txt', 'json'];
  const filePath = await invoke('dialog:open', {
    filters: [
      {
        name: isSql ? 'CSV, JSON or SQL' : dataExtensions.length ? 'CSV, JSON or a script' : 'Script',
        extensions: [...dataExtensions, ...scriptExtensions],
      },
    ],
  });
  if (!filePath) return false;
  const ext = filePath.split('.').pop().toLowerCase();
  if (scriptExtensions.includes(ext)) return runScriptFile(ws, filePath);
  if (!dataExtensions.length) {
    toast('Only a file of commands can be run here', { error: true });
    return false;
  }
  const format = ext === 'json' ? 'json' : 'csv';
  const state = {
    delimiter: undefined,
    header: true,
    mode: 'name-ci',
    emptyAsNull: true,
    disableForeignKeys: false,
    create: !dest.table,
    table: dest.table || '',
    newName: cleanColumnName(
      filePath
        .split('/')
        .pop()
        .replace(/\.[^.]+$/, ''),
      0,
    ),
    preview: null,
    targetColumns: dest.columns ? dest.columns.map((column) => column.name) : [],
    mapping: [],
  };
  const tables = ws.objects ? ws.objects.tables.map((table) => table.name) : [];
  return modal(
    (close) => {
      const importBody = el('div.import-body');
      const muted = el('div.muted');
      const previewNames = () => {
        if (!state.preview) return [];
        if (format === 'json') return state.preview.names;
        const first = state.preview.rows[0] || [];
        return state.header
          ? first.map((cell, index) => cell || `column_${index + 1}`)
          : first.map((cell, index) => `column_${index + 1}`);
      };
      const dataRows = () => (format === 'json' || !state.header ? state.preview.rows : state.preview.rows.slice(1));
      const remap = () => {
        const names = previewNames();
        state.mapping = state.create
          ? names.map(cleanColumnName)
          : matchColumns(state.mode, names, state.targetColumns);
      };
      const loadPreview = async () => {
        try {
          state.preview = await invoke('import:preview', { filePath, format, delimiter: state.delimiter });
          if (format === 'csv') state.delimiter = state.preview.delimiter;
          remap();
          render();
        } catch (err) {
          setChildren(importBody, el('div.error-box', el('b', 'The file could not be read'), el('pre', err.message)));
        }
      };
      const loadTarget = async () => {
        if (state.create || !state.table) {
          state.targetColumns = [];
          remap();
          render();
          return;
        }
        try {
          const desc = await invoke('db:describe', dest.schema ?? ws.schema, state.table);
          state.targetColumns = desc.columns.map((column) => column.name);
        } catch {
          state.targetColumns = [];
        }
        remap();
        render();
      };
      const render = () => {
        if (!state.preview) {
          setChildren(importBody, el('div.loading', 'Reading the file…'));
          return;
        }
        const names = previewNames();
        const rows = dataRows();
        const length = state.mapping.filter(Boolean).length;
        muted.textContent = state.create
          ? `File ${names.length} columns · ${isSql ? `a new table with ${length} text columns` : `${length} fields, created with the first row`}`
          : `File ${names.length} columns, table ${state.targetColumns.length} columns, matched ${length} columns`;
        const tableSelect = select(
          [{ value: '', label: isSql ? 'New table…' : 'New…' }, ...tables.map((label) => ({ value: label, label }))],
          state.create ? '' : state.table,
          (table) => {
            state.create = table === '';
            state.table = table;
            loadTarget();
          },
        );
        setChildren(
          importBody,
          el(
            'div.form-row',
            field('Into', tableSelect),
            state.create
              ? field(
                  isSql ? 'Table name' : 'Name',
                  el('input.input', {
                    value: state.newName,
                    oninput: (event) => {
                      state.newName = event.target.value;
                    },
                  }),
                )
              : field(
                  'Match columns',
                  select(MATCH_MODES, state.mode, (mode) => {
                    state.mode = mode;
                    remap();
                    render();
                  }),
                ),
            format === 'csv'
              ? field(
                  'Delimiter',
                  select(DELIMITERS, state.delimiter, (delimiter) => {
                    state.delimiter = delimiter;
                    loadPreview();
                  }),
                )
              : null,
          ),
          el(
            'div.form-row',
            format === 'csv'
              ? checkbox('First line is the header', state.header, (header) => {
                  state.header = header;
                  remap();
                  render();
                })
              : null,
            checkbox('Empty values become NULL', state.emptyAsNull, (emptyAsNull) => {
              state.emptyAsNull = emptyAsNull;
            }),
            ws.info.dialect === 'mysql' || ws.info.dialect === 'sqlite'
              ? checkbox('Disable foreign key checks', state.disableForeignKeys, (disableForeignKeys) => {
                  state.disableForeignKeys = disableForeignKeys;
                })
              : null,
          ),
          state.preview.truncated
            ? el('div.error-box', 'The CSV file was truncated unexpectedly, please check the file encoding.')
            : null,
          el(
            'div.import-table-wrap',
            el(
              'table.simple-table.import-table',
              el(
                'thead',
                el(
                  'tr',
                  el('th', 'File column'),
                  el('th', state.create ? 'New column' : isSql ? 'Table column' : 'Field'),
                  el('th', 'Sample'),
                ),
              ),
              el(
                'tbody',
                names.map((name, index) =>
                  el(
                    'tr',
                    el('td', el('b', name)),
                    el(
                      'td',
                      state.create
                        ? el('input.input.small', {
                            value: state.mapping[index],
                            placeholder: 'skip',
                            oninput: (event) => {
                              state.mapping[index] = event.target.value.trim();
                            },
                          })
                        : (() => {
                            const targetSelect = select(
                              [
                                { value: '', label: 'Do not import' },
                                ...state.targetColumns.map((label) => ({ value: label, label })),
                              ],
                              state.mapping[index] || '',
                              (chosen) => {
                                state.mapping[index] = chosen;
                                render();
                              },
                            );
                            targetSelect.classList.add('small');
                            return targetSelect;
                          })(),
                    ),
                    el(
                      'td.muted.sample',
                      rows
                        .slice(0, 3)
                        .map((row) =>
                          row[index] === null || row[index] === undefined ? 'NULL' : String(row[index]).slice(0, 40),
                        )
                        .join('  ·  '),
                    ),
                  ),
                ),
              ),
            ),
          ),
          muted,
        );
      };
      const run = async () => {
        const sourceNames = previewNames();
        const mapping = state.mapping.map((target, source) => ({ source, target })).filter((entry) => entry.target);
        if (!mapping.length) {
          toast('No column is mapped', { error: true });
          return;
        }
        const duplicate = mapping.map((entry) => entry.target).find((name, index, all) => all.indexOf(name) !== index);
        if (duplicate) {
          toast(`“${duplicate}” is mapped more than once`, { error: true });
          return;
        }
        const table = state.create ? state.newName.trim() : state.table;
        if (!table) {
          toast('Choose the table to import into', { error: true });
          return;
        }
        const dialect = ws.info.dialect;
        const schema = dest.schema ?? ws.schema;
        const statement = importStatement(
          dialect,
          ws.info.hasSchemas ? schema : null,
          table,
          mapping.map((entry) => entry.target),
          filePath.split('/').pop(),
        );
        if (
          !(await confirmSend(
            ws,
            [state.create && isSql ? `CREATE TABLE ${quoteIdent(dialect, table)} (…)` : null, statement].filter(
              Boolean,
            ),
          ))
        )
          return;
        const overlay = progressOverlay('Importing…', () => invoke('db:cancel').catch(() => {}));
        try {
          const result = await invoke('import:run', {
            filePath,
            format,
            delimiter: state.delimiter,
            header: state.header,
            schema,
            table,
            sourceNames,
            mapping,
            emptyAsNull: state.emptyAsNull,
            disableForeignKeys: state.disableForeignKeys,
            createTable: state.create ? { name: table, columns: mapping.map((entry) => entry.target) } : null,
          });
          overlay();
          close(true);
          toast(`${formatNumber(result.rows)} rows imported into ${result.table}`);
          if (state.create) ws.reloadObjects();
        } catch (err) {
          overlay();
          showError(
            err,
            ws.info.transactional === false ? 'The import failed' : 'The import failed — nothing was imported',
          );
        }
      };
      loadPreview();
      return el(
        'div.dialog',
        el('h3', `Import ${filePath.split('/').pop()}`),
        importBody,
        el(
          'div.dialog-buttons',
          button('Cancel', { onclick: () => close(false) }),
          button('Import', { primary: true, onclick: run }),
        ),
      );
    },
    { width: 720 },
  ).then((result) => result === true);
}

async function runScriptFile(ws, filePath) {
  const fileName = filePath.split('/').pop();
  if (
    !(await confirmDialog({
      title: `Run ${fileName}?`,
      message: `Every statement in this file is sent to “${ws.info.name}”, in order, stopping at the first error. Statements that already ran are not undone.`,
      confirmLabel: 'Run File',
    }))
  )
    return false;
  const sample =
    ws.info.dialect === 'neo4j'
      ? `// every statement in ${fileName}\nCREATE …`
      : `-- every statement in ${fileName}\nUPDATE …`;
  if (!(await confirmSend(ws, [sample], { confirmed: true }))) return false;
  const overlay = progressOverlay(`Running ${fileName}…`, () => invoke('db:cancel').catch(() => {}));
  try {
    const result = await invoke('import:sql', { filePath });
    overlay();
    toast(`${formatNumber(result.statements)} statements ran`);
    ws.reloadObjects();
    return true;
  } catch (err) {
    overlay();
    await showError(err, 'The file stopped with an error');
    ws.reloadObjects();
    return true;
  }
}
