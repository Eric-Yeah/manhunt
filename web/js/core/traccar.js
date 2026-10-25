// Liest Standortmeldungen aus den Formaten, die bei der Edge Function "location" ankommen:
// 1) Traccar Client (neue Versionen): POST JSON {"location": {"timestamp", "coords": {...}}, "device_id": "..."}
// 2) OsmAnd-Protokoll (ältere Traccar-Clients u. a.): Parameter id, lat, lon, timestamp, accuracy ... als Query oder Formular
// 3) Manhunt-Web-App: POST JSON {"id", "lat", "lon", "accuracy", "timestamp", "source": "web"}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** Zeitstempel in ms: Sekunden, Millisekunden, ISO 8601 oder "yyyy-MM-dd HH:mm:ss" (UTC). */
export function parseTimestamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
  }
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function num(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function fromParams(get) {
  const token = get('id') ?? get('deviceid') ?? get('device_id');
  let lat = num(get('lat')), lon = num(get('lon'));
  const loc = get('location');
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && typeof loc === 'string' && loc.includes(',')) {
    const [a, b] = loc.split(',');
    lat = num(a); lon = num(b);
  }
  let accuracy = num(get('accuracy'));
  if (!Number.isFinite(accuracy)) {
    const hdop = num(get('hdop'));
    if (Number.isFinite(hdop)) accuracy = hdop * 5;
  }
  const valid = get('valid');
  return {
    token: token == null ? null : String(token),
    lat, lon, accuracy,
    at: parseTimestamp(get('timestamp')),
    invalidFix: valid === 'false' || valid === '0',
  };
}

function fromTransistorJson(body) {
  let loc = body.location;
  if (Array.isArray(loc)) {
    loc = loc.filter(Boolean).sort((a, b) => (parseTimestamp(a.timestamp) || 0) - (parseTimestamp(b.timestamp) || 0)).pop();
  }
  const c = loc?.coords || {};
  return {
    token: body.device_id != null ? String(body.device_id) : (loc?.extras?.device_id ?? null),
    lat: num(c.latitude), lon: num(c.longitude), accuracy: num(c.accuracy),
    at: parseTimestamp(loc?.timestamp),
    invalidFix: false,
  };
}

/**
 * @param {{method:string, url:string, contentType?:string, bodyText?:string}} req
 * @returns {{token:string|null, lat:number, lon:number, accuracy:number, at:number|null, source:'traccar'|'web', invalidFix:boolean}}
 */
export function parseLocationRequest(req) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const ct = (req.contentType || '').toLowerCase();
  const text = req.bodyText || '';
  let parsed = null;
  let source = 'traccar';

  if (text && (ct.includes('json') || /^\s*[{[]/.test(text))) {
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (body && typeof body === 'object') {
      if (body.location) parsed = fromTransistorJson(body);
      else parsed = fromParams((k) => body[k]);
      if (body.source === 'web') source = 'web';
    }
  } else if (text && ct.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(text);
    parsed = fromParams((k) => form.get(k) ?? q.get(k));
  }
  // Fehlende Werte aus der URL ergänzen (alte Clients schicken alles als Query, auch bei POST)
  const fromQuery = fromParams((k) => q.get(k));
  if (!parsed) parsed = fromQuery;
  else {
    if (!parsed.token) parsed.token = fromQuery.token;
    for (const k of ['lat', 'lon', 'accuracy']) if (!Number.isFinite(parsed[k])) parsed[k] = fromQuery[k];
    if (parsed.at == null) parsed.at = fromQuery.at;
  }
  return { ...parsed, source };
}
