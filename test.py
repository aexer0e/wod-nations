#!/usr/bin/env python3
"""Fetch the War of Dots ELO and World top-20 leaderboards."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import websockets

from get_user_data import (
    DEFAULT_VERSION,
    ROOT_DIR,
    bake_cake,
    eat_cake,
    get_steam_id_from_wrapper,
    load_config,
)


async def main() -> None:
    config = load_config(ROOT_DIR / "config.txt")
    login = config.get("login") or {}
    username = login.get("username")
    password = login.get("password")
    steam_id = get_steam_id_from_wrapper(ROOT_DIR) or 0

    async with websockets.connect("ws://cs.war-of-dots.com:9056", ping_interval=None) as ws:
        requests = [
            {"type": "access", "content": {"version": DEFAULT_VERSION}},
            {
                "type": "authorize",
                "content": {
                    "username": username,
                    "password": password,
                    "steamid": str(steam_id),
                },
            },
            {"type": "get_leaderboard", "content": {}},
        ]

        for request in requests:
            await ws.send(bake_cake(json.dumps(request, separators=(",", ":")).encode()))
            reply = eat_cake(await asyncio.wait_for(ws.recv(), timeout=8))
            if isinstance(reply, dict) and reply.get("type") == "get_leaderboard":
                print(json.dumps(reply, indent=2, ensure_ascii=False))
                return

    raise RuntimeError("The server did not return a leaderboard response")


if __name__ == "__main__":
    asyncio.run(main())
get_leaderboard.py
#!/usr/bin/env python3
"""Fetch the War of Dots ELO and World top-20 leaderboards."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import websockets

from get_user_data import (
    DEFAULT_VERSION,
    ROOT_DIR,
    bake_cake,
    eat_cake,
    get_steam_id_from_wrapper,
    load_config,
)


async def main() -> None:
    config = load_config(ROOT_DIR / "config.txt")
    login = config.get("login") or {}
    username = login.get("username")
    password = login.get("password")
    steam_id = get_steam_id_from_wrapper(ROOT_DIR) or 0

    async with websockets.connect("ws://cs.war-of-dots.com:9056", ping_interval=None) as ws:
        requests = [
            {"type": "access", "content": {"version": DEFAULT_VERSION}},
            {
                "type": "authorize",
                "content": {
                    "username": username,
                    "password": password,
                    "steamid": str(steam_id),
                },
            },
            {"type": "get_leaderboard", "content": {}},
        ]

        for request in requests:
            await ws.send(bake_cake(json.dumps(request, separators=(",", ":")).encode()))
            reply = eat_cake(await asyncio.wait_for(ws.recv(), timeout=8))
            if isinstance(reply, dict) and reply.get("type") == "get_leaderboard":
                print(json.dumps(reply, indent=2, ensure_ascii=False))
                return

    raise RuntimeError("The server did not return a leaderboard response")


if __name__ == "__main__":
    asyncio.run(main())