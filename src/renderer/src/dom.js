export const IS_MAC = (window.bridge && window.bridge.platform) === 'darwin';

// Shortcut hints are written the macOS way (⇧⌘F); elsewhere they read Ctrl+Shift+F.
export function keys(text) {
  if (IS_MAC) return text;
  return text.replace(/([⇧⌥]*)⌘(↩|.)/g, (all, mods, key) =>
    ['Ctrl', mods.includes('⇧') && 'Shift', mods.includes('⌥') && 'Alt', key === '↩' ? 'Enter' : key].filter(Boolean).join('+'),
  );
}

export function el(selector, attrs, ...children) {
  const [tag, ...classes] = selector.split('.');
  const element = document.createElement(tag || 'div');
  if (classes.length) element.className = classes.join(' ');
  if (attrs != null && (typeof attrs != 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [key, value] of Object.entries(attrs || {}))
    if (!(value == null || value === false)) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') element.className += (element.className ? ' ' : '') + value;
      else if (key === 'style' && typeof value == 'object') Object.assign(element.style, value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key in element && key !== 'list') element[key] = value;
      else element.setAttribute(key, value === true ? '' : value);
    }
  appendChildren(element, children);
  return element;
}

function appendChildren(parent, children) {
  for (const child of children)
    if (!(child == null || child === false)) {
      if (Array.isArray(child)) appendChildren(parent, child);
      else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  return parent;
}

export function clear(node) {
  for (; node.firstChild;) node.removeChild(node.firstChild);
  return node;
}

export function setChildren(node, ...children) {
  clear(node);
  return appendChildren(node, children);
}

export async function invoke(channel, ...args) {
  const reply = await window.bridge.invoke(channel, ...args);
  if (reply && reply.ok) return reply.value;
  const error = new Error((reply && reply.error) || 'Unknown error');
  if (reply && reply.need) error.need = reply.need;
  throw error;
}

const ICONS = {
  table: '<path d="M2 3.5h12v9H2zM2 6.5h12M6 6.5v6" />',
  view: '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.8"/>',
  fn: '<path d="M10.5 3c-1.7 0-2.2.8-2.5 2.5L7 11c-.3 1.7-.8 2-2 2M5.5 7h5"/>',
  seq: '<path d="M3 12V9M6.5 12V6.5M10 12V8M13.5 12V4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3"/>',
  filter: '<path d="M2.5 3.5h11l-4.2 5v4l-2.6-1.3V8.5z"/>',
  play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
  playAll: '<path d="M3 3.5v9l5-4.5zM8.5 3.5v9l5-4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  left: '<path d="M10 4L6 8l4 4"/>',
  right: '<path d="M6 4l4 4-4 4"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3M10.5 5.5l2 2"/>',
  link: '<path d="M6.5 9.5l3-3M5 7L3.6 8.4a2.3 2.3 0 0 0 3.3 3.3L8.3 10.300M11 9l1.4-1.4a2.3 2.3 0 0 0-3.300-3.300L7.700 5.700"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.500 3.500"/>',
  sql: '<path d="M4 5.500l-2 2.500 2 2.500M12 5.500l2 2.500-2 2.500M9.200 3.500l-2.400 9"/>',
  gear: '<circle cx="8" cy="8" r="2.200"/><path d="M8 1.800v1.700M8 12.500v1.700M1.800 8h1.700M12.500 8h1.700M3.600 3.600l1.200 1.200M11.200 11.200l1.200 1.200M3.600 12.400l1.200-1.200M11.200 4.800l1.200-1.200"/>',
  history: '<circle cx="8" cy="8" r="5.500"/><path d="M8 5v3.200l2 1.300"/>',
  star: '<path d="M8 2.300l1.700 3.600 3.900.500-2.900 2.700.800 3.900L8 11l-3.500 2 .800-3.900-2.900-2.700 3.900-.500z"/>',
  download: '<path d="M8 2.500v8M4.800 7.500L8 10.700l3.200-3.200M3 13h10"/>',
  upload: '<path d="M8 10.500v-8M4.800 5.700L8 2.500l3.200 3.200M3 13h10"/>',
  columns: '<path d="M2.500 3h11v10h-11zM6.200 3v10M9.800 3v10"/>',
  detail: '<path d="M2 3h12v10H2zM10 3v10"/>',
  terminal: '<path d="M2 3h12v10H2zM4.500 6.500l2 1.800-2 1.800M8 10.500h3"/>',
  lock: '<rect x="3.500" y="7" width="9" height="6.500" rx="1"/><path d="M5.500 7V5a2.500 2.500 0 0 1 5 0v2"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.100 2.200 2 5 2s5-.900 5-2V4M3 8c0 1.100 2.200 2 5 2s5-.900 5-2"/>',
  check: '<path d="M3.500 8.500l3 3 6-7"/>',
  trash: '<path d="M3 4.500h10M6.500 4.500V3h3v1.500M4.500 4.500l.600 8.500h5.800l.600-8.500"/>',
  wand: '<path d="M3 13l7.500-7.500M9 4l3 3M12.500 2v2M11.500 3h2M4 3.500v1.600M3.200 4.300h1.600"/>',
  folder: '<path d="M2 4.500h4l1.500 1.500H14v6.500H2z"/>',
};

export function icon(name, size = 14) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.300" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

export function button(label, options = {}) {
  const { icon: iconName, primary, danger, onclick, title, small, disabled } = options;
  return el(
    'button',
    {
      class: ['btn', primary && 'primary', danger && 'danger', small && 'small', !label && 'icon-only']
        .filter(Boolean)
        .join(' '),
      onclick,
      title,
      disabled,
      type: 'button',
    },
    iconName ? icon(iconName) : null,
    label || null,
  );
}

export function debounce(refresh, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(...args), ms);
  };
}

export function formatNumber(value) {
  return value == null ? '' : Number(value).toLocaleString('en-US');
}

export function formatDuration(loadMs) {
  return loadMs == null
    ? ''
    : loadMs < 1000
      ? `${Math.round(loadMs)} ms`
      : `${(loadMs / 1000).toFixed(loadMs < 10000 ? 2 : 1)} s`;
}

export function fuzzyScore(query, text) {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index !== -1) return 1000 - index * 2 - (haystack.length - needle.length);
  let score = 0;
  let from = 0;
  let streak = 0;
  for (let k = 0; k < needle.length; k++) {
    const index = haystack.indexOf(needle[k], from);
    if (index === -1) return -1;
    streak = index === from ? streak + 1 : 0;
    score += 10 + streak * 5 - (index - from);
    if (index === 0 || /[_\s.-]/.test(haystack[index - 1])) score += 15;
    from = index + 1;
  }
  return score - (haystack.length - needle.length) * 0.5;
}
