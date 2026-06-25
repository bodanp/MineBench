# MineBench — Team Scope & Delegation Plan

> ⚠️ **DEPRECATED — historical snapshot, not maintained.** This was the initial team
> scope/delegation plan. Some details (especially scoring & milestones) no longer match the
> code. For an up-to-date description of how each system actually works, see **`context.md`**
> (the living document). Kept only for historical reference of the original role split.

> A reproducible Minecraft benchmark for agentic AI. Plug in an LLM/agent, run it
> through standardized Minecraft tasks, get a comparable scorecard.

**Read this first:** MineBench is a **benchmark**. The product we ship is the
**harness** (tasks + environment + scoring + comparison). The agent (model + tools)
is the *thing being tested*, not the deliverable. A benchmark is valid even if the
agent is mediocre — a weak model just earns a low score. So "the bot isn't perfect
yet" is **not** a blocker for any workstream below.

We are **refactoring the existing prototype into modules, not rewriting from scratch.**
The prototype already solved the painful parts (Azure auth, the mineflayer connection,
pathfinding recovery, the anti-cheat kick, env config). Carving it into the modules
below *is* how the team comes to understand it and how we work in parallel.

---

## TL;DR — who owns what

| # | Role | Person | Load | One-line mission |
|---|------|--------|------|------------------|
| 1 | **Harness / Runner** | full, strong async/Node | 1.0 | Run an agent against a task reproducibly; emit a trace. |
| 2 | **Scoring & Results** | full | 1.0 | Turn traces into scorecards; persist + compare across models. |
| 3 | **Agent: Skills & Movement** | full, strong | 1.0 | Make the in-world tools (mine/craft/place/navigate) actually work. |
| 4 | **Agent: Brain & Models** | full, strong | 1.0 | Observation + prompt + **swappable models** (mini vs 4.1 vs 4o). |
| 5 | **Tasks & Success Specs** | half-in | 0.5 | Author the task suite as data + success checks. |
| 6 | **Dashboard & Demo** | half-in | 0.5 | Visualize/compare results; build the demo + write-up. |

The four full-timers each own one meaty, well-bounded module with exactly one main
interface to the others. The two half-in people own the most loosely-coupled work, so
their availability never blocks the critical path.

**Why this split:** the old plan overloaded a single "agent owner" (tools + observation
+ models) and under-loaded a "task suite" full-timer. Here the agent is two roles (3 and
4), and task authoring is sized to a half-in person because, once the schema exists, it's
parallel, low-dependency work.

---

## The 3 contracts everyone codes against (agree on these in the kickoff)

Nothing else can start until these are pinned. They are the seams between modules.

### A. Task schema — owned by Role 5, consumed by Roles 1 & 2
```jsonc
{
  "id": "stone_pickaxe",
  "title": "Make a stone pickaxe from scratch",
  "goal": "Make a stone_pickaxe from scratch.",   // the prompt handed to the agent
  "difficulty": 2,                                  // 1..5
  "max_steps": 60,
  "setup": {                                        // applied before each run = determinism
    "gamerules": { "doDaylightCycle": false, "doWeatherCycle": false,
                   "doMobSpawning": false, "keepInventory": true },
    "time": "day", "weather": "clear",
    "teleport": [0, 64, 0],                         // fixed spawn
    "give": []                                      // starting inventory, e.g. [{"item":"stone_pickaxe","count":1}]
  },
  "success": { "inventory": { "stone_pickaxe": 1 } } // declarative; see below
}
```
**Success DSL (v1 = inventory only, keep it simple):**
`{ "inventory": { "<item>": <minCount>, ... } }` → true when the bot holds ≥ each count.
(Future: `{ "placed": "<block>" }`, `{ "reach": [x,y,z], "radius": n }` — not for v1.)

