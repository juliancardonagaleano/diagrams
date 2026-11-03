#!/usr/bin/env python3
"""Launcher for the ECE MCP client (`ece-mcp`).

Reads the API key from the environment or `.env`, then exec's `mcp-ece.py`.
The canonical names are `ECE_MCP_API_KEY` and, in the client, `ECE_MCP_URL`.
`PCE_MCP_API_KEY` is a read alias when the new name is absent.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
ENV_FILE = REPO_ROOT / ".env"
CHECK_CREDENTIAL_FLAG = "--check-credential"


def _from_file(name: str) -> str:
    if not ENV_FILE.is_file():
        return ""
    prefix = name + "="
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(prefix):
            return line[len(prefix):].strip().strip('"').strip("'")
    return ""


def _load_key_from_env() -> str:
    if os.environ.get("ECE_MCP_API_KEY", "").strip():
        return os.environ["ECE_MCP_API_KEY"].strip()
    if "ECE_MCP_API_KEY" not in os.environ:
        from_file = _from_file("ECE_MCP_API_KEY")
        if from_file:
            return from_file
        if os.environ.get("PCE_MCP_API_KEY", "").strip():
            return os.environ["PCE_MCP_API_KEY"].strip()
        return _from_file("PCE_MCP_API_KEY")
    return ""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if CHECK_CREDENTIAL_FLAG in argv:
        if _load_key_from_env():
            print("credential: present")
            return 0
        print("credential: absent")
        print(
            "mcp-ece: credencial ausente: ECE_MCP_API_KEY no está en el entorno ni en .env",
            file=sys.stderr,
        )
        return 1

    key = _load_key_from_env()
    if not key:
        print(
            "mcp-ece: ECE_MCP_API_KEY no está en el entorno ni en .env",
            file=sys.stderr,
        )
        return 1

    os.environ["ECE_MCP_API_KEY"] = key
    client_script = SCRIPT_DIR / "mcp-ece.py"
    os.execv(sys.executable, [sys.executable, str(client_script)])


if __name__ == "__main__":
    sys.exit(main())
