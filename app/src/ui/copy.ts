/* The words the app uses for timing classes, and what each one means.
 *
 * Worth spelling out because the names are only obvious once you already know
 * the model: "intra-char gap" is easy to read as the gap *between* characters,
 * which is a different class with a target more than three times as large.
 *
 * Each entry says where to look on the chart as well as what the number should
 * be — a flagged element you cannot find is a flagged element you cannot fix.
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
    "A short mark. The unit everything else is measured in: it should be 1.00u " +
    "by definition, so a dit off target means your dits are uneven, not slow.",
  dah:
    "A long mark. Should be 3.00u — exactly three dits. A dah keyed short is " +
    "the usual reason a letter comes back as a different one.",
  "element-gap":
    "The silence INSIDE a single character, between its own dits and dahs (the " +
    "gap between the dot and the dash of an A). Should be 1.00u. These are the " +
    "narrowest gaps drawn, so their labels are left off until you zoom in — " +
    "hover the bracket on the chart for the exact length. Hovering this row " +
    "highlights just the one character the gap is inside, and clicking plays " +
    "that character alone.",
  "char-gap":
    "The silence BETWEEN two letters of the same word. Should be 3.00u, and " +
    "wider than that when you send Farnsworth — the target column has the " +
    "figure for the speeds now set. Clicking one on the chart plays the letter " +
    "before it, the gap, and the letter after: a silence on its own is silence, " +
    "and spacing is only audible against what it separates.",
  "word-gap":
    "The silence between two words. Should be 7.00u, and wider under " +
    "Farnsworth. Long enough and it stops being a gap at all and becomes a " +
    "rest, which is not graded. Clicking one on the chart plays the whole word " +
    "either side, because half a word does not read as one.",
  pause:
    "A silence long enough to be you stopping rather than spacing. Not graded, " +
    "and drawn at a fixed width with its real length on the label.",
};

/** Appended to a deviation row's class tooltip. A single element being out is
 *  a different claim from the class average being out, and the table shows
 *  both — so each has to say which it is. */
export const DEVIATION_NOTE =
  " This row is one of them, not the average — the class can sit inside " +
  "tolerance overall and still have a single element out here.";

export const COLLAPSE_RESTS_HELP =
  "A silence more than three word gaps long is you stopping, not mis-spacing. " +
  "Collapsed, it takes a fixed sliver of the chart, stays out of the grading, " +
  "and the drift plot restarts after it. Off, every silence is graded and " +
  "drawn to scale.";

export const PACE_CURSOR_HELP =
  "While you record another take, a cursor runs along the target track at the " +
  "speed now set, after a count-in you can watch it come in on. It is a " +
  "metronome you can see: spacing is the hardest thing to feel and the easiest " +
  "thing to watch. It paces the message already on screen, so it is for " +
  "another attempt at the same text rather than for something new. Nothing " +
  "about the recording changes — the cursor is a guide, not a gate, and " +
  "falling behind it costs nothing but the drift plot showing it afterwards.";

export const CHAR_MARKERS_HELP =
  "Draw each character as a fixed-width tick at the moment it starts, instead " +
  "of the dits and dahs inside it. The width carries nothing: what is being " +
  "practiced is the rhythm — when the next character begins — and a block " +
  "whose length tracked the character would put its duration back on screen, " +
  "which is what pulls attention into counting elements rather than keeping " +
  "time. The grading does not change: a marker takes the worst grade of its " +
  "own elements and the gap that led into it, and the report below still " +
  "breaks every element out.";

export const FLASH_CARD_HELP =
  "The next character you are due to send, large, with a countdown to it. At " +
  "speed the chart's captions are small, moving, and exactly where you cannot " +
  "look — your eyes are on a paddle. It shows what the target says comes next, " +
  "never what you just sent, and it runs on the same count-in the pacing " +
  "cursor does.";

export const FLASH_CUE_HELP =
  "Light the card on the beat as well as showing it. Showing it and flashing " +
  "it are different things: the card is a reference you glance at, the flash " +
  "is a cue you react to — and reacting to a cue is a different skill from " +
  "keeping time, which is why neither is on by default.";

export const WORD_PREVIEW_HELP =
  "Spell the word being sent under the card, turning each letter green as it " +
  "passes. The card shows one character at a time, which says nothing about " +
  "where a word ends — and the gap between words is a decision you make, not " +
  "one the keyer makes for you.";

export const FLASH_LEAD_HELP =
  "How far ahead of the beat the card lights. Reacting to something you see " +
  "takes time, so a cue that fires exactly on the beat leaves you late by that " +
  "much on every character. How much is yours, which is why this is a dial and " +
  "not a constant. The countdown is not moved by it — the clock stays true and " +
  "only the flash runs early.";

