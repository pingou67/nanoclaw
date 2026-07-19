#!/usr/bin/env python3
"""
End-to-end test suite for the in-process Mattermost channel adapter
(src/channels/mattermost.ts).

Orchestrates the full swap-and-restart cycle:
  1. Stop the live nanoclaw service
  2. Back up data/mattermost.json (production config) → .bak
  3. Write a mock-pointing data/mattermost.json (URL=http://127.0.0.1:8888)
  4. Start mock_mm.py in background
  5. Restart nanoclaw — adapter connects to mock, registers messaging_groups
     and agent_groups for each configured channel
  6. Run each scenario via POST /__test/inject; verify reply via GET /__test/replies
  7. Restore real config, restart service, stop mock

The suite covers the critical contract surface of the adapter:
  - 6 channel routes (mention vs pattern engage modes)
  - DM lazy registration on first event
  - must-IGNORE when mention required and no @ in text
  - thread root_id propagation in the reply
  - image attachment download → multimodal block (Claude identifies "rouge")
  - container reuse: 2nd reply latency should be substantially lower than 1st

Run from the project root:
    python3 tests/integration/mattermost/run_suite.py [--keep-mock]

Requires: aiohttp, websockets, ws (pnpm), the running nanoclaw service,
the nanoclaw-agent-v2-* image already built, and ~/.claude/.credentials.json.
"""

import argparse
import atexit
import base64
import json
import os
import signal
import struct
import subprocess
import sys
import time
import urllib.request
import urllib.error
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / "data"
LIVE_CONFIG = DATA_DIR / "mattermost.json"
BACKUP_CONFIG = DATA_DIR / "mattermost.json.bak"
MOCK_LOG = Path("/tmp/mock-mm-suite.log")
NANOCLAW_LOG = ROOT / "logs" / "nanoclaw.log"

MOCK_BASE = "http://127.0.0.1:8888"
WAIT_REPLY_SEC = 90
WAIT_REUSE_SEC = 30
NANOCLAW_BOOT_SEC = 30  # max wait for "Mattermost WS ready"

# ---------------------------- installed skills --------------------------------
# The suite must stay green after every nanoclaw update, whatever the set of
# installed skills. Skill presence is detected by the file its install copies
# in; scenarios that exercise an absent skill are SKIPPED (passing), never
# failed. The whole suite is the /add-mattermost skill's E2E — without the
# adapter there is nothing to test at all.
MATTERMOST_INSTALLED = (ROOT / "src" / "channels" / "mattermost.ts").exists()
OPENCODE_INSTALLED = (ROOT / "src" / "providers" / "opencode.ts").exists()


def skip_result(name: str, skill: str) -> "Result":
    return Result(name, True, f"SKIP — skill {skill} non installé", skipped=True)

# Channel id mapping in mock_mm.py — keep in sync with mock_mm.CHANNELS
CHANNELS = {
    "work":      ("ch-work",      False),
    "adminsys":  ("ch-adminsys",  False),
    "famille":   ("ch-famille",   True),
    "coding":    ("ch-coding",    False),
}


# ------------------------------ HTTP helpers ---------------------------------

