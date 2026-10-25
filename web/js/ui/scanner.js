// QR-Scanner (Kamera + jsQR). Wird nur bei Bedarf geladen.
import { h } from '../util/dom.js';

const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Holt den 6-stelligen Code aus einem Einladungslink oder direkt aus dem Text. */
export function extractCode(text) {
  try {
    const u = new URL(text);
    const j = u.searchParams.get('join');
    if (j && clean(j).length === 6) return clean(j);
  } catch { /* kein Link */ }
  const c = clean(text);
  return c.length === 6 ? c : null;
}

export async function scanQr() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera nicht verfügbar. Gib den Code von Hand ein.');
  const { default: jsQR } = await import('../../vendor/jsqr.esm.js');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    throw new Error('Kein Kamerazugriff. Erlaube ihn in den Einstellungen oder gib den Code von Hand ein.');
  }
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  video.srcObject = stream;
  const canvas = document.createElement('canvas');
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      resolve(v);
    };
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const s = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * s);
        canvas.height = Math.round(video.videoHeight * s);
        c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = c2d.getImageData(0, 0, canvas.width, canvas.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        const code = r?.data && extractCode(r.data);
        if (code) return finish(code);
      }
      setTimeout(tick, 200);
    };
    const wrap = h('div', { class: 'modal' },
      h('div', { class: 'card scanner' },
        h('h2', {}, 'QR-Code scannen'),
        video,
        h('p', { class: 'sub' }, 'Halte die Kamera auf den QR-Code im Warteraum des Hosts.'),
        h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Abbrechen')));
    document.body.append(wrap);
    video.play().catch(() => {});
    tick();
  });
}
