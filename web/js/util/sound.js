// Sound-Joker: Ton abspielen, wenn ein Sucher ihn bei einem Gejagten auslöst.
// Browser erlauben Ton erst nach einer Berührung der Seite. Deshalb "entsperren" wir ihn beim ersten Tippen
// (stumm kurz abspielen), damit der Ton später auch ohne Berührung losgehen darf.
const SRC = new URL('../../sounds/fahh.mp3', import.meta.url).href;
const REPEATS = 3;

let audio = null;
let unlocked = false;

function get() {
  if (!audio) {
    audio = new Audio(SRC);
    audio.preload = 'auto';
  }
  return audio;
}

/** Einmal beim Start aufrufen: entsperrt den Ton beim ersten Tippen. */
export function initSound() {
  const events = ['pointerdown', 'touchend', 'keydown'];
  const unlock = async () => {
    if (unlocked) return;
    for (const ev of events) document.removeEventListener(ev, unlock, true);
    try {
      const a = get();
      a.muted = true;
      await a.play();
      a.pause();
      a.currentTime = 0;
      unlocked = true;
    } catch { /* wird beim Abspielen noch einmal versucht */ } finally {
      get().muted = false;
    }
  };
  for (const ev of events) document.addEventListener(ev, unlock, { capture: true, passive: true });
}

/** Spielt den Ton laut ab (mehrmals hintereinander). Gibt false zurück, wenn der Browser es verbietet. */
export async function playAlarm(repeats = REPEATS) {
  try {
    const a = get();
    a.muted = false;
    a.volume = 1;
    let left = repeats;
    a.onended = () => {
      left -= 1;
      if (left > 0) { a.currentTime = 0; a.play().catch(() => {}); }
    };
    a.currentTime = 0;
    await a.play();
    return true;
  } catch {
    return false;
  }
}