**Milestones (partial-credit progress) are AUTO-DERIVED — you do not hand-author them.** Scoring
walks the goal item's ingredient graph from Minecraft's own recipe data, so a new task that just
declares `success: { <item>: n }` gets a progress chain for free. Optionally add an explicit
`"progress": [ { "item": "...", "count": 1, "label": "..." }, ... ]` to a task ONLY for long-
horizon tasks whose process/tool-tier steps (smelting; mining gated by tool tier) the crafting
graph cannot see (e.g. iron). Even with no chain at all, 4 of the 6 capability dimensions still
score the run. See `scoring/milestones.js`.

### B. Trace schema — emitted by Role 1, consumed by Role 2
```jsonc
{
  "task_id": "stone_pickaxe",
  "model": "gpt-4.1-mini",
  "started_at": "2026-06-22T10:00:00Z",
  "ended_reason": "agent_stop | max_steps | disconnected | error",
  "steps": [
    { "i": 1, "observation": { /* … */ }, "thought": "I need wood",
      "action": { "tool": "mine_block", "args": { "block_type": "oak_log" } },
      "result": "Mined oak_log at (…)", "ok": true, "pos": [0.5, 64, 0.5] }
  ]
}
```

### C. Scorecard schema — produced by Role 2, consumed by Role 6
MineBench is a proxy for GENERAL agentic capability (Minecraft is just the instrument), so a run
is NOT collapsed to one "A beats B" scalar. The scorecard is a **capability profile** — six
deterministic, transferable dimensions (each 0..1, or `null` when the run never exercised it, so
it's excluded from averages rather than scored 0). Scoring is a pure function of (trace, task):
no LLM judge (non-deterministic + biased), no elapsed time (LLM-latency-dominated, not behaviour).
```jsonc
{
  "task_id": "stone_pickaxe", "model": "gpt-4.1-mini",
  "success": true,
  "progress": 0.86,                  // milestone partial credit (how far down the dependency chain)
  "milestones": { "reached": 6, "total": 7, "list": [ { "label": "...", "reached": true } ] },
  "capabilities": {
    "completion": 0.86,              // milestone progress
    "planning":   0.90,              // prerequisites pursued before dependents (no premature attempts)
    "tool_use":   0.81,              // valid actions / preconditions (1 - self-inflicted errors)
    "adaptation": 1.0,               // after a SELF-caused failure, does the next action differ
    "robustness": null,              // recovery after an EXTERNAL disturbance (e.g. stolen resource)
    "efficiency": 0.57               // productive-action ratio (NOT duration, NOT raw step count)
  },
  "diagnostics": {                   // informational, never subtracted from the score
    "actions": 28, "productive_actions": 16, "unproductive_loops": 8,
    "agent_errors": 7, "env_errors": 2, "disturbance_events": 0
  },
  "duration_s": 142,                 // INFORMATIONAL ONLY — never part of the score
  "score": 0.78                      // roll-up digest of the profile (the profile is the headline)
}
```
**Why a profile, not a scalar:** it surfaces tradeoffs honestly — e.g. "A completes more tasks
but B uses tools more precisely and recovers from disturbances better" — which is what an unbiased
model-vs-model benchmark should report. Errors are DIAGNOSTICS (classified agent-fault vs
environmental); only *looping* (repeating an action that changed nothing) is ever penalised, and
legitimate repeats (mining log after log) are not.

---

## Target module layout (the refactor)

```
agent/
  skills.js        # tools: move_to, mine_block, place_block, craft, equip, …  (Role 3)
  observation.js   # buildObservation(bot) -> structured world state           (Role 3 owns world-read, Role 4 owns shape)
  brain.js         # createAgent({model}) -> { act(obs, history) }             (Role 4)
  knowledge.js     # Minecraft knowledge base                                  (Role 4)
  models/azure.js  # model adapter (later: models/openai.js, etc.)             (Role 4)
harness/
  runner.js        # run(agent, task) -> trace ; applies task.setup, max_steps  (Role 1)
  env.js           # world reset + apply gamerules/teleport/give via RCON/chat  (Role 1)
scoring/
  scorer.js        # score(trace, task) -> scorecard                            (Role 2)
  store.js         # write results/*.json, aggregate comparison table          (Role 2)
tasks/
  *.json           # the task suite (data)                                      (Role 5)
results/
  *.json           # one scorecard per (task,model) run                         (output)
dashboard/
  index.html / app # read results/*.json -> comparison view + leaderboard       (Role 6)
```

**Where today's prototype goes (reuse, don't rewrite):**
- `bot/tools.js` → split into `agent/skills.js` + `agent/observation.js` (Role 3).
- `bot/llm_bot.js` → loop → `harness/runner.js` (Role 1); Azure client + prompt → `agent/brain.js` (Role 4); metrics/summary → `scoring/scorer.js` (Role 2).
- `bot/knowledge.js` → `agent/knowledge.js` (Role 4).
- `spigot.yml` / gamerules / spawn → `harness/env.js` + `tasks/*.setup` (Roles 1 & 5).

