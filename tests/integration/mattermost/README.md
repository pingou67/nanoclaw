# Mattermost adapter v2 — E2E integration tests

End-to-end smoke + regression suite for the in-process Mattermost channel
adapter (`src/channels/mattermost.ts`). Talks to a local mock that
implements just enough of the Mattermost REST + WebSocket API for the
adapter to think it's connected to a real server.

## What gets tested

| Scenario | Validates |
|---|---|
| `scenario_main` | Channel + `engage_mode='mention'` (requires `@claw`) |
| `scenario_work`, `mainframe`, `adminsys`, `coding` | Channel + `engage_mode='pattern'` (responds to all) |
| `scenario_famille` | Channel + `engage_mode='mention'` (responds when `@claw`) |
| `must_ignore` | Mention-required channel must IGNORE messages without `@claw` |
| `thread_propagation` | Bot's reply carries the inbound `root_id` so it lands in the same thread |
| `dm_lazy` | DM channel auto-creates `messaging_groups` + `agent_groups` + wiring on first event |
| `image_attachment` | Image attachment is downloaded → `inbox/<msg_id>/<file>` → agent identifies "rouge" |
| `container_reuse` | Second message in the same channel is ≥30% faster than the first (warm container) |

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

Production downtime during the suite ≈ 2-3 min. Phil can keep working in
Mattermost while it runs — messages sent during this window queue up on
the Mattermost server and the bot picks them up after the suite restores
the live config (Mattermost retains messages indefinitely).

## Flags

- `--scenario <name>` — run only one scenario (e.g. `--scenario scenario_main`).
  Names match the keys in the `SCENARIOS` list at the bottom of `run_suite.py`.
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

`mock_mm.py` implements only the endpoints the adapter calls:

| Endpoint | Purpose |
|---|---|
| `GET /api/v4/users/me` | Bot identity |
| `GET /api/v4/users/me/teams` | Team enumeration |
| `GET /api/v4/teams/{id}/channels/name/{name}` | Channel ID lookup |
| `GET /api/v4/files/{id}/info` | File metadata |
| `GET /api/v4/files/{id}` | File download |
| `POST /api/v4/posts` | Captures bot replies |
| `WSS /api/v4/websocket` | Inbound event stream |

Plus a control plane the adapter never sees:

| Endpoint | Purpose |
|---|---|
| `POST /__test/inject` | Push a `posted` event over the WS |
| `GET /__test/replies` | Read everything the bot POSTed back |
| `POST /__test/reset` | Clear captured replies |
| `POST /__test/add_file` | Upload a fake attachment for `file_ids` references |

See `mock_mm.py` for full request/response shapes.

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
  (otherwise the agent container cannot authenticate)
