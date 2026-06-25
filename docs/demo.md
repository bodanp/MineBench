# MineBench — Demo Script & Run-of-Show

> Owner: Role 6 (Dashboard & Demo). Companion to `docs/team-plan.md` and `context.md`.
> Built against the **current** repo (`bench.js` + harness + scoring + live dashboard).
> Target: **4–5 min live + 1 min Q&A**. Designed to survive a flaky network and a flaky
> agent, because both will happen on stage.

---

## 0. The one sentence (memorize this)

> **"MineBench is a reproducible benchmark that drops any LLM into the same Minecraft
> tasks, runs them through identical tools, and scores them — so 'is it the model or is
> it our code?' stops being an argument and becomes a number on a live scoreboard."**

The **live dashboard** is the star of this demo. Lead with it, end with it.

---

## 1. The thesis (why anyone should care)

Everyone is shipping "agents." Almost nobody can answer **"is this agent good, and
compared to what?"** When one fails, two people argue forever: *"the model is dumb"* vs
*"our tools are broken."* You don't settle that by rewriting — you settle it by
**measuring under controlled conditions**. That's what a benchmark is, and that's what we
built. Minecraft is the arena: a real tech tree (wood → planks → pickaxe → stone → iron)
that forces **planning, perception, and tool use** — exactly what agents claim to do.

---

## 2. What we built (be accurate on stage)

A full benchmark harness, not a prototype. End-to-end flow in `bench.js`:
`load task → resolve model → runner.run() → scorer.score() → store.saveResult()`.

| Piece | File(s) | What it does |
|---|---|---|
| CLI | `bench.js` | `--task` / `--model` / `--goal` / `--verbose`, plus **dual mode** `--model-a/--model-b` |
| Agent | `agent/brain.js`, `observation.js`, `skills.js`, `models/*` | perceive → think → one tool call; **swappable models** (Azure + GitHub Copilot) |
| Harness | `harness/runner.js`, `env.js` | the step loop + Trace; applies `task.setup` for determinism; **harness checks success, not the model** |
| Scoring | `scoring/scorer.js`, `store.js` | Scorecard + saved `results/*.json` + side-by-side comparison + winner |
| Tasks | `tasks/*.json` | the suite as data: `gather_wood` (1) → `stone_pickaxe` (3) → `iron_pickaxe` (5) |
| **Dashboard** | `dashboard/live-server.js`, `live.js`, `app.js` | **live** view of the running agent — **two agents side-by-side in one world** with a live winner — + historical leaderboard |

---

## 3. The story arc (three acts)

1. **Problem (30s):** agents are everywhere, comparable evaluation isn't.
2. **Demo (3 min):** one model runs a task **live on the dashboard** → then **two models
   run the same task in the same world**, rendered **side-by-side on the dashboard**, and one
   wins on the scorecard. The money shot.
3. **Payoff (45s):** the scorecard answers "model vs. tools," and history becomes a
   leaderboard across tasks × models.

---

## 4. Run-of-show (timed)

| Time | Beat | Screen | You do / say |
|------|------|--------|--------------|
| 0:00 | Hook | Slide 1 | Say the one sentence (§0). |
| 0:30 | Problem | Slide 2 | "Everyone ships agents; nobody can score them." |
| 1:00 | The board | Browser → **localhost:8099** + Minecraft view | "Same world, same tools, same task. Only the model changes. Watch the agent think in real time." |
| 1:20 | **Live run** | Dashboard + game | `node bench.js --task stone_pickaxe --model copilot/gpt-4o --verbose` — narrate the loop as steps stream in. |
| 2:40 | Scorecard | Dashboard scorecard panel | Point at success / score / steps / tool_errors. |
| 3:00 | **Compare** | Dashboard — two live panels (A vs B) | `node bench.js --task gather_wood --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o` → both agents in **one world, side-by-side** on the dashboard → live winner banner. |
| 4:00 | Metric map | Slide 4 | "That's how we answer model-vs-tools." (§8) |
| 4:30 | Leaderboard | Dashboard history grid | "Scale it to tasks × models." |
| 4:45 | Scope | Slide 6 | In/out of scope; invite questions. |

> If a live run is slow, **keep talking over it** — narrate observation → thought → action
> on the dashboard. Never wait in silence. Pre-warmed runs (see §6) keep this on rails.

---

## 5. The spoken script (with stage directions)

Stage directions in **[brackets]**. Speak the rest. ~600 words ≈ 4 min at demo pace.

