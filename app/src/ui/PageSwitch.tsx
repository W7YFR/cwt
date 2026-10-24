/* Send, Copy or QSO: the three pages, one switch, in the header of each.
 *
 * Send is "practice" in the code and in what is stored, as it was before it
 * had a name of its own. */

export type Page = "practice" | "copy" | "qso";

const PAGES: ReadonlyArray<{ value: Page; label: string; help: string }> = [
  { value: "practice", label: "Send", help: "Send a message and see how you sent it" },
  { value: "copy", label: "Copy", help: "Copy a recording of CW and see what you got" },
  { value: "qso", label: "QSO", help: "Call CQ and work the stations that answer" },
];

export function PageSwitch({
  page,
  onPage,
  disabled = false,
}: {
  page: Page;
  onPage(page: Page): void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div className="modeswitch pageswitch" role="group" aria-label="Page" data-testid="page">
      {PAGES.map((p) => (
        <button
          key={p.value}
          data-page={p.value}
          aria-pressed={page === p.value}
          title={p.help}
          disabled={disabled}
          onClick={() => onPage(p.value)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
