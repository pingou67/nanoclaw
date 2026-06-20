#!/usr/bin/env python3
"""Mock Mattermost server (HTTP REST + WebSocket on the same port).

Faithful-enough stand-in for a real Mattermost v11.x server, scoped to the
surface the in-process adapter (`src/channels/mattermost.ts`) actually uses.

Protocol fidelity notes (verified against the adapter + Mattermost docs):
  - WebSocket auth: the client connects with an `Authorization: Bearer`
    header, then sends an `{action: "authentication_challenge", data:{token}}`
    frame. The server replies with a status frame keyed by `seq_reply`, then
    pushes a `hello` event. The adapter marks itself ready on `hello`.
  - Events pushed to the client use the envelope
    `{event, data, broadcast, seq}` where `seq` increments server-side.
  - In a `posted` event, `data.post` and `data.mentions` are **JSON-encoded
    strings** (double-encoded) — a classic Mattermost footgun. We reproduce it.
  - A `post` object carries id/create_at/update_at/edit_at/delete_at/user_id/
    channel_id/root_id/message/type/props/file_ids/metadata. The adapter skips
    posts whose `type` is non-empty (system messages) and its own posts.
  - Keepalive is native RFC 6455 ping/pong (not application events). With
    `silence_ws` on we drop pings to simulate a zombie reverse-proxy socket.

Capture surface for the harness (cleared by /__test/reset):
  - REPLIES   — every POST /posts (bot-created posts), ordered.
  - EDITS     — every PUT /posts/{id}/patch (live-status / edit_message).
  - DELETES   — every DELETE /posts/{id}.
  - REACTIONS — every POST /reactions.
  - TYPING    — every POST /users/me/typing.
"""
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
SERVER_VERSION = "11.8.1"

# Channels the adapter resolves by name. The e2e-* channels back the dedicated
# provider-matrix test groups (the harness appends matching entries to the mock
# mattermost.json so the adapter registers them on startup).
CHANNELS = {
    "main":         {"id": "ch-main",         "type": "O"},
    "coding":       {"id": "ch-coding",       "type": "O"},
    "famille":      {"id": "ch-famille",      "type": "O"},
    "adminsys":     {"id": "ch-adminsys",     "type": "O"},
    "work":         {"id": "ch-work",         "type": "O"},
    "dm":           {"id": "ch-dm",           "type": "D"},
    # Dedicated throwaway channel for the provider-switch regression test —
    # backs a test-only agent group the harness flips opencode↔claude, so no
    # production group is ever mutated.
    "e2e-switch":   {"id": "ch-e2e-switch",   "type": "O"},
}

FILES = {}
POSTS = {}        # post_id -> post dict (bot-created, for edit/delete reference)
REPLIES = []      # ordered log of POST /posts bodies (back-compat shape)
EDITS = []        # PUT /posts/{id}/patch  -> {post_id, message, _received_at}
DELETES = []      # DELETE /posts/{id}     -> {post_id, _received_at}
REACTIONS = []    # POST /reactions        -> {post_id, emoji_name, _received_at}
TYPING = []       # POST /users/me/typing  -> {channel_id, _received_at}
WS_CLIENTS = []   # active WSResponse objects — events broadcast to all
WS_SILENCE = False  # when True, drop client pings (simulate a zombie WS)
_SEQ = [1]        # server-side event seq counter (mutable cell)


def _next_seq():
    s = _SEQ[0]
    _SEQ[0] += 1
    return s


def _make_post(post_id, user_id, channel_id, message, root_id="", file_ids=None, ptype=""):
    """Build a Mattermost-shaped post object (fields the adapter may read,
    plus the rest for fidelity)."""
    now = int(time.time() * 1000)
    return {
        "id": post_id,
        "create_at": now,
        "update_at": now,
        "edit_at": 0,
        "delete_at": 0,
        "is_pinned": False,
        "user_id": user_id,
        "channel_id": channel_id,
        "root_id": root_id or "",
        "original_id": "",
        "message": message,
        "type": ptype or "",
        "props": {},
        "hashtags": "",
        "pending_post_id": "",
        "reply_count": 0,
        "file_ids": file_ids or [],
        "metadata": {},
    }


# ----------------------------- REST: identity -------------------------------

async def users_me(r):
    return web.json_response({
        "id": BOT_ID,
        "username": BOT_USERNAME,
        "roles": "system_user",
        "is_bot": True,
        "create_at": 1, "update_at": 1, "delete_at": 0,
    })


async def my_teams(r):
    return web.json_response([{"id": TEAM_ID, "name": TEAM_NAME, "display_name": "Home"}])


async def channel_by_name(r):
    name = r.match_info["name"]
    if name not in CHANNELS:
        return web.json_response(
            {"id": "", "message": "Channel does not exist.", "status_code": 404}, status=404
        )
    ch = CHANNELS[name]
    return web.json_response({"id": ch["id"], "name": name, "type": ch["type"], "team_id": TEAM_ID})