> **[Slide 1]** "Everyone here has built or used an AI agent this month. Now — *which one
> is better, and how do you know?* Nobody can actually answer that. **MineBench answers
> it.** It drops any LLM into the same Minecraft tasks, runs them through the exact same
> tools, and scores them — so *'is it the model or is it our code?'* stops being an
> argument and becomes a number."
>
> **[Slide 2]** "Minecraft is perfect: it has a real tech tree — wood, planks, a pickaxe,
> stone, iron — so the agent has to **plan, look around, and use tools**. And we pin the
> world down so every model gets the *exact same* test."
>
> **[Open the browser on localhost:8099, Minecraft beside it.]** "This is our live
> dashboard. Right now it's idle. I'll start a benchmark and you'll watch the agent think,
> step by step, in real time — same screen the judges see."
>
> **[Run: `node bench.js --task stone_pickaxe --model copilot/gpt-4o --verbose`]**
> "The task: make a stone pickaxe from scratch. Every step the agent gets an
> **observation** — position, what's blocking it, the nearest tree or ore with
> coordinates, its inventory. It states a **thought** and picks **one tool call** — mine,
> craft, move. Watch the table fill: thought, action, result, and a green check or red X."
>
> **[Point at the dashboard as steps stream.]** "There — it found a tree, mined logs,
> crafted planks, sticks, placed a crafting table, made a wooden pickaxe, and now it's
> mining stone for cobblestone. And crucially: we don't trust the model when it *says* it
> finished — the **harness** checks the inventory."
>
> **[When the scorecard panel fills.]** "Done. Here's the scorecard: success, a score,
> steps taken, duration, and the error counts. Hold that thought."
>
> **[Run: `node bench.js --task gather_wood --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o`]**
> "Now the real point of a benchmark — comparison. **Same task, same tools, two models, one
> world.** The dashboard splits into **two live panels, A and B**, side by side. Watch which
> one finds and mines wood efficiently and which one wanders."
>
> **[Narrate the divergence; when both finish, the winner banner appears on the dashboard.]**
> "And the harness picks a winner — right there on the board: success first, then efficiency,
> fewer steps and fewer errors. Same world, neither got better *tools*; only the brain changed."
>
> **[Slide 4 — the metric map.]** "This is the answer to the eternal argument. High
> **tool_errors** → that's *our* code, the skills. **Repeated actions** with no progress →
> looping. But **coherent reasoning, wrong action**, and it clears the moment we swap in a
> stronger model on the *same* tools? — that was the **model**. We don't argue. We read it
> off the card."
>
> **[Dashboard history grid.]** "Every run is saved, so this becomes a leaderboard: task by
> model, success plus score. That's MineBench — a comparable scorecard for agentic AI in a
> world that actually tests planning and tool use."
>
> **[Slide 6.]** "We ship deterministic tasks on a difficulty ramp, automatic success
> detection, model-vs-model comparison from one command, and a live dashboard. Out of
> scope on purpose: no training, no diamond-luck tasks, no custom mods. Questions?"

---

## 6. Pre-flight checklist (T-30 min — don't skip)

