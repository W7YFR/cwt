/* The debug panel, behind `__cwt.debug(true)`: absent without the switch,
 * its switches kept where the console helpers keep them, the rag chew lines
 * on the screen, and a page's own tools shown in it. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DebugPanel, DebugTools } from "@/ui/DebugPanel";
import { DebugDownload } from "@/ui/DebugDownload";
import { setDebugPanel } from "@/devtools";
import { clearLlmEvents, llmLog, setLlmDebug } from "@/llm/engine";

const box = (id: string) => screen.getByTestId<HTMLInputElement>(`debug-switch-${id}`);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearLlmEvents();
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("the debug panel", () => {
  it("is not there at all without the switch", () => {
    const { container } = render(<DebugPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens with __cwt.debug(true) or ?debug, and closes from its own control", async () => {
    const user = userEvent.setup();
    render(<DebugPanel />);
    const cwt = (window as unknown as { __cwt: Record<string, (on?: boolean) => unknown> }).__cwt;
    act(() => void cwt.debug!(true));
    expect(screen.getByTestId("debug-panel")).toBeInTheDocument();
    expect(localStorage.getItem("cwt:debug")).toBe("1");
    await user.click(screen.getByTestId("debug-close"));
    expect(screen.queryByTestId("debug-panel")).toBeNull();
    expect(localStorage.getItem("cwt:debug")).toBeNull();

    window.history.replaceState({}, "", "/?debug");
    act(() => setDebugPanel(false));
    expect(screen.getByTestId("debug-panel")).toBeInTheDocument();
  });

  it("folds to a tab and back", async () => {
    const user = userEvent.setup();
    setDebugPanel(true);
    render(<DebugPanel />);
    await user.click(screen.getByTestId("debug-hide"));
    expect(screen.queryByTestId("debug-panel")).toBeNull();
    await user.click(screen.getByTestId("debug-show"));
    expect(screen.getByTestId("debug-panel")).toBeInTheDocument();
  });

  it("shows each switch as its helper keeps it, and sets it there", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cwt:debugLLM", "1");
    setDebugPanel(true);
    render(<DebugPanel />);
    expect(box("debugllm").checked).toBe(true);
    expect(box("replies").checked).toBe(false);

    await user.click(box("debugllm"));
    expect(localStorage.getItem("cwt:debugLLM")).toBeNull();
    await user.click(box("replies"));
    expect(sessionStorage.getItem("cwt:suggested-replies")).toBe("1");
    await user.click(box("live"));
    expect(localStorage.getItem("cwt:live-page")).toBe("1");
    vi.spyOn(console, "info").mockImplementation(() => {});
    await user.click(box("micdebug"));
    expect(sessionStorage.getItem("cwt:micdebug")).toBe("1");

    // A helper typed into the console moves the switch on the screen.
    act(() => setLlmDebug(true));
    expect(box("debugllm").checked).toBe(true);
  });

  it("shows each rag chew line, newest last, until Clear", async () => {
    const user = userEvent.setup();
    setDebugPanel(true);
    render(<DebugPanel />);
    act(() => {
      llmLog("qso: rag chew", { said: "your name?", english: ".-.. ---", cw: "", kept: false, why: "morse" });
      llmLog("qso: rag chew", { said: "your name?", english: "My name is Lynn.", cw: "MY NAME IS LYNN BK", kept: true, why: null });
      llmLog("llm: error", { name: "Error", message: "device lost" });
    });
    const events = screen.getAllByTestId("debug-event");
    expect(events.map((e) => [e.dataset.event, e.dataset.why ?? null])).toEqual([
      ["qso: rag chew", "morse"],
      ["qso: rag chew", null],
      ["llm: error", null],
    ]);
    expect(events[1]).toHaveTextContent("MY NAME IS LYNN BK");

    await user.click(screen.getByTestId("debug-ragchew-clear"));
    expect(screen.queryAllByTestId("debug-event")).toEqual([]);
    expect(screen.getByTestId("debug-ragchew").dataset.count).toBe("0");
  });

  it("keeps the last 20 rag chew lines", () => {
    setDebugPanel(true);
    render(<DebugPanel />);
    act(() => {
      for (let i = 0; i < 25; i++) llmLog("qso: suggested reply", { english: `line ${i}`, cw: `LINE ${i} BK`, why: null });
    });
    const events = screen.getAllByTestId("debug-event");
    expect(events).toHaveLength(20);
    expect(events[0]).toHaveTextContent("LINE 5 BK");
  });

  it("shows a page's Save buttons without ?micdebug, and only while open", async () => {
    const user = userEvent.setup();
    setDebugPanel(true);
    render(
      <>
        <DebugPanel />
        <DebugTools>
          <DebugDownload current={() => null} session={() => ({ data: {}, audio: null })} />
        </DebugTools>
      </>,
    );
    const panel = screen.getByTestId("debug-panel");
    expect(panel.querySelector('[data-testid="debug-log"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="debug-session"]')).not.toBeNull();

    await user.click(screen.getByTestId("debug-hide"));
    expect(screen.queryByTestId("debug-log")).toBeNull();
    await user.click(screen.getByTestId("debug-show"));
  });

  it("is listed by __cwt.help()", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    (window as unknown as { __cwt: { help(): void } }).__cwt.help();
    expect(String(info.mock.calls[0]?.[0])).toContain("__cwt.debug:");
  });
});
