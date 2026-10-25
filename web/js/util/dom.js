// Kleine DOM-Helfer ohne Framework.

/** Erzeugt ein Element. attrs: class, style, html, on…-Handler, data-*, sonstige Attribute. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Ersetzt den Inhalt eines Elements. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Setzt Text nur, wenn er sich geändert hat (verhindert Flackern). */
export function setText(el, text) {
  const t = String(text ?? '');
  if (el && el.textContent !== t) el.textContent = t;
}

const recentToasts = new Map();
export function toast(text, kind = '') {
  const box = document.getElementById('toasts');
  if (!box) return;
  // Gleiche Meldung nicht mehrfach kurz hintereinander zeigen
  const now = Date.now();
  if (now - (recentToasts.get(text) || 0) < 4000) return;
  recentToasts.set(text, now);
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, text);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 5000 : 3200);
}

/** Einfacher Dialog. buttons: [{label, value, kind}] → Promise mit value (oder null bei Abbruch). */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, kind: 'pri' }], dismissable = true }) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const card = h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
      title ? h('h2', {}, title) : null,
      body instanceof Node ? body : body ? h('p', { class: 'sub', style: { whiteSpace: 'pre-line' } }, body) : null,
      h('div', { class: 'stack' }, buttons.map((b) => h('button', { class: `btn ${b.kind || 'sec'}`, onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label))),
    );
    const wrap = h('div', { class: 'modal', onclick: (e) => { if (dismissable && e.target === wrap) close(null); } }, card);
    document.body.append(wrap);
    const first = card.querySelector('input, textarea');
    (first || card.querySelector('button'))?.focus();
  });
}

export function confirmDialog(title, text, okLabel = 'Ja', danger = false) {
  return modal({ title, body: text, buttons: [{ label: okLabel, value: true, kind: danger ? 'danger' : 'pri' }, { label: 'Abbrechen', value: false, kind: 'ghost' }] });
}

export function promptDialog(title, { label = '', value = '', placeholder = '', okLabel = 'OK', maxlength = 40 } = {}) {
  const input = h('input', { class: 'field', value, placeholder, maxlength, 'aria-label': label || title });
  const body = h('div', { class: 'stack' }, label ? h('span', { class: 'sub' }, label) : null, input);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.closest('.card').querySelector('.btn.pri')?.click(); });
  return modal({ title, body, buttons: [{ label: okLabel, value: () => input.value.trim() || null, kind: 'pri' }, { label: 'Abbrechen', value: null, kind: 'ghost' }] });
}

/** Button, der während einer Aktion gesperrt ist und Fehler als Toast zeigt. */
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      btn.classList.remove('busy');
    }
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert');
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Kopiert'); } catch { toast('Kopieren hat nicht geklappt', 'bad'); }
    ta.remove();
  }
}

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS kann das nicht */ }
}