export const PACE_LEAD_HELP =
  "How long the count-in runs before the cursor reaches the first character. " +
  "The recording starts the moment you click, whatever this is set to — the " +
  "count is time to get a hand back to the paddle, not a delay, and the dead " +
  "air at the front is trimmed off anyway.";

export const GAIN_HELP =
  "Applied at playback only — the recording and any download stay at the level " +
  "you recorded.";

export const OPEN_FILE_HELP = "Open a recording from disk";

/** Why a file cannot join a session that already has attempts in it. */
export const OPEN_FILE_CLOSED =
  "A recording sets the speed for the session, so it can only start one. " +
  "Clear or start a new session to open a file.";

export const RUN_SORT_HELP =
  "What order the attempts are drawn in. Newest first while you are still " +
  "going, most consistent first when you are looking for the one that went " +
  "right. It changes where a row sits and nothing else — a run keeps the " +
  "number it was recorded with wherever it lands, and nothing about the " +
  "grading moves. Consistency rather than accuracy is what \u201cbest\u201d " +
  "means here: you can send every character correctly and still be all over " +
  "the place, and that is the thing being practiced.";

export const ZOOM_HELP = "Or scroll over the chart, which zooms about the pointer";

export const DEVIATION_SCOPE_NOTE =
  "Hover a value to find it on the chart, click to hear it — yours or the " +
  "target. Either way you get just what the class covers: the character itself " +
  "for a dit, dah or intra-char gap, the characters either side of a letter " +
  "gap, the words either side of a word gap.";

/* ---- what the calibration result is reporting ---------------------------- */

export const CAL_TAIL_HELP =
  "How long a note keeps sounding after the key comes up, measured as the time " +
  "it spends within 20 dB of full level. A room is the usual cause. Compared " +
  "against the dit at the speed you calibrated, this is what the verdict is.";

export const CAL_MAXWPM_HELP =
  "The speed at which that tail is still a small part of a dit — three quarters " +
  "of one, which is the widest margin every recording measured so far has read " +
  "correctly at. Send faster than this and elements start running together.";

export const CAL_CORRECTION_HELP =
  "How much longer every mark reads than it was keyed. That much time is moved " +
  "from the end of each mark into the silence that follows it, so the total " +
  "length of the recording never changes — only the boundary between them. " +
  "Measured by holding a paddle at a speed you state: the keyer supplies the " +
  "true element length, so the difference is what your setup is adding.";

export const RUN_SCORES_HELP =
  "Each attempt's two scores in the gutter beside its name \u2014 how much of " +
  "it landed inside the tolerance, and how much of it decoded to the target. " +
  "It is what a stack is for: which attempt went better, readable without " +
  "clicking through them one at a time. Only ever drawn with more than one " +
  "attempt on screen, since with one the figures under the chart are already " +
  "its score.";

export const CAPTION_ALL_HELP =
  "Caption every attempt with what it came out as, rather than only the one " +
  "being read. The band is reserved on every row either way, so nothing moves " +
  "\u2014 what you get is a page of text where the rows themselves are usually " +
  "the thing being compared, and what you get for it is reading every " +
  "attempt's decode at once.";

export const ADVANCED_GRADING_HELP =
  "The three tables under the chart: every class of element and gap with its " +
  "jitter, the deviations worth working on next, and what came out against " +
  "what you meant. Off by default \u2014 they are the deepest thing on the page " +
  "and the slowest to read, and the two figures in the scores band answer " +
  "\u201chow did that go\u201d without them. Turn them on when the answer is " +
  "\u201cnot well\u201d and the question becomes why.";

export const SHOW_DOWNLOADS_HELP =
  "The row of download buttons: your audio, the target rendered at the speeds " +
  "now set, the whole chart as a PNG, and every number on the page as JSON. " +
  "Off by default \u2014 getting a file out is an occasional act, and four " +
  "buttons across the page is a standing invitation to something you do " +
  "rarely.";

export const SHOW_HINTS_HELP =
  "The two notes under the chart: what clicking, scrolling and dragging do, " +
  "and which keys work. On until you turn them off \u2014 a hint nobody has " +
  "seen cannot be asked for, and a permanent instruction is furniture once " +
  "you know it. The color key stays either way: that is a legend rather than " +
  "an instruction, and it is read every time.";

export const SHOW_RUNS_HELP =
  "Whether the chart draws every attempt in the session or only the most " +
  "recent. All of them is the comparison \u2014 the rows share one column " +
  "axis and can be read down a column as well as along a row. The last one " +
  "alone is the loop: send it, look at it, send it again, where the attempts " +
  "behind the one you just made are in the way rather than in the picture.";

export const SHOW_CHART_CONTROLS_HELP =
  "The row above the chart: the order the rows are in, the axis, which " +
  "attempts are drawn, and the zoom. On by default. Turning it off is for " +
  "when the chart is set the way you want it and the page should be nothing " +
  "but chart \u2014 this cog stays either way, so there is always a way " +
  "back.";
