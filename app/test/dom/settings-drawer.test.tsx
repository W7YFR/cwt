/* Settings, the toolbar's quick settings, and Help: the shell every page
 * shares. A page's tabs come first, then the app's; a chip opens its own
 * setting and its tab; Help holds the page's guide and its keys. */

import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MicChip, PageSettings, SettingsButton, SettingsDrawer, SettingsProvider } from "@/ui/SettingsDrawer";
import { QuickChip, Toolbar } from "@/ui/Toolbar";
import { PageHelp } from "@/ui/Help";
import { ChoiceGroup, Section } from "@/ui/Controls";

/** A page in the shell: a choice in a chip and on its own tab. */
function Page({ locked = false }: { locked?: boolean }) {
  const [v, setV] = useState("a");
  const choice = (
    <Section name="pick" title="Pick">
      <div className="panelgroups">
        <ChoiceGroup
          id="pick"
          label="Pick"
          value={v}
          options={[
            { value: "a", label: "A", note: "A short note." },
            { value: "b", label: "B", note: "A much longer note, about twice the length of the other." },
          ]}
          onChange={setV}
        />
      </div>
    </Section>
  );
  return (
    <>
      <header>
        <MicChip devices={[{ deviceId: "x", label: "Desk mic" }]} deviceId="x" profiles={[]} profileId={undefined} />
        <PageHelp
          title="Test"
          guide={<p data-testid="guide-text">How the page works.</p>}
          keys={[{ heading: "Keys", rows: [{ keys: [["R"]], does: "Record" }] }]}
        />
        <SettingsButton />
        <Toolbar
          actions={<button>Go</button>}
          chips={
            <QuickChip id="pick" label="Pick" value={v.toUpperCase()} widest="B" tab="page" locked={locked}>
              {choice}
            </QuickChip>
          }
        />
      </header>
      <PageSettings
        locked={locked}
        tabs={[
          { id: "page", label: "Test", scope: "Only on the test page.", content: choice },
          { id: "sound", label: "Sound", content: <p data-testid="sound-tab">sound</p> },
        ]}
      />
    </>
  );
}

function shell(locked = false) {
  return render(
    <SettingsProvider>
      <Page locked={locked} />
      <SettingsDrawer app={(tab) => <p data-testid="app-tab">{tab}</p>} />
    </SettingsProvider>,
  );
}

const tabs = () => [...document.querySelectorAll("[data-testid='settings-tab'] [role='tab']")].map((t) => t.getAttribute("data-tab"));

describe("Settings", () => {
  it("shows the page's tabs, then the app's, with a line between them", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("panel-toggle"));
    expect(tabs()).toEqual(["page", "sound", "microphone", "you", "drills"]);
    const sep = document.querySelector("[data-testid='settings-tab'] .tabsep")!;
    expect(sep.previousElementSibling!.getAttribute("data-tab")).toBe("sound");
    expect(sep.nextElementSibling!.getAttribute("data-tab")).toBe("microphone");
  });

  it("says where each tab's settings apply", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("panel-toggle"));
    expect(document.querySelector(".drawerscope")!.textContent).toBe("Only on the test page.");
    await user.click(document.querySelector("[data-tab='you']")!);
    expect(document.querySelector(".drawerscope")!.textContent).toBe("The same on every page.");
  });

  it("dims the page's tabs while recording, and leaves the app's", async () => {
    const user = userEvent.setup();
    shell(true);
    await user.click(screen.getByTestId("panel-toggle"));
    expect(document.querySelector(".drawerslot")).toHaveAttribute("inert");
    expect(document.querySelector(".drawerlock")).not.toBeNull();
    await user.click(document.querySelector("[data-tab='drills']")!);
    expect(document.querySelector(".drawerslot")).not.toHaveAttribute("inert");
  });

  it("closes on Esc", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      shell();
      await user.click(screen.getByTestId("panel-toggle"));
      expect(screen.getByTestId("settings")).toBeTruthy();
      await user.keyboard("{Escape}");
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByTestId("settings")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a quick setting", () => {
  it("opens its setting under the chip, and its tab from More in Settings", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("chip-pick"));
    const pop = screen.getByTestId("pop-pick");
    await user.click(pop.querySelector("button[aria-pressed='false']")!);
    expect(screen.getByTestId("chip-pick").textContent).toContain("B");
    await user.click(screen.getByRole("button", { name: /more in settings/i }));
    expect(screen.queryByTestId("pop-pick")).toBeNull();
    expect(screen.getByTestId("settings")).toBeTruthy();
    expect(document.querySelector("[data-tab='page']")).toHaveAttribute("aria-selected", "true");
  });

  it("is off while recording", () => {
    shell(true);
    expect(screen.getByTestId("chip-pick")).toBeDisabled();
  });

  it("keeps room for its widest value, so the chips beside it do not move", () => {
    shell();
    const value = screen.getByTestId("chip-pick").querySelector<HTMLElement>(".chipvalue")!;
    expect(value.style.minWidth).toBe("1ch");
  });
});

describe("a choice's note", () => {
  it("keeps every choice's note in one place, so the row does not change height", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("panel-toggle"));
    const notes = [...document.querySelectorAll("#pick-note > span")];
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.getAttribute("data-on"))).toEqual(["true", "false"]);
  });
});

describe("the microphone chip", () => {
  it("names the input and opens Settings at Microphone", async () => {
    const user = userEvent.setup();
    shell();
    const chip = screen.getByTestId("mic-chip");
    expect(chip.textContent).toContain("Desk mic");
    expect(chip.getAttribute("data-state")).toBe("none");
    await user.click(chip);
    expect(screen.getByTestId("app-tab").textContent).toBe("microphone");
  });
});

describe("Help", () => {
  it("holds the page's guide and its keys, and closes Settings' way", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("help-open"));
    expect(screen.getByTestId("guide-text")).toBeTruthy();
    await user.click(document.querySelector("[data-testid='help-tab'] [data-tab='keys']")!);
    expect([...screen.getByTestId("help-keys").querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["R"]);
  });

  it("gives way to Settings", async () => {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByTestId("help-open"));
    expect(screen.getByTestId("help-open")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("mic-chip"));
    expect(screen.getByTestId("help-open")).toHaveAttribute("aria-pressed", "false");
  });
});
