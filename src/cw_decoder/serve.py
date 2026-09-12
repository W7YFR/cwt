"""Serve the browser app with one recording already loaded.

A plain static server over two directories: the built app, and the session
directory holding `take.json` and its audio. The session files win, so the app
finds its bundle beside itself and everything else falls through to the build.

Why a server at all, rather than a self-contained HTML file opened straight
from `file://`? Because Chrome and Safari treat every `file://` document as an
opaque origin, so `fetch("take.json")` from one is blocked outright. Localhost
is the smallest thing that works, and it costs one short-lived process.
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import threading


def find_app_dir(explicit: str | None = None) -> str | None:
    """Locate the built app: `dist/` next to the repo, or an explicit path."""
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(1, 5):
        root = os.path.abspath(os.path.join(here, *[".."] * up))
        candidate = os.path.join(root, "dist")
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    return None


class _Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the session directory first, then the built app."""

    session_dir = ""
    app_dir = ""

    def translate_path(self, path: str) -> str:  # noqa: D102
        # Strip the query and fragment before deciding what file is meant.
        clean = path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        clean = os.path.normpath(clean)
        if clean.startswith("..") or os.path.isabs(clean):
            return os.path.join(self.app_dir, "index.html")
        if not clean or clean == ".":
            return os.path.join(self.app_dir, "index.html")

        session = os.path.join(self.session_dir, clean)
        if os.path.isfile(session):
            return session
        served = os.path.join(self.app_dir, clean)
        if os.path.isfile(served):
            return served
        # A single-page app: unknown paths are routes, not missing files.
        return os.path.join(self.app_dir, "index.html")

    def end_headers(self) -> None:  # noqa: D102
        # The bundle changes every run and the browser must not reuse the last
        # one — the symptom would be reviewing yesterday's sending.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102, ARG002
        pass  # a request log is noise in a CLI that just opened a browser


class Server:
    """A running server. Use as a context manager."""

    def __init__(self, httpd: socketserver.TCPServer, port: int) -> None:
        self._httpd = httpd
        self.port = port
        self.url = f"http://127.0.0.1:{port}/"
        self._thread = threading.Thread(target=httpd.serve_forever, daemon=True)

    def start(self) -> "Server":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def __enter__(self) -> "Server":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()


def serve(session_dir: str, app_dir: str, port: int = 0) -> Server:
    """Start a server on `port` (0 picks a free one)."""
    handler = functools.partial(_Handler)
    _Handler.session_dir = os.path.abspath(session_dir)
    _Handler.app_dir = os.path.abspath(app_dir)

    class _Reusable(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = _Reusable(("127.0.0.1", port), handler)
    return Server(httpd, httpd.server_address[1])
