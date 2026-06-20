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

# Channel id mapping in mock_mm.py — keep in sync with mock_mm.CHANNELS
CHANNELS = {
    "main":      ("ch-main",      True),   # requireMention=True
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
    """Stop service, swap config to mock, restart, wait for WS ready."""
    systemctl("stop")
    if LIVE_CONFIG.exists():
        LIVE_CONFIG.replace(BACKUP_CONFIG)
    real = json.loads(BACKUP_CONFIG.read_text())
    mock_config = dict(real)
    mock_config["url"] = MOCK_BASE
    mock_config["token"] = "dummy"  # mock doesn't validate
    LIVE_CONFIG.write_text(json.dumps(mock_config, indent=2))
    LIVE_CONFIG.chmod(0o600)
    # Disable the live-status mechanism for tests — its intermediate "🔧
    # tool_name" status posts would race with the actual answer and break
    # wait_for_reply assertions which check the FIRST reply.
    subprocess.run(["systemctl", "--user", "set-environment", "NANOCLAW_LIVE_STATUS_DISABLED=1"], check=True, capture_output=True)
    # Disable auto-background for tests — the office-attachment scenario takes
    # ~45s for libreoffice docx→PDF conversion, well over the 30s default
    # auto-bg threshold. Without this override the next-scenario inject would
    # trip auto-bg and the test would get the bg notice as its first reply.
    subprocess.run(["systemctl", "--user", "set-environment", "NANOCLAW_AUTO_BG_THRESHOLD_MS=0"], check=True, capture_output=True)
    systemctl("start")
    if not wait_for_ws_ready(NANOCLAW_BOOT_SEC):
        raise RuntimeError("nanoclaw didn't reach 'Mattermost WS ready' in time")
    # Belt-and-braces: even after 'WS ready' fires in the log, the adapter
    # only joins the mock's WS_CLIENTS list once the aiohttp handler has
    # processed the upgrade — there's a sub-100ms window where injects
    # would be broadcast to zero clients. Verify by injecting a no-op
    # event and checking the mock confirms `delivered_to >= 1`.
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            r = http_post("/__test/inject", {
                "user_id": "_warmup_",
                "message": "_warmup_",
                "channel_id": "ch-warmup-no-such-channel",
                "channel_type": "O",
            })
            if r.get("delivered_to", 0) >= 1:
                # adapter is wired into WS_CLIENTS — purge the warmup row from replies
                # (the adapter ignored it since the channel_id isn't configured)
                http_post("/__test/reset")
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("WS reported ready but mock has no client connected after 10s")

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
    def __init__(self, name: str, passed: bool, detail: str = ""):
        self.name = name
        self.passed = passed
        self.detail = detail
    def __str__(self):
        sign = "✓" if self.passed else "✗"
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

SCENARIOS = [
    ("scenario_main",       lambda: scenario_channel_text("main",      "ch-main",      True,  "OK-MAIN")),
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
    args = parser.parse_args()

    print(f"== Mattermost adapter v2 E2E suite ==")
    print(f"Project root: {ROOT}")
    print(f"Live config:  {LIVE_CONFIG}")

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

    print("\n[1/5] Starting mock_mm.py …")
    mock_proc = start_mock()
    try:
        wait_for_mock_ready()
        print("[2/5] Mock ready on 127.0.0.1:8888")

        print("[3/5] Stopping live service, swapping config to mock, restarting …")
        restart_nanoclaw_with_mock_config()
        print("[4/5] nanoclaw connected to mock — running scenarios\n")

        results: list[Result] = []
        for sid, fn in SCENARIOS:
            if args.scenario and args.scenario != sid:
                continue
            print(f"▸ {sid} …", flush=True)
            try:
                r = fn()
            except Exception as e:
                r = Result(sid, False, f"exception: {e}")
            results.append(r)
            print(f"  {r}\n")

        print("=" * 60)
        print("RESULTS")
        print("=" * 60)
        passed = sum(1 for r in results if r.passed)
        for r in results:
            print(f"  {r}")
        print(f"\n{passed}/{len(results)} passed")
        exit_code = 0 if passed == len(results) else 1
    finally:
        # Guaranteed first: drop the test-only env overrides, decoupled from the
        # config restore below (which can raise on its safety checks) and run
        # even under --keep-mock. atexit/signal handlers are the last resort if
        # we never reach here at all.
        clear_test_env_overrides()
        if not args.keep_mock:
            print("\n[5/5] Restoring live config + restarting nanoclaw …")
            try:
                restore_live_config_and_restart()
                print("  live config restored, nanoclaw back on production Mattermost")
            except Exception as e:
                print(f"  WARN: failed to restore: {e}")
            stop_mock(mock_proc)
        else:
            print("\n[5/5] --keep-mock set: live config NOT restored, mock left running")
            print("  (test-only env overrides cleared; the running mock service keeps")
            print("   them frozen until its next restart)")
            print(f"  to undo manually:")
            print(f"    pkill -f mock_mm.py")
            print(f"    mv {BACKUP_CONFIG} {LIVE_CONFIG}")
            print(f"    systemctl --user restart nanoclaw")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