**Minecraft server (folder: `minebench-server`)**
- [ ] Start it: `java -Xms2G -Xmx2G -jar paper.jar nogui` (leave the window open).
- [ ] Wait for `Done (… )!`, then in the **server console OP the bots** (required — the
      harness applies task setup via commands and they're silently ignored without OP):
      `op MineBenchBot` · `op MineBenchBotA` · `op MineBenchBotB`
- [ ] Anti-cheat already loosened (done): `spigot.yml` →
      `moved-too-quickly-multiplier: 100.0`, `moved-wrongly-threshold: 5.0`.
      *(Defaults kick the bot mid-pathfind.)*
- [ ] `difficulty=peaceful` (already set) so no mobs kill the bot on camera.

**Agent (folder: `MineBench`)**
- [ ] `npm install` (deps unchanged; `node_modules` present).
- [ ] **Models:** the `copilot/<model>` examples need **`COPILOT_TOKEN` in `.env`** — it is
      **not set yet**. Either add it, or use an Azure deployment (`AZURE_OPENAI_*` is
      configured; pass a bare `--model <deployment>` or omit `--model` for the default).
- [ ] Start the live dashboard: `npm run dashboard:live` → open **http://localhost:8099**.
      Confirm it loads (it shows "waiting for a run…").
- [ ] **Warm runs (critical):** run each command once for real ~30 min before. The saved
      `results/*.json` populate the dashboard **history**, which doubles as your fallback.

**Stage setup**
- [ ] Browser (dashboard) + Minecraft client (spectator account following the bots) +
      terminal all visible. Dashboard on the projector is the hero view.
- [ ] Terminal font ≥ 18pt for the `--verbose` thought/action lines.

---

## 7. Fallback plans (assume something breaks)

**Plan A — everything works:** live single run, then live dual-mode compare. As scripted.

**Plan B — `copilot/*` won't auth / no `COPILOT_TOKEN`:** run on **Azure** instead. Solo:
`node bench.js --task stone_pickaxe` (default deployment). For a compare, use two Azure
deployments on the same endpoint via `--model-a <depA> --model-b <depB>` (bare names swap the
Azure deployment).

**Plan C — network/LLM down or too slow:** open the **static dashboard** built from your
warm runs — `npm run dashboard` then open `dashboard/index.html` — and walk the saved
scorecards + comparison. Say plainly: *"These are runs we captured 20 minutes ago — same
command you'd run now."* A prepared fallback reads as competence.

**Plan D — the bot gets stuck on camera:** that's *content*. Navigation is our known hard
part (pathfinder occasionally traps the agent). Point at it: *"This is exactly what the
benchmark surfaces — watch the failed steps and `tool_errors` climb. A weaker model does
this more; it's a measurable signal, not a vibe."* Then cut to a warm run in history.

**Golden rule:** never debug live. If anything hangs >10s, narrate the fallback and move on.

---

## 8. "Is it the model or the tools?" — the metric map (your killer slide)

Memorize this; it's the intellectual core. Scorecard fields:
`success, score, steps, duration_s, tool_calls, tool_errors, repeated_actions, ended_reason`.

| Symptom in the scorecard | What it means | Whose area |
|---|---|---|
| High `tool_errors` | skills fail / bad args | **Tools** (Role 3) |
| Many failed nav steps, agent traps itself | navigation/pathfinder | **Movement** (Role 3) |
| High `repeated_actions` | looping, no progress | model planning |
| Coherent `thought`, wrong `action` (`--verbose`) | reasoning gap | **Model** (Role 4) |
| Strong model passes, weak fails — **same tools** | it was the brain | **Model** — proven by A/B |
| Both models fail **identically** | the harness/tools cap performance | **Tools/harness** |

> Punchline: *"A benchmark turns a debate into a diff. Swap the model, hold the tools
> fixed — the scorecard tells you which one to blame."*

Scoring (from `scoring/scorer.js`): **success is primary**; ties broken by efficiency —
`score = success ? clamp(1 − 0.3·steps/max − 0.1·errnorm − 0.1·repeatnorm) : 0`.

---

## 9. Slide outline (6 slides — keep them sparse)

1. **Title** — "MineBench: a reproducible benchmark for agentic AI" + the one-liner.
2. **Problem** — "Everyone ships agents. Nobody can score them."
3. **How it works** — the loop: *observe → think → one tool call → result*, same for every model; harness checks success.
4. **The metric map** — the table from §8. The "smart" slide.
5. **Leaderboard** — a screenshot of the dashboard history grid (task × model → success + score).
6. **Scope & ask** — in: tasks ramp, auto success, model A/B, live dashboard. Out: training, mods, luck/long-horizon. "Questions?"

The dashboard + game **is** the demo; slides are scaffolding. ≤ 10 words per bullet.

---

## 10. Q&A prep

- **"Isn't this just Voyager / MineDojo?"** — Those are agents/environments. We're a
  **benchmark/harness**: deterministic setup + automatic scoring + model-vs-model
  comparison. The agent is the *thing under test*, not the deliverable.
- **"How is it reproducible if Minecraft is random?"** — Each task pins gamerules, time,
  weather, spawn, and inventory via `harness/env.js`. Success is a declarative inventory
  check (`scoring/scorer.js`), not the model's self-report.
- **"What if your tools are just bad?"** — Then *every* model fails identically and the
  card says so — that's a finding. The model A/B isolates tools from brain.
- **"What's the hardest part?"** — Navigation reliability; pathfinder occasionally traps
  the agent. That failure mode is itself measured, not hidden.
- **"How fast to add a model?"** — One flag: `--model copilot/<x>` (needs `COPILOT_TOKEN`)
  or an Azure deployment name. That swappability is the whole point.

---

## Appendix A — Task suite (pick 2 to show)

| Task | Goal | Diff | max_steps | Why show it |
|---|---|---|---|---|
| `gather_wood` | Mine ≥ 3 oak_log | 1 | 40 | Fast, reliable. The **dual-mode compare** task — both finish, winner on efficiency. |
| `stone_pickaxe` | Make a stone_pickaxe from scratch | 3 | 60 | The **solo live run** — multi-step tech tree, great narration. |
| `iron_pickaxe` | Make an iron_pickaxe from scratch | 5 | 120 | Stretch / "future work" mention. Too long to run live. |

**Recommended:** solo live = `stone_pickaxe`; head-to-head = `gather_wood` (short, finishes
on camera, clear winner).

## Appendix B — Command cheat-sheet (verified)

```powershell
# 1) Server (in minebench-server) — then OP the bots in its console
java -Xms2G -Xmx2G -jar paper.jar nogui
#   server console:  op MineBenchBot   op MineBenchBotA   op MineBenchBotB

# 2) Live dashboard (in MineBench) — leave open at http://localhost:8099
npm run dashboard:live

# 3) Solo live run (scored)
node bench.js --task stone_pickaxe --model copilot/gpt-4o --verbose

# 4) Head-to-head, same task, two models in one world -> two live dashboard panels + winner
node bench.js --task gather_wood --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o

# 5) Azure fallback (no COPILOT_TOKEN): omit --model for the default deployment
node bench.js --task stone_pickaxe

# 6) Static dashboard from saved results (fallback view)
npm run dashboard   # then open dashboard/index.html
```

> Models: `copilot/<model>` needs `COPILOT_TOKEN` in `.env`; a bare `--model <name>` uses the
> Azure deployment from `AZURE_OPENAI_*`. `--goal "..."` runs an ad-hoc goal with **no**
> automatic scoring.
