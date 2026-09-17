"""Compatibility entrypoint for the current Unix-socket voice daemon.

The original WebSocket/Vosk implementation is retired. Production uses
voice_engine.py; keeping this tiny wrapper prevents the stale entrypoint from
remaining a syntax/import trap for operators or tooling.
"""

from voice_engine import main


if __name__ == "__main__":
    main()
