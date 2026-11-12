import { button, clear, el, fuzzyScore, icon, invoke } from './dom.js';

export function modal(render, { width = 460, dismissable = true, className = '' } = {}) {
  return new Promise((resolve) => {
    const activeElement = document.activeElement;
    const overlay = el('div.overlay');
    const dialog = el('div.modal', {
      class: className,
      style: { width: typeof width == 'number' ? width + 'px' : width },
    });
    let closed = false;
    const finish = (result) => {
      if (!closed) {
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        if (activeElement && activeElement.focus) activeElement.focus();
        resolve(result);
      }
    };
    const onKey = (result) => {
      if (overlay === document.body.lastElementChild) {
        if (result.key === 'Escape' && dismissable) {
          result.stopPropagation();
          finish(undefined);
        }
        if (
          result.key === 'Enter' &&
          !result.shiftKey &&
          !(result.target instanceof HTMLTextAreaElement) &&
          !result.target.closest('.cm-editor')
        ) {
          const primary = dialog.querySelector('.btn.primary:not(:disabled)');
          if (primary && !(result.target instanceof HTMLButtonElement)) {
            result.preventDefault();
            result.stopPropagation();
            primary.click();
          }
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (result) => {
      if (result.target === overlay && dismissable) finish(undefined);
    });
    dialog.append(render(finish));
    overlay.append(dialog);
    document.body.append(overlay);
    const focusTarget =
      dialog.querySelector('[autofocus]') ||
      dialog.querySelector('input, textarea, select') ||
      dialog.querySelector('.btn.primary');
    if (focusTarget) {
      focusTarget.focus();
      if (focusTarget.select && focusTarget.type !== 'checkbox') focusTarget.select();
    }
  });
}

function alertDialog(title, message, { danger = false } = {}) {
  return modal((close) =>
    el(
      'div.dialog',
      el('h3', { class: danger ? 'danger-text' : '' }, title),
      message ? el('p.dialog-text', message) : null,
      el('div.dialog-buttons', button('OK', { primary: true, onclick: () => close(true) })),
    ),
  );
}

export function showError(err, title = 'Something went wrong') {
  return alertDialog(title, err && err.message ? err.message : String(err), { danger: true });
}

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return modal((close) =>
    el(
      'div.dialog',
      el('h3', title),
      message ? el('p.dialog-text', message) : null,
      el(
        'div.dialog-buttons',
        button(cancelLabel, { onclick: () => close(false) }),
        button(confirmLabel, { primary: !danger, danger, onclick: () => close(true) }),
      ),
    ),
  ).then((result) => result === true);
}

export function promptDialog({
  title,
  message,
  value = '',
  placeholder = '',
  confirmLabel = 'OK',
  password = false,
  validate,
}) {
  return modal((close) => {
    const input = el('input.input', { type: password ? 'password' : 'text', value, placeholder, autofocus: true });
    const fieldError = el('div.field-error');
    const submit = async () => {
      const problem = validate ? await validate(input.value) : null;
      if (problem) {
        fieldError.textContent = problem;
        input.select();
        return;
      }
      close(input.value);
    };
    return el(
      'div.dialog',
      el('h3', title),
      message ? el('p.dialog-text', message) : null,
      input,
      fieldError,
      el(
        'div.dialog-buttons',
        button('Cancel', { onclick: () => close(undefined) }),
        button(confirmLabel, { primary: true, onclick: submit }),
      ),
    );
  });
}

export function sqlDialog({ title, message, note, sql, confirmLabel = 'Send', danger = false, readOnly = false }) {
  return modal(
    (close) =>
      el(
        'div.dialog',
        el('h3', title),
        message ? el('p.dialog-text', message) : null,
        el('pre.sql-preview', { tabIndex: 0 }, sql),
        note ? el('p.dialog-note', note) : null,
        el(
          'div.dialog-buttons',
          button('Copy SQL', {
            onclick: () => {
              invoke('clipboard:write', sql);
              toast('SQL copied');
            },
          }),
          el('div.spacer'),
          readOnly ? null : button('Cancel', { onclick: () => close(false) }),
          button(readOnly ? 'Close' : confirmLabel, { primary: !danger, danger, onclick: () => close(!readOnly) }),
        ),
      ),
    { width: 640 },
  ).then((result) => result === true);
}

export function confirmByName({ title, message, name, confirmLabel }) {
  return modal((close) => {
    const input = el('input.input', { placeholder: name, autofocus: true });
    const confirmButton = button(confirmLabel, { danger: true, disabled: true, onclick: () => close(true) });
    input.addEventListener('input', () => {
      confirmButton.disabled = input.value !== name;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !confirmButton.disabled) close(true);
    });
    return el(
      'div.dialog',
      el('h3', title),
      el('p.dialog-text', message),
      el('label.field-label', 'Type ', el('b', name), ' to confirm'),
      input,
      el('div.dialog-buttons', button('Cancel', { onclick: () => close(false) }), confirmButton),
    );
  }).then((result) => result === true);
}

let toastHost = null;

export function toast(message, { error = false, ms = 2600 } = {}) {
  if (!toastHost) {
    toastHost = el('div.toasts');
    document.body.append(toastHost);
  }
  const node = el('div.toast', { class: error ? 'error' : '' }, message);
  toastHost.append(node);
  setTimeout(
    () => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 250);
    },
    error ? ms * 2 : ms,
  );
}

let activeMenu = null;

function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

document.addEventListener(
  'mousedown',
  (event) => {
    if (activeMenu && !activeMenu.contains(event.target)) closeMenu();
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') closeMenu();
  },
  true,
);

