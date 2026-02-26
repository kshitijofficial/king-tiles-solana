import { useCallback, useEffect, useRef } from "react";

/**
 * Short impact sound for player collision push events.
 */
export function useBumpSound(volume = 0.14) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playBumpSound = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;

    const doPlay = () => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = "square";
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now);
      filter.Q.value = 0.8;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.02, Math.min(0.28, volume)),
        now + 0.01
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(doPlay).catch(() => {});
      return;
    }

    doPlay();
  }, [ensureContext, volume]);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  return { playBumpSound };
}
