import React from "react";
import { useBackgroundMusic } from "./useBackgroundMusic";

export interface BackgroundMusicProps {
  /** Custom music URL. Add your file to public/ and use e.g. "/music.mp3" */
  src?: string;
  /** Volume 0-1 */
  volume?: number;
  /** Auto-play on first user click/tap anywhere. Default false (user clicks music button to start) */
  playOnInteraction?: boolean;
}

/**
 * Background music for the game. Renders a floating toggle button.
 * Uses royalty-free default music; pass `src` to use your own.
 */
export const BackgroundMusic: React.FC<BackgroundMusicProps> = ({
  src,
  volume = 0.3,
  playOnInteraction = false,
}) => {
  const { isPlaying, toggle } = useBackgroundMusic({
    src,
    volume,
    playOnInteraction,
  });

  return (
    <button
      type="button"
      className="background-music-toggle"
      onClick={toggle}
      title={isPlaying ? "Mute music" : "Play music"}
      aria-label={isPlaying ? "Mute background music" : "Play background music"}
    >
      {isPlaying ? "🔊" : "🔇"}
    </button>
  );
};
