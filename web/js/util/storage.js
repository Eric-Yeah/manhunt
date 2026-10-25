// localStorage mit Fehlerschutz (privates Surfen, volle Speicher usw.).
const PREFIX = 'manhunt:';

export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* egal */ }
}