def http_post(path: str, payload: dict | list | None = None) -> dict:
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(f"{MOCK_BASE}{path}", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def http_get(path: str) -> dict | list:
    with urllib.request.urlopen(f"{MOCK_BASE}{path}", timeout=10) as r:
        return json.loads(r.read())

def reset_replies() -> None:
    http_post("/__test/reset")

def inject(payload: dict) -> dict:
    return http_post("/__test/inject", payload)

def add_file(file_id: str, name: str, mime_type: str, data: bytes) -> dict:
    return http_post("/__test/add_file", {
        "file_id": file_id,
        "name": name,
        "mime_type": mime_type,
        "base64_data": base64.b64encode(data).decode(),
    })

def wait_for_reply(timeout: int) -> dict | None:
    """Poll /__test/replies until at least one is captured. Returns the first."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        replies = http_get("/__test/replies")
        if replies:
            return replies[0]
        time.sleep(0.1)
    return None

def wait_for_reply_count(target: int, timeout: int) -> list[dict]:
    """Poll until at least `target` replies captured. Returns all of them."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        replies = http_get("/__test/replies")
        if len(replies) >= target:
            return replies
        time.sleep(0.1)
    return http_get("/__test/replies")


# ----------------------------- nanoclaw service ------------------------------

def systemctl(action: str) -> None:
    subprocess.run(["systemctl", "--user", action, "nanoclaw"], check=True, capture_output=True)

def wait_for_ws_ready(timeout: int) -> bool:
    """Tail nanoclaw.log for the 'Mattermost WS ready' marker emitted on start."""
    start_marker = "NanoClaw starting"
    ready_marker = "Mattermost WS ready"
    started_at = time.time()
    last_pos = max(0, NANOCLAW_LOG.stat().st_size - 65536) if NANOCLAW_LOG.exists() else 0
    while time.time() - started_at < timeout:
        if not NANOCLAW_LOG.exists():
            time.sleep(1); continue
        with open(NANOCLAW_LOG, "rb") as f:
            f.seek(last_pos)
            tail = f.read().decode(errors="replace")
        if ready_marker in tail and tail.rfind(ready_marker) > tail.rfind(start_marker):
            return True
        time.sleep(1)
    return False

def restart_nanoclaw_with_mock_config() -> None:
    """Stop service, back up the REAL config (once), swap to a mock-pointing
    config, restart, and wait for the adapter to connect to the mock.

    Live-status is disabled here for deterministic first-reply assertions; the
    dedicated live-status phase uses restart_for_live_status() instead (which
    never touches the config files).
    """
    systemctl("stop")
    # Back up the real config EXACTLY ONCE. A repeat call must NEVER overwrite an
    # existing backup — that would clobber it with the mock, and the real bot
    # token is then lost for good (this actually happened once). Also refuse to
    # back up a config that already points at the mock (means the real one was
    # already lost — fail loudly instead of making it worse).
    if not BACKUP_CONFIG.exists():
        if not LIVE_CONFIG.exists():
            raise RuntimeError(f"No {LIVE_CONFIG} and no backup — nothing to swap from.")
        live_data = json.loads(LIVE_CONFIG.read_text())
        if "127.0.0.1:8888" in live_data.get("url", ""):
            raise RuntimeError(
                f"Refusing to back up {LIVE_CONFIG}: it already points at the mock "
                f"({live_data.get('url')}). The real config/token was lost — reconstruct "
                f"data/mattermost.json (real url + bot token) before re-running.")
        LIVE_CONFIG.replace(BACKUP_CONFIG)
    real = json.loads(BACKUP_CONFIG.read_text())
    mock_config = dict(real)
    mock_config["url"] = MOCK_BASE
    mock_config["token"] = "dummy"  # mock doesn't validate
    # Append the throwaway provider-switch test channel so the adapter registers
    # ag-e2e_switch on startup. Test-only — gone when prod is restored.
    channels = list(mock_config.get("channels", []))
    if not any(c.get("folder") == "e2e_switch" for c in channels):
        channels.append({"channel": "e2e-switch", "folder": "e2e_switch", "requireMention": False})
    mock_config["channels"] = channels
    LIVE_CONFIG.write_text(json.dumps(mock_config, indent=2))
    LIVE_CONFIG.chmod(0o600)
    # Live-status disabled (deterministic first-reply) + auto-bg disabled (the
    # office-attachment scenario's ~45s docx→PDF would otherwise trip the 30s
    # default and the next inject would get the bg notice as its first reply).
    subprocess.run(["systemctl", "--user", "set-environment", "NANOCLAW_LIVE_STATUS_DISABLED=1"], check=True, capture_output=True)
    subprocess.run(["systemctl", "--user", "set-environment", "NANOCLAW_AUTO_BG_THRESHOLD_MS=0"], check=True, capture_output=True)
    systemctl("start")
    _await_adapter_connected()


def restart_for_live_status() -> None:
    """Restart the (already mock-configured) service with live-status ENABLED.
    Only flips the env — it NEVER touches the config files, so it can't
    interact with (let alone clobber) the real-config backup."""
    systemctl("stop")
    subprocess.run(["systemctl", "--user", "set-environment", "NANOCLAW_LIVE_STATUS_DISABLED=0"], check=True, capture_output=True)
    systemctl("start")
    _await_adapter_connected()


def _await_adapter_connected() -> None:
    """Wait for 'Mattermost WS ready', then confirm the adapter actually joined
    the mock's WS_CLIENTS (a warmup inject is delivered_to >= 1) — even after
    'WS ready' there's a brief window before the aiohttp upgrade completes."""
    if not wait_for_ws_ready(NANOCLAW_BOOT_SEC):
        raise RuntimeError("nanoclaw didn't reach 'Mattermost WS ready' in time")
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            r = http_post("/__test/inject", {
                "user_id": "_warmup_", "message": "_warmup_",
                "channel_id": "ch-warmup-no-such-channel", "channel_type": "O",
            })
            if r.get("delivered_to", 0) >= 1:
                http_post("/__test/reset")  # purge the warmup row (adapter ignored it)
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("WS reported ready but mock has no client connected after 15s")

# Test-only systemd --user env overrides set by restart_nanoclaw_with_mock_config().
# They MUST be dropped before any production service start, or live-status stays
# off and auto-bg stays disabled in prod (the symptom that motivated this guard).
TEST_ENV_OVERRIDES = ("NANOCLAW_LIVE_STATUS_DISABLED", "NANOCLAW_AUTO_BG_THRESHOLD_MS")


def clear_test_env_overrides() -> None:
    """Drop the test-only `systemctl --user` env overrides.

    Best-effort and idempotent: `unset-environment` of an unset var is a no-op,
    and this never raises — cleanup must never mask a test result nor abort
    ahead of the rest of teardown. Wired through atexit + signal handlers +
    main()'s finally so it runs no matter how the run ends (test failure,
    exception, config-restore error, Ctrl-C / SIGTERM, or --keep-mock).
    """
    for var in TEST_ENV_OVERRIDES:
        try:
            subprocess.run(["systemctl", "--user", "unset-environment", var], check=False, capture_output=True)
        except Exception:
            pass


def _on_signal(signum, _frame):
    # Turn a kill/stop into an orderly shutdown: SystemExit unwinds through
    # main()'s finally (config restore) and fires the atexit handler (env
    # cleanup), so an interrupted run cleans up exactly like a normal one.
    raise SystemExit(128 + signum)


def restore_live_config_and_restart() -> None:
    """Stop service, swap config back to production, restart."""
    # Drop the env overrides FIRST — before the config-restore safety checks
    # below (which can raise) and before the service start at the end — so the
    # restarted service always comes up clean even if the config restore fails.
    clear_test_env_overrides()
    systemctl("stop")
    if BACKUP_CONFIG.exists():
        # Verify the backup looks like a real config (has a non-mock URL) before
        # trusting it. If the test was killed mid-restore in a previous run, the
        # backup may itself be the mock URL — restore would then leave prod
        # pointed at a dead local mock. Detect that and refuse, so a missing
        # live config surfaces as a clear error instead of silent breakage.
        try:
            backup_data = json.loads(BACKUP_CONFIG.read_text())
            if "127.0.0.1:8888" in backup_data.get("url", ""):
                raise RuntimeError(
                    f"Refusing to restore {BACKUP_CONFIG}: URL still points at the mock "
                    f"({backup_data.get('url')}). The live config was lost — the operator "
                    f"must reconstruct data/mattermost.json manually with the real bot token."
                )
        except json.JSONDecodeError as err:
            raise RuntimeError(f"Refusing to restore {BACKUP_CONFIG}: not valid JSON ({err})") from err
        BACKUP_CONFIG.replace(LIVE_CONFIG)
    elif not LIVE_CONFIG.exists() or "127.0.0.1:8888" in LIVE_CONFIG.read_text():
        # No backup AND live is currently the mock config (or missing entirely) —
        # the test left things in a broken state. Refuse to silently no-op.
        raise RuntimeError(
            f"No {BACKUP_CONFIG.name} and {LIVE_CONFIG} is the mock config. The live "
            f"config was lost in a prior failed test run — reconstruct "
            f"data/mattermost.json manually with the real bot token before re-running."
        )
    # (Env overrides were already cleared at the top of this function.)
    systemctl("start")
    wait_for_ws_ready(NANOCLAW_BOOT_SEC)


# ----------------------------- mock subprocess ------------------------------

def start_mock() -> subprocess.Popen:
    here = Path(__file__).parent
    return subprocess.Popen(
        ["python3", str(here / "mock_mm.py")],
        stdout=open(MOCK_LOG, "w"),
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

def stop_mock(p: subprocess.Popen) -> None:
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()

def wait_for_mock_ready(timeout: int = 10) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            http_get("/api/v4/users/me")
            return
        except urllib.error.URLError:
            time.sleep(0.5)
    raise RuntimeError("mock_mm.py did not become ready")


# ----------------------------- scenarios -------------------------------------

class Result:
    def __init__(self, name: str, passed: bool, detail: str = "", skipped: bool = False):
        self.name = name
        self.passed = passed
        self.detail = detail
        self.skipped = skipped
    def __str__(self):
        sign = "⤼" if self.skipped else ("✓" if self.passed else "✗")
        return f"{sign} {self.name}{f' — {self.detail}' if self.detail else ''}"


def scenario_channel_text(channel: str, channel_id: str, mention_required: bool, marker: str) -> Result:
    name = f"#{channel} ({'mention' if mention_required else 'pattern'})"
    reset_replies()
    text = f"@claw réponds juste {marker}" if mention_required else f"réponds juste {marker}"
    inject({
        "user_id": "human-test",
        "message": text,
        "channel_id": channel_id,
        "channel_type": "O",
    })
    reply = wait_for_reply(WAIT_REPLY_SEC)
    if not reply:
        return Result(name, False, "no reply within timeout")
    msg = reply.get("message", "")
    if marker in msg:
        return Result(name, True, f"replied with {marker}")
    return Result(name, False, f"reply did not contain {marker}: {msg[:80]!r}")


def scenario_must_ignore() -> Result:
    name = "famille / mention required + no @ → must IGNORE"
    reset_replies()
    inject({
        "user_id": "human-test",
        "message": "yo",  # no @claw
        "channel_id": "ch-famille",
        "channel_type": "O",
    })
    # Wait 20s for absence
    time.sleep(20)
    replies = http_get("/__test/replies")
    if len(replies) == 0:
        return Result(name, True, "no reply (correct)")
    return Result(name, False, f"got {len(replies)} unexpected replies")


def scenario_thread_propagation() -> Result:
    name = "thread root_id propagation"
    reset_replies()
    inject({
        "user_id": "human-test",
        "message": "réponds juste OK-THR",
        "channel_id": "ch-adminsys",
        "channel_type": "O",
        "root_id": "test-thread-root",
    })
    reply = wait_for_reply(WAIT_REPLY_SEC)
    if not reply:
        return Result(name, False, "no reply within timeout")
    rid = reply.get("root_id", "")
    if rid == "test-thread-root":
        return Result(name, True, f"root_id propagated ({rid})")
    return Result(name, False, f"root_id={rid!r}, expected 'test-thread-root'")


def scenario_dm_lazy() -> Result:
    name = "DM lazy registration + reply"
    reset_replies()
    inject({
        "user_id": "phil-dm",
        "message": "réponds juste OK-DM",
        "channel_id": "dm-suite-test",
        "channel_type": "D",
    })
    reply = wait_for_reply(WAIT_REPLY_SEC)
    if not reply:
        return Result(name, False, "no reply within timeout")
    msg = reply.get("message", "")
    if "OK-DM" in msg:
        return Result(name, True, f"replied with {msg[:80]!r}")
    return Result(name, False, f"reply did not contain OK-DM: {msg[:80]!r}")


def make_red_png(size: int = 64) -> bytes:
    """Generate a NxN solid red PNG without external deps."""
    raw = b""
    for _ in range(size):
        raw += b"\x00" + b"\xff\x00\x00" * size
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    idat = chunk(b"IDAT", zlib.compress(raw, 9))
    iend = chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


def make_minimal_docx(text: str) -> bytes:
    """Build a minimal valid .docx (zip with the 4 essential XML parts).
    Just enough for libreoffice to recognize and convert. No external deps."""
    import io
    import zipfile

    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

    # Escape the user text for XML
    escaped = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    document_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{escaped}</w:t></w:r></w:p>
  </w:body>
</w:document>"""

    document_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>"""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document_xml)
        zf.writestr("word/_rels/document.xml.rels", document_rels)
    return buf.getvalue()


def scenario_office_attachment() -> Result:
    """Validate libreoffice docx → PDF conversion path: ship a synthetic .docx
    containing a magic word, expect the bot to find it (which means the
    conversion succeeded and Claude got a readable PDF)."""
    name = "office attachment (docx → libreoffice PDF → identifies magic word)"
    magic = "AURELIE-VAUTOUR-PEGS-2026"
    docx = make_minimal_docx(f"Document de test. Le mot magique est : {magic}. Fin.")
    add_file("suite-docx-1", "test_doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx)
    reset_replies()
    inject({
        "user_id": "human-test",
        "message": "Lis ce document Word et dis-moi quel est le mot magique qu'il contient. Réponds juste le mot, rien d'autre.",
        "channel_id": "ch-adminsys",
        "channel_type": "O",
        "file_ids": ["suite-docx-1"],
    })
    reply = wait_for_reply(180)
    if not reply:
        return Result(name, False, "no reply within timeout (libreoffice not installed?)")
    msg = reply.get("message", "")
    if magic in msg:
        return Result(name, True, f"agent extracted magic word from docx ({msg[:120]!r})")
    return Result(name, False, f"didn't find magic word in reply: {msg[:200]!r}")


def scenario_image_attachment() -> Result:
    name = "image attachment (red PNG → identifies Rouge)"
    add_file("suite-red-1", "red.png", "image/png", make_red_png())
    reset_replies()
    inject({
        "user_id": "human-test",
        "message": "De quelle couleur est cette image ? Réponds juste la couleur en français en un mot.",
        "channel_id": "ch-work",
        "channel_type": "O",
        "file_ids": ["suite-red-1"],
    })
    reply = wait_for_reply(120)
    if not reply:
        return Result(name, False, "no reply within timeout")
    msg = reply.get("message", "")
    if "rouge" in msg.lower() or "red" in msg.lower():
        return Result(name, True, f"identified red ({msg[:80]!r})")
    return Result(name, False, f"didn't identify red: {msg[:80]!r}")


def scenario_ws_keepalive() -> Result:
    """Validate the WS ping/pong keepalive: simulate a zombie WS by silencing
    the mock's pong responses; the adapter should detect it within ~90s
    (30s ping interval + 60s pong timeout), terminate, reconnect."""
    name = "WS keepalive (zombie WS detection + reconnect)"
    # Make sure we have an active WS connection in a known state.
    initial = http_get("/__test/replies")  # just to confirm mock is reachable
    _ = initial

    # 1. Silence the mock's pong responses
    http_post("/__test/silence_ws", {"on": True})

    # 2. Wait up to 120s for the adapter to detect the dead WS and reconnect.
    #    "Reconnect" means: a new WS handler runs in the mock — observable
    #    via mock log "WS client connected" or via a working inject/reply
    #    cycle. We use the latter: re-enable pong, inject a message,
    #    expect a reply within reasonable latency.
    print("  [waiting up to 120s for adapter to detect dead WS]")
    deadline = time.time() + 120
    reconnected = False
    while time.time() < deadline:
        # Re-enable pong so the new connection (when it tries) succeeds
        http_post("/__test/silence_ws", {"on": False})
        # Try injecting — if a fresh WS is connected, it'll deliver
        reset_replies()
        resp = inject({
            "user_id": "human-test",
            "message": "réponds juste OK-KEEPALIVE",
            "channel_id": "ch-adminsys",
            "channel_type": "O",
        })
        if resp.get("delivered_to", 0) > 0:
            # Event was delivered to at least one WS — that means a fresh
            # connection is active. Wait for the bot's reply to confirm
            # the full round-trip works.
            reply = wait_for_reply(WAIT_REPLY_SEC)
            if reply and "OK-KEEPALIVE" in reply.get("message", ""):
                reconnected = True
                break
        # Re-silence and wait
        http_post("/__test/silence_ws", {"on": True})
        time.sleep(10)

    # Always re-enable pong before returning
    http_post("/__test/silence_ws", {"on": False})

    if reconnected:
        return Result(name, True, "adapter detected zombie WS and reconnected")
    return Result(name, False, "no reconnect within 120s — keepalive may be broken")


def scenario_container_reuse() -> Result:
    """Send 2 messages back-to-back; second should reuse the container.
    Pass condition: T2 latency < T1 latency × 0.7 (warm should be measurably faster).

    Cold-start guarantee: kill any running work container first. Without this,
    earlier scenarios (scenario_work, scenario_main) may have left the work
    container warm, making T1 fast and the cold→warm comparison meaningless."""
    name = "container reuse (T2 < T1 × 0.7)"
    reset_replies()
    # Reap any pre-existing work container so T1 measures a true cold spawn.
    subprocess.run(
        "docker rm -f $(docker ps -a --filter 'name=nanoclaw-v2-mattermost_work' -q) 2>/dev/null",
        shell=True, check=False,
    )
    # Brief settle so the host sweep registers the kill before we inject.
    time.sleep(1)
    t0 = time.time()
    inject({
        "user_id": "human-test",
        "message": "réponds juste 1ER",
        "channel_id": "ch-work",
        "channel_type": "O",
    })
    if not wait_for_reply(WAIT_REPLY_SEC):
        return Result(name, False, "T1 did not reply")
    t1 = time.time() - t0

    # Don't reset — we want both replies in the queue
    t0 = time.time()
    inject({
        "user_id": "human-test",
        "message": "réponds juste 2EME",
        "channel_id": "ch-work",
        "channel_type": "O",
    })
    replies = wait_for_reply_count(2, WAIT_REUSE_SEC)
    if len(replies) < 2:
        return Result(name, False, f"T2 did not reply within {WAIT_REUSE_SEC}s (got {len(replies)} replies)")
    t2 = time.time() - t0

    detail = f"T1={t1:.1f}s T2={t2:.1f}s (ratio={t2/t1:.2f})"
    if t2 < t1 * 0.7:
        return Result(name, True, detail)
    return Result(name, False, f"T2 not faster enough: {detail}")


# ------------------------------- runner --------------------------------------

# =========================================================================
# Provider matrix + new scenarios (tool-use, live-status, runner commands,
# provider-switch regression, env hygiene). See README.md for the rationale.
# =========================================================================

def http_put(path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{MOCK_BASE}{path}", data=body,
                                 headers={"Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


# --- DB / container-config helpers (via the in-tree better-sqlite3 wrapper) ---

CENTRAL_DB = "data/v2.db"

def _q(db: str, sql: str) -> str:
    """Run SQL through scripts/q.ts (no sqlite3 CLI dependency). Returns
    stdout (pipe-separated rows, like sqlite3 -list)."""
    res = subprocess.run(["node_modules/.bin/tsx", "scripts/q.ts", db, sql],
                         cwd=ROOT, capture_output=True, text=True, timeout=30)
    return res.stdout.strip()

def group_provider(folder: str) -> str:
    """Effective provider of ag-<folder> (NULL → claude)."""
    out = _q(CENTRAL_DB, f"SELECT COALESCE(provider,'claude') FROM container_configs WHERE agent_group_id='ag-{folder}'")
    return out.strip() or "claude"

def any_opencode_env() -> str | None:
    """An opencode group's env JSON, to seed the switch-test group's opencode leg."""
    out = _q(CENTRAL_DB, "SELECT env FROM container_configs WHERE provider='opencode' AND env LIKE '%OPENCODE_API_KEY%' LIMIT 1")
    return out.strip() or None

def set_container_config(group_id: str, provider: str, model: str, env_json: str) -> None:
    # Groups created by the adapter at startup have NO container_configs row yet
    # (backfill runs before adapters start), so upsert first. Only agent_group_id
    # + updated_at are required; every other column has a default.
    _q(CENTRAL_DB, "INSERT OR IGNORE INTO container_configs (agent_group_id, updated_at, env) "
                   f"VALUES ('{group_id}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '{{}}')")
    _q(CENTRAL_DB, f"UPDATE container_configs SET provider='{provider}', model='{model}', env='{env_json}' "
                   f"WHERE agent_group_id='{group_id}'")

def purge_continuation(group_id: str) -> None:
    import glob
    for ob in glob.glob(str(ROOT / f"data/v2-sessions/{group_id}/*/outbound.db")):
        _q(ob, "DELETE FROM session_state WHERE key IN ('continuation:claude','continuation:opencode')")

def kill_group_container(folder: str) -> None:
    """Kill any running container for ag-<folder> so the next inject respawns it
    with the current DB config (provider/env changes take effect at spawn)."""
    names = subprocess.run(["docker", "ps", "--filter", f"name=nanoclaw-v2-{folder}-",
                            "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
    for n in names:
        subprocess.run(["docker", "kill", n], capture_output=True)


# --- reply matching that ignores live-status posts ---------------------------

def _is_live_status(msg: str) -> bool:
    return any(m in msg for m in ("🔧", "✅ Terminé", "⏹ Arrêté"))

def wait_for_answer(timeout: int) -> dict | None:
    """Like wait_for_reply, but skip live-status posts (🔧 / ✅ Terminé / ⏹) so
    it returns the real answer even when live-status is enabled."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for rep in http_get("/__test/replies"):
            if not _is_live_status(rep.get("message", "")):
                return rep
        time.sleep(0.2)
    return None


# --- new scenarios -----------------------------------------------------------

def scenario_tool_use(label: str, channel_id: str, require_mention: bool) -> Result:
    """Force a deterministic Bash tool call and assert the computed result —
    exercises the tool-call path (differs per provider, feeds live-status).
    1234 * 5678 = 7006652."""
    name = f"#{label} / tool-use (Bash)"
    reset_replies()
    prefix = "@claw " if require_mention else ""
    inject({
        "user_id": "human-test",
        "message": f"{prefix}Utilise le tool Bash pour exécuter exactement `echo $((1234 * 5678))` "
                   f"et réponds UNIQUEMENT avec le nombre obtenu, rien d'autre.",
        "channel_id": channel_id, "channel_type": "O",
    })
    reply = wait_for_answer(WAIT_REPLY_SEC)
    if not reply:
        return Result(name, False, "no reply within timeout")
    msg = reply.get("message", "")
    return Result(name, "7006652" in msg, f"got {msg[:80]!r}")


def scenario_live_status(label: str, channel_id: str, require_mention: bool) -> Result:
    """Assert the live-status lifecycle: a 🔧 post is created (POST /posts),
    edited (PUT patch), and finalized to ✅ Terminé. Requires the service
    started with live-status ENABLED. The sleep outlasts the 2.5s throttle so
    a status post is actually created+edited."""
    name = f"#{label} / live-status lifecycle"
    # The live-status env is frozen at container spawn — a warm container from an
    # earlier phase still has it DISABLED. Kill it so the inject respawns fresh
    # with live-status ENABLED.
    kill_group_container(f"mattermost_{label}")
    reset_replies()
    prefix = "@claw " if require_mention else ""
    # Force a REAL tool call: `$(date +%s%N)` is unpredictable so the model
    # can't shortcut it, and `sleep 4` outlasts the 2.5s live-status throttle so
    # a 🔧 post is actually created → edited → finalized.
    inject({
        "user_id": "human-test",
        "message": f"{prefix}Utilise le tool Bash pour exécuter exactement `sleep 4 && echo LIVE-$(date +%s%N)` "
                   f"et renvoie la sortie exacte, rien d'autre.",
        "channel_id": channel_id, "channel_type": "O",
    })
    answer = wait_for_answer(WAIT_REPLY_SEC)
    if not answer:
        return Result(name, False, "no final answer")
    replies = http_get("/__test/replies")
    edits = http_get("/__test/edits")
    created = any("🔧" in r.get("message", "") for r in replies)
    # The finalize marker is italicized: `✅ _Terminé en Xs, N actions_` —
    # match both with and without the markdown underscore.
    finalized = any("Terminé" in e.get("message", "") and "✅" in e.get("message", "") for e in edits)
    return Result(name, created and finalized, f"🔧create={created} ✅finalize={finalized} edits={len(edits)}")


def scenario_runner_help(channel_id: str) -> Result:
    """The runner `!help` command (Mattermost intercepts `/`, so only `!`
    works). Posted directly by the outer loop — provider-agnostic, fast."""
    name = "runner command !help"
    reset_replies()
    inject({"user_id": "human-test", "message": "!help", "channel_id": channel_id, "channel_type": "O"})
    reply = wait_for_reply(30)
    if not reply:
        return Result(name, False, "no reply to !help")
    msg = reply.get("message", "")
    return Result(name, "!clear" in msg and "!stop" in msg, f"got {msg[:90]!r}")


def scenario_provider_switch() -> Result:
    """Regression guard for the opencode→claude switch: a stale per-provider
    continuation must not hang the next turn ("Model not found"). Runs on the
    throwaway ag-e2e_switch group only — never a production group."""
    name = "provider switch opencode→claude (continuity)"
    group, folder, ch = "ag-e2e_switch", "e2e_switch", "ch-e2e-switch"
    if not OPENCODE_INSTALLED:
        return skip_result(name, "add-opencode")
    env = any_opencode_env()
    if not env:
        return Result(name, False, "no opencode group to copy env from — cannot test opencode leg")

    def _leg(provider: str, model: str, env_json: str, marker: str) -> dict | None:
        set_container_config(group, provider, model, env_json)
        purge_continuation(group)
        kill_group_container(folder)
        reset_replies()
        inject({"user_id": "human-test", "message": f"réponds juste {marker}",
                "channel_id": ch, "channel_type": "O"})
        return wait_for_answer(WAIT_REPLY_SEC)

    r_oc = _leg("opencode", "opencode-go/minimax-m3", env, "OK-SW-OC")
    leg_oc = bool(r_oc) and "Model not found" not in r_oc.get("message", "")
    r_cl = _leg("claude", "sonnet", "{}", "OK-SW-CL")
    leg_cl = bool(r_cl) and "Model not found" not in r_cl.get("message", "")
    return Result(name, leg_oc and leg_cl,
                  f"opencode_leg={'ok' if leg_oc else 'FAIL'} claude_leg={'ok' if leg_cl else 'FAIL'}")


# --- provider matrix ---------------------------------------------------------

# Candidate channels to sample. The canonical sub-suite (text + tool-use) runs
# on the FIRST channel found for each provider, so the matrix always exercises
# one Claude-backed and one OpenCode-backed group regardless of current
# provider assignments.
PROVIDER_MATRIX_CANDIDATES = [
    ("work",      "ch-work",      False),
    ("coding",    "ch-coding",    False),
    ("adminsys",  "ch-adminsys",  False),
    ("famille",   "ch-famille",   True),
    ("testor",    "ch-testor",    False),  # OpenCode-backed — keeps both providers covered
    ("testor-claude", "ch-testor-claude", False),  # Claude-backed depuis la migration opencode de 2026-07 — garde la couverture claude
]

def _relabel(r: Result, name: str) -> Result:
    return Result(name, r.passed, r.detail)

def run_provider_matrix() -> list[Result]:
    out: list[Result] = []
    seen: dict[str, str] = {}
    for label, ch_id, req in PROVIDER_MATRIX_CANDIDATES:
        prov = group_provider(f"mattermost_{label}")
        if prov in seen:
            continue
        seen[prov] = label
        tag = f"{prov}:#{label}"
        print(f"  ▸ matrix {tag} …", flush=True)
        out.append(_relabel(scenario_channel_text(label, ch_id, req, f"OK-MX-{label.upper()}"),
                            f"matrix {tag} / text"))
        out.append(_relabel(scenario_tool_use(label, ch_id, req), f"matrix {tag} / tool-use"))
    # Coverage expectation follows the INSTALLED providers: claude ships in
    # trunk; opencode only counts when /add-opencode is installed. An absent
    # skill is a SKIP, not a missing provider.
    expected = {"claude"} | ({"opencode"} if OPENCODE_INSTALLED else set())
    covered = expected.issubset(set(seen.keys()))
    detail = f"covered {sorted(seen.keys())}" + ("" if covered else f" — MISSING {sorted(expected - set(seen.keys()))}")
    out.append(Result("matrix provider coverage", covered, detail))
    if not OPENCODE_INSTALLED:
        out.append(skip_result("matrix opencode leg", "add-opencode"))
    return out


# --- MCP matrix ---------------------------------------------------------------
# One scenario per MCP server wired in container_configs (vikunja, imap, gmail,
# google-calendar, searxng, memory…). Each test picks the FIRST
# E2E-reachable channel whose group has the server wired, sends a read-only
# prompt forcing one MCP call, and asserts a stable invariant of the real
# backend (project name, INBOX folder, calendar name, city…). Read-only by
# design: no create/update/delete ever reaches the backends. A server wired on
# no reachable group is a SKIP (same policy as absent skills).

WAIT_MCP_SEC = 120  # npx-based servers download into the container on cold start

MCP_CHANNEL_CANDIDATES = [
    ("work",     "ch-work",     False),
    ("testor",   "ch-testor",   False),
    ("testor-claude", "ch-testor-claude", False),
    ("famille",  "ch-famille",  True),
    ("coding",   "ch-coding",   False),
    ("adminsys", "ch-adminsys", False),
]

# (server key, read-only prompt, expected marker per channel label — None = default,
#  optional preferred labels tried before the default candidate order — lets a
#  scenario target the group whose CREDENTIALS matter most, e.g. famille's own
#  calendar OAuth token, distinct from testor's)
MCP_SCENARIOS = [
    ("vikunja",
     "Utilise le serveur MCP vikunja pour lister les projets accessibles et réponds "
     "UNIQUEMENT avec les noms des projets, séparés par des virgules.",
     {"work": "WORK", None: "Inbox"}),
    ("imap",
     "Utilise le serveur MCP imap (compte unistra) pour lister les dossiers de la boîte "
     "et réponds UNIQUEMENT avec les noms des dossiers, séparés par des virgules.",
     {None: "INBOX"}),
    ("gmail",
     "Utilise le serveur MCP gmail pour lister les labels de la boîte et réponds "
     "UNIQUEMENT avec les noms des labels, séparés par des virgules.",
     {None: "INBOX"}),
    ("google-calendar",
     "Utilise le serveur MCP google-calendar pour lister les calendriers disponibles et "
     "réponds UNIQUEMENT avec les noms des calendriers, séparés par des virgules.",
     {"famille": "Famille", None: "Philippe"},
     ["famille"]),
    ("searxng",
     "Utilise le serveur MCP searxng pour chercher « capitale de la France » et "
     "réponds UNIQUEMENT avec le nom de la ville.",
     {None: "Paris"}),
    ("ha",
     "Utilise le serveur MCP ha pour lister les entités du domaine todo et réponds "
     "UNIQUEMENT avec leurs entity_id, séparés par des virgules.",
     {None: "liste_dachats"},
     ["famille"]),
    ("memory",
     "Utilise le serveur MCP memory pour lister l'index de ta mémoire persistante et "
     "réponds UNIQUEMENT avec OK-MEMORY si l'appel a réussi.",
     {None: "OK-MEMORY"}),
]

def _group_mcp_servers(label: str) -> set[str]:
    raw = _q(CENTRAL_DB,
             f"SELECT COALESCE(mcp_servers,'{{}}') FROM container_configs "
             f"WHERE agent_group_id='ag-mattermost_{label}'")
    try:
        return set(json.loads(raw or "{}").keys())
    except json.JSONDecodeError:
        return set()

def run_mcp_matrix() -> list[Result]:
    out: list[Result] = []
    servers_by_label = {label: _group_mcp_servers(label) for label, _, _ in MCP_CHANNEL_CANDIDATES}
    for name, prompt, expects, *rest in MCP_SCENARIOS:
        prefer = rest[0] if rest else []
        candidates = sorted(MCP_CHANNEL_CANDIDATES,
                            key=lambda c: prefer.index(c[0]) if c[0] in prefer else len(prefer) + 1)
        # Match `gmail` against `gmail` AND `gmail-perso` (per-group aliases).
        target = next(
            ((label, ch_id, req) for label, ch_id, req in candidates
             if any(k == name or k.startswith(name + "-") for k in servers_by_label[label])),
            None,
        )
        if target is None:
            out.append(Result(f"mcp {name}", True,
                              "SKIP — câblé sur aucun groupe joignable en E2E", skipped=True))
            continue
        label, ch_id, req = target
        expected = expects.get(label) or expects[None]
        rname = f"mcp {name} @#{label}"
        print(f"  ▸ {rname} …", flush=True)
        reset_replies()
        prefix = "@claw " if req else ""
        inject({
            "user_id": "human-test",
            "message": prefix + prompt,
            "channel_id": ch_id, "channel_type": "O",
        })
        reply = wait_for_answer(WAIT_MCP_SEC)
        if not reply:
            out.append(Result(rname, False, "no reply within timeout"))
            continue
        msg = reply.get("message", "")
        out.append(Result(rname, expected.lower() in msg.lower(),
                          f"expected {expected!r} — got {msg[:80]!r}"))
        print(f"  {out[-1]}", flush=True)
    return out


def env_hygiene_result() -> Result:
    """Post-teardown: the systemd --user manager env must carry no test-only
    NANOCLAW_* overrides (the leak that silently disabled live-status in prod)."""
    out = subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True, text=True).stdout
    leaked = [v for v in TEST_ENV_OVERRIDES if v in out]
    return Result("env hygiene (post-teardown)", not leaked,
                  "clean" if not leaked else f"LEAKED: {leaked}")


def _safe(label: str, fn) -> Result:
    try:
        return fn()
    except Exception as e:
        return Result(label, False, f"exception: {e}")


SCENARIOS = [
    ("scenario_work",       lambda: scenario_channel_text("work",      "ch-work",      False, "OK-WK")),
    ("scenario_adminsys",   lambda: scenario_channel_text("adminsys",  "ch-adminsys",  False, "OK-AS")),
    ("scenario_coding",     lambda: scenario_channel_text("coding",    "ch-coding",    False, "OK-CD")),
    ("scenario_famille",    lambda: scenario_channel_text("famille",   "ch-famille",   True,  "OK-FAM")),
    ("must_ignore",         scenario_must_ignore),
    ("thread_propagation",  scenario_thread_propagation),
    ("dm_lazy",             scenario_dm_lazy),
    ("image_attachment",    scenario_image_attachment),
    ("office_attachment",   scenario_office_attachment),
    ("container_reuse",     scenario_container_reuse),
    ("ws_keepalive",        scenario_ws_keepalive),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-mock", action="store_true",
                        help="don't restore live config or stop mock at end (for debugging)")
    parser.add_argument("--scenario", help="run only one scenario by name")
    parser.add_argument("--only-mcp", action="store_true",
                        help="run only the MCP matrix (plus setup/teardown)")
    args = parser.parse_args()

    print(f"== Mattermost adapter v2 E2E suite ==")
    print(f"Project root: {ROOT}")
    print(f"Live config:  {LIVE_CONFIG}")

    if not MATTERMOST_INSTALLED:
        print("\n⤼ SKIP — skill add-mattermost non installé (src/channels/mattermost.ts absent).")
        print("  Cette suite est le test E2E du skill add-mattermost ; rien à tester sans lui.")
        print("  Installer : /add-mattermost (fetch depuis la branche `channels` d'origin).")
        return 0

    if not LIVE_CONFIG.exists() and not BACKUP_CONFIG.exists():
        print(f"ERROR: neither {LIVE_CONFIG} nor {BACKUP_CONFIG} exists — nothing to back up.", file=sys.stderr)
        return 2

    # Arm env cleanup as a last resort before anything can set the overrides:
    # atexit covers normal/exception/Ctrl-C exit (after finally); the signal
    # handlers turn SIGTERM/SIGINT into an orderly SystemExit so kill/stop also
    # unwinds through the finally and clears the overrides. No-op if never set.
    atexit.register(clear_test_env_overrides)
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    print("\n[setup] Starting mock_mm.py …")
    mock_proc = start_mock()
    results: list[Result] = []
    full_run = not args.scenario and not args.only_mcp  # extra phases only run on a full suite
    try:
        wait_for_mock_ready()
        print("[setup] Mock ready on 127.0.0.1:8888")

        print("[setup] Stopping live service, swapping config to mock, restarting …")
        restart_nanoclaw_with_mock_config()
        print("[setup] nanoclaw connected to mock — running scenarios\n")

        for sid, fn in SCENARIOS:
            if (args.scenario and args.scenario != sid) or args.only_mcp:
                continue
            print(f"▸ {sid} …", flush=True)
            results.append(_safe(sid, fn))
            print(f"  {results[-1]}\n")

        if full_run or args.only_mcp:
            print("▸ MCP matrix (un scénario par serveur MCP câblé) …", flush=True)
            try:
                results.extend(run_mcp_matrix())
            except Exception as e:
                results.append(Result("mcp matrix", False, f"exception: {e}"))
            print()

        if full_run:
            print("▸ provider matrix (Claude + OpenCode parity) …", flush=True)
            try:
                results.extend(run_provider_matrix())
            except Exception as e:
                results.append(Result("provider matrix", False, f"exception: {e}"))
            print()

            print("▸ runner command (!help) …", flush=True)
            results.append(_safe("runner !help", lambda: scenario_runner_help("ch-coding")))
            print(f"  {results[-1]}\n")

            print("▸ provider switch regression (throwaway group) …", flush=True)
            results.append(_safe("provider switch", scenario_provider_switch))
            print(f"  {results[-1]}\n")

            print("▸ live-status phase — restarting with live-status ENABLED …", flush=True)
            try:
                restart_for_live_status()
                results.append(_safe("live-status", lambda: scenario_live_status("work", "ch-work", False)))
            except Exception as e:
                results.append(Result("live-status", False, f"exception: {e}"))
            print(f"  {results[-1]}\n")
    finally:
        # Guaranteed first: drop the test-only env overrides, decoupled from the
        # config restore below (which can raise on its safety checks) and run
        # even under --keep-mock. atexit/signal handlers are the last resort if
        # we never reach here at all.
        clear_test_env_overrides()
        if not args.keep_mock:
            print("\n[teardown] Restoring live config + restarting nanoclaw …")
            try:
                restore_live_config_and_restart()
                print("  live config restored, nanoclaw back on production Mattermost")
            except Exception as e:
                print(f"  WARN: failed to restore: {e}")
            stop_mock(mock_proc)
        else:
            print("\n[teardown] --keep-mock set: live config NOT restored, mock left running")
            print("  (test-only env overrides cleared; the running mock service keeps")
            print("   them frozen until its next restart)")
            print(f"  to undo manually:")
            print(f"    pkill -f mock_mm.py")
            print(f"    mv {BACKUP_CONFIG} {LIVE_CONFIG}")
            print(f"    systemctl --user restart nanoclaw")

    # Post-teardown assertion: the manager env must be clean now (proves the
    # harness left no NANOCLAW_* override behind for prod).
    if full_run and not args.keep_mock:
        results.append(env_hygiene_result())

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    passed = sum(1 for r in results if r.passed)
    skipped = sum(1 for r in results if r.skipped)
    for r in results:
        print(f"  {r}")
    print(f"\n{passed}/{len(results)} passed" + (f" ({skipped} skipped)" if skipped else ""))

    # Persist a last-run marker for the dashboard health collector
    # (src/dashboard-health.ts reads logs/e2e-last-run.json). Best effort —
    # a marker failure must never flip the suite's exit code.
    try:
        marker = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "passed": passed,
            "failed": len(results) - passed,
            "skipped": skipped,
            "total": len(results),
        }
        marker_path = ROOT / "logs" / "e2e-last-run.json"
        marker_path.parent.mkdir(exist_ok=True)
        marker_path.write_text(json.dumps(marker))
    except Exception:
        pass

    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
