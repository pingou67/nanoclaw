#!/usr/bin/env python3
"""Mock Mattermost server (HTTP REST + WebSocket on the same port)."""
import asyncio
import base64
import json
import time
import uuid
from aiohttp import web, WSMsgType

BOT_ID = "test-bot-id"
BOT_USERNAME = "claw"
TEAM_ID = "test-team-id"
TEAM_NAME = "home"

CHANNELS = {
    "main":      {"id": "ch-main",      "type": "O"},
    "coding":    {"id": "ch-coding",    "type": "O"},
    "famille":   {"id": "ch-famille",   "type": "O"},
    "adminsys":  {"id": "ch-adminsys",  "type": "O"},
    "work":      {"id": "ch-work",      "type": "O"},
    "dm":        {"id": "ch-dm",        "type": "D"},
}

FILES = {}
REPLIES = []
WS_CLIENTS = []  # list of active WSResponse — broadcast to all
WS_SILENCE = False  # when True, mock stops responding to pings (simulates zombie WS)

async def users_me(r):
    return web.json_response({"id": BOT_ID, "username": BOT_USERNAME})

async def my_teams(r):
    return web.json_response([{"id": TEAM_ID, "name": TEAM_NAME, "display_name": "Home"}])

async def channel_by_name(r):
    name = r.match_info["name"]
    if name not in CHANNELS:
        return web.json_response({"error": "not found"}, status=404)
    ch = CHANNELS[name]
    return web.json_response({"id": ch["id"], "name": name, "type": ch["type"], "team_id": TEAM_ID})

async def file_info(r):
    fid = r.match_info["file_id"]
    if fid not in FILES:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(FILES[fid]["info"])

async def file_data(r):
    fid = r.match_info["file_id"]
    if fid not in FILES:
        return web.Response(status=404)
    return web.Response(body=FILES[fid]["data"], content_type=FILES[fid]["info"].get("mime_type", "application/octet-stream"))

async def post_message(r):
    body = await r.json()
    body["_received_at"] = time.time()
    REPLIES.append(body)
    rid = body.get("root_id", "")
    rid_label = f" root={rid}" if rid else ""
    print(f"[mock-mm] BOT REPLY in {body.get('channel_id')}{rid_label}: {body.get('message','')[:300]!r}")
    return web.json_response({"id": f"reply-{uuid.uuid4().hex[:8]}", **body})

async def inject_event(r):
    body = await r.json()
    user_id = body.get("user_id", "human-test")
    message = body.get("message", "")
    channel_id = body.get("channel_id")
    channel_type = body.get("channel_type", "O")
    file_ids = body.get("file_ids", [])
    mention_bot = body.get("mention_bot", False)
    root_id = body.get("root_id", "")

    post = {
        "id": f"post-{uuid.uuid4().hex[:8]}",
        "user_id": user_id,
        "channel_id": channel_id,
        "message": message,
        "create_at": int(time.time() * 1000),
        "file_ids": file_ids,
        "root_id": root_id,
    }
    event = {
        "event": "posted",
        "data": {
            "post": json.dumps(post),
            "channel_type": channel_type,
            "channel_display_name": "test",
            "channel_name": "test",
            "team_id": TEAM_ID,
            "sender_name": "tester",
            "set_online": "true",
            "mentions": json.dumps([BOT_ID]) if mention_bot else "",
        },
        "broadcast": {"channel_id": channel_id, "user_id": "", "team_id": ""},
        "seq": 0,
    }
    payload = json.dumps(event)
    delivered = 0
    for ws in list(WS_CLIENTS):
        if ws.closed:
            try: WS_CLIENTS.remove(ws)
            except ValueError: pass
            continue
        try:
            await ws.send_str(payload)
            delivered += 1
        except Exception as e:
            print(f"[mock-mm] failed to send to client: {e}")
    return web.json_response({"injected": True, "post_id": post["id"], "delivered_to": delivered})

async def get_replies(r):
    return web.json_response(REPLIES)

async def reset(r):
    REPLIES.clear()
    return web.json_response({"reset": True})

async def silence_ws(r):
    """Toggle WS zombie mode — when on, mock stops responding to pings.
    Lets the keepalive E2E test simulate a silently-dropped reverse-proxy
    connection (TCP ESTAB, no FIN, no further frames). Use:
      POST /__test/silence_ws  body={"on": true|false}
    """
    global WS_SILENCE
    body = await r.json()
    WS_SILENCE = bool(body.get("on", True))
    return web.json_response({"silenced": WS_SILENCE, "active_clients": len(WS_CLIENTS)})

async def add_file(r):
    body = await r.json()
    data = base64.b64decode(body["base64_data"])
    FILES[body["file_id"]] = {
        "info": {
            "id": body["file_id"],
            "name": body.get("name", "file.bin"),
            "mime_type": body.get("mime_type", "application/octet-stream"),
            "size": len(data),
        },
        "data": data,
    }
    return web.json_response({"added": True})

async def ws_handler(request):
    # autoping=False so we control ping/pong responses manually — required
    # to simulate a zombie WS in the keepalive E2E scenario (when
    # WS_SILENCE is set, we drop client pings on the floor).
    ws = web.WebSocketResponse(autoping=False)
    await ws.prepare(request)
    print("[mock-mm] WS client connected", flush=True)
    WS_CLIENTS.append(ws)
    try:
        # Wait for authentication_challenge
        try:
            await asyncio.wait_for(ws.receive(), timeout=5)
            print("[mock-mm] WS auth received", flush=True)
        except Exception:
            pass
        # Send hello
        await ws.send_str(json.dumps({"event": "hello", "seq": 0}))

        # Loop on received messages. Pings get ponged manually unless the
        # silence flag is set (simulated zombie). Other frames (text /
        # binary) are ignored — adapter only sends typing events here.
        async for msg in ws:
            if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
            if msg.type == WSMsgType.PING:
                if WS_SILENCE:
                    # Drop the ping — simulates a server that stopped
                    # responding without closing the TCP connection.
                    continue
                try:
                    await ws.pong(msg.data)
                except Exception:
                    pass
    except Exception as e:
        print(f"[mock-mm] WS error: {e}", flush=True)
    finally:
        try: WS_CLIENTS.remove(ws)
        except ValueError: pass
        print("[mock-mm] WS client disconnected", flush=True)
    return ws

def init_app():
    app = web.Application()
    app.router.add_get("/api/v4/users/me", users_me)
    app.router.add_get("/api/v4/users/me/teams", my_teams)
    app.router.add_get("/api/v4/teams/{team_id}/channels/name/{name}", channel_by_name)
    app.router.add_get("/api/v4/files/{file_id}/info", file_info)
    app.router.add_get("/api/v4/files/{file_id}", file_data)
    app.router.add_post("/api/v4/posts", post_message)
    app.router.add_get("/api/v4/websocket", ws_handler)
    app.router.add_post("/__test/inject", inject_event)
    app.router.add_get("/__test/replies", get_replies)
    app.router.add_post("/__test/reset", reset)
    app.router.add_post("/__test/add_file", add_file)
    app.router.add_post("/__test/silence_ws", silence_ws)
    return app

if __name__ == "__main__":
    web.run_app(init_app(), host="0.0.0.0", port=8888, print=lambda *a, **k: print("[mock-mm] HTTP+WS listening on :8888"))
