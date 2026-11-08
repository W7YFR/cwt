/* Help: the ? beside Settings on every page. It opens a drawer with the
 * page's guide and every key the page answers to. */

import { useEffect, useState } from "react";
import { useSettings } from "./SettingsDrawer";
import { Drawer, DrawerTabs } from "./Drawer";
import { IconHelp } from "./Icons";

/** One key, or keys pressed together, and what it does. */
export interface KeyRow {
  keys: readonly (readonly string[])[];
  does: string;
}

/** Keys under a heading, such as "While recording". */
export interface KeyGroup {
  heading: string;
  rows: readonly KeyRow[];
}

type HelpTab = "guide" | "keys";

export function PageHelp({
  title,
  guide,
  keys,
}: {
  /** What the page is, for the drawer's guide, such as "Send". */
  title: string;
  guide: React.ReactNode;
  keys: readonly KeyGroup[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<HelpTab>("guide");
  /* One drawer at a time: Settings opening, as from a link in the guide,
     closes Help. */
  const settings = useSettings();
  useEffect(() => {
    if (settings.open) setOpen(false);
  }, [settings.open]);
  return (
    <>
      <button
        className="iconbtn cornerbtn"
        data-testid="help-open"
        aria-pressed={open}
        aria-controls="help-drawer"
        aria-label={`Help with the ${title} page`}
        title="Help and keys"
        onClick={() => setOpen((o) => !o)}
      >
        <IconHelp />
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Help"
        id="help-drawer"
        testId="help"
        bodyTab={tab}
        tabs={
          <DrawerTabs label="Help section" testId="help-tab">
            <button role="tab" data-tab="guide" aria-selected={tab === "guide"} onClick={() => setTab("guide")}>
              {title}
            </button>
            <button role="tab" data-tab="keys" aria-selected={tab === "keys"} onClick={() => setTab("keys")}>
              Keys
            </button>
          </DrawerTabs>
        }
      >
        {tab === "guide" ? <div className="helpguide prose">{guide}</div> : <KeyList groups={keys} />}
      </Drawer>
    </>
  );
}

/** Every key, a group at a time: the keys on the left, what each does on the
 *  right. */
function KeyList({ groups }: { groups: readonly KeyGroup[] }): React.ReactElement {
  return (
    <div className="keylist" data-testid="help-keys">
      {groups.map((g) => (
        <section key={g.heading}>
          <h3>{g.heading}</h3>
          <dl>
            {g.rows.map((r) => (
              <div className="keyrow" key={r.does}>
                <dt>
                  {r.keys.map((combo, i) => (
                    <span key={i} className="combo">
                      {i > 0 && <span className="or">or</span>}
                      {combo.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  ))}
                </dt>
                <dd>{r.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
