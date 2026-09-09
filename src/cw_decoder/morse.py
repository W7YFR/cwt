"""Morse code <-> character mapping, including prosigns.

A *prosign* is two or more letters keyed as a single character (no inter-letter
gap), conventionally written in angle brackets, e.g. <BK> = B+K = -...-.-.

Some prosigns share their dit/dah pattern with a punctuation mark. We resolve
those collisions toward whichever reading is normal in on-air CW (see
`_PROSIGN_OVERRIDES` below): e.g. .-.-. decodes as <AR> (end of message) rather
than "+", but -...- stays "=" (the separator, which hams write literally).
"""

# Letters, digits, and punctuation.
BASE = {
    "A": ".-",    "B": "-...",  "C": "-.-.",  "D": "-..",   "E": ".",
    "F": "..-.",  "G": "--.",   "H": "....",  "I": "..",    "J": ".---",
    "K": "-.-",   "L": ".-..",  "M": "--",    "N": "-.",    "O": "---",
    "P": ".--.",  "Q": "--.-",  "R": ".-.",   "S": "...",   "T": "-",
    "U": "..-",   "V": "...-",  "W": ".--",   "X": "-..-",  "Y": "-.--",
    "Z": "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.",
    "!": "-.-.--", "/": "-..-.",  "(": "-.--.",  ")": "-.--.-",
    "&": ".-...",  ":": "---...", ";": "-.-.-.", "=": "-...-",
    "+": ".-.-.",  "-": "-....-", "_": "..--.-", '"': ".-..-.",
    "$": "...-..-", "@": ".--.-.",
}

# Prosigns (multi-letter, keyed run-together). Rendered in <...> form.
PROSIGNS = {
    "<AA>":  ".-.-",       # new line
    "<AR>":  ".-.-.",      # end of message            (pattern also "+")
    "<AS>":  ".-...",      # wait / stand by           (pattern also "&")
    "<BK>":  "-...-.-",    # break (invite reply mid-transmission)
    "<BT>":  "-...-",      # new paragraph / separator (pattern also "=")
    "<CL>":  "-.-..-..",   # closing / going off the air
    "<CT>":  "-.-.-",      # start of message (a.k.a. <KA>)
    "<KN>":  "-.--.",      # go ahead, named station only (pattern also "(")
    "<SK>":  "...-.-",     # end of contact (a.k.a. <VA>)
    "<SN>":  "...-.",      # understood (a.k.a. <VE>)
    "<SOS>": "...---...",  # distress
    "<HH>":  "........",   # error / correction (eight dits)
}

CHAR_TO_MORSE = {**BASE, **PROSIGNS}

# Which prosigns win over a colliding punctuation mark when decoding. "<BT>" is
# intentionally excluded so the pattern -...- decodes as "=" (the way hams write
# the between-thoughts separator). The rest are operational signals that, on the
# air, almost always mean the prosign rather than the punctuation.
_PROSIGN_OVERRIDES = {
    "<AA>", "<AR>", "<AS>", "<BK>", "<CL>", "<CT>",
    "<KN>", "<SK>", "<SN>", "<SOS>", "<HH>",
}

# Reverse map: base characters first, then let the chosen prosigns override.
MORSE_TO_CHAR = {}
for _ch, _pat in BASE.items():
    MORSE_TO_CHAR.setdefault(_pat, _ch)
for _name in _PROSIGN_OVERRIDES:
    MORSE_TO_CHAR[PROSIGNS[_name]] = _name


def decode_pattern(pattern: str) -> str:
    """Map a dit/dah string (e.g. '.-') to a character/prosign, or '?'."""
    return MORSE_TO_CHAR.get(pattern, "?")


def tables() -> dict:
    """Both mappings as plain dicts.

    The web review page needs them in JavaScript; injecting them from here at
    page-build time means the browser can't disagree with the decoder about what
    a pattern means, including the prosign collision policy above.
    """
    return {"charToMorse": dict(CHAR_TO_MORSE),
            "morseToChar": dict(MORSE_TO_CHAR)}
