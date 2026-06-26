# Commands

Quick reference for running MineBench. See `context.md` / `handoff.md` for how things work.

> ✅ **Recommended: launch via the UI.** `npm run dashboard` opens the dashboard where you pick a
> task (or interactive mode), model(s), single/H2H, world, and reset — and it **auto-launches the
> Minecraft server(s) for you**. You no longer need to start a server or `/op` bots by hand. The
> CLI below still works and is handy for scripting/debugging.

## Dashboard (recommended)
```bash
npm run dashboard            # live dashboard at http://localhost:8099 — Run button auto-starts servers
npm run dashboard:build      # rebuild the static historical results view
```

## Run a benchmark (CLI)
Servers are started/adopted automatically; the world is left warm (reused next run).
```bash
npm run bench -- --task gather_wood --model copilot/gpt-4o          # single run
npm run bench -- --goal "Mine 3 oak_log" --model copilot/gpt-5.4    # ad-hoc goal (no auto-scoring)
npm run bench -- --task stone_pickaxe --model copilot/claude-opus-4.8 --verbose   # show thoughts
npm run bench -- --task gather_wood --model copilot/gpt-4.1 --reset # wipe + regenerate world first
```

## Head-to-head (two models)
Different worlds (same seed, isolated) by default; `--world same` puts both bots in one world.
```bash
npm run bench -- --task stone_pickaxe --model-a copilot/gpt-4.1 --model-b copilot/claude-opus-4.8
npm run bench -- --task stone_pickaxe --model-a X --model-b Y --world same     # one shared world
npm run bench -- --task stone_pickaxe --model-a X --model-b Y --reset          # fresh worlds
```

## Interactive (standby, then chat)
The bot joins and idles **"awaiting goal/instruction"** — no agent loop yet. The goal arrives
later as a **chat message**, which starts the bot (no goal-first launch). Easiest via the
dashboard (pick **Goal source → Interactive**, Run, then type a goal and **Send**), or from the
CLI. Interactive goals are ad-hoc, so the outcome is **human-judged** (no automatic score).
```bash
npm run bench -- --interactive --model copilot/gpt-4.1     # then type a goal in-game chat
```
Works in **single** and **H2H same-world** (one chat message starts both bots). For H2H different
worlds the same goal is broadcast to each isolated world. From the dashboard, the goal box relays
via the server console (`say [GOAL] <text>`); in-game chat also works.

## Manage servers (optional — for keeping them warm or resetting)
The dashboard/CLI already auto-manage servers; use these only to hold them warm or reset manually.
```bash
npm run servers:up           # start + hold server A warm (Ctrl+C stops it)
npm run servers:up:both      # hold A + B warm (for head-to-head)
npm run servers:reset        # wipe + regenerate world A from the seed, then hold
npm run servers:reset:both   # wipe + regenerate A and B
npm run servers:down         # stop servers this launcher started
```

## Flags reference
| Flag | Meaning |
|------|---------|
| `--task <id>` | Run a task from `tasks/*.json` (auto-scored). |
| `--goal "<text>"` | Free-form ad-hoc goal (no auto success check). |
| `--model <name>` | Single model, e.g. `copilot/gpt-4.1`, `gpt-4o`. |
| `--model-a` / `--model-b` | Head-to-head: one model per bot. |
| `--world same\|different` | H2H only: shared world vs two same-seed worlds (default `different`). |
| `--reset` | Wipe world(s) and regenerate from the seed before running. |
| `--no-server` | Don't auto-launch; connect to a server you're managing yourself. |
| `--verbose` | Stream agent thoughts to the console. |

## Notes
- Copilot models need `COPILOT_TOKEN` in `.env`.
- Server config via env (optional): `MINEBENCH_SEED`, `MINEBENCH_JAVA_ARGS`,
  `MINEBENCH_SERVER_A_DIR`/`_B_DIR`, `MINEBENCH_SERVER_A_PORT`/`_B_PORT`.
- Server B auto-provisions (clones from A) the first time head-to-head "different worlds" runs.

## Give players infinite night vision
Run in the server console (or as an op'd player) to grant night vision that never expires.
```bash
/effect give @s night_vision infinite 0 true
```

## Manage servers (optional — for keeping them warm or resetting)
The dashboard/CLI already auto-manage servers; use these only to hold them warm or reset manually.
```bash
node bench.js --task gather_wood --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o
```

npm run servers:up           # start + hold server A warm (Ctrl+C stops it)
npm run servers:up:both      # hold A + B warm (for head-to-head)
npm run servers:reset        # wipe + regenerate world A from the seed, then hold
npm run servers:reset:both   # wipe + regenerate A and B
npm run servers:down         # stop servers this launcher started
```

## Flags reference
| Flag | Meaning |
|------|---------|
| `--task <id>` | Run a task from `tasks/*.json` (auto-scored). |
| `--goal "<text>"` | Free-form ad-hoc goal (no auto success check). |
| `--model <name>` | Single model, e.g. `copilot/gpt-4.1`, `gpt-4o`. |
| `--model-a` / `--model-b` | Head-to-head: one model per bot. |
| `--world same\|different` | H2H only: shared world vs two same-seed worlds (default `different`). |
| `--reset` | Wipe world(s) and regenerate from the seed before running. |
| `--no-server` | Don't auto-launch; connect to a server you're managing yourself. |
| `--verbose` | Stream agent thoughts to the console. |

## Notes
- Copilot models need `COPILOT_TOKEN` in `.env`.
- Server config via env (optional): `MINEBENCH_SEED`, `MINEBENCH_JAVA_ARGS`,
  `MINEBENCH_SERVER_A_DIR`/`_B_DIR`, `MINEBENCH_SERVER_A_PORT`/`_B_PORT`.
- Server B auto-provisions (clones from A) the first time head-to-head "different worlds" runs.

## Other
```bash
npm run smoke                # connect + walk 30s sanity check (node bot/bot.js)
```
