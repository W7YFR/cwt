/* Playback through an <audio> element, for a phone.
 *
 * A phone suspends a Web Audio context when the screen locks or the page goes
 * to the background, so the sound stops. An <audio> element playing a file
 * plays on. It also makes the page the phone's Now Playing, so the lock screen
 * and the headphone buttons reach it through the Media Session API.
 *
 * Only a recording as WAV bytes plays here. The target, a decoded buffer and
 * the offline render go to the Web Audio player underneath. A recording
 * opens no audio context: on iOS a live one pauses the element when the
 * screen locks. The page's audio session is set to playback for the same
 * reason, where the browser has one (Safari 17 and later).
 *
 * An element cannot play louder than its file: a level over 0 dB plays at
 * 0 dB. iOS ignores the element's volume altogether, and the phone's own
 * volume sets the level there.
 *
 * The element sits in the page, hidden: iOS may not take a detached one as
 * the page's sound.
 *
 * The phone sends the headphone buttons to the page only after the page's
 * sound has played. Before that, play goes to the last app that played. So
 * the first tap on the page, once the page names what it plays, plays a
 * moment of silence and pauses. The page is then the phone's Now Playing,
 * paused, and the first press of play reaches it.
 */

import { addHelper } from "@/devtools";
import { createPlayer, type Player, type PlayerCallbacks, type PlaySide } from "./player";
import { encodeWavBuffer } from "./wav";

/** HTMLMediaElement.HAVE_METADATA, which jsdom may not define. */
const HAVE_METADATA = 1;

/** How close to its stop a timer may fire and still count as there. */
const STOP_SLACK_SEC = 0.03;

/** How long the silence is that makes the page Now Playing. iOS may pass
 *  over a very short sound. */
const SILENCE_SEC = 5;

/** The taps and keys a browser lets start a sound. */
const GESTURES = ["touchend", "click", "keydown"];

/** What the headphones and the element did, newest last, for
 *  `__cwt.headphoneLog()`. */
const log: { at: string; what: string }[] = [];
/** The most the log keeps. */
const LOG_MAX = 200;

/** Add `what` to the headphone log. */
export function noteHeadphones(what: string): void {
  log.push({ at: new Date().toISOString().slice(11, 23), what });
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

addHelper(
  "headphoneLog",
  "headphoneLog() lists what the headphone buttons sent the Copy page on a phone, and what its sound did. " +
    "headphoneLog(false) clears it.",
  (show = true) => {
    if (!show) log.length = 0;
    else console.table(log);
    return log.length;
  },
);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => noteHeadphones(`page ${document.visibilityState}`));
}

