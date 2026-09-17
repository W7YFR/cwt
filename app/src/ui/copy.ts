/* Every name and tooltip the interface uses.
 *
 * Worth spelling the class names out because they are only obvious once you
 * know the model: "intra-char gap" is easy to read as the gap *between*
 * characters, which is a different class with a target three times as large.
 *
 * Short, and about what the reader does next. A tooltip is read standing over
 * a control with a decision to make, not sat down — the reasoning behind a
 * setting belongs in the module that implements it, where the person who needs
 * it is looking.
 */

import type { BlockKind } from "@/types";

export const CLASS_LABEL: Record<BlockKind, string> = {
  dit: "dit",
  dah: "dah",
  "element-gap": "intra-char gap",
  "char-gap": "character gap",
  "word-gap": "word gap",
  pause: "rest",
};

/** Longer names, for the tooltip over a block on the chart. */
export const CLASS_LONG: Record<BlockKind, string> = {
  dit: "dit",
  dah: "dah",
  "element-gap": "intra-character gap",
  "char-gap": "character gap",
  "word-gap": "word gap",
  pause: "rest",
};

export const CLASS_HELP: Record<BlockKind, string> = {
  dit:
    "A short mark, and the unit everything else is measured in: 1.00u by " +
    "definition. Off target means your dits are uneven, not slow.",
  dah:
    "A long mark \u2014 3.00u, exactly three dits. Keyed short is the usual " +
    "reason a letter comes back as a different one.",
  "element-gap":
    "The silence INSIDE one character, between its own dits and dahs. Should " +
    "be 1.00u. Too narrow to label on the chart, so hover the bracket for the " +
    "length; clicking plays the character it is inside.",
  "char-gap":
    "The silence BETWEEN two letters of a word. Should be 3.00u, and wider " +
    "under Farnsworth \u2014 the target column has the figure for the speeds " +
    "now set. Clicking plays the letter either side with the gap between.",
  "word-gap":
    "The silence between two words. Should be 7.00u, wider under Farnsworth. " +
    "Long enough and it becomes a rest, which is not graded. Clicking plays " +
    "the word either side.",
  pause:
    "A silence long enough to be you stopping rather than spacing. Not " +
    "graded, and drawn at a fixed width with its real length on the label.",
};

/** Appended to a deviation row's class tooltip. A single element being out is
 *  a different claim from the class average being out, and the table shows
 *  both — so each has to say which it is. */
export const DEVIATION_NOTE =
  " This row is one element, not the class average — the class can sit inside " +
  "tolerance and still have this one out.";

export const COLLAPSE_RESTS_HELP =
  "A silence longer than three word gaps is you stopping, not mis-spacing. " +
  "Collapsed, it takes a fixed sliver of the chart and stays out of the " +
  "grading. Off, every silence is graded and drawn to scale.";

export const PACE_CURSOR_HELP =
  "A cursor runs along the target in real time while you record, after a " +
  "count-in. A metronome you can see. It is a guide, not a gate: falling " +
  "behind costs nothing but the drift plot showing it.";

export const PACE_ABSOLUTE_HELP =
  "Show the clock axis while a paced take runs, and put your view back " +
  "after. The cursor moves in real time and the per-character axis does not, " +
  "so the two disagree about how far along you are. Off if you would rather " +
  "the chart held still.";

export const CHAR_MARKERS_HELP =
  "Draw each character as a tick where it starts, instead of the dits and " +
  "dahs inside it. What is being practiced is when the next character " +
  "begins, not how long this one was. The grading does not change.";

export const ZEN_MODE_HELP =
  "While you record, the message alone on screen in large type, with the " +
  "clock and the way to stop. No beat and no count-in — the take ends when " +
  "you say it does, so it cannot run with the paced aids. Off again next " +
  "time you open the app.";

export const ZEN_PACING_HELP =
  "Not while Zen mode is on: one puts a beat in front of you, the other " +
  "takes the page away.";

export const FLASH_CARD_HELP =
  "The next character to send, large, with a countdown. At speed the " +
  "chart\u2019s captions are small, moving, and nowhere near where you are " +
  "looking. It shows what comes next, never what you just sent.";

