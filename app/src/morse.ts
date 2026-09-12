/* Morse code <-> character mapping, including prosigns.
 *
 * A *prosign* is two or more letters keyed as a single character (no
 * inter-letter gap), conventionally written in angle brackets, e.g.
 * <BK> = B+K = -...-.-
 *
 * Some prosigns share their dit/dah pattern with a punctuation mark. Those
 * collisions resolve toward whichever reading is normal on the air (see
 * PROSIGN_OVERRIDES): .-.-. decodes as <AR> (end of message) rather than "+",
 * but -...- stays "=", the separator hams write literally.
 *
 * Ported from cw_decoder/morse.py and asserted equal to it by the oracle test,
 * so the browser cannot disagree with the Python decoder about what a pattern
 * means — including the collision policy.
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

/* Which prosigns win over a colliding punctuation mark when decoding. <BT> is
   intentionally absent, so -...- decodes as "=". The rest are operational
   signals that on the air almost always mean the prosign. */
const PROSIGN_OVERRIDES = [
  "<AA>", "<AR>", "<AS>", "<BK>", "<CL>", "<CT>",
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

/** Map a dit/dah string (e.g. ".-") to a character or prosign, or "?". */
export function decodePattern(pattern: string): string {
  return MORSE_TO_CHAR[pattern] ?? "?";
}

/** Matches one comparable symbol: a prosign in brackets, or a single char. */
export const SYMBOL_RE = /<[A-Z]+>|./g;

/** Split text into comparable symbols.
 *
 * Prosigns are one token and spaces are single tokens, so a word-spacing error
 * shows up in the alignment as its own edit rather than vanishing into a
 * substitution. Case is normalized and runs of whitespace collapse to one. */
export function tokenize(text: string): string[] {
  const collapsed = String(text ?? "").toUpperCase().trim().split(/\s+/).join(" ");
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
