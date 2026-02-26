import { useState, useCallback, useEffect, useRef } from "react";

export interface UseBackgroundMusicOptions {
  /** Optional music URL. If omitted, a built-in synth loop is used. */
  src?: string;
  /** Volume 0-1. Default 0.3 */
  volume?: number;
  /** Start playing on first user interaction anywhere on page. Default false (user clicks music button) */
  playOnInteraction?: boolean;
}

export function useBackgroundMusic(options: UseBackgroundMusicOptions = {}) {
  const {
    src,
    volume = 0.3,
    playOnInteraction = false,
  } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const synthGainRef = useRef<GainNode | null>(null);
  const synthTimerRef = useRef<number | null>(null);
  const noteIndexRef = useRef(0);
  const hasInteractedRef = useRef(false);

  const initAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    if (!src) return null;

    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = volume;
    audio.preload = "auto";

    audio.addEventListener("canplaythrough", () => setIsReady(true));
    audio.addEventListener("error", () => {
      setIsReady(false);
      setIsPlaying(false);
    });
    audio.addEventListener("playing", () => setIsPlaying(true));
    audio.addEventListener("pause", () => setIsPlaying(false));

    audioRef.current = audio;
    return audio;
  }, [src, volume]);

  const initSynth = useCallback(() => {
    if (audioCtxRef.current && synthGainRef.current) return;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;

    const ctx: AudioContext = audioCtxRef.current ?? new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0.01, Math.min(0.4, volume * 0.35));
    gain.connect(ctx.destination);

    audioCtxRef.current = ctx;
    synthGainRef.current = gain;
  }, [volume]);

  const playSynthStep = useCallback(() => {
    const ctx = audioCtxRef.current;
    const gain = synthGainRef.current;
    if (!ctx || !gain) return;

    // Simple ambient/chiptune-like loop
    const notes = [261.63, 329.63, 392.0, 329.63, 293.66, 349.23, 440.0, 349.23];
    const freq = notes[noteIndexRef.current % notes.length];
    noteIndexRef.current += 1;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.value = freq;
    env.gain.value = 0.0001;
    osc.connect(env);
    env.connect(gain);

    const now = ctx.currentTime;
    env.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.start(now);
    osc.stop(now + 0.24);
  }, []);

  const play = useCallback(() => {
    if (!src) {
      initSynth();
      const ctx = audioCtxRef.current;
      if (!ctx) {
        setIsPlaying(false);
        return;
      }

      ctx.resume()
        .then(() => {
          if (synthTimerRef.current != null) window.clearInterval(synthTimerRef.current);
          playSynthStep();
          synthTimerRef.current = window.setInterval(playSynthStep, 260);
          setIsPlaying(true);
        })
        .catch(() => setIsPlaying(false));
      return;
    }

    const audio = initAudio();
    if (!audio) {
      setIsPlaying(false);
      return;
    }
    setIsPlaying(true); // Optimistic: show unmuted immediately
    audio.play().catch(() => setIsPlaying(false));
  }, [src, initAudio, initSynth, playSynthStep]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    if (synthTimerRef.current != null) {
      window.clearInterval(synthTimerRef.current);
      synthTimerRef.current = null;
    }
    if (audioCtxRef.current?.state === "running") {
      audioCtxRef.current.suspend().catch(() => {});
    }
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  // Play on first user interaction (click/tap/key) if enabled
  useEffect(() => {
    if (!playOnInteraction || hasInteractedRef.current) return;

    const handleInteraction = () => {
      if (hasInteractedRef.current) return;
      hasInteractedRef.current = true;
      play();
    };

    const events = ["click", "keydown", "touchstart"];
    events.forEach((e) => window.addEventListener(e, handleInteraction, { once: true }));
    return () => events.forEach((e) => window.removeEventListener(e, handleInteraction));
  }, [playOnInteraction, play]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (synthTimerRef.current != null) {
        window.clearInterval(synthTimerRef.current);
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      synthGainRef.current = null;
    };
  }, []);

  return { isPlaying, isReady, play, pause, toggle };
}
