/* Anatomy of a QSO, shown by example.
 *
 * An example QSO, worked by the script itself (see qso/examples.ts), and a
 * short list of what to send when stuck. An example rather than rules: the
 * station takes things in more than one order and more than one wording, and
 * what gets somebody unstuck is seeing what to send back.
 *
 * On the page until the first QSO starts, so an empty page says what to do,
 * then behind the ? beside Start.
 *
 * Behind the ?, it opens over the page as the start screen's sound path help
 * does, and closes on Escape, on Close, or on a click outside it.
 */

import { useEffect, useMemo, useRef } from "react";
import { examples } from "@/qso/examples";

/** The guide itself: what a QSO is, a worked example, and what to send. On
 *  the page before the first QSO, and in the help after it. */
export function QsoGuide({
  onSettings,
  settingsOpen,
}: {
  onSettings(): void;
  /** The settings are open already: the guide points at them, not to them. */
  settingsOpen: boolean;
}): React.ReactElement {
  const shown = useMemo(() => examples(), []);
  return (
    <>
      <p>
        Call CQ with your call sign. A station will call you back and you can begin an
        exchange. Send a signal report, your name, and your QTH, and the other station will
        respond in kind. Send 73 to end the call.
      </p>

      {shown.map((ex) => (
        <section key={ex.title}>
          <h3>{ex.title}</h3>
          <ol className="qsoexample">
            {ex.lines.map((line, i) => (
              <li key={i} className={line.you ? "you" : "them"}>
                <span className="who">{line.you ? "You" : "K4ABC"}</span>
                <span className="text">
                  <code>{line.text}</code>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}

      <h3>Useful to know</h3>
      <ul className="qsosend">
        <li>
          End your turn with <code>K</code>, or stop sending and wait.
        </li>
        <li>
          Send <code>QRS</code> or <code>QRQ</code> to ask the station to send slower or faster.
        </li>
        <li>
          Send <code>AGN</code> or <code>?</code> to ask the station to repeat.
        </li>
        <li>
          Made a mistake? Send a row of dits, then send the word again.
        </li>
        <li>If you get stuck, send what the station asked for.</li>
      </ul>

      {settingsOpen ? (
        <p>Change your speed and configure the QSO parameters in the settings panel.</p>
      ) : (
        <p>
          Open the{" "}
          <button type="button" className="link" data-testid="qso-guide-settings" onClick={onSettings}>
            settings
          </button>{" "}
          to change your speed and configure the QSO parameters.
        </p>
      )}
    </>
  );
}

/** The guide, over the page, once a QSO has started. */
export function QsoHelp({
  onClose,
  onSettings,
  settingsOpen,
}: {
  onClose(): void;
  settingsOpen: boolean;
  /** Open the settings. The help closes first, so they are in view. */
  onSettings(): void;
}): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);

  /* Focus on the dialog itself: it is a page to read, and Escape reaches a
     handler on it only with focus inside. */
  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="dialog qsohelp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qsohelp-title"
        data-testid="qso-help"
        tabIndex={-1}
        ref={box}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h2 id="qsohelp-title">Anatomy of a QSO</h2>
        <div className="prose">
          <QsoGuide
            settingsOpen={settingsOpen}
            onSettings={() => {
              onClose();
              onSettings();
            }}
          />
        </div>
        <div className="confirm">
          <button className="primary" data-testid="qso-help-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
