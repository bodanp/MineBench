# MineBench — Project Context

> **Living document.** This file describes the architecture and behavior of MineBench's
> systems. It exists so contributors (and AI agents) can quickly understand *what each part
> does and why* before touching it.

## 🛠️ How to maintain this file (READ BEFORE EDITING CODE)

**When you change the project, UPDATE the matching section below — do not just append.**

- Every system has its own section. When your change alters a system's behavior, contracts,
  files, or data shapes, **edit that section in place** so it keeps describing reality.
- **Modify, don't accumulate.** Prefer rewriting an existing sentence/bullet over adding a
  new one beside a now-stale one. Delete claims that are no longer true.
- Only add a *new* section when you introduce a genuinely new system/module that none of the
  existing sections cover. Keep sections short and current.
- If you change a shared **contract** (Task / Trace / Scorecard schema, tool list, the
  `executeAction` / `complete` / `buildObservation` interfaces), update **both** the owning
  section here and any other section that references it.
- This is not a changelog. Don't record history ("previously X, now Y") — describe the
  *current* state only.

---

## Overview

MineBench is a **reproducible benchmark for agentic AI in Minecraft**. You plug in an
LLM/agent, run it through standardized Minecraft tasks against a live server (via
[mineflayer](https://github.com/PrismarineJS/mineflayer)), and get a comparable scorecard.

The **product is the harness** (tasks + environment + scoring + comparison). The agent
(model + tools) is the *thing being tested*, not the deliverable — a weak model simply earns
a low score. See `docs/team-plan.md` for the full role/ownership breakdown.

**End-to-end flow** (`bench.js`):
`load task → resolve model → runner.run() → scorer.score() → store.saveResult()`

## Directory map

```
bench.js            # CLI entry point — parses args, wires the flow together
agent/              # the agent under test (model + tools + perception)
  brain.js          # decision policy: system prompt + act() loop over a swappable model
  observation.js    # turns the live world into the structured state the model perceives
  skills.js         # in-world tools (mine/craft/move/...) + movement reliability layer
  models/           # swappable model adapters (Azure, GitHub Copilot) + registry
harness/            # the benchmark spine
  runner.js         # run(task, model) -> Trace; owns the step loop + Trace schema
  env.js            # applies task.setup to the world for determinism (gamerules/tp/give)
scoring/            # turns runs into comparable results
  scorer.js         # checkSuccess() + score() -> Scorecard (capability profile)
  milestones.js     # per-task progress DAG: getMilestones()/validateMilestones()
  store.js          # persist results/*.json + aggregate comparison table
tasks/              # the task suite as data (*.json)
results/            # one saved {scorecard, trace} JSON per run (output)
bot/bot.js          # standalone smoke test — connects + walks; not part of the benchmark
commands.md         # quick command reference (run/compare/server/dashboard)
docs/team-plan.md   # team scope, role ownership, and design rationale
```

## Shared contracts (the seams between systems)

Changing any of these affects multiple systems — update every dependent section.

- **Task schema** (`tasks/*.json`): `{ id, title, goal, difficulty, max_steps, rationale,
  setup, success, milestones? }`. `setup` = `{ gamerules, time, weather, teleport, give,
  clear_inventory }`. `success` (v1) = `{ inventory: { "<item>": <minCount> } }`. `milestones`
  (optional) = a partial-credit dependency DAG; see Scoring.
- **Trace schema** (emitted by `harness/runner.js`): `{ task_id, model, started_at,
  ended_reason, duration_s, final_state, steps: [{ i, observation, thought, action, result,
  ok, pos }] }`. `ended_reason` ∈ `success | max_steps | agent_stop | no_tool_call |
  disconnected | llm_error | error`.
- **Scorecard schema** (produced by `scoring/scorer.js`): a capability PROFILE, not one scalar —
  `{ task_id, model, success, score, progress, milestones: { reached, total, list }, capabilities:
  { completion, planning, tool_use, adaptation, robustness, efficiency }, diagnostics: {...} }`
  plus legacy fields (`steps, tool_calls, tool_errors, repeated_actions, stuck_events,
  duration_s, ended_reason`) the dashboard/older tooling still read. Each capability is `0..1` or
  `null` when the run never exercised it (excluded from averages, never scored `0`).
- **Model interface**: `complete({ messages, tools }) -> assistantMessage`.
- **Skills interface**: `TOOL_SCHEMAS` (array) + `executeAction(bot, { tool, args }) ->
  { result, ok, done }`.
- **Observation interface**: `buildObservation(bot) -> obs`, `readInventory(bot) -> {item: n}`.

---

## Systems

### CLI entry point — `bench.js`
Parses `--task`, `--model`, `--goal`, `--verbose` flags (and a positional ad-hoc goal).
Loads a task JSON from `tasks/` (defaults to `gather_wood`), or builds an ad-hoc task with no
automatic success check from a free-form goal. Resolves the model, runs the task, scores the
trace, prints a scorecard, and saves the result. Thin glue — keep orchestration logic in the
owning modules, not here.

**Dual mode** (`--model-a X --model-b Y`): runs two bots on the *same* task, one per model, so
two models can be compared. Each bot runs the **unchanged single-bot command** in its **own
console window** (`cmd start … cmd /k`, windows stay open), differing only by the
`MC_BOT_USERNAME` injected via the spawn environment (`MC_BOT_USERNAME_A`/`_B`, default
`MineBenchBotA`/`B`). Before opening the two windows it closes any leftover bot windows from a
previous dual run (matched by the `MineBenchBot*` window title) so repeated runs don't pile up.
The bots share one world (a "race" — they may compete for blocks). The controller waits until
both children have written their `results/*.json` (timeout `DUAL_WAIT_MS`), then prints
`store.printComparison`. Comparison rendering lives in `store.js`, keeping this file thin.

### Harness / Runner — `harness/runner.js`
The benchmark spine. `run({ task, model })` creates a mineflayer bot, waits for spawn, applies
the task setup, then loops up to `max_steps`: `buildObservation → agent.act → executeAction →
record step → checkSuccess`. **Success is detected by the harness, not trusted from the
model's `stop()`.** Owns the **Trace schema** and `ended_reason` values. Surfaces the
anti-cheat movement kick with the server-side fix. Bot version is pinned to `1.21.11`;
connection uses `MC_SERVER_HOST/PORT` and `MC_BOT_USERNAME`/`BOT_NAME` env vars, offline auth.
The agent's `thought` is only logged to the console when the `--verbose` flag is set (mirrors
the tool-call logging); follow that gate when adding diagnostic output for agent internals.

The oscillation "stuck nudge" assistance is currently **disabled** (the `STUCK_NUDGE`
constant, `posHistory`/`stuckCooldown`, the detection block, and the `stuck_events` trace
field are all commented out). `let nudge = ''` is intentionally **kept** so `agent.act(obs,
nudge)` still gets a valid argument. Rationale: the homegrown unstuck nudges rotted the
agent's context window and changed its behavior. If reintroducing navigation recovery, these
are the integration points.

### Environment setup — `harness/env.js`
Makes runs reproducible. `applyTaskSetup(bot, task)` issues chat commands derived from
`task.setup`: gamerules, time, weather, teleport (coords or `'spawn'` → `bot.spawnPoint`, a
safe surface spot), inventory clear, and `give`. Always issues a
`/attribute <bot> minecraft:scale base set 0.9999999` first. **Requires the bot to be OP** on
the server (`/op <bot>` once); otherwise commands are silently ignored.

### Agent: Brain — `agent/brain.js`
The decision policy. `createAgent({ model, goal, toolSchemas })` owns the conversation, builds
the Minecraft system prompt, and turns each observation into the next action via the swappable
model. **One action per step**: the harness executes the first tool call and feeds the result
back via `recordResult` before the next `act()`. Because reasoning models hide their
chain-of-thought, a `thought` string is injected into every tool schema so the model states
its rationale as a tool argument (read back deterministically for the trace). Nudges once for
an explicit tool call if a model replies with prose only, and closes out unanswered sibling
tool-call ids so the next request stays valid.

### Agent: Observation — `agent/observation.js`
Turns the live world into the structured state the model perceives. `buildObservation(bot)`
returns `position`, `facing`, `health`, `food`, `on_ground`, `inventory`, `surroundings`
(immediate blocks: front/step-up/blocked/standing-on/drop), `nearby` (a coordinate "radar" of
the nearest notable resource/hazard of each `RADAR_BLOCKS` type, preferring **exposed** blocks
the bot can actually reach), and `time_of_day`. `readInventory(bot)` returns `{item: count}`.

### Agent: Skills — `agent/skills.js`
The agent's in-world capabilities + the movement reliability layer. Exposes `TOOL_SCHEMAS`
(OpenAI function schemas the LLM sees), `TOOL_IMPLS` (name → `async (bot, args) => string`),
and `executeAction(bot, {tool, args}) -> { result, ok, done }`. Tools include `read_data`,
`look_around`, `move_to`, `move_forward`, `mine_block`, `place_block`, `craft`, `smelt`,
`equip`, `turn`, `jump`, `chat`, and `stop`. Each impl returns a human-readable string;
strings matching the error regex (`Failed|Unknown|No |Could not|Nothing|Tool .* threw`) are
scored as failures (`ok: false`). Skills verify outcomes against inventory deltas (e.g.
`invGain`, `settleInventory`, `waitForSmelt`) rather than assuming an action worked, and
auto-equip a valid harvest tool before mining. **Add a skill = add a schema to `TOOL_SCHEMAS`
+ an impl to `TOOL_IMPLS`.**

Conventions & gotchas:
- **Name lookups**: any tool that resolves a block/item by name must use
  `loadMcData(bot)` (cached) + `normalizeName()` (strips `minecraft:`, lowercases, spaces →
  underscores), matching the `read_data` tool — not raw `mcData` lookups. Unknown names
  return suggestions.
- **Navigation** is the project's biggest pain point. It is built on
  `mineflayer-pathfinder` (the chosen library — `mineflayer-navigate` and
  `mineflayer-movement` were evaluated and rejected; don't re-investigate). The real issue is
  pathfinder occasionally getting stuck, not the library choice.
- **Known bug**: the `craft` tool can wrongly report a crafting table is "not near me" even
  when one is adjacent (`dist≈0.9`, exposed). The fault is in the craft tool's
  nearby-table detection (search radius / position matching), not pathfinder.

### Agent: Models — `agent/models/`
Swappable model adapters behind one interface (`complete({ messages, tools }) ->
assistantMessage`) so mini/4.1/4o and other providers can be compared.
- `index.js` — `resolveModel(name)`: `copilot/<model>` → Copilot adapter; otherwise an Azure
  deployment from `AZURE_OPENAI_*` env config (a bare `--model` just swaps the deployment).
- `azure.js` — Azure OpenAI adapter; supports API-key or Entra (`USE_ENTRA`) auth. Exports
  `callWithRetry`, which retries transient API failures (429/408/5xx/network) with
  exponential backoff + jitter, honoring `Retry-After`. Optional env knob
  `AZURE_MIN_REQUEST_INTERVAL_MS` serializes calls to pace under the rate limit (slower, but
  cannot raise the Azure-side TPM quota ceiling).
- `copilot.js` — GitHub Copilot adapter (`COPILOT_TOKEN`); same contract, different base URL +
  integration headers. Reuses `callWithRetry`.
Both adapters set `parallel_tool_calls: false` to match the one-action-per-step loop.

### Scoring — `scoring/scorer.js` + `scoring/milestones.js`
MineBench is a proxy for GENERAL agentic capability (Minecraft is just the instrument), so a run is
NOT collapsed to one "A beats B" scalar. `score(trace, task)` emits a **capability profile** — six
deterministic dimensions, each `0..1` or `null` when never exercised (excluded from averages, not
scored `0`). Scoring is a pure function of `(trace, task)`: **no LLM judge** (non-deterministic +
biased), **no elapsed time** (LLM-latency-dominated, not behaviour). The dimensions:
- **completion** — milestone-graph progress (see below).
- **planning** — did a craft/smelt pursue its *direct* prerequisites first (no premature attempts)?
- **tool_use** — valid actions respecting preconditions (`1 - self-inflicted errors / actions`).
- **adaptation** — after a SELF-caused failure, does the next action differ (not looping)?
- **robustness** — recovery after an EXTERNAL disturbance (e.g. another bot takes a resource).
- **efficiency** — productive-action ratio (NOT duration, NOT raw step count).

Errors are DIAGNOSTICS, not blunt penalties; only *looping* (repeating an action that changed
nothing) is penalised, and env-fault failures are classified apart from agent-fault ones. `score`
is the roll-up digest (`0.5*completion + 0.5*mean(available behaviour dims)`); the profile is the
headline. `checkSuccess(state, task)` evaluates the declarative success DSL (v1: `inventory`
minimums) — keep it declarative so task authors never write engine code.

**Milestones** (`scoring/milestones.js`) are a per-task dependency **DAG** of progress checkpoints,
authored in the task JSON under `"milestones"` (there is NO recipe auto-derivation). Each node is
`{ id, <matcher>, count?, label?, deps?, tool? }` where `<matcher>` ∈ `{item}|{any:[...]}|{suffix}`
and `deps` lists the ids of its direct prerequisites. Why a DAG, not a linear chain: a complex task
has many valid solution orders, so a forced sequence mis-scores legal reorderings. Two rules make
credit path-independent:
- **completion** uses *backward entailment* — reaching a node credits all of its prerequisites (you
  can't hold a stone pickaxe without having had sticks, cobblestone and table access), so credit
  never depends on catching a transient intermediate in the inventory.
- **planning** checks a craft/smelt's *actual direct parents*, not "every earlier step". `tool:true`
  marks a recipe REQUIREMENT (crafting_table/furnace, satisfied by a world block): counted for
  completion via entailment, but EXCLUDED from the premature check (its presence is proven by the
  dependent action succeeding). A task may omit `milestones` — it then scores on the four
  milestone-free dimensions only. `validateMilestones(task)` flags dangling deps / duplicate ids.

### Results store — `scoring/store.js`
`saveResult(scorecard, trace, dir?)` writes one
`<task>__<model>__<timestamp>.json` (`{ scorecard, trace }`) to `results/`.
`loadResults(dir?)` reads them back; `comparisonTable(results)` reduces to
`{ task_id, model, success, score, steps }` rows for cross-model comparison.
`resultFilesForTask(taskId, sinceMs?, dir?)` lists this task's result files (optionally only
those written at/after `sinceMs`), newest first — used by `bench.js` dual mode to wait for both
child runs. `pickWinner(a, b)` ranks two scorecards (success → higher `score` → fewer `steps`;
`null` on a tie), and `printComparison(cards, log?)` prints the two models side-by-side plus the
winner.

### Tasks — `tasks/*.json`
The benchmark content, authored purely as data (no engine code). Each task has a deterministic
`setup`, an automatic `success` check, a `max_steps` cap, a one-line `rationale` naming the skill
it isolates, and (optionally) a `milestones` dependency DAG for partial-credit scoring (see
Scoring). Current suite ramps in difficulty: `gather_wood` → `stone_pickaxe` →
`iron_pickaxe`. If a task needs a new capability, add the skill in `agent/skills.js` rather
than embedding logic here.

### Smoke test — `bot/bot.js`
A standalone connection sanity check (`npm run smoke`): connects to the server, confirms
spawn, and walks forward for 30s. Not part of the benchmark loop — use it to verify server
connectivity/credentials.

## Configuration & scripts
- **Env** (`.env`, see `.env.example`): `AZURE_OPENAI_*` (key/endpoint/deployment/api-version),
  `USE_ENTRA`, `AZURE_MIN_REQUEST_INTERVAL_MS`, `COPILOT_TOKEN`, `MC_SERVER_HOST/PORT`,
  `MC_BOT_USERNAME`/`BOT_NAME`, `MAX_STEPS`. Dual mode adds `MC_BOT_USERNAME_A`/`_B` (one bot
  each; both must be op'd) and optional `DUAL_WAIT_MS` (controller wait before timeout). Loaded
  via `dotenv`.
- **Scripts** (`package.json`): `npm run bench` / `npm run agent` → `node bench.js`;
  `npm run smoke` → `node bot/bot.js`.
- **Server prerequisites**: the bot must be **OP** for `harness/env.js` setup to apply, and the
  server's anti-cheat may need loosened movement thresholds (`spigot.yml`) to avoid kicks.
