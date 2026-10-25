// Einstiegspunkt der Web-App.
import { App } from './app.js';

const app = new App(document.getElementById('app'));
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));
app.start();

// Offline-Fähigkeit und "Zum Home-Bildschirm" (nur über HTTPS bzw. localhost)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
