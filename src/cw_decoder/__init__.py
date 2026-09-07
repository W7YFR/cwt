"""cw-decoder: decode Morse code (CW) from audio into text."""

from .core import Result, Timing, decode_file

__all__ = ["decode_file", "Result", "Timing"]
__version__ = "0.1.0"