# ----------------------------- REST: files ----------------------------------

async def file_info(r):
    fid = r.match_info["file_id"]
    if fid not in FILES:
        return web.json_response({"status_code": 404}, status=404)
    return web.json_response(FILES[fid]["info"])


async def file_data(r):
    fid = r.match_info["file_id"]
    if fid not in FILES:
        return web.Response(status=404)
    return web.Response(
        body=FILES[fid]["data"],
        content_type=FILES[fid]["info"].get("mime_type", "application/octet-stream"),
    )


# ----------------------------- REST: posts ----------------------------------

async def post_message(r):
    """POST /api/v4/posts — the bot creates a post. Stored by id so later
    edits/deletes can reference it; also appended to REPLIES (ordered log)."""
    body = await r.json()
    body["_received_at"] = time.time()
    REPLIES.append(body)
    post_id = f"reply-{uuid.uuid4().hex[:8]}"
    post = _make_post(
        post_id,
        BOT_ID,
        body.get("channel_id", ""),
        body.get("message", ""),
        root_id=body.get("root_id", ""),
        file_ids=body.get("file_ids", []),
    )
    if body.get("props"):
        post["props"] = body["props"]
    POSTS[post_id] = post
    rid = body.get("root_id", "")
    rid_label = f" root={rid}" if rid else ""
    print(f"[mock-mm] BOT POST in {body.get('channel_id')}{rid_label}: {body.get('message','')[:300]!r}", flush=True)
    return web.json_response(post)


async def patch_post(r):
    """PUT /api/v4/posts/{post_id}/patch — edit a post in place (live-status
    updates, edit_message MCP tool). Records the edit for assertions."""
    post_id = r.match_info["post_id"]
    body = await r.json()
    new_message = body.get("message", "")
    EDITS.append({"post_id": post_id, "message": new_message, "_received_at": time.time()})
    post = POSTS.get(post_id)
    if post is None:
        return web.json_response({"status_code": 404, "message": "post not found"}, status=404)
    post["message"] = new_message
    post["edit_at"] = int(time.time() * 1000)
    post["update_at"] = post["edit_at"]
    print(f"[mock-mm] BOT EDIT {post_id}: {new_message[:200]!r}", flush=True)
    return web.json_response(post)


async def delete_post(r):
    """DELETE /api/v4/posts/{post_id}."""
    post_id = r.match_info["post_id"]
    DELETES.append({"post_id": post_id, "_received_at": time.time()})
    post = POSTS.get(post_id)
    if post is not None:
        post["delete_at"] = int(time.time() * 1000)
    print(f"[mock-mm] BOT DELETE {post_id}", flush=True)
    return web.json_response({"status": "OK"})


async def add_reaction(r):
    """POST /api/v4/reactions."""
    body = await r.json()
    body["_received_at"] = time.time()
    REACTIONS.append(body)
    print(f"[mock-mm] BOT REACTION {body.get('emoji_name')} on {body.get('post_id')}", flush=True)
    return web.json_response(body)


async def user_typing(r):
    """POST /api/v4/users/me/typing — the bot publishes a typing indicator.
    Real Mattermost broadcasts a `typing` WS event to channel members; here we
    just record it (no human client to notify in the mock)."""
    body = await r.json() if r.can_read_body else {}
    TYPING.append({"channel_id": body.get("channel_id", ""), "_received_at": time.time()})
    return web.json_response({"status": "OK"})


# ----------------------------- test control ---------------------------------

