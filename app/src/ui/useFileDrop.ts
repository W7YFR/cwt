/* Dropping a recording anywhere on the page.
 *
 * Bound to the window rather than to a drop zone, for two reasons. The obvious
 * one is that aiming at a particular card is work the person should not have to
 * do — they have a file and they want it open. The less obvious one is that a
 * page which does not handle a drop does not simply ignore it: the browser
 * navigates away and opens the file on its own, losing whatever was on screen.
 * Once anywhere is a target, everywhere has to be.
 *
 * `dragleave` fires on every hop between child elements, so tracking "is a drag
 * over the window" with a boolean flickers the whole time the pointer moves.
 * Enter and leave do come in matched pairs, though, so a depth counter is
 * steady: the drag has left when the count returns to zero.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { audioFromDrop } from "@/capture/file";

export interface FileDropOptions {
  onFile(file: File): void;
  onError(message: string): void;
  /** Ignore drops entirely — while one is already being decoded, say. */
  disabled?: boolean;
}

/** True while a drag is over the window, for whatever the page wants to show. */
export function useFileDrop(options: FileDropOptions): boolean {
  const { onFile, onError, disabled = false } = options;
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // Read through a ref so the listeners are attached once rather than being
  // torn down and rebuilt every time a caller re-renders — a re-bind in the
  // middle of a drag would lose the depth count and strand the overlay.
  const latest = useRef({ onFile, onError, disabled });
  latest.current = { onFile, onError, disabled };

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  useEffect(() => {
    /** Files, as opposed to a selection of text or a link from another tab. */
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      if (!latest.current.disabled) setOver(true);
    };

    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // Without this the drop never fires and the browser opens the file
      // itself, which navigates away from the app.
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = latest.current.disabled ? "none" : "copy";
      }
    };

    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (latest.current.disabled) return;
      const file = audioFromDrop(e.dataTransfer);
      if (file) latest.current.onFile(file);
      else latest.current.onError("That drop had no audio file in it — try another one.");
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    // A drag that ends outside the window never reports a leave for its last
    // enter, so the count would stay above zero and the overlay would stick.
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
    };
  }, [reset]);

  return over;
}
