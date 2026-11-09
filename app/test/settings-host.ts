/* A page as the app draws it: inside the Settings host, with the drawer its
 * tabs open into. Without it a page's ⚙ opens nothing. */

import { createElement, type ReactElement } from "react";
import { SettingsDrawer, SettingsProvider } from "@/ui/SettingsDrawer";

export function withSettings(page: ReactElement): ReactElement {
  return createElement(SettingsProvider, null, page, createElement(SettingsDrawer, { app: () => null }));
}