export function createMediaPlayer(callbacks: PlayerCallbacks = {}): Player {
  const inner = createPlayer(callbacks);
  const el = new Audio();
  el.preload = "auto";
  el.hidden = true;
  for (const event of ["play", "playing", "pause", "ended", "waiting", "stalled", "suspend", "emptied", "error"]) {
    el.addEventListener(event, () => noteHeadphones(`sound ${event} at ${el.currentTime.toFixed(1)} s`));
  }
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = "playback";
  let gainDb = 0;

  let mode: PlaySide | null = null;
  let stopAt: number | null = null;
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** True while a file not yet read plays muted, on its way to the start. */
  let moving = false;

  /* The WAV bytes the element holds, and their URL. */
  let source: ArrayBuffer | null = null;
  let url: string | null = null;

  /* Each start takes a ticket; a stop or another start voids it, so a seek
     that lands after either does nothing. */
  let ticket = 0;

  const volume = () => Math.min(1, Math.pow(10, gainDb / 20));

  function teardown(): void {
    ticket++;
    mode = null;
    stopAt = null;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    moving = false;
    if (!el.paused) el.pause();
    el.muted = false;
  }

  function finish(reason: "done" | "stopped"): void {
    const was = mode !== null;
    teardown();
    if (was) callbacks.onEnded?.(reason);
  }

  /** Where the element is: on to the next frame, or done at its stop.
   *  A frame, the element's own time updates and a timer all call this,
   *  as a locked phone runs no frames. */
  function watch(): void {
    if (mode !== "you" || moving) return;
    const t = el.currentTime;
    if (stopAt !== null && t >= stopAt - STOP_SLACK_SEC) return finish("done");
    callbacks.onProgress?.(t, "you");
  }

  function frame(): void {
    watch();
    raf = mode === "you" ? requestAnimationFrame(frame) : null;
  }

  /** A timer for the stop, set again from where the element is each time
   *  it fires early. */
  function timeStop(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (mode !== "you" || moving || stopAt === null) return;
    const left = (stopAt - el.currentTime) / (el.playbackRate || 1);
    timer = setTimeout(() => {
      timer = null;
      watch();
      timeStop();
    }, Math.max(10, left * 1000));
  }

  el.addEventListener("timeupdate", watch);
  el.addEventListener("playing", timeStop);
  el.addEventListener("ended", () => {
    if (mode === "you") finish("done");
  });
  // Paused from outside the page: a call coming in, or the phone's own
  // controls. The end of the file pauses it too, just before it ends.
  el.addEventListener("pause", () => {
    if (mode !== "you") return;
    finish(el.ended || el.currentTime >= el.duration - 0.05 ? "done" : "stopped");
  });

  /* Silence on the first tap, to make the page Now Playing. A tap that plays
     the QSO itself takes the element over, and the silence stops. */
  let primed = false;
  let silence: string | null = null;
  function prime(): void {
    if (primed || mode !== null || !navigator.mediaSession?.metadata) return;
    primed = true;
    const mine = ticket;
    silence ??= URL.createObjectURL(
      new Blob([encodeWavBuffer(new Float32Array(SILENCE_SEC * 8000), 8000)], { type: "audio/wav" }),
    );
    el.src = silence;
    source = null;
    if (!el.isConnected) document.body.append(el);
    noteHeadphones("silence to take Now Playing");
    el.play().then(
      () => {
        if (mine === ticket && mode === null) el.pause();
      },
      () => {
        if (mine === ticket) primed = false;
      },
    );
  }
  for (const type of GESTURES) document.addEventListener(type, prime, true);

  return {
    async playBuffer(data, from, to) {
      inner.stop();
      if (!(data instanceof ArrayBuffer)) return inner.playBuffer(data, from, to);
      teardown();
      const mine = ticket;
      if (source !== data) {
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
        source = data;
        el.src = url;
      }
      if (!el.isConnected) document.body.append(el);
      const start = Math.max(from ?? 0, 0);
      mode = "you";
      stopAt = to ?? null;
      el.volume = volume();
      // play() is called here, before any wait, so a click or a headphone
      // button still counts as the reason it plays. A file not yet read
      // plays muted from its start until it can move to `start`.
      if (el.readyState >= HAVE_METADATA) el.currentTime = start;
      else if (start > 0) {
        el.muted = true;
        moving = true;
        el.addEventListener(
          "loadedmetadata",
          () => {
            if (mine !== ticket) return;
            el.currentTime = start;
            el.addEventListener(
              "seeked",
              () => {
                if (mine !== ticket) return;
                el.muted = false;
                moving = false;
                timeStop();
              },
              { once: true },
            );
          },
          { once: true },
        );
      }
      raf = requestAnimationFrame(frame);
      try {
        await el.play();
      } catch (e) {
        if (mine !== ticket) return;
        teardown();
        callbacks.onError?.(`could not play the recording: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    playTarget(timeline, options) {
      if (mode !== null) teardown();
      inner.playTarget(timeline, options);
    },

    stop() {
      inner.stop();
      finish("stopped");
    },

    // The element needs no waking, and a context opened here would stop it
    // on a locked phone. The target opens its own.
    wake() {},

    setGainDb(db) {
      gainDb = db;
      el.volume = volume();
      inner.setGainDb(db);
    },

    gainDb: () => gainDb,
    playing: () => mode ?? inner.playing(),
    renderTarget: (timeline, options) => inner.renderTarget(timeline, options),

    destroy() {
      teardown();
      for (const type of GESTURES) document.removeEventListener(type, prime, true);
      el.removeAttribute("src");
      el.load();
      el.remove();
      if (url) URL.revokeObjectURL(url);
      if (silence) URL.revokeObjectURL(silence);
      url = null;
      silence = null;
      source = null;
      inner.destroy();
    },
  };
}
