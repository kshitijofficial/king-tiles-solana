import { useCallback, useEffect, useRef } from "react";

/**
 * Emergency-style countdown beep using Web Audio (no external asset required).
 * Intended to be triggered once per second during the final countdown.
 */
export function useEmergencyCountdownSound(volume = 0.16) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playEmergencyTick = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;

    const doPlay = () => {
      const now = ctx.currentTime;
      const vol = Math.max(0.02, Math.min(0.35, volume));

      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      gain.gain.setValueAtTime(0.0001, now);

      filter.type = "highpass";
      filter.frequency.setValueAtTime(280, now);
      filter.Q.value = 0.7;

      filter.connect(gain);
      gain.connect(ctx.destination);

      const makeBeep = (startAt: number, f0: number, f1: number) => {
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.setValueAtTime(f0, startAt);
        osc.frequency.exponentialRampToValueAtTime(f1, startAt + 0.09);
        osc.connect(filter);
        osc.start(startAt);
        osc.stop(startAt + 0.1);
      };

      // Two short beeps gives a more "emergency" feel while still being quick.
      // Envelope covers both beeps.
      gain.gain.exponentialRampToValueAtTime(vol, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.23);

      makeBeep(now, 980, 720);
      makeBeep(now + 0.12, 980, 720);
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

  return { playEmergencyTick };
}

