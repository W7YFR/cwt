/* The audio inputs the browser lists, kept current as devices come and go.
 *
 * For the Microphone settings on a screen with no recorder of its own. A
 * screen that records has the same list from its recorder. */

import { useEffect, useState } from "react";
import { listInputs, type InputDevice } from "@/capture/mic";

export function useInputs(): InputDevice[] {
  const [inputs, setInputs] = useState<InputDevice[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void listInputs()
        .then((found) => live && setInputs(found))
        .catch(() => live && setInputs([]));
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);
  return inputs;
}
