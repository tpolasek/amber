let context: AudioContext | undefined;

function audioContext(): AudioContext | undefined {
  const creator = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!creator) return undefined;
  context ??= new creator();
  return context;
}

/**
 * Browsers only start audio from inside a user gesture; runs end on stream
 * events, so the context is unlocked eagerly on the first interaction.
 */
export function installIdleSoundUnlock(): void {
  const unlock = () => {
    const audio = audioContext();
    if (audio?.state === "suspended") void audio.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

/**
 * A short two-tone blip marking the session's return to idle. Stays silent
 * until audio is unlocked or when the browser blocks playback.
 */
export function playIdleSound(): void {
  try {
    const audio = audioContext();
    if (!audio || audio.state !== "running") return;
    const start = audio.currentTime;
    const gain = audio.createGain();
    gain.connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    for (const [frequency, offset, duration] of [[1046.5, 0, 0.08], [784, 0.09, 0.1]] as const) {
      const oscillator = audio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + duration);
    }
  } catch {
    // No audio available: the visual idle state is signal enough.
  }
}
