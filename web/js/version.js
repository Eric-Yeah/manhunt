// Version und Release Notes. Bei jedem Update: VERSION hier, in sw.js und in package.json erhöhen
// und oben in RELEASES einen Eintrag ergänzen (tests/core.test.js prüft, dass alles zusammenpasst).
// Die neue Version lädt sich die App von selbst nach (Service Worker) und zeigt danach die Neuerungen.
export const VERSION = '0.3.0';

/** Neueste Version zuerst. items: kurze Sätze für Spieler, nicht für Entwickler. */
export const RELEASES = [
  {
    version: '0.3.0',
    date: '2026-11-13',
    items: [
      'Neu: Ein Ping zeigt jetzt nur noch die Entfernung in Metern. Jeder Sucher sieht, wie weit er selbst vom Gejagten weg ist. Keine Richtung, kein Kreis.',
      'Neu: Alle Joker gibt es von Anfang an, jeden einmal pro Runde. Gejagte haben „Ping überspringen“, „Ungenauer Ping“, „Falsche Entfernung“ und das neue Sucher-Radar, das zeigt, wo alle Sucher gerade genau sind.',
      'Neu: Sucher haben den Sound-Joker. Er spielt bei einem Gejagten einen Ton ab und zeigt allen Suchern seinen genauen Standort, egal wo er ist. Du setzt ihn im Ping-Menü ein.',
      'Neu: Wer gefunden wurde, kann als Sucher mitjagen. Gefundene geben ihren Standort nicht mehr weiter.',
      'Neu: Wiederholungen werden auf deinem Handy gespeichert. Du findest sie auf der Startseite, auch nachdem du die Lobby verlassen hast.',
      'Behoben: Das Ping-Menü lässt sich jetzt nach unten wegwischen und wieder hochziehen.',
      'Neu: Die schrumpfende Zone stellst du mit Schiebereglern ein: Zeit von 1 bis 120 Minuten, Fläche von 1 bis 90 %. Mit + und − geht es Schritt für Schritt.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-25',
    items: [
      'Neu: „Meine Daten löschen“ auf der Startseite entfernt deine Spiele, Routen, gespeicherten Gebiete und deine Tracker-Kennung vom Server.',
      'Neu: Release Notes und automatische Updates. Die App lädt sich bei einer neuen Version selbst neu und zeigt dir, was sich geändert hat.',
      'Datenschutz: Nach einem abgebrochenen Spiel sehen Sucher nur noch die Routen ihres eigenen Teams. Echte Positionen bleiben nicht mehr auf dem Handy gespeichert.',
      'Einladungslinks tragen nur noch den Code ein. Beitreten musst du selbst bestätigen.',
      'Das Spiel endet, wenn alle Sucher gegangen sind. Die Gejagten gewinnen dann.',
      'Der Extra-Ping als Strafe für das Verlassen des Gebiets gilt erst ab Jagdbeginn, nicht schon im Vorsprung.',
      'Richtungs-Pings mit „Doppelter Kreis“ zeigen jetzt ein Band, das die echte Position sicher einschließt.',
      'Die App startet nach dem ersten Besuch auch ohne Netz und bleibt bei schlechtem Empfang flüssig.',
      'Viele Fehler behoben: Chat schließt per Escape, Joker-Knopf bleibt beim Antippen stabil, Gebiets-Karte stürzt bei frühem Tippen nicht mehr ab, Spielgebiete werden strenger geprüft.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-24',
    items: ['Erste Version: Manhunt mit Pings, Spielgebiet, Zone, Jokern, Chat und Traccar im Hintergrund.'],
  },
];

const num = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);

/** true, wenn Version a neuer ist als b. */
export function isNewer(a, b) {
  const x = num(a), y = num(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** Alle Releases, die neuer sind als `seen` (höchstens 5). Ohne `seen`: leer. */
export function releasesSince(seen, releases = RELEASES) {
  if (!seen) return [];
  return releases.filter((r) => isNewer(r.version, seen)).slice(0, 5);
}
