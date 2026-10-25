# Manhunt – Jagd im echten Gelände

Private Web-App (PWA) für 3 bis 10 Freunde: Gejagte verstecken sich in einem festgelegten Gebiet, Sucher bekommen deren Position nur als **Ping** im eingestellten Takt. Kein automatisches Fangen per GPS – wer gefunden wird, hält „Ich wurde gefunden“ zwei Sekunden gedrückt.

- **Frontend:** statische Dateien in `web/` (kein Build-Tool nötig), läuft auf GitHub Pages, installierbar auf dem Home-Bildschirm
- **Backend:** Supabase (Auth, Postgres mit Row-Level-Security, Realtime, Edge Functions, Cron) – alles im Free Tier
- **Standort im Hintergrund:** kostenlose App *Traccar Client* → Edge Function `location`
- **Demo-Modus:** Ohne Supabase-Einrichtung spielst du gegen simulierte Mitspieler (Zeit läuft 10× schneller)

> Den App-Namen „Manhunt“ ändern: `web/js/config.js` (`APP_NAME`), `web/manifest.webmanifest` (`name`, `short_name`) und `<title>` in `web/index.html`.

---

## Inhalt

1. [Sofort ausprobieren (Demo)](#1-sofort-ausprobieren-demo)
2. [Einrichtung Schritt für Schritt](#2-einrichtung-schritt-für-schritt)
3. [Testlauf vor dem ersten Spiel](#3-testlauf-vor-dem-ersten-spiel)
4. [So funktioniert ein Spiel](#4-so-funktioniert-ein-spiel)
5. [Sicherheit und Datenschutz](#5-sicherheit-und-datenschutz)
6. [Free Tier: Was ist knapp?](#6-free-tier-was-ist-knapp)
7. [Entwicklung und Tests](#7-entwicklung-und-tests)
8. [Entscheidungen, die ich getroffen habe](#8-entscheidungen-die-ich-getroffen-habe)
9. [Ordnerstruktur](#9-ordnerstruktur)

---

## 1. Sofort ausprobieren (Demo)

Solange in `web/js/config.js` keine Supabase-Daten stehen, startet die App im **Demo-Modus**:

```bash
npm run dev          # startet http://localhost:5173 (braucht nur Node.js, sonst nichts)
```

Oder einfach den Ordner `web/` auf GitHub Pages veröffentlichen (Schritt 2.7) und auf dem Handy öffnen. Im Demo-Modus erstellst du ein Spiel, fünf simulierte Mitspieler treten bei, und du kannst alles durchspielen: Regeln, Gebiet zeichnen, Sperrzonen, Pings, Chat, SOS, Joker, Ergebnis mit Wiederholung, Revanche. **Tippe auf die Karte, um deine Figur zu bewegen** (z. B. aus dem Gebiet heraus, um die Grenzwarnung zu sehen).

---

## 2. Einrichtung Schritt für Schritt

Du brauchst: einen Supabase-Account, deinen GitHub-Account (öffentliches Repo + Pages, kostenlos) und ca. 30 Minuten.

### 2.1 Supabase-Projekt anlegen

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. Name z. B. `manhunt`, Region **Central EU (Frankfurt)**, Plan **Free**, ein sicheres DB-Passwort (im Passwortmanager speichern).

> Im Free Plan sind nur **2 aktive Projekte** erlaubt. Hast du schon zwei (z. B. Overload und ein weiteres), musst du eins pausieren – oder Manhunt in ein bestehendes Projekt einspielen. Prüfe dann vorher, dass es dort noch keine Tabellen namens `games`, `players`, `messages`, `pings`, `locations`, `player_private`, `ping_secrets`, `saved_areas` oder `user_trackers` gibt.

### 2.2 Anonyme Anmeldung einschalten

Spieler brauchen kein Konto. Jedes Handy meldet sich automatisch anonym an.

Dashboard → **Authentication → Sign In / Providers** (je nach Version „Providers“ oder „Settings“) → **Allow anonymous sign-ins** einschalten → Speichern.

### 2.3 Datenbank einspielen

Dashboard → **SQL Editor** → **New query** → den kompletten Inhalt von
`supabase/migrations/20261025000000_manhunt.sql` einfügen → **Run**.

Das legt Tabellen, Sicherheitsregeln (RLS), alle Spielfunktionen und die Realtime-Freigaben an. Die Datei darf mehrfach ausgeführt werden (z. B. nach einem Update).

### 2.4 Edge Functions deployen

Es gibt zwei Funktionen: `location` (nimmt Standorte an) und `tick` (erzeugt Pings, beendet Spiele, schrumpft die Zone). Beide sind schon fertig gebündelt, jeweils als **eine Datei**.

**Variante A – im Browser (ohne Terminal):**

1. Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**
2. Name: `location`. Den Inhalt von `supabase/functions/location/index.ts` komplett einfügen → **Deploy**
3. In den Einstellungen der Funktion **„Verify JWT“ / „Enforce JWT verification“ AUSschalten** (Traccar kann kein Login mitschicken; die Funktion prüft selbst den geheimen Tracker-Token).
4. Dasselbe für `tick` mit `supabase/functions/tick/index.ts` – ebenfalls **Verify JWT aus**.

**Variante B – mit der Supabase CLI** (z. B. über Claude Code):

```bash
npx supabase login
npx supabase link --project-ref DEIN-PROJEKT-REF
npx supabase functions deploy location --no-verify-jwt
npx supabase functions deploy tick --no-verify-jwt
```

(`supabase/config.toml` setzt `verify_jwt = false` ohnehin für beide.)

### 2.5 Tick-Secret setzen

Die Funktion `tick` wird alle 10 Sekunden von der Datenbank aufgerufen (nur wenn etwas fällig ist). Damit niemand anderes sie aufrufen kann, braucht sie ein Secret.

1. Einen langen Zufallstext erzeugen, z. B. im Mac-Terminal: `openssl rand -hex 32`
2. Dashboard → **Edge Functions → Secrets** (bzw. „Manage secrets“) → neues Secret **`TICK_SECRET`** mit diesem Wert.
   CLI-Variante: `npx supabase secrets set TICK_SECRET=dein-wert`

### 2.6 Zeitsteuerung (Cron) einrichten

1. Öffne `supabase/setup/cron.sql`, ersetze oben `DEINE-PROJEKT-URL` (z. B. `https://abcdefgh.supabase.co`) und `DEIN-TICK-SECRET` (derselbe Wert wie in 2.5).
2. Dashboard → **SQL Editor** → Inhalt einfügen → **Run**.

Das aktiviert `pg_cron` und `pg_net`, legt URL und Secret verschlüsselt im Vault ab und plant zwei Jobs:
- `manhunt-tick` alle 10 s: ruft `tick` **nur** auf, wenn ein Ping, ein Spielende, eine Zonen-Stufe oder eine Grenzstrafe fällig ist.
- `manhunt-purge` stündlich: löscht abgelaufene Spiele (Standorte, Pings, Chat) und alte Cron-Protokolle.

Kontrolle im SQL-Editor: `select jobname, schedule, active from cron.job;`

> Zusätzlich stößt jede offene App die Funktion `tick` an, wenn ein Countdown abgelaufen ist. Falls Cron einmal hakt, laufen Spiele trotzdem weiter, solange jemand die App offen hat.

### 2.7 App konfigurieren und auf GitHub Pages veröffentlichen

1. Dashboard → **Project Settings → API Keys** (bzw. „API“). Kopiere die **Project URL** und den **Publishable Key** (`sb_publishable_…`; bei älteren Projekten heißt er „anon public“).
2. Trage beides in `web/js/config.js` ein:
   ```js
   SUPABASE_URL: 'https://abcdefgh.supabase.co',
   SUPABASE_KEY: 'sb_publishable_…',
   PUBLIC_URL: 'https://eric-yeah.github.io/manhunt/',
   ```
   **Niemals** den Secret Key oder `service_role`-Key ins Frontend schreiben. Der Publishable Key darf öffentlich sein, die Datenbank ist durch RLS geschützt.
3. Neues **öffentliches** Repository `manhunt` auf GitHub anlegen (Pages für private Repos geht nur mit GitHub Pro) und den **ganzen Projektordner** hochladen (inkl. `.github/workflows/pages.yml`; `node_modules` nicht).
4. Repo → **Settings → Pages → Build and deployment → Source: „GitHub Actions“**. Bei jedem Push veröffentlicht der Workflow automatisch den Ordner `web/`.
5. Nach ein bis zwei Minuten läuft die App unter `https://eric-yeah.github.io/manhunt/`.

> Code und App sind öffentlich. Das ist okay: Im Repo stehen keine Secrets (nur der Publishable Key), ohne Spielcode kommt niemand in ein Spiel, und alle Daten sind per RLS geschützt.

### 2.8 Auf dem iPhone installieren

Safari → App-Adresse öffnen → **Teilen → Zum Home-Bildschirm**. Danach immer über das Home-Bildschirm-Symbol öffnen.

**Wichtig:** Die Home-Bildschirm-App ist für iOS ein eigenes „Gerät“ mit eigener anonymer Anmeldung und eigener Tracker-Kennung. Richte Traccar deshalb mit der Kennung aus der installierten App ein (nächster Schritt) und nutze danach nur noch diese.

### 2.9 Traccar Client einrichten (jeder Spieler, einmalig)

In der App: **„Tracking im Hintergrund einrichten“** (Startseite oder Warteraum). Dort stehen Kennung und Server-URL zum Kopieren und die empfohlenen Einstellungen:

| Einstellung | Wert |
|---|---|
| Gerätekennung | (aus der App kopieren – geheim!) |
| Server-URL | `https://DEIN-PROJEKT.supabase.co/functions/v1/location` |
| Standortgenauigkeit | Höchste |
| Entfernung / Intervall / Winkel | 10 m / 10 s / 30° |
| Stillstand-Heartbeat | 60 s |
| Offline-Pufferung / Stopp-Erkennung | aus / aus |
| iPhone-Standortzugriff | **Immer** + Genauer Standort |

Die Edge Function versteht beide Traccar-Formate: das neue JSON (`{"location": {"coords": …}, "device_id": …}`) und das klassische OsmAnd-Format (`id`, `lat`, `lon`, `timestamp`, `accuracy` als URL- oder Formular-Parameter).

---

## 3. Testlauf vor dem ersten Spiel

Am besten mit zwei Handys im Garten oder Park:

1. Handy A: Spiel erstellen → Regeln (z. B. Ping 1 min, Vorsprung „Ohne“) → Gebiet (Kreis 300 m um dich) → Warteraum.
2. Handy B: Code eingeben oder QR scannen → beitreten.
3. Im Warteraum: Steht bei beiden „Traccar · aktiv“? Wenn nicht: Traccar-Ortung an? Kennung/URL richtig? (Der Hilfe-Screen zeigt live „Signal kommt an“.)
4. Rollen wählen (A Sucher, B Gejagter) → Starten.
5. Nach ca. 1 Minute: Handy A zeigt den ersten Ping-Kreis, Handy B bekommt „Die Sucher haben dich gerade geortet“.
6. Handy B sperren und 100 m laufen → nächster Ping auf A sollte sich bewegen (das ist Traccar im Hintergrund).
7. B läuft aus dem Gebiet → nach Warnzeit Extra-Ping auf A.
8. SOS testen, Chat testen (Team und Alle), „Ich wurde gefunden“ → Ergebnis mit Wiederholung.

Wenn Pings ausbleiben: Dashboard → **Edge Functions → tick → Logs** und im SQL-Editor
`select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;`

---

## 4. So funktioniert ein Spiel

| Phase | Was passiert |
|---|---|
| **Warteraum** | Code/QR teilen, Rollen wählen (oder Host verteilt/lost), „Bereit“, Tracker-Status je Spieler, Hinweis „Wer sieht was?“ |
| **Vorsprung** | Gejagte verstecken sich. Kein Ping. |
| **Jagd** | Alle *X* Minuten erzeugt der Server pro Gejagtem einen Ping: exakter Punkt, Kreis (echte Position irgendwo darin, nie in der Mitte) oder Richtung + Entfernung (je Sucher von dessen Position aus, gerundet). |
| **Grenze** | Server prüft jede Position (Toleranz 20 m + GPS-Ungenauigkeit). Außerhalb oder in einer Sperrzone: Warnung mit Countdown, danach Extra-Ping oder Ausscheiden. |
| **Zone** | Optional schrumpfend; die nächste Stufe erscheint 2 Minuten vorher gestrichelt. |
| **Joker** | Optional: Ping überspringen, doppelter Kreis, falscher Ort (wird erst nach Spielende verraten). Eine gemeinsame Abklingzeit pro Gejagtem. |
| **Ende** | Alle Gejagten gefunden/raus → Sucher gewinnen. Zeit abgelaufen → Gejagte gewinnen. Ergebnis mit Routen-Wiederholung, Revanche mit getauschten Rollen. |

Pause/SOS stoppt das Spiel für alle (Countdowns, Pings, Strafen) und erscheint rot im gemeinsamen Chat. Fortsetzen kann der Host oder wer pausiert hat.

---

## 5. Sicherheit und Datenschutz

**Das Wichtigste: Echte Standorte der Gejagten erreichen die Sucher nie.**

- `locations` (echte Positionen) und `player_private` (geglättete Position, Grenzstatus, Joker) sind per RLS nur für den Spieler selbst lesbar (eigene Teammitglieder sehen sich gegenseitig, abschaltbar). Das andere Team sieht sie nie.
- Sucher lesen nur `pings` – vom Server bereits verfremdet. Richtungs-Pings sieht nur der Sucher, für den sie berechnet wurden; Gejagte sehen sie nicht (sie würden die Sucher-Position verraten). Der Täuschungs-Joker steht in `ping_secrets`, das erst nach Spielende sichtbar wird.
- Apps dürfen **keine Tabelle direkt ändern**. Jede Änderung läuft über geprüfte Datenbank-Funktionen. Server-Funktionen (`svc_…`) kann nur die Edge Function mit Secret Key aufrufen.
- Chat: Kanäle `hunters`, `hiders`, `all`, Zugriff per RLS (nicht nur in der App ausgeblendet). Wer im Warteraum die Seite wechselt, verliert sofort den Zugang zum alten Team-Chat. Nach Spielende lesen alle alles.
- Tracker-Token: 64 Hex-Zeichen (≈ 244 Bit Zufall, nicht erratbar), nur für den Besitzer lesbar, neu erzeugbar. Rate-Limit 1 Meldung/Sekunde, Prüfung von Koordinaten, Zeitstempel (max. 5 min alt) und Genauigkeit (Standard 50 m), Kalman-Filter gegen GPS-Ausreißer.
- Standorte werden nur während laufender Spiele gespeichert. **Automatische Löschung** von Standorten, Pings und Chat nach Spielende (Standard 24 h, einstellbar 6/24/72 h). Verlassene Warteräume nach 24 h.
- Keine Werbung, keine Analyse-Tools, keine fremden CDNs: Alle Bibliotheken liegen in `web/vendor/`. Einzige Drittanfrage: Kartenkacheln von OpenStreetMap.

Die Sicherheitsregeln sind mit automatischen Tests abgedeckt (siehe 7).

**Falls die App irgendwann öffentlicher werden soll** (nicht nur ihr Freunde), bräuchtest du zusätzlich:
- eine **Datenschutzerklärung** (Standortdaten sind besonders sensibel) und ein **Impressum**,
- eine aktive **Einwilligung** vor der ersten Ortung (z. B. Häkchen mit Erklärung) und eine Möglichkeit, eigene Daten zu löschen,
- Regeln für **Minderjährige**: In Deutschland brauchen unter 16-Jährige für solche Datenverarbeitung die Zustimmung der Eltern,
- einen **Auftragsverarbeitungsvertrag (DPA)** mit Supabase,
- eigene Kartenkacheln oder einen Kachel-Anbieter (die OSM-Server sind nicht für viel Verkehr gedacht),
- Schutz gegen Spam-Anmeldungen (Captcha bei anonymer Anmeldung) und ggf. mehr Rate-Limits.

---

## 6. Free Tier: Was ist knapp?

Grenzen des Supabase Free Plans: 500 MB Datenbank, 5 GB Datenverkehr, 500.000 Edge-Function-Aufrufe/Monat, 200 gleichzeitige Realtime-Verbindungen, 2 Mio. Realtime-Nachrichten/Monat, max. 2 aktive Projekte.

| Bereich | Verbrauch | Einschätzung |
|---|---|---|
| **Edge Functions** | `location`: 1 Aufruf je Meldung. 10 Spieler × alle 10 s (Traccar) + App im Vordergrund ≈ 4.000–7.000 pro Spielstunde. `tick`: nur bei fälligen Ereignissen (ca. 20–80 pro Spiel). | Reicht für 60+ Spielstunden im Monat. |
| **Realtime-Nachrichten** | Jede Änderung wird an alle berechtigten Mitspieler verteilt. „Letztes Signal“ wird deshalb höchstens alle 20 s geschrieben. Grob 20.000–40.000 pro Spielstunde bei 10 Spielern. | **Am ehesten knapp:** ca. 50–100 Spielstunden pro Monat. Für eine Freundesgruppe locker genug. |
| **Realtime-Verbindungen** | 1 pro offener App | Kein Problem. |
| **Datenbank** | Positionen werden nach Spielende gelöscht | Kein Problem. |
| **Cron** | Prüfung alle 10 s, sehr billig; Protokolle werden stündlich bereinigt | Kein Problem. |
| **Pausierung** | **Free-Projekte werden nach 7 Tagen ohne Aktivität pausiert.** | Vor einem Spieleabend im Dashboard prüfen und ggf. „Restore“ klicken (dauert ein paar Minuten). |

Wenn es knapp wird: Traccar-Intervall auf 20 s erhöhen, „Team auf der Karte“ ausschalten (spart die meisten Realtime-Nachrichten) oder das Web-Intervall in `config.js` (`WEB_LOCATION_INTERVAL_S`) erhöhen.

---

## 7. Entwicklung und Tests

```bash
npm install
npm test             # Spiel-Logik + Edge-Function-Handler + Datenbank (RLS) + Durchstich
npm run test:core    # nur Logik/Handler, braucht nichts außer Node
npm run test:db      # braucht Postgres 15+ (Mac: brew install postgresql@16); Deno optional
npm run test:ui      # Klick-Durchlauf im Demo-Modus mit Screenshots (npx playwright install chromium)
npm run test:ui-db   # zwei Browser gegen echte Datenbank + echte Edge-Function-Handler (Postgres + Playwright)
npm run dev          # lokaler Server auf http://localhost:5173
```

Was getestet wird (aktuell 70 Tests plus zwei Browser-Durchläufe):
- **Sicherheit (RLS) gegen echtes Postgres:** Sucher sehen keine `locations` der Gejagten; Gejagte sehen keinen Sucher-Chat und keine Richtungs-Pings; Außenstehende sehen nichts; Apps können keine Tabellen ändern und keine `svc_`-Funktionen aufrufen; Tracker-Token privat; Täuschungs-Joker bis Spielende geheim; Seitenwechsel entzieht den Team-Chat; nach Spielende alles lesbar.
- **Ping-Logik:** Kreis-Versatz (echte Position im Kreis, nie in der Mitte – 2000 Zufallsproben), Rundung von Richtung/Entfernung, Joker, Strafen, Zone, Spielende, keine doppelten Pings bei parallelen Ticks.
- **Durchstich:** Traccar-JSON → `location` → Datenbank → `tick` → Sucher sehen nur den verfremdeten Ping.
- **Deno:** Die fertig gebündelten Edge Functions laufen in echtem Deno gegen die Testdatenbank (wird übersprungen, wenn Deno fehlt).
- **Zwei Handys im Browser (`test:ui-db`):** Host erstellt Spiel, speichert ein Gebiet, Mitspielerin tritt per Einladungslink bei, Start, Standort über die App, Ping, Team-Chat bleibt geheim, „Ich wurde gefunden“, Ergebnis, nach Spielende alle Kanäle lesbar, Revanche mit getauschten Rollen. Läuft gegen einen kleinen Supabase-Nachbau (`tests/helpers/mini-supabase.js`) mit der echten Datenbank und RLS.
- **Demo-Durchlauf (`test:ui`):** alle Screens in iPhone-Größe, ohne Fehler in der Konsole.

**Code-Aufteilung:** Die Spielregeln liegen als reine Funktionen in `web/js/core/` und werden von Browser (Demo-Modus), Node (Tests) und Deno (Edge Functions) gemeinsam benutzt. Nach Änderungen an `web/js/core/` oder `server/`:

```bash
npm run build:functions   # erzeugt supabase/functions/*/index.ts neu – danach neu deployen
```

**Bibliotheken aktualisieren:** Versionen in `package.json` anpassen, dann `npm install && npm run vendor`.

**Capacitor später:** Die Standort-Schicht (`web/js/location/index.js`) hat austauschbare Provider (`WebGeolocationProvider`, `ManualProvider` für die Demo). Für eine native Version kommt ein dritter Provider dazu, der die Meldungen wie Traccar an `location` schickt.

---

## 8. Entscheidungen, die ich getroffen habe

Du hattest „selbstständig“ gesagt, also habe ich die offenen Planfragen so entschieden. Alles lässt sich ändern.

| Frage | Entscheidung | Warum |
|---|---|---|
| Build-Tool? | **Keins.** Statische ES-Module, Bibliotheken liegen fertig in `web/vendor/` | Läuft direkt auf GitHub Pages, keine Toolchain nötig, kein CDN (Datenschutz, offline) |
| Tracker-Token pro Spiel oder pro Gerät? | **Pro Gerät**, neu erzeugbar | Traccar nur einmal einrichten statt vor jedem Spiel. Der Server ordnet das aktive Spiel selbst zu. |
| Richtungs-Ping: Richtung von wo? | **Von der Position des jeweiligen Suchers** (8 Himmelsrichtungen, Entfernung auf 50/100/250 m gerundet). Ohne aktuelles Sucher-Signal: vom Spielfeld-Mittelpunkt | Exakte Werte würden die echte Position verraten |
| Kreis-Versatz | Echte Position bei 25–85 % des Radius, flächengleich zufällig | „Irgendwo im Kreis, nicht in der Mitte“ |
| Spieldauer | **Zählt ab Ende des Vorsprungs** | Die Jagdzeit bleibt gleich, egal wie lang der Vorsprung ist |
| Erster Ping | Direkt am Ende des Vorsprungs | Laut Vorgabe |
| Strafe für Sucher? | Nein, Sucher bekommen nur eine Warnung (auch in Sperrzonen) | Sucher sollen jagen; Sperrzonen-Warnung trotzdem aus Sicherheitsgründen |
| Extra-Ping wiederholt? | Ja, solange man draußen bleibt, alle max(60 s, 2× Warnzeit) | Sonst wäre draußen bleiben nach einem Ping straffrei |
| Teammitglieder auf der Karte | An (abschaltbar) | Sucher können sich absprechen; spart Chat |
| Joker-Abklingzeit | Eine gemeinsame pro Gejagtem | Einfach und fair |
| Glättung | Kalman-Filter mit Ausreißer-Erkennung | Glättet, ohne echtes Rennen zu verschlucken |
| Rollen „Zufall“ | Etwa ein Drittel Sucher, mindestens einer | Übliche Manhunt-Verteilung |
| Ping-Auslöser | pg_cron alle 10 s **und** App-Anstoß bei abgelaufenem Countdown | Robust, auch wenn Cron einmal verzögert |
| Wer darf fortsetzen? | Host oder wer pausiert hat | Kein Fremder kann eine SOS-Pause beenden |
| Demo-Modus | Zusätzlich gebaut | Sofort testbar ohne Einrichtung; Screenshots/UI-Tests laufen damit |
| Realtime fällt aus | App lädt dann alle 4 s neu, bis die Verbindung wieder steht | Spiel läuft weiter, auch bei wackeligem Netz |
| Stillstehen mit App offen | App fordert neue Messungen an und meldet die letzte Position bis zu 2 min weiter | iOS meldet bei Stillstand keine neuen Positionen; sonst sähe es nach Signalverlust aus |

---

## 9. Ordnerstruktur

```
manhunt/
├─ web/                       ← das wird auf GitHub Pages veröffentlicht
│  ├─ index.html, manifest.webmanifest, sw.js, icons/
│  ├─ css/app.css             Design A (dunkel/hell)
│  ├─ js/config.js            ← Supabase-Daten und App-Name hier eintragen
│  ├─ js/core/                Spielregeln: Geometrie, Pings, Kalman, Zone, Traccar-Format
│  ├─ js/backend/             supabase.js (echt) und demo.js (Simulation)
│  ├─ js/location/            austauschbare Standort-Schicht + Wake Lock
│  ├─ js/ui/                  Screens, Karte, Chat, Hilfe, QR-Scanner
│  └─ vendor/                 Leaflet, Leaflet-Geoman, Turf, supabase-js, QR (mit Lizenzen)
├─ server/                    Quellcode der Edge Functions (location, tick)
├─ supabase/
│  ├─ migrations/…_manhunt.sql  Schema, RLS, Spielfunktionen
│  ├─ functions/*/index.ts      fertig gebündelte Edge Functions (generiert)
│  ├─ setup/cron.sql            Cron + Vault
│  └─ config.toml
├─ tests/                     Logik-, Datenbank-, Deno- und UI-Tests
├─ scripts/                   Testdatenbank, Bündeln, Vendor, Dev-Server
├─ design/                    die beiden Mockups
└─ .github/workflows/pages.yml  automatisches Veröffentlichen von web/
```
