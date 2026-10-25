// ======================================================================
//  Manhunt – zentrale Einstellungen. Nur diese Datei musst du anpassen.
// ======================================================================
export const CONFIG = {
  // App-Name. Zusätzlich in manifest.webmanifest und index.html (<title>) ändern.
  APP_NAME: 'Manhunt',
  TAGLINE: 'Jagd im echten Gelände.\nVerstecken, suchen, entkommen.',

  // Supabase: Dashboard → Project Settings → API (bzw. "API Keys").
  // Der Publishable Key (sb_publishable_…) oder der alte anon-Key darf öffentlich sein.
  // NIEMALS den Secret- oder service_role-Key hier eintragen!
  SUPABASE_URL: 'https://salqciekmrbgejuhpmkh.supabase.co',
  SUPABASE_KEY: 'sb_publishable_1FmYifiReXLLK6awTdt6SQ_JebJzu5W',

  // Adresse der veröffentlichten App (für QR-Codes und Einladungslinks).
  // Leer lassen = aktuelle Adresse verwenden.
  PUBLIC_URL: 'https://eric-yeah.github.io/manhunt/',

  // Kartenkacheln (OpenStreetMap, kostenlos, Namensnennung ist Pflicht)
  TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',

  // Startpunkt der Karte, wenn noch kein Standort bekannt ist (Frankfurt)
  DEFAULT_CENTER: { lat: 50.1109, lon: 8.6821 },

  // Wie oft die App im Vordergrund ihren Standort schickt (Sekunden)
  WEB_LOCATION_INTERVAL_S: 10,

  VERSION: '0.1.0',
};

export const isConfigured = () => /^(https:\/\/.+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/.test(CONFIG.SUPABASE_URL) && CONFIG.SUPABASE_KEY.length > 20;
