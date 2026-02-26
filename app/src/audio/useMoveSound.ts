import { useCallback, useEffect, useRef } from "react";

/**
 * Lightweight move SFX using Web Audio (no external asset required).
 * Plays a short blip each time a move is detected.
 */
export function useMoveSound(volume = 0.12) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureContext = useCallback(() => {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  const playMoveSound = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;

    const playTone = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.value = 680;
      gain.gain.value = 0.0001;

      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      const clamped = Math.max(0.01, Math.min(0.25, volume));
      gain.gain.exponentialRampToValueAtTime(clamped, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

      osc.start(now);
      osc.stop(now + 0.1);
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(playTone).catch(() => {});
      return;
    }

    playTone();
  }, [ensureContext, volume]);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  return { playMoveSound };
}