---

## Role cards (the specifics)

### Role 1 — Harness / Runner  (full)
- **Mission:** one command runs `(agent, task)` reproducibly and produces a Trace (schema B).
- **Owns:** `harness/runner.js`, `harness/env.js`, the **Trace schema**, the CLI
  (`npm run bench -- --task stone_pickaxe --model gpt-4.1-mini`).
- **The loop:** reset world → apply `task.setup` → for each step: `buildObservation(bot)`
  (Role 3) → `agent.act(obs, history)` (Role 4) → `executeAction(bot, action)` (Role 3) →
  record step → stop on success/`stop()`/`max_steps`/disconnect → write trace.
- **Interfaces:** consumes `agent.act` (Role 4), `buildObservation`/`executeAction` (Role 3),
  task config (Role 5); hands the Trace to Role 2.
- **Definition of done (demo):** `npm run bench` runs any task with any registered model,
  is resumable after a kick, and always writes a complete trace.
- **First 2 days:** stand up the walking skeleton (see phasing) calling the existing bot.
- **Good fit:** strongest with async/Node, comfortable owning the integration spine.

### Role 2 — Scoring & Results  (full)
- **Mission:** turn Traces into comparable Scorecards and make model-vs-model comparison trivial.
- **Owns:** `scoring/scorer.js`, `scoring/store.js`, the **Scorecard schema**, the scoring formula.
- **Scope:** interpret `task.success` against final state; compute steps/errors/repeats/stuck;
  define `score` (start simple: `success` is primary; efficiency is the tiebreaker, e.g.
  `score = success ? clamp(1 - 0.3*steps/max_steps - 0.1*errnorm - 0.1*stucknorm) : 0`);
  write `results/*.json`; build the aggregate comparison table (task × model → score).
- **Interfaces:** consumes Trace (Role 1) + Task (Role 5); produces Scorecards for Role 6.
- **Definition of done:** running the same task on 2 models yields a side-by-side table with
  success + the four sub-metrics. The metrics already exist in the prototype's run summary — port them.
- **Good fit:** likes clean data contracts and metrics.

### Role 3 — Agent: Skills & Movement  (full)
- **Mission:** the in-world primitives actually work — navigation never traps the agent.
- **Owns:** `agent/skills.js` (tool catalog + implementations), `agent/observation.js`
  (world reading), and movement reliability (the navigate/dig-through/anti-stuck logic).
- **Interfaces:** exposes `tools` (name → schema), `executeAction(bot,{tool,args}) -> {result, ok}`,
  and `buildObservation(bot) -> obs`. Consumed by Roles 1 & 4.
- **Definition of done:** each tool has a schema + a robust impl that returns a clear
  success/failure string; a 1-block obstacle can never permanently stall the agent.
- **First 2 days:** lift `bot/tools.js` into `agent/skills.js`, keep the existing
  navigate()/digInFront() recovery, add 1-2 missing skills tasks need (e.g. `smelt`).
- **Good fit:** enjoys game/physics/pathfinding debugging.

### Role 4 — Agent: Brain & Models  (full)  ← the "is it the model or the tools?" role
- **Mission:** the decision layer, and the ability to **swap models** so we can measure.
- **Owns:** `agent/brain.js` (the `act()` policy + prompt assembly), `agent/knowledge.js`,
  `agent/models/*` (model adapters), the system-prompt + observation *shape*.
