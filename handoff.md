# MineBench — Server Orchestration → UI Handoff

> **Audience:** the next agent, who will wire the new server-orchestration backend into the
> dashboard UI, including a **head-to-head (H2H) side-by-side** live view.
>
> **TL;DR:** The backend is done and tested. A single function — `prepareForRun()` — abstracts
> the whole Minecraft-server lifecycle. The web "Run" button already auto-launches a server
> today (it spawns `bench.js`, which calls `prepareForRun`). Your job has **three phases**:
> (1) expose the config (task-or-interactive / mode / model(s) / world / reset) in the UI and
> render two live lanes for H2H; (2) add **interactive mode** (bots join and idle "awaiting
> goal/instruction", then a **chat message** kicks them off — not goal-first); and
> (3) **hand off to the human to validate the test cases** — do not self-certify (see §8).

---

## 1. What was built (backend) — already merged & validated

### New files
- **`harness/server-manager.js`** — all Minecraft (Paper) server lifecycle. The one entry point
  the UI/CLI should use is:
  ```js
  // mode: 'single' | 'h2h'   world: 'same' | 'different'   reset: boolean
  const targets = await sm.prepareForRun({ mode, world, reset })
  // -> [{ port, username }]   (1 item for single, 2 for h2h)
  ```
  `prepareForRun` hides everything: **provisioning** (clones server A→B if B's folder is
  missing), **adopt-or-boot** (reuses a running server, else cold-boots), **reset** (wipe world
  + regenerate from the fixed seed), and **op management** (same-world H2H needs two distinct
  opped usernames). Other exports: `ensureServer`, `ensureOpped`, `resetAndRestart`, `stopAll`,
  `stopServer`, `SERVERS`, `USERNAME`, `USERNAME_A`, `USERNAME_B`, `isPortOpen`.
- **`harness/servers.js`** — standalone CLI launcher to keep servers warm across runs
  (`up` / `reset` / `down`), clean Ctrl+C shutdown. (Not needed by the UI, but handy in dev.)

### Changed files
- **`bench.js`** — single runs and dual runs both call `sm.prepareForRun`. New flags:
  `--reset`, `--no-server`, `--world same|different`, plus existing `--model-a/--model-b`.
- **`package.json`** — `servers:up[:both]`, `servers:reset[:both]`, `servers:down`.
- **Servers on disk** — `minebench-server` (A, port 25565) and `minebench-server-b` (B, 25566),
  one shared seed, `MineBenchBot` opped in both.

### Design decisions (why it's shaped this way)
1. **One seam (`prepareForRun`)** so callers never reason about ports, folders, or boot state.
   The UI just forwards form values; the CLI does the same. This is the core abstraction.
2. **Two server instances for "different worlds"**, not one server with two worlds (Multiverse).
   Same seed → byte-identical terrain generation, but fully isolated state → no cross-bot
   interference. Verified: both regenerate the same seed.
3. **Same-world H2H = one server, two usernames.** Two mineflayer bots cannot share a username
   on one server, so we mint `MineBenchBotA/B` and auto-op them (correct offline UUIDs written
   to `ops.json`; verified `offlineUuid('MineBenchBot')` equals the server's real UUID).
4. **Idempotent + warm by default.** `ensureServer` adopts an already-open port (fast path) and
   never wipes a world unless `reset` is set. Servers are left running after a run.
5. **Auto-provisioning.** `provisionServer` clones A→B (minus `world*`/`logs`/`cache`) on demand,
   so a dev who never set up server B still gets H2H "different worlds" with zero setup.
6. **Task setup is untouched & orthogonal.** `harness/runner.js` still calls
   `applyTaskSetup(bot, task)` every run (gamerules/time/weather/teleport/clear/give). The
   server-manager owns the *world*; `applyTaskSetup` owns the *per-run state*. Both always apply.

### Config (env, all optional)
`MINEBENCH_SEED`, `MINEBENCH_JAVA`, `MINEBENCH_JAVA_ARGS`, `MINEBENCH_SERVER_A_DIR`/`_B_DIR`,
`MINEBENCH_SERVER_A_PORT`/`_B_PORT`, `MINEBENCH_SERVER_BOOT_MS`, `MC_BOT_USERNAME[_A|_B]`.

> ⚠️ **Seed note:** `DEFAULT_SEED` in `server-manager.js` is currently `'6720193'`, but the
> on-disk worlds were generated from `'minebench'`. Run once with `--reset` (or
> `npm run servers:reset:both`) to regenerate worlds under the active seed before demoing.

---

## 2. Current end-to-end flow (what already works)

```
Browser (dashboard/live.js)
  └─ POST /run { task, model }
       └─ dashboard/live-server.js: launchRun()
            └─ spawn(node, [bench.js, --task, X, --model, Y])      ← direct child process, NO npm/shell
                 └─ bench.js main(): sm.prepareForRun({mode:'single'})   ← AUTO-LAUNCHES server A
                      └─ harness/runner.js run(): applyTaskSetup + agent loop
                           └─ emits run_start / step / run_end / run_scored
                                └─ dashboard/live-client.js POSTs each event to /ingest
                                     └─ live-server broadcasts via SSE (/events) → browser renders
```

**Key insight:** because the button spawns `bench.js` *without* `--no-server`, the server
auto-launch already reaches the UI. Single-player mode is effectively done. What's missing is
**exposing the new options** and **a second lane for H2H**.

Relevant `live-server.js` symbols: `launchRun()` (line ~125), `stopRun()`, `isBusy()`,
`currentRun` (single-run state), `benchProc` (single child), routes `/run`, `/stop`, `/tasks`,
`/events`, `/ingest`, `/state`. Event types handled in `handleEvent()`:
`run_start`, `step`, `run_end`, `run_scored`.

---

## 3. What the UI needs (your work)

### 3a. Form controls (in `dashboard/index.html` + `dashboard/live.js`)
Add to the existing `#run-controls`:
- **Goal source** toggle: **Task** | **Interactive**.
  - **Task** → show the existing task dropdown (populated from `/tasks`, which reads the
    `tasks/` folder). This path has automatic success scoring.
  - **Interactive** → hide the dropdown and show a **goal/chat text input**. In this mode the
    bot(s) join and idle "awaiting goal/instruction"; the goal arrives later via chat (see §3.5).
    Free-form / ad-hoc, no automatic success spec.
- **Mode** toggle: `single` | `h2h`.
- **Model** input (single) OR **Model A** + **Model B** inputs (h2h). The `/tasks` endpoint
  already returns `default_model` + `models` suggestions — reuse the datalist for all three.
- **World** radio (h2h only): `different` (default) | `same`.
- **Reset** checkbox: "Wipe world & regenerate" → maps to `reset: true`.

### 3b. Extend the `/run` contract (`dashboard/live-server.js`)
Today `launchRun(task, model)` hardcodes `[--task, --model]`. Generalize it to accept the config
and forward flags:
```js
// POST /run  { task, mode, model, modelA, modelB, world, reset }
// single  -> spawn bench.js --task T --model M            [--reset]
// h2h     -> see 3c (two children) — do NOT use bench.js --model-a/-b here (that opens cmd windows)
```
`--reset` can be passed straight through to a single child. For H2H, do the server prep in
live-server (3c) so both children share one prepared world set.

### 3c. H2H = two headless children, side-by-side (the important part)
The CLI dual mode (`bench.js --model-a/--model-b` → `runDual`) opens **two visible cmd windows**
and waits for result *files*. That's wrong for the web UI. Instead, have **live-server orchestrate**:

```js
// 1) Prepare servers ONCE (this is the whole abstraction):
const targets = await sm.prepareForRun({ mode: 'h2h', world, reset })   // [{port,username},{port,username}]

// 2) Spawn TWO headless bench children, one per lane, each with --no-server
//    (servers are already up; children must NOT re-launch them):
for (const [lane, model, t] of [['A', modelA, targets[0]], ['B', modelB, targets[1]]]) {
  spawn(process.execPath, [BENCH_JS, '--task', task, '--model', model, '--no-server'], {
    cwd: REPO_ROOT, windowsHide: true,
    env: { ...process.env,
      MINEBENCH_LIVE_PORT: String(PORT),
      MC_SERVER_PORT: String(t.port),
      MC_BOT_USERNAME: t.username,
      MINEBENCH_LANE: lane            // ← NEW: tags this child's events
    }
  })
}
```

### 3d. Tag events by lane (so two streams don't clobber each other) — REQUIRED
Right now every event is untagged; two children POSTing to `/ingest` would overwrite one
`currentRun`. Smallest robust change: have the emitter stamp a lane on every event.
- In **`dashboard/live-client.js`** `createLiveEmitter`, read `process.env.MINEBENCH_LANE` and add
  `event.lane = lane` (default `'A'` / single) before POSTing.
- In **`live-server.js`**, replace the single `currentRun` with a map keyed by lane, e.g.
  `runs = { A: {...}, B: {...} }`. Route each incoming event by `event.lane`. Keep a top-level
  `mode` so the snapshot tells the browser whether to show one lane or two.
- Update the `/events` snapshot + broadcasts to carry `lane`. The browser keeps two run objects.

### 3e. Render side-by-side + comparison (`dashboard/live.js`)
- When `mode === 'h2h'`, render **two columns** (A | B): each is the existing live panel
  (title, progress bar, current step, steps table, inventory, scorecard), driven by its lane.
- Reuse `apply(e)` but index into `runs[e.lane]` and `render` both columns.
- When **both** lanes reach `status: 'done'`, show a comparison strip. The scorecard fields are
  in each lane's `run_scored.scorecard`. You can mirror `scoring/store.js` `printComparison`
  (rows: `success, score, steps, duration_s, tool_calls, tool_errors, repeated_actions,
  ended_reason`) as a small 2-column HTML table in the browser — no backend call needed.

### 3e-bis. Thought presentation — chatbot style, NOT raw JSON (in scope)
In the H2H lanes (and ideally the single view too), render **every step's `thought`** as a clean,
readable **chat-style message bubble** — like a chatbot transcript — one bubble per thought, in
order, instead of dumping raw JSON. Requirements:
- Each thought is its own bubble (speech-bubble styling, readable line wrapping), shown for **every
  single step**, scrolling as new steps arrive. No `JSON.stringify` of the thought/observation in
  the user-facing feed.
- **Keep a tool/params column**: alongside (or directly under) each thought bubble, still show the
  **tool called** and its **args/params** in the existing structured form (`s.action.tool` +
  `fmtArgs(s.action.args)`), plus the result + OK badge. So each row reads as: *thought bubble →
  the tool+params it produced → result*.
- Insert all text via `textContent` (never `innerHTML`) — model output is untrusted.
- The raw step/trace JSON can remain available behind a collapsed "details" affordance if useful,
  but the default view is the human-readable bubble + tool/params, not JSON.
- The current steps **table** (`#live-steps`) may be reshaped into this bubble+tool layout, or kept
  with a prettier `Thought` cell — either way the thought must read like chat, and the
  tool/params/result columns must remain.

### 3f. Busy/stop semantics
`isBusy()` and `stopRun()` assume one child. For H2H, track both children (e.g. `benchProcs = []`)
and have `/stop` kill both. `isBusy()` is true if either lane is launching/running.

---

## 3.5. NEXT STEP — Interactive mode (do this after the task/H2H wiring above works)

**The model is "standby, then go on a chat" — NOT "type a goal, then spawn".**
When the dev picks Interactive and clicks Run, the bot(s) **immediately join the world and idle in
an "awaiting goal/instruction" state** (no agent loop running yet). The world is live and you can
watch the bots standing by. **Then** a **chat message** delivers the goal (e.g. "obtain a gold
ingot") and the bot(s) begin pursuing it. We do **not** wait for a goal before spinning up.

Available in **single** mode and **H2H + same world** (both bots idle in one world, one chat
message starts both at once). For H2H different worlds, either disable Interactive or document that
the same goal is broadcast to each isolated world.

**⚠️ This needs NEW backend work — the one-shot `--goal` path is not enough.** Today `bench.js`/
`harness/runner.js` take a fixed goal at launch, run the loop, and exit. Interactive needs a
**standby session**:
1. **Standby launch:** a new mode (e.g. `bench.js --interactive`, no `--task`/`--goal`) where the
   runner connects the bot, applies a minimal setup, announces readiness (e.g.
   `bot.chat('Awaiting goal/instruction…')`) and emits a new lane status `awaiting` to the
   dashboard — but does **not** start the agent loop yet.
2. **Goal trigger via chat:** the bot listens with mineflayer `bot.on('chat', (user, msg) => …)`.
   The first human chat message becomes the goal; the runner injects it as the agent's objective
   and starts the loop. This is the literal "on a chat they go". (The human is already joined to
   the world to watch — same-world H2H especially — so in-game chat is the natural channel.)
   - **Dashboard relay (optional):** also offer a text box that POSTs to a new `/prompt {goal}`
     endpoint; `live-server` delivers it to the standby bot(s). Simplest delivery: have the
     managed server say it in chat (`sm.sendCommand(port, 'say <goal>')`) so the same
     `bot.on('chat')` path handles both in-game and UI-typed goals uniformly. (Filter the bot's
     own/`MineBenchBot*` messages to avoid self-trigger loops.)
3. **H2H same world:** both standby bots are in one world and both receive the same chat message →
   both start on the same goal simultaneously. One chat, both go.
4. **Scoring:** an interactive goal is ad-hoc (no automatic `success` spec), so `success` stays
   `false` and the outcome is **human-judged** (ties into §8). Process metrics still populate.
5. **(Stretch)** stay in standby after a goal completes and accept the next chat message as a new
   goal in the same warm world — a continuous "prompt → run → idle → prompt" loop.

**Reuse:** the two-lane live view (§3c–3e) is unchanged; lanes just gain an `awaiting` status
before their first goal. The `MINEBENCH_LANE` tagging and per-lane state already cover it.

**Validate (human, see §8):** confirm the bot(s) JOIN and show "awaiting" FIRST, then a single chat
message ("obtain a gold ingot") starts them — both bots in H2H same-world, one bot in single.

---

## 4. Implementation checklist

**Phase 1 — Task/H2H wiring**
- [ ] `index.html` + `live.js`: **Goal-source toggle (Task | Interactive)**, mode/model(s)/world/reset controls; two-column H2H render; comparison strip.
- [ ] `live.js`: render each step's **thought as a chat-style bubble** (not raw JSON), every step, while keeping the **tool + params** (and result/OK) column — see §3e-bis. `textContent` only.
- [ ] `live-client.js`: stamp `event.lane` from `MINEBENCH_LANE` (default `'A'`).
- [ ] `live-server.js`: `runs` keyed by lane; route `handleEvent` by `event.lane`; snapshot carries mode+lanes.
- [ ] `live-server.js`: generalize `launchRun` → accept `{task, mode, model, modelA, modelB, world, reset, goal, interactive}`.
- [ ] `live-server.js`: H2H path calls `sm.prepareForRun` once, spawns two `--no-server` children with per-lane env.
- [ ] `live-server.js`: track multiple children; `/stop` kills all; `isBusy` covers both; `stopAll()` server cleanup on process exit/SIGINT (`sm.stopAll`).
- [ ] Re-`require('../harness/server-manager')` in live-server (single import).

**Phase 2 — Interactive mode (§3.5) — standby-then-chat (new backend work)**
- [ ] `runner.js`/`bench.js`: add a **standby session** (`--interactive`) — connect, apply minimal setup, announce "Awaiting goal/instruction…", emit lane status `awaiting`; do NOT start the agent loop yet.
- [ ] Goal trigger: bot `bot.on('chat', ...)` — first human chat message becomes the goal and starts the loop (filter out `MineBenchBot*`/own messages).
- [ ] H2H same-world: both standby bots receive the same chat → both start together.
- [ ] (Optional) `/prompt {goal}` endpoint → `sm.sendCommand(port, 'say <goal>')` so UI-typed goals flow through the same `bot.on('chat')` path.
- [ ] `live.js`: render an `awaiting` lane state; provide the goal/chat input shown in Interactive.

**Phase 3 — Human validation (§8): do NOT self-certify; prompt the human.**

## 5. End-to-end test plan
> Run these yourself to catch crashes/wiring errors, but the **acceptance** of each is the
> human's call (§8) — several require eyes on the Minecraft world and the live UI.
1. `npm run dashboard` → page opens at http://localhost:8099.
2. **Single, Task, no reset:** pick a task + model, Run. Confirm: server A adopts/boots, bot
   connects, live steps stream, scorecard appears, result saved. *(human-validated)*
3. **Single + reset:** check Reset, Run. Confirm world regenerates (server log shows fresh gen)
   and the run still completes. *(human-validated)*
4. **H2H different worlds:** mode=h2h, modelA/modelB set, world=different, Run. Confirm **two
   columns** stream in parallel, ports 25565 & 25566 both used, no interference, each lane shows
   **thoughts as chat-style bubbles (not JSON)** with the tool+params/result columns intact, and a
   comparison strip renders when both finish. (B auto-provisions if its folder was deleted.) *(human-validated)*
5. **H2H same world:** world=same. Confirm one server (25565), two distinct bots
   (`MineBenchBotA/B`) both opped (their setup commands succeed), two columns stream. *(human-validated)*
6. **Interactive, single:** Interactive source, Run. Confirm the bot **joins and idles showing
   "awaiting goal/instruction"** (no actions yet). Then send a chat "obtain a gold ingot" → the bot
   begins pursuing it. *(human-validated)*
7. **Interactive, H2H same world:** Interactive + h2h + same world, Run. Confirm BOTH bots join and
   idle "awaiting" in the one world; then ONE chat message starts BOTH on the same goal. *(human-validated)*
8. **Stop:** during an H2H run, click Stop → both children terminate, UI returns to idle.
9. **Warm reuse:** run twice without reset → second run starts fast (adopts the warm server),
   world state preserved.

## 6. Gotchas / constraints
- **Don't double-prepare servers in H2H.** live-server calls `prepareForRun` once; children use
  `--no-server`. If a child omits `--no-server`, it'll try to boot its own server (port clash).
- **Cold boot is ~50–60s.** First run / first reset will pause before steps stream — show a
  "starting server…" state (you can surface `prepareForRun`'s `log` callback into the SSE feed).
- **Same-world ops:** if server A was already warm *before* `MineBenchBotA/B` were ever opped,
  `ensureOpped` writes `ops.json` (persists) and issues a live `op` for servers we manage. After
  the first time it's permanent. If you adopt a long-running external server, a reset guarantees ops.
- **Inventory/crafting GUI** of a bot can't be shown in another client (protocol limit); the live
  feed's `inventory` field (from `readInventory`) is the source of truth for the UI.
- **Result pairing (CLI only):** `bench.js runDual` pairs result files by model name; the UI
  path should instead pair by **lane** from live events — simpler and unambiguous.

## 7. Quick reference — backend API the UI calls
```js
const sm = require('../harness/server-manager')
const targets = await sm.prepareForRun({ mode, world, reset })  // [{port, username}, ...]
await sm.stopAll()                                              // on dashboard shutdown
sm.SERVERS.A.port / sm.SERVERS.B.port                           // 25565 / 25566
sm.USERNAME / sm.USERNAME_A / sm.USERNAME_B                     // bot logins
```

---

## 8. FINAL STEP — Human validates the test cases (do NOT self-certify)

**This is a hard requirement.** The acceptance criteria here involve watching the Minecraft world
and the live dashboard (bots moving, two lanes streaming, a typed goal spinning up both bots). An
agent cannot truthfully verify those from logs alone. So when your implementation is code-complete:

1. **Do not** call `task_complete` / declare success based only on your own runs or on the code
   compiling. Self-run the test plan (§5) first to catch crashes, but treat that as a smoke test.
2. **Prompt the human** to perform the acceptance validation. Use the interactive question tool
   (`ask_user`) — ask **one test case at a time**, tell them exactly what to do and what a PASS
   looks like, and wait for their verdict before moving on. Suggested prompts:
   - *"Single + Task: I'll start the dashboard. Click Run on a task — do you see the bot connect
     and live steps stream, ending with a scorecard? (pass/fail)"*
   - *"Single + Reset: with Reset checked, did the world visibly regenerate and the run still
     complete? (pass/fail)"*
   - *"H2H different worlds: did TWO columns stream in parallel and a comparison render at the end,
     with the bots clearly not interfering? (pass/fail)"*
   - *"H2H same world: are BOTH bots in the one world (ports 25565 only), both acting, two columns
     streaming? (pass/fail)"*
   - *"H2H readability: in the two-lane view, is each bot's thinking shown as readable chat-style
     bubbles (not raw JSON), one per step, with the tool + params and result still visible
     alongside? (pass/fail)"*
   - *"Interactive single: after clicking Run, does the bot JOIN and sit idle showing 'awaiting
     goal/instruction'? Then after you send a chat 'obtain a gold ingot', does it start pursuing
     it? (pass/fail)"*
   - *"Interactive H2H same world: do BOTH bots join and idle 'awaiting' in the one world, and does
     a SINGLE chat message start BOTH on the same goal? (pass/fail)"*
   - *"Stop & warm reuse: does Stop kill both bots, and does a second no-reset run start fast?
     (pass/fail)"*
3. **Record each verdict.** If the human marks a case **fail**, fix it and re-prompt that case.
   Only consider the feature done when the human has explicitly **passed every case** they choose
   to validate.
4. **Let the human choose scope.** Ask which cases they want to validate (they may skip some);
   don't assume. Their sign-off — not yours — is the definition of done for this UI work.
