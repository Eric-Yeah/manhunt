// Formatierungen für Zeiten, Strecken und Zahlen (deutsch).

export function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function ago(ms) {
  if (!Number.isFinite(ms)) return 'nie';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'gerade eben';
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`;
}

export function minutes(s) {
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

export function meters(m) {
  if (!Number.isFinite(m)) return '–';
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(a)} m`;
  return `${(a / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;
}

export function clock(t) {
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(t) {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  const tomo = new Date(Date.now() + 86_400_000);
  const day = d.toDateString() === today.toDateString() ? 'heute'
    : d.toDateString() === yest.toDateString() ? 'gestern'
      : d.toDateString() === tomo.toDateString() ? 'morgen'
        : `am ${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}`;
  return `${day}, ${clock(t)}`;
}

/**
 * Zeitstempel aus der Datenbank in Millisekunden. Postgres liefert z. B.
 * "2026-10-25T02:30:00.123456+00:00" oder (Realtime) "2026-10-25 02:30:00.123456+00".
 * Safari ist beim Einlesen strenger als Chrome, deshalb vorher normalisieren.
 */
export function ts(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function initials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

export function formatCode(code) {
  return code ? `${code.slice(0, 3)}·${code.slice(3)}` : '';
}