- **Interfaces:** exposes `createAgent({ model }) -> { act(obs, history) -> {thought, tool, args} | {done} }`.
  Consumes `buildObservation` shape (coordinate with Role 3).
- **Definition of done:** the same agent runs on `gpt-4.1-mini`, `gpt-4.1`, and `gpt-4o`
  by changing one flag — this is what turns "I can't tell if it's the model" into a graph.
- **First 2 days:** extract the prompt + Azure client into `brain.js`; add a thin model-adapter
  seam so a second deployment is one config line.
- **Good fit:** strong on prompting/LLM behavior.

### Role 5 — Tasks & Success Specs  (half-in)
- **Mission:** author the benchmark's content as data.
- **Owns:** `tasks/*.json` — 5 tasks across a difficulty ramp, each with `setup`, `success`,
  `max_steps`, and a one-line rationale (what skill it isolates).
- **Starter suite:** `gather_wood` (1) → `craft_table` (1) → `wooden_pickaxe` (2) →
  `stone_pickaxe` (3) → `furnace_and_smelt_iron` (4). Avoid luck tasks ("find diamond").
- **Interfaces:** pure data consumed by Roles 1 (setup) & 2 (success). No engine code —
  if a task needs a new capability, file it to Role 3.
- **Definition of done:** 5 tasks load and run end-to-end; each has a deterministic setup and
  an automatic success check (no human judging, no trusting the agent's `stop()`).
- **Why half-in:** once the Task schema exists, this is independent, low-blast-radius work.

### Role 6 — Dashboard & Demo  (half-in)
- **Mission:** make the results legible and build the story we present.
- **Owns:** `dashboard/` (read `results/*.json` → comparison table / simple leaderboard),
  the demo script, and the hackathon write-up/slides.
- **Interfaces:** consumes Scorecards (Role 2). Zero coupling to the engine internals.
- **Definition of done:** one view showing task × model → success + score, plus a 3-minute
  demo narrative. A static HTML page reading JSON is enough — do not build a backend.
- **Why half-in:** fully downstream; can be done in bursts.

---

## Phasing — build a walking skeleton first

**Phase 0 (whole team, day 1): agree the 3 contracts above.** Nothing else starts until
Task / Trace / Scorecard schemas are signed off. Timebox to one session.

**Phase 1 (days 1–3): one end-to-end run.** Wire `runner → existing bot → scorer` so that
`npm run bench -- --task gather_wood --model gpt-4.1-mini` produces one `results/*.json`,
even if every module is a thin stub. Getting a real (ugly) number end-to-end de-risks
everything and exposes interface problems early.

**Phase 2 (days 3–N): deepen in parallel.** Each owner improves their module behind the
fixed interfaces. Integration stays green because the seams don't move.

**Phase 3: experiments + demo.** Run all 5 tasks × 2 models × N trials, fill the dashboard,
rehearse the pitch.

---

## Definition of done for the hackathon (the demo)
- **5 tasks**, deterministic setup, **automatic** success detection.
- **2 models** compared (e.g. gpt-4.1-mini vs gpt-4.1) on the same tasks.
- A **scorecard per run** + one **comparison view**.
- One command to run a task; results reproducible across runs.

## Explicitly NOT in scope (protect the timeline)
Multi-agent races, RL/training, custom Minecraft mods, non-Azure providers, Entra/multi-auth,
a results backend/database, >5 tasks, or "obtain diamond"-class long-horizon tasks. Park all
of these as "future work" in the write-up.

## Answering "is it the model or our tools?"
You don't resolve this by rewriting — you resolve it by **measuring**, which is the project
itself. The run scorecard already separates the signals: high `tool_errors` → Role 3's area;
high `stuck_events` with few tool errors → world/navigation; coherent-but-wrong reasoning in
`thought` → the model. Then Role 4's model-swap A/B settles it: if a bigger model clears the
same task with the same tools, it was the model; if both fail identically, it's the harness.
