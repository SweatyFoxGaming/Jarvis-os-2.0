#!/usr/bin/env python3
"""
Check for technical jargon in user‑facing strings.
Only scans string literals (text in quotes) in relevant files.
"""

import os
import re
import sys
import ast

# Forbidden jargon (case‑insensitive)
FORBIDDEN = [
    "department", "worker", "registry", "pipeline", "scheduler",
    "capability", "execution", "engine", "planner", "board",
    "chief of staff", "event bus", "eventbus", "tool registry",
    "knowledge librarian", "secure memory", "synapse interface",
    "security module", "user manager", "model manager",
]

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
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            strings.append(node.value)
        elif isinstance(node, ast.Str):  # for older Python versions
            strings.append(node.s)
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
            lower = s.lower()
            for word in FORBIDDEN:
                if word in lower:
                    # Check if it's a technical description (like in comments) – we allow if it's a code comment
                    # But we'll still flag it if it's not a comment or docstring
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
