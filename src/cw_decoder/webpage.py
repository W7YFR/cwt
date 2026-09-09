"""Assemble the self-contained `--web-review` HTML page.

Everything — styles, logic, payload, and the recording itself as a base64 WAV —
is inlined into one file, so the review works offline forever, opens straight
from `file://` with no server, and can be archived or mailed as a single
artifact. The target-side audio isn't inlined at all: the page synthesizes it
with Web Audio, which both keeps the file smaller and lets the ideal keying
re-render instantly when you move the speed slider.
"""

from __future__ import annotations

import json
from importlib import resources

from . import morse


def _asset(name: str) -> str:
    return (resources.files("cw_decoder") / "web" / name).read_text(
        encoding="utf-8")


def _embed_json(obj) -> str:
    """Serialize for inlining inside a <script> tag.

    json.dumps already escapes every non-ASCII character (so a stray U+2028 in
    the intended text can't break the script), but it leaves `<` alone — and a
    literal `</script>` in any string field would terminate the element early.
    """
    return json.dumps(obj, separators=(",", ":")).replace("<", "\\u003c")


def render(payload: dict) -> str:
    """Return the complete HTML document for `payload`."""
    html = _asset("index.html")
    for token, value in (
        ("/*__CSS__*/", _asset("style.css")),
        ("/*__CORE_JS__*/", _asset("review-core.js")),
        ("/*__APP_JS__*/", _asset("app.js")),
        ("/*__MORSE__*/", _embed_json(morse.tables())),
        ("/*__PAYLOAD__*/", _embed_json(payload)),
    ):
        if token not in html:
            raise RuntimeError(f"web/index.html is missing the {token} slot")
        html = html.replace(token, value, 1)
    return html


def write(path: str, payload: dict) -> int:
    """Write the review page to `path`; returns the byte size."""
    data = render(payload).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)
