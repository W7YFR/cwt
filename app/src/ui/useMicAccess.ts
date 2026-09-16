/* Whether the microphone is available to this page at all.
 *
 * Separate from `useRecorder`, and asked at the top of the app rather than by
 * whichever screen happens to want a microphone, because a blocked one is not
 * a fact about a screen. It is a fact about the browser, and the symptom is
 * silence: the device list comes back empty, so every picker that offers a
 * choice correctly declines to offer one, and the page ends up with no
 * controls and no explanation. That reads as the app being broken.
 *
 * Only the permission, not the devices. Opening one is what `useRecorder`
 * does, and asking here would mean the page requesting a microphone it has no
 * intention of recording from.
 */

import { useEffect, useState } from "react";
import { watchMicAccess, type MicAccess } from "@/capture/mic";

export function useMicAccess(): MicAccess {
  const [access, setAccess] = useState<MicAccess>("unknown");
  useEffect(() => watchMicAccess(setAccess), []);
  return access;
}
