// Linien-Icons (24×24, currentColor), Stil wie im Design-Entwurf.
const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 010 7M18 14c2.2.6 3.5 2.6 3.5 6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.5M14 20h3M20 18v3"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  area: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H4v1a4 4 0 004 4M16 6h4v1a4 4 0 01-4 4M12 13v4M8 20h8M10 17h4"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  megaphone: '<path d="M3 10v4h4l7 4V6L7 10z"/><path d="M18 9a4 4 0 010 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4M12 17v.5"/>',
  shrink: '<path d="M4 4l6 6M4 9V4h5M20 20l-6-6M20 15v5h-5"/>',
  joker: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  skip: '<path d="M5 5l9 7-9 7zM18 5v14"/>',
  double: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
  ghost: '<path d="M6 20V10a6 6 0 0112 0v10l-2-2-2 2-2-2-2 2-2-2z"/><path d="M10 10h.01M14 10h.01"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  circle: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  arrow: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  signal: '<path d="M5 12a10 10 0 0114 0M8 15a6 6 0 018 0"/><circle cx="12" cy="18.5" r="1" fill="currentColor"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

export function icon(name, size = 20, extra = '') {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${P[name] || ''}</svg>`;
}

export function logoSvg(size = 92) {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" role="img" aria-label="Logo">
<circle class="lg-a" cx="32" cy="32" r="27" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="132 38" transform="rotate(-70 32 32)"/>
<circle class="lg-a" cx="32" cy="32" r="16" stroke-width="2.5" opacity=".55"/>
<circle class="lg-d" cx="32" cy="32" r="5.5"/>
<circle cx="55" cy="14" r="2.2" fill="currentColor"/></svg>`;
}

/** Fortschrittsring für Countdowns. frac: 0..1 (verbleibend). */
export function ringSvg(frac, label) {
  const c = 138.2;
  const off = c * (1 - Math.max(0, Math.min(1, frac)));
  return `<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="22" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="27" cy="27" r="22" fill="none" stroke="var(--ac)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 27 27)"/><text x="27" y="31" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--tx)">${label}</text></svg>`;
}
