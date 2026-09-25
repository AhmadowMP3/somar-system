let ctx: AudioContext | null = null;

function tone(freqs: number[], duration: number) {
  try {
    ctx ??= new AudioContext();
    const start = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t0 = start + i * duration;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    });
  } catch {
    /* audio is best-effort */
  }
}

/** Distinct success / error sounds plus a short haptic buzz. */
export function feedback(kind: 'success' | 'error') {
  if (kind === 'success') {
    tone([880, 1320], 0.12);
    navigator.vibrate?.(80);
  } else {
    tone([300, 200], 0.2);
    navigator.vibrate?.([120, 60, 120]);
  }
}

/** Must be called from a user gesture on iOS to unlock audio. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    /* ignore */
  }
}
