/* Morse code <-> character mapping, including prosigns.
 *
 * A *prosign* is two or more letters keyed as a single character (no
 * inter-letter gap), conventionally written in angle brackets, e.g.
 * <BK> = B+K = -...-.-
 *
 * Some prosigns share their dit/dah pattern with a punctuation mark. Those
 * collisions resolve toward whichever reading is normal on the air (see
 * PROSIGN_OVERRIDES): .-.-. decodes as <AR> (end of message) rather than "+",
 * and -...- as <BT> rather than "=".
 *
 * Which name wins only decides what a decode is WRITTEN as. It never decides
 * whether two of them match — see `canonicalChar`. Both names of a pair are
 * the same keying, so both are correct to send and neither can be an error
 * against the other.
 *
 * The tables are checked against recorded fixtures, collision policy included,
 * so a pattern cannot quietly change what it means.
 */

/** Letters, digits, and punctuation. */
export const BASE: Readonly<Record<string, string>> = {
  A: ".-",     B: "-...",   C: "-.-.",   D: "-..",    E: ".",
  F: "..-.",   G: "--.",    H: "....",   I: "..",     J: ".---",
  K: "-.-",    L: ".-..",   M: "--",     N: "-.",     O: "---",
  P: ".--.",   Q: "--.-",   R: ".-.",    S: "...",    T: "-",
  U: "..-",    V: "...-",   W: ".--",    X: "-..-",   Y: "-.--",
  Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.",
  "!": "-.-.--", "/": "-..-.",  "(": "-.--.",  ")": "-.--.-",
  "&": ".-...",  ":": "---...", ";": "-.-.-.", "=": "-...-",
  "+": ".-.-.",  "-": "-....-", _: "..--.-",  '"': ".-..-.",
  $: "...-..-", "@": ".--.-.",
};

/** Prosigns (multi-letter, keyed run-together). Rendered in <...> form. */
export const PROSIGNS: Readonly<Record<string, string>> = {
  "<AA>": ".-.-",        // new line
  "<AR>": ".-.-.",       // end of message            (pattern also "+")
  "<AS>": ".-...",       // wait / stand by           (pattern also "&")
  "<BK>": "-...-.-",     // break (invite reply mid-transmission)
  "<BT>": "-...-",       // new paragraph / separator (pattern also "=")
  "<CL>": "-.-..-..",    // closing / going off the air
  "<CT>": "-.-.-",       // start of message (a.k.a. <KA>)
  "<DN>": "-..-.",       // slash                     (pattern also "/")
  "<KN>": "-.--.",       // go ahead, named station only (pattern also "(")
  "<SK>": "...-.-",      // end of contact (a.k.a. <VA>)
  "<SN>": "...-.",       // understood (a.k.a. <VE>)
  "<SOS>": "...---...",  // distress
  "<HH>": "........",    // error / correction (eight dits)
};

export const CHAR_TO_MORSE: Readonly<Record<string, string>> = {
  ...BASE,
  ...PROSIGNS,
};

/* Which prosigns win over a colliding punctuation mark when decoding — which
   is a question about spelling and nothing more. Every one of these is an
   operational signal that on the air almost always means the prosign.
   <DN> is absent: on the air -..-. is almost always "/", as in W7YFR/P. */
const PROSIGN_OVERRIDES = [
  "<AA>", "<AR>", "<AS>", "<BK>", "<BT>", "<CL>", "<CT>",
  "<KN>", "<SK>", "<SN>", "<SOS>", "<HH>",
] as const;

/** Reverse map: base characters first, then the chosen prosigns override. */
export const MORSE_TO_CHAR: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [ch, pat] of Object.entries(BASE)) {
    if (!(pat in out)) out[pat] = ch;
  }
  for (const name of PROSIGN_OVERRIDES) {
    const pat = PROSIGNS[name];
    if (pat) out[pat] = name;
  }
  return out;
})();

/** The name a character comes back as once it has been keyed and decoded.
 *
 * Some patterns have two names. `-...-` is both `=` and `<BT>`; `.-.-.` is
 * both `+` and `<AR>`. A sender keying either name of a pair sends exactly the
 * same dits and dahs, so a decode can only ever return whichever name the
 * table picks — and comparing the two names as text then reports a
 * substitution for sending precisely what was asked for.
 *
 * So comparison goes through here. Display does not: what you typed is what
 * you meant, and the chart still shows it. */
export function canonicalChar(ch: string): string {
  const pat = CHAR_TO_MORSE[ch];
  return pat ? (MORSE_TO_CHAR[pat] ?? ch) : ch;
}

/** What a pattern with no character decodes to. It has no Morse pattern of
 *  its own, so it never matches an intended character — a "?" would match a
 *  keyed question mark. */
export const UNKNOWN = "\u25AF";

/** Map a dit/dah string (e.g. ".-") to a character or prosign, or UNKNOWN. */
export function decodePattern(pattern: string): string {
  return MORSE_TO_CHAR[pattern] ?? UNKNOWN;
}

/** A long break inside a message: the other side of a dialog, or time to
 *  read the next part. It has no Morse. The ideal timeline holds a pause
 *  here, and text comparison reads it as a word space. */
export const BREAK = "|";

/** One message out of however it was typed or pasted: upper case with single
 *  spaces, and each line break or typed BREAK as one BREAK between words. */
export function normalizeMessage(text: string): string {
  return text
    .toUpperCase()
    .replaceAll("\n", BREAK)
    .split(BREAK)
    .map((part) => part.trim().split(/\s+/).join(" "))
    .filter(Boolean)
    .join(` ${BREAK} `);
}

/** A message with each BREAK shown as a line break, for a text box. */
export function breakLines(text: string): string {
  return text
    .split(BREAK)
    .map((part) => part.trim())
    .join("\n");
}

/** Matches one comparable symbol: a prosign in brackets, or a single char. */
export const SYMBOL_RE = /<[A-Z]+>|./g;

/** Split text into comparable symbols.
 *
 * Prosigns are one token and spaces are single tokens, so a word-spacing error
 * shows up in the alignment as its own edit rather than vanishing into a
 * substitution. Case is normalized and runs of whitespace collapse to one. */
export function tokenize(text: string): string[] {
  const collapsed = String(text ?? "").toUpperCase().split(BREAK).join(" ").trim().split(/\s+/).join(" ");
  return collapsed ? (collapsed.match(SYMBOL_RE) ?? []) : [];
}

/** Split a word into keyable symbols, treating <XX> as one prosign.
 *
 * Anything with no Morse pattern is dropped rather than keyed as "?" — the
 * intended message is what a sender would have sent, and they cannot send a
 * character that has no code. */
export function keyableSymbols(word: string): string[] {
  return (String(word ?? "").toUpperCase().match(SYMBOL_RE) ?? []).filter(
    (t) => t in CHAR_TO_MORSE,
  );
}
