/* The headphone buttons and the lock screen, through the Media Session API.
 *
 * A phone sends play, pause and next track from the headphones and the lock
 * screen to the page that plays its Now Playing sound. The page must play
 * through an <audio> element for that: see createMediaPlayer.
 */

import { useEffect, useRef } from "react";
import { noteHeadphones } from "@/audio/mediaPlayer";

/** Whether this is a phone or a tablet: touch, and no mouse to hover with. */
export function onPhone(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false);
}

export interface HeadphoneOptions {
  /** Off: the page takes no buttons. */
  on: boolean;
  /** What the lock screen shows as playing. Null when nothing is open. */
  title: string | null;
  playing: boolean;
  onPlay(): void;
  onPause(): void;
  /** Next track. `playing` is whether the QSO played before the press.
   *  `again` is whether another next track came just before it. */
  onNext(playing: boolean, again: boolean): void;
}

/** How soon next track follows a play or pause that is the first press of
 *  the same double press. iOS sends that first press on its own. */
const DOUBLE_PRESS_MS = 1000;

/** How soon a second next track counts as next track twice. */
const AGAIN_MS = 2000;

const ARTIST = "CWT Copy";
/** The app's icon squared to its edges, as the phone rounds the corners
 *  itself. From where the page is: the site may not sit at the root. */
const artwork = (): MediaImage[] => [
  { src: new URL("artwork-512.png", document.baseURI).href, sizes: "512x512", type: "image/png" },
];

export function useHeadphones(options: HeadphoneOptions): void {
  const { on, title, playing } = options;
  // Read through a ref, so the handlers are set once and always call the
  // page's latest functions.
  const latest = useRef(options);
  latest.current = options;
  /** The last play or pause: when, and whether the QSO played before it. */
  const press = useRef<{ at: number; playing: boolean } | null>(null);
  /** When the last next track came. */
  const lastNext = useRef<number | null>(null);

  const session = typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;

  useEffect(() => {
    if (!on || !session) return;
    const actions: [MediaSessionAction, () => void][] = [
      ["play", () => latest.current.onPlay()],
      ["pause", () => latest.current.onPause()],
      [
        "nexttrack",
        () => {
          const now = performance.now();
          const last = press.current;
          const recent = last !== null && now - last.at < DOUBLE_PRESS_MS;
          const again = lastNext.current !== null && now - lastNext.current < AGAIN_MS;
          // Twice is one action: a third next track starts a new count.
          lastNext.current = again ? null : now;
          latest.current.onNext(recent ? last.playing : latest.current.playing, again);
        },
      ],
    ];
    for (const [action, run] of actions) {
      const handler = () => {
        noteHeadphones(`button ${action}, ${latest.current.playing ? "playing" : "paused"}`);
        if (action !== "nexttrack") press.current = { at: performance.now(), playing: latest.current.playing };
        run();
        if (action === "nexttrack") press.current = null;
      };
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* this browser does not take that button */
      }
    }
    return () => {
      for (const [action] of actions) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* as above */
        }
      }
      session.metadata = null;
    };
  }, [on, session]);

  useEffect(() => {
    if (!on || !session || typeof MediaMetadata === "undefined") return;
    session.metadata = title === null ? null : new MediaMetadata({ title, artist: ARTIST, artwork: artwork() });
  }, [on, session, title]);

  useEffect(() => {
    if (!on || !session) return;
    session.playbackState = playing ? "playing" : "paused";
  }, [on, session, playing]);
}
