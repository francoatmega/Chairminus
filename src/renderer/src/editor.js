import { keys } from './dom.js';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MySQL, PostgreSQL, sql, SQLite } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { languageSupport, PLACEHOLDERS } from './languages.js';

const SQL_DIALECTS = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite };

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-number)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-type)' },
  { tag: [tags.special(tags.name), tags.quote, tags.propertyName], color: 'var(--syn-ident)' },
  { tag: tags.operator, color: 'var(--syn-operator)' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-faint)', border: 'none', paddingLeft: '4px' },
  '.cm-activeLine': { backgroundColor: 'var(--row-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow)',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--modified-bg)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    color: 'var(--text-dim)',
  },
});

export function createEditor({
  parent,
  dialect,
  doc = '',
  onChange,
  onRun,
  onRunAll,
  indent = '  ',
  uppercase = true,
}) {
  const compartment = new Compartment();
  const language = (schema) =>
    languageSupport(dialect, schema || {}) ||
    sql({ dialect: SQL_DIALECTS[dialect] || PostgreSQL, schema: schema || {}, upperCaseKeywords: uppercase });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        indentUnit.of(indent),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                if (onRun) onRun();
                return true;
              },
            },
            {
              key: 'Shift-Mod-Enter',
              run: () => {
                if (onRunAll) onRunAll();
                return true;
              },
            },
          ]),
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        compartment.of(language()),
        syntaxHighlighting(highlightStyle),
        editorTheme,
        placeholder(PLACEHOLDERS[dialect] || keys('Write SQL here — ⌘↩ runs the statement under the cursor')),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (insert) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } }),
    insert: (insert) => {
      const main = view.state.selection.main;
      view.dispatch({
        changes: { from: main.from, to: main.to, insert },
        selection: { anchor: main.from + insert.length },
      });
      view.focus();
    },
    cursor: () => view.state.selection.main.head,
    selection: () => {
      const main = view.state.selection.main;
      return main.empty ? '' : view.state.sliceDoc(main.from, main.to);
    },
    select: (anchor, head) => view.dispatch({ selection: { anchor, head }, scrollIntoView: true }),
    setSchema: (schema) => view.dispatch({ effects: compartment.reconfigure(language(schema)) }),
    find: () => openSearchPanel(view),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
