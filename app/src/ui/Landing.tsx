/* The first screen: record, or open a file.
 *
 * Recording is the primary path and gets the bigger half, because that is what
 * the tool is for — a decoder that only reads files is a curiosity, and a
 * trainer you can key into is a practice instrument. Opening a file is still
 * here because it is how you check a recording you already have.
 */

import { useCallback, useRef, useState } from "react";
import { ACCEPTED, audioFromDrop, loadAudioFile } from "@/capture/file";
import { MIC_SOURCE } from "@/io/take";
import type { AudioClip } from "@/types";
import { fmtElapsed } from "./format";
import { DevicePicker, LevelMeter } from "./Record";
import { Wordmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";
import { useRecorder } from "./useRecorder";

export interface LandingProps {
  expected: string;
  onExpectedChange(text: string): void;
  onAudio(
    clip: AudioClip,
    source: string,
    fromMic: boolean,
    data: ArrayBuffer | null,
  ): void;
  onError(message: string): void;
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
}

export function Landing(props: LandingProps): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { onAudio, onError } = props;

  const rec = useRecorder({
    deviceId: props.deviceId,
    onClip: useCallback(
      (clip: AudioClip) => onAudio(clip, MIC_SOURCE, true, null),
      [onAudio],
    ),
    onError,
  });

  const openFile = useCallback(
    async (file: File) => {
      setOpening(true);
      try {
        const loaded = await loadAudioFile(file);
        onAudio(loaded.clip, loaded.name, false, loaded.data);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setOpening(false);
      }
    },
    [onAudio, onError],
  );

  if (opening || rec.busy) {
    return (
      <div className="busy" role="status">
        measuring your sending…
      </div>
    );
  }

  return (
    <div className="landing">
      <Wordmark art={visitWordmark()} />

      <p className="lede">
        Key into your microphone and every dit, dah and gap gets measured against
        a perfect sender, so you can become the perfect sender!
        <br />
        <br />
        Nothing is uploaded; the whole analysis runs right here in this tab.
      </p>

      <div className="intended-field">
        <label htmlFor="landing-expected">
          What are you going to send?{" "}
          <span className="hint">
            optional — but with it you get accuracy as well as timing
          </span>
        </label>
        <input
          id="landing-expected"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="CQ CQ DE W1AW K"
          value={props.expected}
          onChange={(e) => props.onExpectedChange(e.target.value.toUpperCase())}
        />
      </div>

      <div className="ways">
        <div className="way">
          <h2>Record</h2>
          {rec.recorder ? (
            <div className="recording">
              <div className="reclight">
                <span className="dot" />
                {fmtElapsed(rec.elapsed)}
              </div>
              <LevelMeter level={rec.level} />
              <div className="rowbuttons">
                <button className="big" onClick={() => void rec.finish()}>
                  Stop and review
                </button>
                <button onClick={() => rec.recorder?.restart()}>Start over</button>
              </div>
              <button className="link" onClick={() => void rec.discard()}>
                cancel
              </button>
              <p className="hint">Enter finishes the take · Esc throws it away</p>
            </div>
          ) : (
            <>
              <button className="big" onClick={() => void rec.start()}>
                ● Start recording
              </button>
              <DevicePicker
                devices={rec.devices}
                value={props.deviceId}
                onChange={props.onDeviceChange}
              />
              <p>
                {rec.needPermission
                  ? "Device names appear once you have allowed microphone access."
                  : "A virtual loopback device works here too, for keying an app on this machine."}
              </p>
            </>
          )}
        </div>

        <div
          className={`way drop${dragging ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = audioFromDrop(e.dataTransfer);
            if (file) void openFile(file);
            else onError("That drop had no audio file in it — try another one.");
          }}
        >
          <h2>Or open a recording</h2>
          <button className="big" onClick={() => fileInput.current?.click()}>
            Choose a file
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept={ACCEPTED}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openFile(file);
              e.target.value = "";
            }}
          />
          <p>Drop one here. WAV, MP3, M4A, FLAC and OGG all work.</p>
        </div>
      </div>
    </div>
  );
}
