// Einstiegspunkt der Web-App.
import { App } from './app.js';

const app = new App(document.getElementById('app'));
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));
app.start();

// Offline-Fähigkeit und "Zum Home-Bildschirm" (nur über HTTPS bzw. localhost)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Neue Version: Der neue Service Worker übernimmt sofort, dann lädt sich die App einmal selbst neu.
  // (Beim allerersten Besuch gibt es noch keinen alten Worker, dann bleibt alles wie es ist.)
  let controlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; } // erste Übernahme nach der Installation
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // Regelmäßig und beim Zurückkehren in die App nach Updates suchen (iOS tut das sonst kaum).
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 10 * 60_000);
  }).catch(() => {});
}