window.addEventListener('blur', closeMenu);

export function showMenu(event, items) {
  closeMenu();
  if (event.preventDefault) event.preventDefault();
  const menu = buildMenu(items.filter(Boolean));
  activeMenu = menu;
  document.body.append(menu);
  placeMenu(menu, event.clientX ?? event.x, event.clientY ?? event.y);
  return menu;
}

function buildMenu(items) {
  const menu = el('div.menu');
  for (const item of items) {
    if (item === '-') {
      menu.append(el('div.menu-sep'));
      continue;
    }
    const row = el(
      'div.menu-item',
      { class: [item.disabled && 'disabled', item.danger && 'danger'].filter(Boolean).join(' ') },
      el('span.menu-check', item.checked ? '✓' : ''),
      el('span.menu-label', item.label),
      item.hint ? el('span.menu-hint', item.hint) : null,
      item.submenu ? icon('chevron', 11) : null,
    );
    if (item.submenu) {
      let submenu = null;
      row.addEventListener('mouseenter', () => {
        if (submenu) return;
        submenu = buildMenu(item.submenu.filter(Boolean));
        submenu.classList.add('submenu');
        row.append(submenu);
        const rect = row.getBoundingClientRect();
        const offsetWidth = submenu.offsetWidth;
        submenu.style.left = (rect.right + offsetWidth > window.innerWidth ? -offsetWidth + 4 : rect.width - 4) + 'px';
        const overflow = rect.top + submenu.offsetHeight - window.innerHeight + 8;
        submenu.style.top = (overflow > 0 ? -overflow : -5) + 'px';
      });
      row.addEventListener('mouseleave', () => {
        if (submenu) {
          submenu.remove();
          submenu = null;
        }
      });
    } else if (!item.disabled)
      row.addEventListener('mouseup', (submenu) => {
        submenu.stopPropagation();
        closeMenu();
        if (item.onclick) item.onclick();
      });
    menu.append(row);
  }
  return menu;
}

function placeMenu(menu, x, y) {
  const offsetWidth = menu.offsetWidth;
  const offsetHeight = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - offsetWidth - 6)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - offsetHeight - 6)) + 'px';
}

export function showMenuBelow(anchor, items) {
  const rect = anchor.getBoundingClientRect();
  return showMenu({ x: rect.left, y: rect.bottom + 3 }, items);
}

export function quickPick(items, { placeholder = 'Search…', empty = 'No matches' } = {}) {
  return modal(
    (close) => {
      const input = el('input.input.quick-input', { placeholder, autofocus: true, spellcheck: false });
      const quickList = el('div.quick-list');
      let matches = [];
      let active = 0;
      const render = () => {
        const query = input.value.trim();
        matches = items
          .map((it) => ({ it, score: fuzzyScore(query, it.label) }))
          .filter((scored) => scored.score >= 0)
          .sort((first, second) => second.score - first.score || first.it.label.localeCompare(second.it.label))
          .slice(0, 80)
          .map((scored) => scored.it);
        active = Math.min(active, Math.max(0, matches.length - 1));
        clear(quickList);
        if (!matches.length) quickList.append(el('div.quick-empty', empty));
        matches.forEach((match, index) => {
          quickList.append(
            el(
              'div.quick-item',
              {
                class: index === active ? 'active' : '',
                onmousemove: () => {
                  if (active !== index) {
                    active = index;
                    paint();
                  }
                },
                onclick: () => close(match.value),
              },
              match.icon ? icon(match.icon) : null,
              el('span.quick-label', match.label),
              match.detail ? el('span.quick-detail', match.detail) : null,
            ),
          );
        });
      };
      const paint = () => {
        [...quickList.children].forEach((child, index) => child.classList.toggle('active', index === active));
        const current = quickList.children[active];
        if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
      };
      input.addEventListener('input', () => {
        active = 0;
        render();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          active = Math.min(matches.length - 1, active + 1);
          paint();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          active = Math.max(0, active - 1);
          paint();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (matches[active]) close(matches[active].value);
        }
      });
      render();
      return el('div.quick', input, quickList);
    },
    { width: 560, className: 'quick-modal' },
  );
}

export function field(label, control, hint) {
  return el('label.field', el('span.field-label', label), control, hint ? el('span.field-hint', hint) : null);
}

export function select(options, value, onChange) {
  const input = el('select.input', { onchange: () => onChange && onChange(input.value) });
  for (const item of options) {
    const option = typeof item == 'string' ? { value: item, label: item } : item;
    input.append(el('option', { value: String(option.value), disabled: option.disabled }, option.label));
  }
  input.value = String(value ?? '');
  return input;
}

export function checkbox(label, checked, onChange) {
  const input = el('input', {
    type: 'checkbox',
    checked: !!checked,
    onchange: () => onChange && onChange(input.checked),
  });
  const check = el('label.check', input, el('span', label));
  check.input = input;
  return check;
}

export function segmented(options, value, onChange) {
  const group = el('div.segmented');
  const setValue = (option) => {
    group.value = option;
    [...group.children].forEach((child) => child.classList.toggle('active', child.dataset.value === option));
  };
  for (const option of options)
    group.append(
      el(
        'button',
        {
          type: 'button',
          dataset: { value: option.value },
          title: option.title,
          onclick: () => {
            if (group.value !== option.value) {
              setValue(option.value);
              onChange(option.value);
            }
          },
        },
        option.label,
      ),
    );
  group.set = setValue;
  setValue(value);
  return group;
}
