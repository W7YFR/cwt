/* The Live page, offered only once `__cwt.enableLive()` turns it on, while it
 * is being tried out. */

import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { PageSwitch } from "@/ui/PageSwitch";
import "@/devtools";

const cwt = () => (window as unknown as { __cwt: { enableLive(on?: boolean): string } }).__cwt;

const pages = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("[data-page]")].map((b) => b.dataset.page);

afterEach(() => {
  localStorage.clear();
});

describe("the Live page's switch", () => {
  it("leaves Live out of the page switch until it is turned on", () => {
    const { container } = render(<PageSwitch page="practice" onPage={() => {}} />);
    expect(pages(container)).toEqual(["practice", "copy", "qso"]);
  });

  it("adds Live at once, keeps it across a reload, and takes it away again", () => {
    const { container, unmount } = render(<PageSwitch page="practice" onPage={() => {}} />);
    act(() => void cwt().enableLive());
    expect(pages(container)).toEqual(["practice", "copy", "qso", "live"]);
    unmount();
    // As after a reload: the switch is kept.
    const again = render(<PageSwitch page="practice" onPage={() => {}} />);
    expect(pages(again.container)).toContain("live");
    act(() => void cwt().enableLive(false));
    expect(pages(again.container)).not.toContain("live");
  });
});
