"""Minimal MCP server that serves one prompt file, so large prompts need not be piped through stdin."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOL_NAME = "read_prompt"
PAGE_CHARS = 20000


def prompt_page(text: str, args: dict) -> dict:
    offset = min(len(text), max(0, int(args.get("offset", 0))))
    end = min(len(text), offset + PAGE_CHARS)
    return {"text": text[offset:end], "offset": offset, "total_chars": len(text),
            "next_offset": end if end < len(text) else None, "complete": end >= len(text)}


def page_count(chars: int) -> int:
    return max(1, -(-chars // PAGE_CHARS))


def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def serve(path: Path) -> None:
    spec = {"name": TOOL_NAME,
            "description": "Read the task prompt in pages. Start at offset 0 and keep passing next_offset until complete is true.",
            "inputSchema": {"type": "object", "properties": {"offset": {"type": "integer", "minimum": 0}},
                            "required": [], "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}
    for raw in sys.stdin:
        try: packet = json.loads(raw)
        except (ValueError, TypeError): continue
        if not isinstance(packet, dict) or packet.get("id") is None: continue
        request_id, method = packet["id"], packet.get("method")
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": request_id,
                   "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": False}},
                              "serverInfo": {"name": "prism_prompt", "version": "0.1.0"}}})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": [spec]}})
        elif method == "tools/call":
            params = packet.get("params") or {}
            if not isinstance(params, dict): params = {}
            try:
                if params.get("name") != TOOL_NAME: raise ValueError("That tool is not available.")
                arguments = params.get("arguments") or {}
                if not isinstance(arguments, dict): raise ValueError("Tool arguments must be a JSON object.")
                payload = prompt_page(path.read_text(encoding="utf-8"), arguments)
                _send({"jsonrpc": "2.0", "id": request_id,
                       "result": {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=True)}],
                                  "structuredContent": payload, "isError": False}})
            except (ValueError, TypeError, OverflowError, UnicodeError, OSError) as exc:
                _send({"jsonrpc": "2.0", "id": request_id,
                       "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True}})
        elif method == "shutdown":
            _send({"jsonrpc": "2.0", "id": request_id, "result": None})
        else:
            _send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=Path, required=True)
    serve(parser.parse_args().file)


if __name__ == "__main__":
    main()
