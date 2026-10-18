/* Practice or QSO: the two pages, one switch, in the header of each. */

export type Page = "practice" | "qso";

const PAGES: ReadonlyArray<{ value: Page; label: string; help: string }> = [
  { value: "practice", label: "Practice", help: "Send a message and see how you sent it" },
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
