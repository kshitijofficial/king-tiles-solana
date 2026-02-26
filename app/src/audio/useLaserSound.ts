import { useCallback, useEffect, useRef } from "react";

/**
 * Fast laser zap for power usage.
 */
export function useLaserSound(volume = 0.16) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playLaserSound = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;

    const doPlay = () => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(1050, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.13);

      filter.type = "bandpass";
      filter.frequency.setValueAtTime(1400, now);
      filter.Q.value = 5;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.03, Math.min(0.3, volume)),
        now + 0.008
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.15);
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

  return { playLaserSound };
}
