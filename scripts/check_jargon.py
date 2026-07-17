#!/usr/bin/env python3
"""
Check for technical jargon in user‑facing strings.
Only scans string literals (text in quotes) in relevant files.
"""

import os
import re
import sys
import ast

# Forbidden jargon (case‑insensitive, whole-word — see FORBIDDEN_PATTERNS)
FORBIDDEN = [
    "department", "worker", "registry", "pipeline", "scheduler",
    "capability", "execution", "engine", "planner", "board",
    "chief of staff", "event bus", "eventbus", "tool registry",
    "knowledge librarian", "secure memory", "synapse interface",
    "security module", "user manager", "model manager",
]

# Word-boundary regexes, not substring checks — otherwise "dashboard" trips
# "board" and "engine_ready" (a JSON field name, not prose) trips "engine".
# \b already treats "_" as a word character, so it correctly does NOT split
# "engine_ready" into "engine" + "_ready".
FORBIDDEN_PATTERNS = [(word, re.compile(r'\b' + re.escape(word) + r'\b', re.IGNORECASE)) for word in FORBIDDEN]

# Files to scan. This is a Python-only, AST-based literal scanner, so it
# cannot cover the actual user-facing strings in src/server.ts or
# src/static/*.html/js — most of this app's UI copy lives there, not here.
SCAN_PATHS = [
    "src/api.py",
]

def extract_strings(filepath):
    """Extract all string literals from a Python file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        tree = ast.parse(content)
    except SyntaxError:
        return []
    strings = []
    for node in ast.walk(tree):
        # ast.Constant covers string literals on every currently-supported
        # Python version; the old ast.Str branch this used to fall back to
        # was removed in Python 3.12 and crashed this script outright
        # (AttributeError: module 'ast' has no attribute 'Str') rather than
        # gracefully skipping anything.
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            strings.append(node.value)
    return strings

def main():
    found = False
    for path in SCAN_PATHS:
        if not os.path.exists(path):
            print(f"⚠️ {path} not found – skipping")
            continue
        strings = extract_strings(path)
        for s in strings:
            # Skip very short strings or obvious code patterns
            if len(s) < 10:
                continue
            if s.startswith('--') or s.startswith('#'):
                continue
            for word, pattern in FORBIDDEN_PATTERNS:
                if pattern.search(s):
                    print(f"❌ Jargon in {path}: '{s[:80]}...' contains '{word}'")
                    found = True
                    break
    if found:
        sys.exit(1)
    else:
        print("✅ No jargon found in user‑facing strings.")
        sys.exit(0)

if __name__ == "__main__":
    main()
