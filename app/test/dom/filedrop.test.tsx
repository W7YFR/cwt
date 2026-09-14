/* Dropping a recording anywhere on the page.
 *
 * Exercised through the hook rather than through a screen, because the whole
 * point of it is that it belongs to no screen: it is bound to the window, and
 * both the landing page and the review answer a drop the same way.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useFileDrop } from "@/ui/useFileDrop";

function Harness(props: {
  onFile: (f: File) => void;
  onError: (m: string) => void;
  disabled?: boolean;
}) {
  const [disabled] = useState(props.disabled ?? false);
  const over = useFileDrop({ onFile: props.onFile, onError: props.onError, disabled });
  return <div data-testid="page">{over ? "drop it" : "idle"}</div>;
}

/** A drag carrying files, the way a browser reports one. */
function withFiles(...files: File[]) {
  return { dataTransfer: { types: ["Files"], files, dropEffect: "" } };
}

const wav = () => new File(["RIFF"], "take.wav", { type: "audio/wav" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a drop anywhere on the page", () => {
  it("opens an audio file dropped on the window itself", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} onError={vi.fn()} />);
    const file = wav();
    fireEvent.drop(window, withFiles(file));
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("says so when the drop had no audio in it", () => {
    const onError = vi.fn();
    render(<Harness onFile={vi.fn()} onError={onError} />);
    fireEvent.drop(window, withFiles(new File(["x"], "notes.txt", { type: "text/plain" })));
    expect(onError.mock.calls[0]![0]).toMatch(/no audio/i);
  });

  it("shows the invitation while a file is over the page, and takes it back after", () => {
    render(<Harness onFile={vi.fn()} onError={vi.fn()} />);
    const page = () => screen.getByTestId("page").textContent;
    expect(page()).toBe("idle");

    fireEvent.dragEnter(window, withFiles(wav()));
    expect(page()).toBe("drop it");

    fireEvent.dragLeave(window, withFiles(wav()));
    expect(page()).toBe("idle");
  });

  it("holds steady while the pointer moves across the page", () => {
    /* `dragleave` fires on every hop between child elements, so a plain
       boolean flickers the whole time the pointer is moving. Enter and leave
       arrive in matched pairs, so the count is what stays steady. */
    render(<Harness onFile={vi.fn()} onError={vi.fn()} />);
    const page = () => screen.getByTestId("page").textContent;

    fireEvent.dragEnter(window, withFiles(wav())); // onto the page
    fireEvent.dragEnter(window, withFiles(wav())); // onto a child of it
    fireEvent.dragLeave(window, withFiles(wav())); // off the parent
    expect(page()).toBe("drop it");

    fireEvent.dragLeave(window, withFiles(wav())); // and finally off the page
    expect(page()).toBe("idle");
  });

  it("ignores a drag that is not carrying files", () => {
    // Selected text, or a link from another tab. Neither is a recording, and
    // covering the page to say so would be a lie.
    const onFile = vi.fn();
    const onError = vi.fn();
    render(<Harness onFile={onFile} onError={onError} />);

    const text = { dataTransfer: { types: ["text/plain"], files: [] } };
    fireEvent.dragEnter(window, text);
    expect(screen.getByTestId("page").textContent).toBe("idle");

    fireEvent.drop(window, text);
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("turns a drag away while one is already being decoded", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} onError={vi.fn()} disabled />);
    fireEvent.dragEnter(window, withFiles(wav()));
    expect(screen.getByTestId("page").textContent).toBe("idle");
    fireEvent.drop(window, withFiles(wav()));
    expect(onFile).not.toHaveBeenCalled();
  });

  it("claims the drop, so the browser does not navigate away to the file", () => {
    /* A page that leaves a drop unhandled does not ignore it — the browser
       opens the file itself and whatever was on screen is gone. Both the
       dragover and the drop have to be claimed for that not to happen. */
    render(<Harness onFile={vi.fn()} onError={vi.fn()} />);
    for (const fire of [fireEvent.dragOver, fireEvent.drop]) {
      const event = new Event(fire === fireEvent.drop ? "drop" : "dragover", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [wav()], dropEffect: "" },
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("stops advertising a drop that ends outside the window", () => {
    // A drag released off-window never reports a leave for its last enter, so
    // the count would stay up and the invitation would stick.
    render(<Harness onFile={vi.fn()} onError={vi.fn()} />);
    fireEvent.dragEnter(window, withFiles(wav()));
    expect(screen.getByTestId("page").textContent).toBe("drop it");
    fireEvent.dragEnd(window, withFiles(wav()));
    expect(screen.getByTestId("page").textContent).toBe("idle");
  });
});
