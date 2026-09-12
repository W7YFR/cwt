/* Two screens and the state between them. */

import { useCallback, useEffect, useState } from "react";
import { loadAudioFile } from "@/capture/file";
import { loadBundle } from "@/io/bundle";
import { loadPrefs, recallTake, savePrefs } from "@/io/storage";
import type { AudioClip } from "@/types";
import { Landing } from "./Landing";
import { ReviewScreen } from "./ReviewScreen";
import { useFileDrop } from "./useFileDrop";
import { useTake } from "./useTake";

/** How long the boot may take before it says anything.
 *
 * Long enough that an ordinary reload never reaches it, short enough that a
 * genuinely slow one does not look broken. */
export const BOOT_MESSAGE_DELAY_MS = 400;

export function App(): React.ReactElement {
  const take = useTake();
  const [error, setError] = useState<string | null>(null);
  const [intended, setIntended] = useState(() => loadPrefs().expected ?? "");
  const [deviceId, setDeviceId] = useState<string | undefined>(
    () => loadPrefs().deviceId,
  );
  /* The boot gate. Something has to hold the page while the checks below run,
     or the landing screen paints and is then replaced by a review — which is
     the flash this exists to prevent.

     Holding it is not the same as narrating it. The work is a 404 for a bundle
     that is usually not there and one IndexedDB read, which together take a
     few tens of milliseconds; a message on screen for that long is not
     information, it is a glitch on every single reload. So the gate is silent
     until the wait is long enough to be worth explaining — a slow network, or
     a large recording coming back off disk. */
  const [booting, setBooting] = useState(true);
  const [slowBoot, setSlowBoot] = useState(false);
  const [opening, setOpening] = useState(false);

  /* Where a session comes from, in order of precedence.
     1. A bundle beside the app: `cw-decode --serve` wrote one and opened a
        browser at it, so it is what you asked to look at just now.
     2. The take you were last looking at, out of IndexedDB. A reload must not
        drop a recording you just spent thirty seconds keying.
     3. Nothing, which is the ordinary first visit and not an error. */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const bundle = await loadBundle();
        if (!live) return;
        if (bundle) {
          take.adopt(bundle.take, bundle.audio);
          return;
        }
        const saved = await recallTake();
        if (!live || !saved) return;
        take.adopt(saved.take, await saved.audio.arrayBuffer(), {
          settings: saved.settings,
          // It came from storage; writing it straight back would copy a few
          // megabytes of audio on every page load for no gain.
          remember: false,
        });
      } catch (e: unknown) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setBooting(false);
      }
    })();
    return () => {
      live = false;
    };
    // Once, on mount. `take` is stable enough for this and re-running would
    // reload the bundle over whatever the user has since recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!booting) return;
    const timer = window.setTimeout(() => setSlowBoot(true), BOOT_MESSAGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [booting]);

  const chooseDevice = useCallback((id: string | undefined) => {
    setDeviceId(id);
    const next = { ...loadPrefs() };
    if (id) next.deviceId = id;
    else delete next.deviceId;
    savePrefs(next);
  }, []);

  /* The intended message outlives the take, because practicing the same text
     until it comes out clean is the whole loop this tool exists for. */
  const chooseIntended = useCallback((text: string) => {
    setIntended(text);
    savePrefs({ ...loadPrefs(), expected: text });
  }, []);

  const onAudio = useCallback(
    (clip: AudioClip, source: string, fromMic: boolean, data: ArrayBuffer | null) => {
      setError(null);
      try {
        take.load(
          clip,
          {
            source,
            expected: intended || null,
            expectedSource: intended ? "what you said you'd send" : null,
            // A microphone take always opens and closes with a moment of dead
            // air while you reach for the mouse; a file is however the person
            // who made it left it, and trimming it would move their clock.
            trim: fromMic,
          },
          data,
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? `${e.message} — make sure the recording has some CW in it, then give it another go.`
            : String(e),
        );
      }
    },
    [intended, take],
  );

  /* Opening a file lives here rather than on the landing screen, because a
     drop is answered anywhere on the page and the review is a page too: having
     looked at one recording, dragging the next one on is the obvious move. */
  const openFile = useCallback(
    async (file: File) => {
      setOpening(true);
      setError(null);
      try {
        const loaded = await loadAudioFile(file);
        onAudio(loaded.clip, loaded.name, false, loaded.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOpening(false);
      }
    },
    [onAudio],
  );

  const dropping = useFileDrop({
    onFile: (file) => void openFile(file),
    onError: setError,
    disabled: opening,
  });

  return (
    <div className="app">
      {dropping && (
        <div className="dropveil" role="presentation">
          <p>Drop a recording to open it</p>
        </div>
      )}

      {error && (
        <p className="banner error" role="alert">
          {error}{" "}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      {opening ? (
        <div className="busy" role="status">
          measuring your sending…
        </div>
      ) : booting && !take.loaded ? (
        /* Holds the page's height either way, so the landing screen does not
           jump up the moment it appears. */
        <div className="busy" role="status" aria-live="polite">
          {slowBoot ? "looking for your last session…" : ""}
        </div>
      ) : take.loaded && take.review ? (
        <ReviewScreen
          loaded={take.loaded}
          review={take.review}
          settings={take.settings}
          onChange={take.setSettings}
          onAudio={onAudio}
          onError={setError}
          deviceId={deviceId}
          onDeviceChange={chooseDevice}
          onBack={() => {
            take.clear();
            setError(null);
          }}
        />
      ) : (
        <Landing
          expected={intended}
          onExpectedChange={chooseIntended}
          onAudio={onAudio}
          onFile={(file) => void openFile(file)}
          onError={setError}
          deviceId={deviceId}
          onDeviceChange={chooseDevice}
        />
      )}
    </div>
  );
}