async def inject_event(r):
    """POST /__test/inject — push a `posted` event to all connected clients,
    faithfully shaped (double-encoded post + mentions, full broadcast)."""
    body = await r.json()
    user_id = body.get("user_id", "human-test")
    message = body.get("message", "")
    channel_id = body.get("channel_id")
    channel_type = body.get("channel_type", "O")
    file_ids = body.get("file_ids", [])
    mention_bot = body.get("mention_bot", False)
    root_id = body.get("root_id", "")

    post = _make_post(
        f"post-{uuid.uuid4().hex[:8]}", user_id, channel_id, message,
        root_id=root_id, file_ids=file_ids,
    )
    data = {
        "channel_display_name": "test",
        "channel_name": "test",
        "channel_type": channel_type,
        "post": json.dumps(post),
        "sender_name": "tester",
        "set_online": True,
        "team_id": TEAM_ID if channel_type != "D" else "",
    }
    if mention_bot:
        data["mentions"] = json.dumps([BOT_ID])
    event = {
        "event": "posted",
        "data": data,
        "broadcast": {
            "omit_users": None,
            "user_id": "",
            "channel_id": channel_id,
            "team_id": "",
            "connection_id": "",
        },
        "seq": _next_seq(),
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
            print(f"[mock-mm] failed to send to client: {e}", flush=True)
    return web.json_response({"injected": True, "post_id": post["id"], "delivered_to": delivered})


async def get_replies(r):
    return web.json_response(REPLIES)


async def get_edits(r):
    return web.json_response(EDITS)


async def get_deletes(r):
    return web.json_response(DELETES)


async def get_reactions(r):
    return web.json_response(REACTIONS)


async def get_typing(r):
    return web.json_response(TYPING)


async def reset(r):
    REPLIES.clear()
    EDITS.clear()
    DELETES.clear()
    REACTIONS.clear()
    TYPING.clear()
    POSTS.clear()
    return web.json_response({"reset": True})


async def silence_ws(r):
    """Toggle WS zombie mode — when on, the mock stops ponging client pings.
    Lets the keepalive E2E test simulate a silently-dropped reverse-proxy
    connection (TCP ESTAB, no FIN, no further frames)."""
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


# ----------------------------- WebSocket ------------------------------------

async def ws_handler(request):
    # autoping=False so we control ping/pong manually — required to simulate a
    # zombie WS in the keepalive scenario (drop client pings when silenced).
    ws = web.WebSocketResponse(autoping=False)
    await ws.prepare(request)
    print("[mock-mm] WS client connected", flush=True)
    WS_CLIENTS.append(ws)
    hello_sent = False
    try:
        # Faithful auth: wait briefly for the client's first frame. Mattermost
        # accepts header auth (sends hello immediately) OR an in-band
        # `authentication_challenge` action. The adapter sends the challenge,
        # so we ack it (status keyed by seq_reply) then push `hello`.
        try:
            first = await asyncio.wait_for(ws.receive(), timeout=5)
            if first.type == WSMsgType.TEXT:
                try:
                    action = json.loads(first.data)
                    if action.get("action") == "authentication_challenge":
                        await ws.send_str(json.dumps({
                            "status": "OK",
                            "seq_reply": action.get("seq", 1),
                        }))
                        print("[mock-mm] WS auth challenge acked", flush=True)
                except Exception:
                    pass
        except Exception:
            pass
        await ws.send_str(json.dumps({
            "event": "hello",
            "data": {"connection_id": f"mock-conn-{uuid.uuid4().hex[:8]}", "server_version": SERVER_VERSION},
            "broadcast": {"omit_users": None, "user_id": "", "channel_id": "", "team_id": "", "connection_id": ""},
            "seq": _next_seq(),
        }))
        hello_sent = True

        # Loop on received frames. Native pings get ponged unless silenced.
        # Other frames (the adapter only sends the auth challenge here) are
        # ignored.
        async for msg in ws:
            if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
            if msg.type == WSMsgType.PING:
                if WS_SILENCE:
                    continue  # drop — simulate a server that went silent
                try:
                    await ws.pong(msg.data)
                except Exception:
                    pass
    except Exception as e:
        print(f"[mock-mm] WS error: {e}", flush=True)
    finally:
        try: WS_CLIENTS.remove(ws)
        except ValueError: pass
        print(f"[mock-mm] WS client disconnected (hello_sent={hello_sent})", flush=True)
    return ws


def init_app():
    app = web.Application()
    # REST — identity / channels / files
    app.router.add_get("/api/v4/users/me", users_me)
    app.router.add_get("/api/v4/users/me/teams", my_teams)
    app.router.add_get("/api/v4/teams/{team_id}/channels/name/{name}", channel_by_name)
    app.router.add_get("/api/v4/files/{file_id}/info", file_info)
    app.router.add_get("/api/v4/files/{file_id}", file_data)
    # REST — posts lifecycle
    app.router.add_post("/api/v4/posts", post_message)
    app.router.add_put("/api/v4/posts/{post_id}/patch", patch_post)
    app.router.add_delete("/api/v4/posts/{post_id}", delete_post)
    app.router.add_post("/api/v4/reactions", add_reaction)
    app.router.add_post("/api/v4/users/me/typing", user_typing)
    # WebSocket
    app.router.add_get("/api/v4/websocket", ws_handler)
    # Test control
    app.router.add_post("/__test/inject", inject_event)
    app.router.add_get("/__test/replies", get_replies)
    app.router.add_get("/__test/edits", get_edits)
    app.router.add_get("/__test/deletes", get_deletes)
    app.router.add_get("/__test/reactions", get_reactions)
    app.router.add_get("/__test/typing", get_typing)
    app.router.add_post("/__test/reset", reset)
    app.router.add_post("/__test/add_file", add_file)
    app.router.add_post("/__test/silence_ws", silence_ws)
    return app


if __name__ == "__main__":
    web.run_app(
        init_app(), host="0.0.0.0", port=8888,
        print=lambda *a, **k: print("[mock-mm] HTTP+WS listening on :8888", flush=True),
    )
