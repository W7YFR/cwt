/* Anatomy of a QSO, shown by example.
 *
 * What to send, and an example QSO of each kind your CQ can start: a rag
 * chew from a plain CQ, or a run of CWT, SST, MST or POTA. One kind shows at
 * a time. Each example is worked by the script itself (see qso/examples.ts),
 * with your call and exchange from User where you set them. An example
 * rather than rules: the station takes things in more than one order and
 * more than one wording, and what gets somebody unstuck is seeing what to
 * send back.
 *
 * On the page until the first QSO starts, so an empty page says what to do,
 * then behind the ? beside Start. On the page, the examples sit to the right
 * of what to send, or under it on a narrow screen.
 *
 * Behind the ?, it opens over the page as the start screen's sound path help
 * does, and closes on Escape, on Close, or on a click outside it.
 */

import { EXAMPLE_STATION, GUIDE_IDS, example, exampleYou, type GuideId } from "@/qso/examples";
import { FORMATS } from "@/qso/formats";
import { loadUser } from "@/io/storage";

/** Each kind's name on its button. */
const LABEL: Readonly<Record<GuideId, string>> = { cq: "CQ", cwt: "CWT", sst: "SST", mst: "MST", pota: "POTA" };

/** The speeds a format's stations send at, as the guide says them. */
function speeds(id: Exclude<GuideId, "cq">): string {
  const [lo, hi] = FORMATS[id].wpm;
  return `Stations send at ${lo} to ${hi} wpm.`;
}

/** What each kind of QSO is, and what to send. */
function About({ id }: { id: GuideId }): React.ReactElement {
  switch (id) {
    case "cq":
      return (
        <p>
          A plain CQ starts a casual QSO. Send a signal report, your name, and your QTH, and the
          other station will respond in kind. Send 73 to end the call.
        </p>
      );
    case "cwt":
      return (
        <p>
          The CWops weekly CWT. Call <code>CQ CWT</code>. Send the station&apos;s call, your name
          and your CWops number. With no number in User, send your state. Send <code>TU</code> to
          end the QSO, and the next station calls. {speeds(id)}
        </p>
      );
    case "sst":
      return (
        <p>
          The K1USN Slow Speed Test. Call <code>CQ SST</code>. Send the station&apos;s call, your
          name and your state. Send <code>TU</code> to end the QSO, and the next station calls.{" "}
          {speeds(id)}
        </p>
      );
    case "mst":
      return (
        <p>
          The ICWC Medium Speed Test. Call <code>CQ MST</code>. Send the station&apos;s call, your
          name and a serial number: 1 for your first QSO, 2 for the next, and so on. Send{" "}
          <code>TU</code> to end the QSO, and the next station calls. {speeds(id)}
        </p>
      );
    case "pota":
      return (
        <p>
          Parks on the Air, with you at the park. Call <code>CQ POTA</code>. Send the
          station&apos;s call, a signal report and your state. Send <code>TU 73</code> to end the
          QSO, and the next station calls. {speeds(id)}
        </p>
      );
  }
}

/** The kinds of QSO, as buttons: one pressed. The Examples choose with it,
 *  and so does **Preferred mode** on the page. Both show the same kind. */
export function KindSwitch({
  shown,
  onShown,
  labelledBy,
  testId,
}: {
  shown: GuideId;
  onShown(shown: GuideId): void;
  /** The id of the label that names the group. */
  labelledBy: string;
  testId: string;
}): React.ReactElement {
  return (
    <div className="modeswitch" role="group" aria-labelledby={labelledBy} data-testid={testId}>
      {GUIDE_IDS.map((id) => (
        <button key={id} type="button" aria-pressed={shown === id} data-kind={id} onClick={() => onShown(id)}>
          {LABEL[id]}
        </button>
      ))}
    </div>
  );
}

/** An example QSO of each kind, one at a time, with buttons to choose. The
 *  kind shown is the page's preferred mode. */
export function QsoExamples({
  shown,
  onShown,
}: {
  shown: GuideId;
  /** Another kind was chosen. */
  onShown(shown: GuideId): void;
}): React.ReactElement {
  return (
    <section className="qsoexamples" data-testid="qso-examples" data-shown={shown}>
      <h3 id="qso-examples-label">Examples</h3>
      <KindSwitch shown={shown} onShown={onShown} labelledBy="qso-examples-label" testId="qso-guide-kinds" />
      <About id={shown} />
      <ExampleLines shown={shown} />
    </section>
  );
}

/** The example QSO of one kind, line by line, with no words about it. In the
 *  Examples, and under Preferred mode as a reminder. */
export function ExampleLines({ shown, testId = "qso-example" }: { shown: GuideId; testId?: string }): React.ReactElement {
  // Read each time: User may have changed in the settings.
  const lines = example(shown, exampleYou(loadUser()));
  return (
    <ol className="qsoexample" data-testid={testId} data-shown={shown}>
      {lines.map((line, i) => (
        <li key={i} className={line.you ? "you" : "them"}>
          <span className="who">{line.you ? "You" : EXAMPLE_STATION.call}</span>
          <span className="text">
            <code>{line.text}</code>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The guide itself: what to send, and an example QSO of each kind. On the
 *  page before the first QSO, and in the help after it. */
export function QsoGuide({
  onSettings,
  settingsOpen,
  shown,
  onShown,
}: {
  onSettings(): void;
  /** The settings are open already: the guide points at them, not to them. */
  settingsOpen: boolean;
  /** The kind the Examples show: the page's preferred mode. */
  shown: GuideId;
  /** Another kind was chosen. */
  onShown(shown: GuideId): void;
}): React.ReactElement {
  return (
    <div className="qsoguidecols">
      <div className="qsointro">
        <p>
          Call CQ with your call sign, and a station calls you back. A plain CQ starts a casual
          QSO. <code>CQ CWT</code>, <code>CQ SST</code>, <code>CQ MST</code> or{" "}
          <code>CQ POTA</code> starts a run: short contest QSOs, one station after another, until
          you press Stop. Choose a kind under Examples to see how it goes.
        </p>

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
            In a run, send <code>NR?</code>, <code>NAME?</code> or <code>QTH?</code> to ask for one
            part again. After your <code>TU</code>, the next station calls in a few seconds.
          </li>
          <li>Made a mistake? Send a row of dits, then send the word again.</li>
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
      </div>

      <QsoExamples shown={shown} onShown={onShown} />
    </div>
  );
}