export const FLASH_CUE_HELP =
  "Light the card on the beat as well as showing it. The card is a " +
  "reference you glance at; the flash is a cue you react to, which is a " +
  "different skill.";

export const WORD_PREVIEW_HELP =
  "Spell the word under the card, greening each letter as it passes. The " +
  "card shows one character at a time, which says nothing about where a word " +
  "ends.";

export const FLASH_LEAD_HELP =
  "How far ahead of the beat the card lights. Reacting takes time, so a cue " +
  "on the beat leaves you late by that much every character. The countdown " +
  "is not moved by it.";

export const PACE_LEAD_HELP =
  "How long the count-in runs before the cursor reaches the first " +
  "character. Recording starts the moment you click either way, and the dead " +
  "air at the front is trimmed off.";

export const TIMES_HELP =
  "How many times you send the message in one take. The box still holds one " +
  "copy; the target you hear, the row the chart draws and what you are " +
  "graded against carry that many, a word gap apart.";

export const TIMES_FILE_HELP =
  "Not for a recording opened from disk. It says how many passes you are " +
  "about to send, and a file already holds what it holds.";

export const GAIN_HELP =
  "Applied at playback only — the recording and any download stay at the level " +
  "you recorded.";

export const OPEN_FILE_HELP = "Open a recording from disk";

/** Why a file cannot join a session that already has attempts in it. */
export const OPEN_FILE_CLOSED =
  "A recording sets the speed for the session, so it can only start one. " +
  "Clear or start a new session to open a file.";

export const RUN_SORT_HELP =
  "What order the attempts are drawn in. A run keeps the number it was " +
  "recorded with wherever it lands, and nothing about the grading moves. " +
  "\u201cBest\u201d means most consistent: you can send every character " +
  "correctly and still be all over the place.";

export const ZOOM_HELP = "Or scroll over the chart, which zooms about the pointer";

export const DEVIATION_SCOPE_NOTE =
  "Hover a value to find it on the chart, click to hear it. You get what the " +
  "class covers: the character for a dit, dah or intra-char gap, the " +
  "characters either side of a letter gap, the words either side of a word " +
  "gap.";

/* ---- what the calibration result is reporting ---------------------------- */

export const CAL_TAIL_HELP =
  "How long a note keeps sounding after the key comes up — the time it " +
  "spends within 20 dB of full level. Against the dit at the speed you " +
  "calibrated, this is what the verdict is.";

export const CAL_MAXWPM_HELP =
  "The speed at which that tail is still three quarters of a dit or less. " +
  "Send faster and elements start running together.";

export const CAL_CORRECTION_HELP =
  "How much longer every mark reads than it was keyed. That time is moved " +
  "from the end of each mark into the silence after it, so the recording\u2019s " +
  "length never changes. Measured by holding a paddle at a speed you state.";

export const RUN_SCORES_HELP =
  "Each attempt\u2019s two scores in the gutter beside its name: how much " +
  "landed inside the tolerance, and how much decoded to the target. Which " +
  "attempt went better, without clicking through them one at a time.";

export const CAPTION_ALL_HELP =
  "Caption every attempt with what it came out as, rather than only the one " +
  "being read. The band is reserved either way, so nothing moves — what you " +
  "get is every decode at once.";

export const ADVANCED_GRADING_HELP =
  "The three tables under the chart: every class with its jitter, the " +
  "deviations worth working on, and what came out against what you meant. " +
  "Off by default — turn them on when the scores say it did not go well and " +
  "you want to know why.";

export const SHOW_DOWNLOADS_HELP =
  "The download buttons: your audio, the target at the speeds now set, the " +
  "chart as a PNG, and every number on the page as JSON.";

export const SHOW_HINTS_HELP =
  "The two notes under the chart: what clicking, scrolling and dragging do, " +
  "and which keys work. The color key stays either way.";

export const SHOW_RUNS_HELP =
  "How many of the session\u2019s attempts the chart draws. All of them is " +
  "the comparison: the rows share one column axis, so they read down as well " +
  "as along. The last alone is the loop — send it, look at it, send it again.";

export const SHOW_CHART_CONTROLS_HELP =
  "The row above the chart: the order the rows are in, the axis, which " +
  "attempts are drawn, and the zoom. The cog stays either way, so there is " +
  "always a way back.";
