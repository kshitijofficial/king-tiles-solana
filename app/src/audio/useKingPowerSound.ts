import { useCallback, useEffect, useRef } from "react";

/**
 * Dopamine-style "power gain" tone for king tile scoring.
 * Pitch rises with streak level while a player keeps earning king points.
 */
export function useKingPowerSound(baseVolume = 0.16) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playKingPower = useCallback(
    (level = 1) => {
      const ctx = ensureContext();
      if (!ctx) return;

      const doPlay = () => {
        const l = Math.max(1, Math.min(level, 10));
        const now = ctx.currentTime;

        const oscA = ctx.createOscillator();
        const oscB = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        const baseFreq = 440 + l * 28;
        oscA.type = "triangle";
        oscB.type = "sine";
        oscA.frequency.setValueAtTime(baseFreq, now);
        oscB.frequency.setValueAtTime(baseFreq * 1.5, now);

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(1600 + l * 120, now);
        filter.Q.value = 1.2;

        const vol = Math.max(0.03, Math.min(0.35, baseVolume + l * 0.008));
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(vol, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

        oscA.connect(filter);
        oscB.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        // Upward chirp for "powering up" feel
        oscA.frequency.exponentialRampToValueAtTime(baseFreq * 1.35, now + 0.19);
        oscB.frequency.exponentialRampToValueAtTime(baseFreq * 1.9, now + 0.19);

        oscA.start(now);
        oscB.start(now);
        oscA.stop(now + 0.25);
        oscB.stop(now + 0.25);
      };

      if (ctx.state === "suspended") {
        ctx.resume().then(doPlay).catch(() => {});
        return;
      }

      doPlay();
    },
    [ensureContext, baseVolume]
  );

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  return { playKingPower };
}

