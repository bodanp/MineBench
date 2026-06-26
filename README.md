# 🟩 MineBench

### A Minecraft benchmark for **general agentic capability** in LLMs

Minecraft is the measuring instrument, not the point. MineBench drops a language model into a live
Minecraft world with nothing but a set of tool calls, gives it a goal ("make a stone pickaxe from
scratch"), and watches what it *actually does* — then scores it on six transferable dimensions of
agentic skill. Same world, same tasks, any model. The result is a deterministic capability profile
you can trust, not a vibe check.

> **Why Minecraft?** Long-horizon goals, deep crafting dependencies, an open world that changes
> under the agent, and verifiable end-states (you either hold the pickaxe or you don't). It is the
> perfect proving ground for planning, tool use, and recovery — the skills that matter for *any*
> agent.

---

## 📊 See it in action

A live, self-hosting dashboard turns every run into a deterministic scorecard, a head-to-head
leaderboard, and a step-by-step replay of the agent's reasoning.

### Leaderboard & capability profile
Models are ranked by success rate and average score, then broken down across the six agentic
dimensions — so you can see *where* one model beats another, not just *that* it does.

![MineBench dashboard — overview, leaderboard, and per-model capability profile](screenshots%20and%20gifs/benchmark%20statistic%20proof%20of%20concept.png)

### Task × model matrix & full run history
Every task-vs-model cell is colour-coded by outcome and clickable to drill into the run. Below it,
a sortable history of every run with score, progress, steps, and errors.

![MineBench dashboard — task×model matrix and run history](screenshots%20and%20gifs/benchmark%20statistic%20proof%20of%20concept2.png)

### Live agent reasoning
Watch the agent think in real time. Every tool call carries a one-sentence rationale, so you see
the model plan backward from the goal, gather wood, and recover when a drop is left on the ground.

![MineBench live dashboard — the agent's step-by-step thoughts and actions](screenshots%20and%20gifs/Thought%20process%20of%20agent.png)

---

## ⭐ What makes MineBench different

| | |
|---|---|
| **🎯 A capability *profile*, not one number** | Six deterministic dimensions instead of a single win/lose scalar — you learn *what* a model is good at. |
| **🧮 Deterministic & unbiased scoring** | No LLM judge. No elapsed-time bias (that just measures latency). Every score is a pure function of the run trace. |
| **🪪 Verified outcomes, never self-reported** | Success is detected by the *harness* from real world state — the model saying "done" proves nothing. |
| **🌍 Any model, one interface** | Azure OpenAI deployments and 20+ models via the GitHub Copilot API, swapped with a single flag. |
| **⚔️ Head-to-head mode** | Run two models in isolated same-seed worlds (or one shared world) and compare capability profiles side by side. |
| **📺 Live, zero-setup dashboard** | Auto-launches the Minecraft server, streams the agent's thoughts, and renders the leaderboard — all from one command. |

---

## 🧠 The six capability dimensions

Each is a deterministic function of the run trace. A dimension is `null` (excluded from the
average) when a run never exercised it — keeping the benchmark unbiased.

| Dimension | What it measures |
|---|---|
| **Completion** | How far down the task's dependency chain the agent got (milestone progress). |
| **Planning** | Did it pursue prerequisites *before* dependents? (no premature attempts) |
| **Tool use** | Valid actions that respect preconditions (`1 − self-inflicted errors`). |
| **Adaptation** | After a self-caused failure, does the next action *change*? (not looping) |
| **Robustness** | Recovery after an *external* disturbance (e.g. another bot grabs your resource). |
| **Efficiency** | Productive-action ratio — **not** duration, **not** raw step count. |

> Errors are treated as **diagnostics, not blunt penalties.** A failed tool call might be
> exploration, or the world changing under the agent — so MineBench only ever penalises *looping*
> (repeating an action that changed nothing), never honest, isolated failures.

---

## 🏗️ How it works

```
                                    ┌─────────────────────────────┐
   Minecraft world  ──observation──▶│  AGENT (swappable LLM)      │
        ▲                           │  brain · skills · models    │
        │                           └──────────────┬──────────────┘
        │                                          │ one tool call / step
        │                                          ▼
   ┌────┴───────────┐   execute    ┌─────────────────────────────┐
   │  HARNESS       │◀─────────────│  TOOL: mine / craft / move / │
   │  runner · env  │   + verify   │        smelt / look_around…  │
   └────┬───────────┘              └─────────────────────────────┘
        │ trace
        ▼
   ┌────────────────┐    score     ┌─────────────────────────────┐
   │  SCORING       │─────────────▶│  DASHBOARD (live + history)  │
   │  scorer · DAG  │   profile    │  leaderboard · matrix · trace│
   └────────────────┘              └─────────────────────────────┘
```

The loop, every step: **`buildObservation → agent.act → executeAction → record → checkSuccess`.**
The agent perceives the world only through a structured JSON observation (position, inventory,
surroundings, a coordinate radar of nearby resources) — never raw pixels — and acts only through
tool calls. The harness owns success detection; the scorer turns the trace into a capability
profile; the dashboard renders it.

### Project layout
```
agent/        The decision-maker
  brain.js        System prompt + conversation loop (turns an observation into one action)
  skills.js       In-world tools (mine, craft, smelt, place, look_around, read_data…) + navigation
  observation.js  Turns the live world into the structured state the model perceives
  models/         Swappable model adapters (Azure OpenAI + GitHub Copilot)
harness/      The runner: applies a task's setup, drives the loop, detects success from world state
scoring/      The judge: milestone DAG → six-dimension capability profile (deterministic)
dashboard/    Live + historical web UI (leaderboard, task×model matrix, step-by-step replay)
tasks/        Benchmark tasks as JSON (goal, setup, success spec, milestone graph)
```

### Tasks are declarative JSON
A task owns its goal, world setup, a verifiable success spec, and a **milestone dependency graph**
(a DAG, so any valid solution path scores fairly via backward entailment). Adding a benchmark is a
data change, not a code change:

```jsonc
{
  "id": "stone_pickaxe",
  "goal": "Make a stone_pickaxe from scratch.",
  "difficulty": 3,
  "max_steps": 60,
  "success": { "inventory": { "stone_pickaxe": 1 } },
  "milestones": [ /* wood → planks → sticks → table → wooden pickaxe → cobblestone → stone pickaxe */ ]
}
```

---

## 🚀 Quick start

> **Prerequisites:** Node.js, a Java Minecraft server jar (auto-managed), and model credentials —
> `AZURE_OPENAI_*` in `.env` for Azure deployments, or `COPILOT_TOKEN` for Copilot models.

### Launch the dashboard (recommended)
The dashboard auto-starts the Minecraft server, lets you pick a task + model, and streams the run
live. No manual server setup, no `/op` by hand.

```bash
npm install
npm run dashboard          # → http://localhost:8099, click Start
```

### Or run from the CLI
```bash
# Single run (server auto-starts; world is reused next time)
npm run bench -- --task stone_pickaxe --model copilot/gpt-5.4 --verbose

# Free-form ad-hoc goal (no auto-scoring)
npm run bench -- --goal "Mine 3 oak_log" --model gpt-4o

# Head-to-head: two models, isolated same-seed worlds
npm run bench -- --task stone_pickaxe --model-a copilot/gpt-5.4 --model-b copilot/claude-opus-4.8
```

### Run the tests
```bash
npm test                   # deterministic scorer self-tests (no network, no live bot)
```

📖 Full command reference and flags: [`commands.md`](commands.md) · Architecture deep-dive:
[`context.md`](context.md).

---

## 🎮 The benchmark suite

Tasks span a difficulty ramp from a one-resource smoke test to a deep, multi-stage tech tree —
each chosen to stress a different agentic muscle.

| Difficulty | Task | Tests |
|:---:|---|---|
| 1 | `gather_wood` | Navigation + find/mine a single resource (smoke test) |
| 1 | `obtain_beef` / `obtain_chicken` / `obtain_mutton` | Mob perception + combat |
| 2 | `kill_bot_a` / `kill_bot_b` | PvP duel (scored from the server's real death packet) |
| 3 | `make_bed` | Multi-resource gathering + crafting |
| 3 | `stone_pickaxe` | Long-horizon tool-tier reasoning + crafting dependencies |
| 5 | `iron_pickaxe` | Very long-horizon: mining, furnace, smelting, multi-stage crafting |
| 6 | `gold_ingot` | Deep tech-tree resource pipeline |

Every task is auto-scored against its success spec — **success is read from real world state, never
from the model's own claim.**

---

## 🛠️ Tech stack

**Node.js** · **[mineflayer](https://github.com/PrismarineJS/mineflayer)** (Minecraft bot
protocol) · **mineflayer-pathfinder** (navigation) · **minecraft-data** (recipes/loot ground
truth) · **Azure OpenAI** + **GitHub Copilot** model APIs · zero-dependency vanilla-JS dashboard.

---

## 🔭 Vision

MineBench treats Minecraft as a **proxy for general agentic capability**. The six dimensions —
planning, tool use, adaptation, robustness, efficiency, completion — are exactly the skills a model
needs to operate autonomously *anywhere*. As models improve, the tasks deepen; the measuring
instrument stays honest, deterministic, and transparent.

*Built for the hackathon. Minecraft is just the instrument — the score is the story.* 🟩
