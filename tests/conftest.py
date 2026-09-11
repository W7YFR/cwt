"""Shared test setup.

The CLI keeps per-user state under `~/.cw-decoder` — the remembered input
device and the review-page session directories. Left alone, the test suite
writes into the developer's real home: it has already polluted a config with a
fake device name once. Every test gets a throwaway HOME instead.

It also opens a browser, and that is now the *default* output rather than
something a flag asks for — so the stub for it has to be automatic too. A test
that forgets it would fling real tabs at whoever ran the suite.
"""

import os

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Point HOME at a temp directory for the duration of each test.

    `cli._state_dir` expands `~` per call rather than at import, so this is
    enough to redirect both the config file and the session directories.
    """
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))   # Windows
    # expanduser consults the password database before HOME on posix in some
    # paths, so make the mapping explicit.
    monkeypatch.setattr(os.path, "expanduser",
                        lambda p: p.replace("~", str(home), 1)
                        if p.startswith("~") else p)
    return home


@pytest.fixture(autouse=True)
def no_browser(monkeypatch):
    """Capture the URL the CLI would open instead of launching a browser.

    Autouse, so no test can open one by omission; request it by name to assert
    on what would have been opened.
    """
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    return opened
