# Mattermost adapter v2 — E2E integration tests

End-to-end smoke + regression suite for the in-process Mattermost channel
adapter (`src/channels/mattermost.ts`). Talks to a local mock that
implements just enough of the Mattermost REST + WebSocket API for the
adapter to think it's connected to a real server.

## What gets tested

| Scenario | Validates |
|---|---|
| `scenario_work`, `mainframe`, `adminsys`, `coding` | Channel + `engage_mode='pattern'` (responds to all) |
| `scenario_famille` | Channel + `engage_mode='mention'` (responds when `@claw`) |
| `must_ignore` | Mention-required channel must IGNORE messages without `@claw` |
| `thread_propagation` | Bot's reply carries the inbound `root_id` so it lands in the same thread |
| `dm_lazy` | DM channel auto-creates `messaging_groups` + `agent_groups` + wiring on first event |
| `image_attachment` | Image attachment is downloaded → `inbox/<msg_id>/<file>` → agent identifies "rouge" |
| `container_reuse` | Second message in the same channel is ≥30% faster than the first (warm container) |
| `office_attachment`, `ws_keepalive` | docx→PDF conversion; zombie-WS detection + reconnect |

### Provider matrix + regression phases (full run only)

These run after the channel scenarios and are the core guard for **provider
parity** (Claude ⇄ OpenCode) after a switch:

| Phase | Validates |
|---|---|
| **provider matrix** | The canonical sub-suite (**text reply** + **Bash tool-use**, `1234*5678=7006652`) runs on the first Claude-backed *and* first OpenCode-backed channel found, so every change is proven on **both engines**. A `matrix provider coverage` check fails if a provider isn't represented. |
| **runner `!help`** | The `!`-prefixed runner commands still work (Mattermost intercepts `/`). Asserts the reply lists `!clear` / `!stop`. |
| **provider switch** | Regression guard for the opencode→claude switch: on a **throwaway `ag-e2e_switch` group only** (never a prod group), flips opencode→claude, purges the per-provider continuation, and asserts the next turn still replies (no stale-continuation `Model not found` hang). |
| **live-status lifecycle** | Restarts with live-status **ENABLED**, runs a tool-using turn, and asserts the mock saw the full cycle: a `🔧` post created (`POST /posts`) → edited (`PUT …/patch`) → finalized to `✅ Terminé`. This is the only phase that exercises live-status — the others disable it for deterministic first-reply assertions. |
| **MCP matrix** | One scenario per MCP server wired in `container_configs` (vikunja, imap, gmail, google-calendar, searxng…). Each picks the first E2E-reachable channel whose group has the server (optionally preferring the group whose credentials matter most, e.g. famille's own calendar OAuth), sends a **read-only** prompt forcing one MCP call, and asserts a stable backend invariant (`WORK` project, `INBOX` folder/label, calendar name, `Paris`). A server wired on no reachable group (e.g. `memory` on the agy-backed agc) is a SKIP. Catches MCP config drift (DB `mcp_servers`, mounts, HOME overrides, OAuth tokens) that unit tests can't see. Run just this phase with `--only-mcp` (~3-4 min). |
| **env hygiene** | After teardown, asserts the systemd `--user` manager env carries no `NANOCLAW_*` test override (the leak that silently disabled live-status in prod). |

## When to run

- After every `/update-nanoclaw` (see `docs/local-patches/POST_UPDATE_CHECKLIST.md` §15).
- Before merging changes that touch `src/channels/mattermost.ts`,
  `src/channels/adapter.ts`, `src/router.ts`, `src/delivery.ts`, or
  `src/session-manager.ts`.
- After any v2 schema migration that touches `messages_in`, `messaging_groups`,
  or `agent_groups`.

## Running

From the project root:

```bash
python3 tests/integration/mattermost/run_suite.py
```

What it does (~2-3 min):

1. Starts `mock_mm.py` on `127.0.0.1:8888`.
2. **Stops** the live nanoclaw service.
3. Backs up `data/mattermost.json` → `data/mattermost.json.bak`.
4. Writes a mock-pointing `data/mattermost.json` (URL `127.0.0.1:8888`,
   token `dummy`, channels copied from real config).
5. Restarts nanoclaw, waits for `Mattermost WS ready` in the log.
6. Runs each scenario by injecting events at `POST /__test/inject` and
   reading replies from `GET /__test/replies`.
7. Stops nanoclaw, **restores `data/mattermost.json`**, restarts nanoclaw.
8. Stops the mock.

Production downtime during a **full** suite ≈ 6-10 min (the channel
scenarios, the provider matrix running real Claude *and* OpenCode turns, the
provider-switch legs, plus one extra restart for the live-status phase). A
single `--scenario <name>` run skips all the extra phases and is ~2-3 min.
Phil can keep working in Mattermost while it runs — messages sent during this
window queue on the server and the bot picks them up after the live config is
restored (Mattermost retains messages indefinitely).

## Flags

- `--scenario <name>` — run only one scenario (e.g. `--scenario scenario_famille`).
  Names match the keys in the `SCENARIOS` list at the bottom of `run_suite.py`.
- `--only-mcp` — run only the MCP matrix phase (plus setup/teardown), ~3-4 min.
  For validating MCP wiring changes without replaying the whole suite.
- `--keep-mock` — don't restore the live config, leave the mock running.
  Useful when debugging a failure: you can re-inject events manually with
  `curl http://127.0.0.1:8888/__test/inject -d ...` and inspect logs
  without the suite blowing away your test setup.

To recover from `--keep-mock` manually:
```bash
pkill -f mock_mm.py
mv data/mattermost.json.bak data/mattermost.json
systemctl --user restart nanoclaw
```

## What's in the mock

`mock_mm.py` reproduces the Mattermost v11.x surface the adapter touches,
kept faithful to the real protocol (see the header comment in the file):

| Endpoint | Purpose |
|---|---|
| `GET /api/v4/users/me` | Bot identity (id, username, roles, is_bot) |
| `GET /api/v4/users/me/teams` | Team enumeration |
| `GET /api/v4/teams/{id}/channels/name/{name}` | Channel ID lookup |
| `GET /api/v4/files/{id}/info`, `GET /api/v4/files/{id}` | File metadata + download |
| `POST /api/v4/posts` | Captures bot posts (stored by id for later edits) |
| `PUT /api/v4/posts/{id}/patch` | Captures edits (live-status updates, `edit_message`) |
| `DELETE /api/v4/posts/{id}` | Captures deletes |
| `POST /api/v4/reactions` | Captures reactions |
| `POST /api/v4/users/me/typing` | Captures typing-indicator publishes |
| `WSS /api/v4/websocket` | Inbound event stream + faithful auth handshake |

**Protocol-fidelity notes reproduced** (the things that bite a naive mock):
`data.post` and `data.mentions` in a `posted` event are **JSON-encoded
strings** (double-encoded); the WS auth is *connect-with-Bearer* → client
sends `authentication_challenge` → server acks (`seq_reply`) → server pushes
`hello`; keepalive is native RFC 6455 ping/pong (not app events); the `post`
object carries the full `create_at/update_at/edit_at/delete_at/type/props/…`
shape and the adapter skips posts with a non-empty `type` (system messages).

Plus a control plane the adapter never sees:

| Endpoint | Purpose |
|---|---|
| `POST /__test/inject` | Push a faithfully-shaped `posted` event over the WS |
| `GET /__test/replies` | Read every `POST /posts` (ordered) |
| `GET /__test/edits` / `…/deletes` / `…/reactions` / `…/typing` | Read each captured lifecycle op |
| `POST /__test/reset` | Clear all captured state |
| `POST /__test/add_file` | Upload a fake attachment for `file_ids` references |
| `POST /__test/silence_ws` | Drop client pings — simulate a zombie reverse-proxy socket |

See `mock_mm.py` for full request/response shapes.

## Limitations (so "green" stays honest)

The mock is a faithful stand-in for the **adapter ⇄ routing ⇄ provider**
contract, **not** a real Mattermost server. It does **not** simulate push/
desktop notifications, user presence, real token auth/permissions, channel
membership/notify-props, or Collapsed Reply Threads. A green run proves the
message path and both providers work end-to-end; it does **not** prove
notification behaviour or anything that depends on a real human client.

## When a scenario fails

1. Re-run with `--scenario <id> --keep-mock` to keep the mock state alive.
2. Look at the nanoclaw log: `tail -f logs/nanoclaw.log` (during the run).
3. Look at the mock log: `tail -f /tmp/mock-mm-suite.log`.
4. Look at the agent container log: `docker logs $(docker ps --filter 'name=nanoclaw-v2' -q --latest)`.

Common transient failure: `claim-stuck` on the first spawn of a fresh
agent group's container. The host-sweep retries with backoff and
eventually succeeds. If it persists across multiple retries, check
that all required mounts (especially `additionalMounts` from
`groups/<folder>/container.json`) exist on the host.

## Requirements

- nanoclaw service installed and runnable (`systemctl --user start nanoclaw`)
- `nanoclaw-agent-v2-*` Docker image already built (`./container/build.sh`)
- `~/.claude/.credentials.json` present (Claude Pro auth)
- Python 3 with `aiohttp` installed (`pip3 install --user --break-system-packages aiohttp`)
- A real production `data/mattermost.json` to copy channel config from
- The OAuth credential mount patch applied to `src/container-runner.ts`
  (otherwise Claude-backed agent containers cannot authenticate)
- **At least one OpenCode-configured group** in `container_configs` (with a
  valid `OPENCODE_API_KEY` in its `env`). The provider matrix needs it for the
  OpenCode leg, and the provider-switch phase copies its env to seed the
  throwaway `e2e_switch` group's opencode leg. Without it, those phases fail
  loudly (they don't silently skip).
