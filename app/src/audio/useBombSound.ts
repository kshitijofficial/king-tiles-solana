import { useCallback, useEffect, useRef } from "react";

/**
 * Short low boom for bomb hits.
 */
export function useBombSound(volume = 0.18) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playBombSound = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;

    const doPlay = () => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.24);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(700, now);
      filter.Q.value = 0.9;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.04, Math.min(0.35, volume)),
        now + 0.02
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.28);
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

  return { playBombSound };
}
