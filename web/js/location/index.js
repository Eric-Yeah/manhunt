// Standort-Schicht. Austauschbar: Browser (navigator.geolocation), Demo (Antippen der Karte)
// und später z. B. Capacitor. Jeder Provider liefert Messungen {lat, lon, accuracy, at, heading}.

/** Provider: Browser-Geolocation (nur solange die App im Vordergrund ist). */
export class WebGeolocationProvider {
  constructor() {
    this.name = 'web';
    this.watchId = null;
  }
  get available() {
    return 'geolocation' in navigator;
  }
  start(onFix, onError) {
    if (!this.available) {
      onError?.(new Error('Dein Browser kann keinen Standort liefern.'));
      return;
    }
    if (this.watchId != null) return;
    this.ok = (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, at: Math.round(p.timestamp || Date.now()), heading: p.coords.heading });
    this.fail = (e) => onError?.(new Error(e.code === 1 ? 'Standortzugriff verweigert. Erlaube ihn in den Einstellungen (Safari → Standort).' : 'Standort gerade nicht verfügbar.'));
    this.watchId = navigator.geolocation.watchPosition(this.ok, this.fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  /** Frische Messung anfordern (watchPosition meldet sich nur bei Bewegung). */
  refresh() {
    if (this.watchId == null || !this.ok) return;
    navigator.geolocation.getCurrentPosition(this.ok, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }
  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

/** Provider für den Demo-Modus: Position wird per Antippen gesetzt und leicht verrauscht. */
export class ManualProvider {
  constructor(start) {
    this.name = 'demo';
    this.pos = start;
    this.timer = null;
    this.onFix = null;
  }
  get available() { return true; }
  start(onFix) {
    this.onFix = onFix;
    const emit = () => {
      if (!this.pos) return;
      const j = () => (Math.random() - 0.5) * 0.00006;
      onFix({ lat: this.pos.lat + j(), lon: this.pos.lon + j(), accuracy: 6 + Math.random() * 6, at: Date.now() });
    };
    emit();
    this.timer = setInterval(emit, 2000);
  }
  set(p) {
    this.pos = p;
    this.onFix?.({ lat: p.lat, lon: p.lon, accuracy: 6, at: Date.now() });
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Verwaltet den aktiven Provider, die letzte Position, das Senden an den Server
 * (gedrosselt) und die Bildschirmsperre (Wake Lock) während eines Spiels.
 */
export class LocationService {
  constructor() {
    this.provider = null;
    this.last = null;
    this.error = null;
    this.subs = new Set();
    this.sender = null;
    this.lastSent = 0;
    this.intervalMs = 10_000;
    this.wakeLock = null;
    this.wantWake = false;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantWake) this.acquireWake();
    });
  }

  use(provider) {
    if (this.provider === provider) return;
    this.stop();
    this.provider = provider;
  }

  start() {
    if (!this.provider) return;
    this.provider.start(
      (fix) => {
        this.last = fix;
        this.error = null;
        this.notify();
        this.maybeSend(fix);
      },
      (err) => {
        this.error = err.message;
        this.notify();
      },
    );
  }

  stop() {
    this.provider?.stop();
  }

  /** sender(fix) wird höchstens alle intervalMs aufgerufen. null = nicht senden. */
  setSender(fn, intervalMs = 10_000) {
    const wasNull = !this.sender;
    this.sender = fn;
    this.intervalMs = intervalMs;
    // Beim Einschalten einmal sofort senden (asynchron, damit keine Schleife entsteht)
    if (fn && wasNull && this.last) setTimeout(() => this.maybeSend(this.last, true), 0);
    clearInterval(this.heartbeat);
    this.heartbeat = fn ? setInterval(() => this.beat(), 2000) : null;
  }

  /**
   * Wer stillsteht, bekommt von watchPosition keine neuen Messungen. Damit der Server trotzdem
   * weiß, dass man noch da ist: frische Messung anfordern und die letzte Position bis zu
   * 2 Minuten lang regelmäßig erneut senden.
   */
  beat() {
    if (!this.sender || !this.last) return;
    const age = Date.now() - this.last.at;
    if (age > this.intervalMs) this.provider?.refresh?.();
    if (Date.now() - this.lastSent >= this.intervalMs && age < 120_000) this.maybeSend({ ...this.last, at: Date.now() });
  }

  async maybeSend(fix, force = false) {
    if (!this.sender) return;
    if (!force && Date.now() - this.lastSent < this.intervalMs) return;
    this.lastSent = Date.now();
    try {
      await this.sender(fix);
    } catch {
      /* nächster Versuch beim nächsten Fix */
    }
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  notify() {
    for (const fn of this.subs) fn(this.last, this.error);
  }

  setWake(on) {
    this.wantWake = on;
    if (on) {
      this.acquireWake();
    } else {
      this.wakeLock?.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  async acquireWake() {
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch {
      /* z. B. Energiesparmodus */
    }
  }
}
