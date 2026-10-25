# Manhunt – Hinweise für Claude Code

Private Manhunt-Web-App (PWA) für Eric und Freunde. Sprache der App, der Texte und der Antworten an Eric: **Deutsch**. Handy zuerst (iPhone, ca. 390 px).

## Aufbau
- `web/` – statisches Frontend ohne Build-Tool (ES-Module, Import-Map für Turf). Wird 1:1 auf GitHub Pages veröffentlicht.
  - `web/js/config.js` – einzige Stelle für Supabase-URL, Publishable Key, App-Name ("Manhunt")
  - `web/js/core/` – reine Spiel-Logik (Geometrie, Pings, Kalman, Zone, Traccar-Parser, Tick-Planung). Wird von Browser, Node-Tests UND Edge Functions benutzt.
  - `web/js/backend/supabase.js` (echt) und `demo.js` (Simulation mit Bots, 10× Zeitraffer)
  - `web/js/location/` – austauschbare Standort-Provider (Browser, Demo; später Capacitor)
  - `web/js/ui/` – Screens, Karte (Leaflet + Geoman), Chat, Hilfe, QR
  - `web/vendor/` – gebündelte Bibliotheken (per `npm run vendor`), keine CDNs
- `server/` – Quellcode der Edge Functions `location` und `tick`
- `supabase/functions/*/index.ts` – **generiert** mit `npm run build:functions`. Nie von Hand ändern.
- `supabase/migrations/20261025000000_manhunt.sql` – Schema, RLS, alle RPCs (mehrfach ausführbar)
- `supabase/setup/cron.sql` – pg_cron + pg_net + Vault (Platzhalter für URL/Secret, nicht committen mit echten Werten)
- `tests/` – Logik, Handler, RLS gegen echtes Postgres, Deno, UI (Demo), UI gegen Supabase-Nachbau

## Regeln
- Echte Standorte der Gejagten dürfen die Sucher nie erreichen. Clients haben nur SELECT (gefiltert per RLS); alles Schreibende läuft über RPCs. `svc_*`-Funktionen nur für service_role.
- Jede Änderung an RLS/RPCs braucht einen Test in `tests/db.test.js`.
- Nach Änderungen in `web/js/core/` oder `server/`: `npm run build:functions` und die Functions neu deployen.
- `normalizeSettings()` in `engine.js` und `public.normalize_settings()` in SQL müssen zusammenpassen.
- Keine Secrets ins Repo. Publishable/anon-Key darf ins Frontend, Secret/service_role-Key nie.
- Alles muss im Supabase Free Tier und kostenlos bleiben.

## Befehle
```
npm install
npm run test:core     # Node, ohne Abhängigkeiten
npm run test:db       # braucht Postgres 15+ (brew install postgresql@16), Deno optional
npm run test:ui       # Demo-Durchlauf im Headless-Browser (npx playwright install chromium)
npm run test:ui-db    # zwei Browser gegen Supabase-Nachbau mit echter DB
npm run dev           # http://localhost:5173
npm run build:functions
```
