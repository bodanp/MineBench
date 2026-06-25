# MineBench — Demo Video Script

> **Author:** Melanie Chen · branch `melanie-script`
> **Format:** ~4–5 min demo video · **Hero shot:** the live dashboard (`localhost:8099`)
> **The demo:** two different models try to **craft a gold ingot** on the *same* world with
> the *same* tools — and we read the difference in their reasoning straight off the screen.

---

## Purpose (what this video has to land)

One job: convince the viewer that we can *grade an AI's reasoning*, not just its words. The
arc is **intro → the gap in how we evaluate models → the old idea we're reviving → the demo
(gold ingot, two models, visible differences) → what it's for → impact.** Impact is the
payload — spend real time there.

> **The one sentence (memorize):** *"MineBench drops any LLM into the same Minecraft tasks,
> runs them through the same tools, and scores them — turning 'which model reasons better?'
> from an argument into a number on a live scoreboard."*

---

## 1. Intro — how we grade AI today, and what we don't (~45s)

> **[Open on leaderboards / benchmark logos: MMLU, HellaSwag, a safety scorecard.]**
> "Here's how we judge AI today. Every leaderboard you've seen grades one thing: the **text**
> a model produces. Is the answer correct? Is it safe? Is it relevant? Does it sound human?
> Those are **lexical** tests — they score the *words that come out*. And we've gotten so good
> at them that frontier models now **beat human experts** on the flagship exam, MMLU.
>
> **[Cut to a model confidently failing a simple multi-step task.]**
> But ask that same model to actually *do* something — to plan, act, and adapt in a world that
> pushes back — and it falls apart. On GAIA, a benchmark of conceptually *simple* real-world
> tasks, GPT-4 scored **15%**. Humans scored **92%**. There is **no standard** that grades a
> model's **reasoning** — its ability to plan and act inside a system with rules, state, and
> consequences. That blind spot is what **MineBench** measures."

*Key facts (paraphrase, don't read URLs aloud — see Appendix A): MMLU/HELM are static,
text-only; Gemini was first to hit human-expert MMLU; GAIA = 15% vs 92%; benchmark
contamination makes static scores unreliable; PlanBench shows LLM planning "falls quite
short."*

---

## 2. The old idea, brought back (~20s)

> **[Project Malmo screenshot → our agent in Minecraft.]**
> "This isn't a new idea — it's an old one, revived. A decade ago **Microsoft Research built
> Project Malmo on top of Minecraft** to study AI, training agents with **reinforcement
> learning** — millions of episodes and a hand-tuned reward for every task. We're bringing
> that same arena back for the **LLM era**: no training, no reward shaping — you hand the model
> the world in plain language and watch it *reason* its way through."

---

## 3. The demo — two models, one gold ingot (~2 min)

The money shot. Same task, same world, two brains — **watch them think, read the difference.**

### 3a. Set the stage (~15s)

> **[Dashboard idle at `localhost:8099`, Minecraft beside it.]**
> "The task: **craft a gold ingot.** Each model starts with raw gold, some coal, and a furnace.
> To win it has to *place the furnace, pick the right fuel, and smelt the gold* — perceive,
> plan, act, verify. Easy to say, and exactly the kind of short plan where two models quietly
> disagree."

### 3b. Model A, live (~45s)

> **[Run: `node bench.js --task gold_ingot --model copilot/gpt-5.4 --verbose`]**
> "Watch the dashboard fill in real time. Every row is one decision: a **Thought** — the
> model's reasoning, in its own words — then one **Action**, the **Result**, and a green check
> or a red X. It reads its inventory, places the furnace, picks **coal** as fuel, smelts the
> raw gold — and the harness confirms a **gold ingot**. Notice: we never *trust* the model when
> it says it's done. The **harness checks the inventory.**"

### 3c. Model B, same task — the divergence (~45s)

> **[Run: `node bench.js --task gold_ingot --model copilot/gpt-4o --verbose`]**
> "Now the *same* task, *same* tools, *same* furnace — only the **brain** changes. Read this
> Thought column against the last one. Same starting hand, different plan: watch where it
> hesitates, re-reads its inventory, or wastes a step on a fuel that won't light. **Neither
> model got better tools. Only the reasoning changed** — and the dashboard shows you exactly
> *where*, line by line."

> **[Optional head-to-head:
> `node bench.js --task gold_ingot --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o`]**
> "Run them at once — two bots, one world — and the harness prints the side-by-side and **picks
> a winner**: success first, then efficiency — fewer steps, fewer errors."

---

## 4. What it's for — reading the result (~30s)

> **[Two scorecards side by side / the history grid.]**
> "This is the point. The reasoning we just watched is now **numbers you can rank**: success,
> score, steps, tool-errors. And it settles the argument every agent team has:
>
> - High **tool_errors** → it's *our code* — the tools.
> - **Looping** with no progress → the model's planning.
> - **Coherent thought, wrong action** — that clears the moment we swap in a stronger model on
>   the *same* tools? That was the **model**, proven by A/B.
> - Both models fail **identically**? Then *we* capped them — the harness.
>
> We don't debate it. We read it off the card. **A benchmark turns a debate into a diff.**"

---

## 5. Impact — why this matters (the payload, ~75s)

### 5a. Why we're building it

> "We're building MineBench because the entire industry just pivoted from **chatbots to
> agents** — models that plan, use tools, and take multi-step actions — and our **evaluation
> didn't come with it.** We still grade agents with static, text-only tests, and the cracks
> are everywhere: on WebArena's realistic web tasks GPT-4 scores **14%** against humans' **78%**;
> on τ-bench, GPT-4o passes the *same* task reliably **less than a quarter of the time.** And a
> 2024 Princeton audit of agent benchmarks found a *'pervasive lack of reproducibility.'*
> MineBench is the missing piece: a **reproducible, interactive** test of reasoning, in a world
> with rules — and because every run starts from fresh game state, it's structurally **immune
> to the benchmark-contamination** problem that's quietly inflating today's leaderboards."

### 5b. What this means for Microsoft

> "For Microsoft, this is directly on-strategy. Microsoft Research calls it plainly: *'the
> future of AI is agentic'* — and the whole stack is being rebuilt around it: **Copilot Studio**
> autonomous agents, **AutoGen**, **Magentic-One**. **Azure AI Foundry** now puts **hundreds of
> models** in front of every developer building an agent — but there is **no agentic-reasoning
> score** to choose between them. An MMLU number tells you a model writes well; it tells you
> nothing about whether it can run a multi-step task without falling over. MineBench is exactly
> that missing yardstick — for **model selection**, and for **regression testing** every time a
> model version ships into a production Copilot agent. Microsoft even shipped *AutoGenBench*
> conceding agent evaluation is unsolved; MineBench attacks the same problem from the
> reasoning-in-a-world angle."

### 5c. What this means beyond Microsoft

> "And it's bigger than us. Agents are already going into **coding, customer service, finance,
> and robotics** — high-stakes places where unmeasured reasoning is a real risk. Deploying an
> agent whose reasoning you can't measure isn't a capabilities problem, it's a **measurement**
> problem — you can't fix what you can't see. The field's most respected voices are pointing
> the same way: Fei-Fei Li's World Labs calls spatial, world-based reasoning *'AI's next
> frontier'*; DeepMind, NVIDIA, and OpenAI are all racing toward agents that act in worlds. The
> proof Minecraft is the right arena? **NVIDIA's Voyager** — an LLM agent in Minecraft —
> unlocked the game's tech tree **15× faster** than the prior state of the art. Minecraft cleanly
> separates a *smart* model from an average one. That's the whole game: **MineBench gives the
> world a reproducible scorecard for how well an AI can actually reason — not just talk.**"

> **[Close on the leaderboard.]** "Adding a model is one flag. Adding a task is one JSON file.
> It scales to any model, any provider, any skill. That's MineBench. **Questions?**"

---

## Run-of-show (timed cheat-sheet)

| Time | Beat | Screen | You do / say |
|------|------|--------|--------------|
| 0:00 | The eval gap | Benchmark logos → a simple-task failure | §1 — lexical tests vs. reasoning; GAIA 15% vs 92%. |
| 0:45 | Old idea, revived | Malmo → our agent | §2 — Malmo + RL, now LLMs (2 sentences). |
| 1:05 | Set the stage | Dashboard idle + game | "Craft a gold ingot: place furnace, pick fuel, smelt." |
| 1:20 | **Model A live** | Dashboard + game | `--task gold_ingot --model copilot/gpt-5.4 --verbose`. |
| 2:05 | **Model B live** | Dashboard + game | Same task, `copilot/gpt-4o` — contrast the Thought column. |
| 2:50 | What it's for | Scorecards / history | The metric map — model vs. tools. |
| 3:20 | **Impact** | Slides / leaderboard | §5: why we built it · Microsoft · beyond. |
| 4:35 | Close + ask | Leaderboard | One flag / one JSON; questions. |

> If a run is slow, **keep talking over it** — narrate observe → think → act on the dashboard.
> Never wait in silence.

---

## Commands (verified)

```powershell
# 1) Server (in minebench-server) — then OP the bots in its console
java -Xms2G -Xmx2G -jar paper.jar nogui
#   server console:  op MineBenchBot   op MineBenchBotA   op MineBenchBotB

# 2) Live dashboard (in MineBench) — leave open at http://localhost:8099
npm run dashboard:live

# 3) Model A live (scored) — gold ingot
node bench.js --task gold_ingot --model copilot/gpt-5.4 --verbose

# 4) Model B live (scored) — same task, swap only the brain
node bench.js --task gold_ingot --model copilot/gpt-4o --verbose

# 5) Head-to-head race -> side-by-side + winner
node bench.js --task gold_ingot --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o

# 6) Azure fallback (no COPILOT_TOKEN): omit --model for the default deployment
node bench.js --task gold_ingot
```

> `copilot/<model>` needs `COPILOT_TOKEN` in `.env`; a bare `--model <name>` uses the Azure
> deployment from `AZURE_OPENAI_*`. Swap the two model names for whichever pair shows the
> clearest reasoning gap on the day.

---

## Pre-flight (T-30, don't skip)

- [ ] Server up; bots **OP'd** (`op MineBenchBot` / `…BotA` / `…BotB`) or task setup is silently ignored.
- [ ] `spigot.yml` anti-cheat loosened (`moved-too-quickly-multiplier: 100.0`) so the bot isn't kicked mid-place.
- [ ] `difficulty=peaceful` so nothing kills the bot on camera.
- [ ] `COPILOT_TOKEN` in `.env` (or fall back to Azure — command 6).
- [ ] Dashboard open at `localhost:8099` ("waiting for a run…").
- [ ] **Warm run:** run the gold-ingot commands once ~30 min before — saved `results/*.json` populate the dashboard history and double as your fallback.
- [ ] Terminal font ≥ 18pt so the `--verbose` Thought/Action lines are readable on video.

## Fallbacks

- **`copilot/*` won't auth:** run on Azure (command 6); for A/B use two Azure deployments via `--model-a/--model-b`.
- **Network/LLM down:** open the static dashboard (`npm run dashboard` → `dashboard/index.html`) and walk the warm-run scorecards. Say plainly: *"captured 20 minutes ago — same command you'd run now."*
- **Bot gets stuck on camera:** that's *content* — "watch the failed steps and tool_errors climb; a weaker model does this more. It's a measurable signal, not a vibe." Then cut to a warm run.
- **Golden rule:** never debug live. If anything hangs >10s, narrate the fallback and move on.

## Q&A prep

- **"Isn't this just Voyager / MineDojo / Malmo?"** Those are *agents/environments*. We're a **benchmark**: deterministic setup + automatic scoring + model-vs-model comparison. The agent is the *thing under test*, not the deliverable.
- **"Reproducible, in *Minecraft*?"** Each task pins gamerules, time, weather, spawn, and starting inventory (`harness/env.js`). Success is a declarative inventory check (`scoring/scorer.js`), never the model's self-report — and fresh state per run makes it contamination-resistant.
- **"What if your tools are just bad?"** Then *every* model fails identically and the card says so — that's a finding. The A/B isolates tools from brain.
- **"How fast to add a model or task?"** A model is one flag (`--model copilot/<x>`); a task is one JSON file in `tasks/`. That swappability is the whole point.

---

## Appendix A — Sources / fact-check (for the claims in §1 and §5)

Spoken claims are paraphrased; verify against these before publishing the video.

| Claim in script | Source |
|---|---|
| Mainstream evals are static, text-only (MMLU, HELM scenarios/metrics) | HELM, Liang et al. 2022 — https://arxiv.org/abs/2211.09110 · HELM blog — https://crfm.stanford.edu/2022/11/17/helm.html |
| Frontier model first to reach human-expert MMLU | Gemini Technical Report, 2023 — https://arxiv.org/abs/2312.11805 |
| GAIA: GPT-4 ≈15% vs humans ≈92% on simple real-world tasks | GAIA, Mialon et al. 2023 — https://arxiv.org/abs/2311.12983 |
| Benchmark contamination/leakage inflates scores | Zhou et al. 2023 — https://arxiv.org/abs/2311.01964 |
| LLM planning "falls quite short" even at SOTA | PlanBench, Valmeekam/Kambhampati — https://arxiv.org/abs/2206.10498 |
| "The future of AI is agentic" | Microsoft Research, Magentic-One, 2024 — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ |
| WebArena: GPT-4 ≈14.41% vs humans ≈78.24% | WebArena, Zhou et al. 2023 — https://arxiv.org/abs/2307.13854 |
| τ-bench: GPT-4o reliable pass⁸ <25%; agents follow rules unreliably | τ-bench, Yao et al. 2024 — https://arxiv.org/abs/2406.12045 |
| "Pervasive lack of reproducibility" in agent benchmarks | AI Agents That Matter, Kapoor et al. 2024 — https://arxiv.org/abs/2407.01502 |
| AutoGen strategic importance (Doug Burger quote) | Microsoft Research AutoGen blog — https://www.microsoft.com/en-us/research/blog/autogen-enabling-next-generation-large-language-model-applications/ |
| Azure AI Foundry = large model catalog + Agent Service (model-selection problem) | Azure AI Foundry — https://azure.microsoft.com/en-us/products/ai-foundry |
| Agents in production across industries | Anthropic, "Building Effective Agents," 2024 — https://www.anthropic.com/engineering/building-effective-agents |
| "Spatial intelligence is AI's next frontier" (world models) | World Labs / Fei-Fei Li, 2025 — https://www.worldlabs.ai/blog |
| Project Malmo = Minecraft + (deep) RL research platform (2016) | Microsoft Research — https://www.microsoft.com/en-us/research/project/project-malmo/ |
| Voyager (LLM in Minecraft) unlocks tech tree ~15.3× faster than SOTA | Voyager, Wang/Anandkumar 2023 — https://arxiv.org/abs/2305.16291 |
| MineDojo: Minecraft as embodied-agent research platform (NeurIPS 2022) | MineDojo, Fan et al. 2022 — https://arxiv.org/abs/2206.08853 |

> Caveats to keep honest on camera: SWE-bench/agent SOTA moves fast (some numbers above are
> from 2023–24 and have since improved on *verified* subsets); cite figures as "at time of
> publication." Malmo's original paper is Johnson et al., IJCAI 2016. EU AI Act / NIST AI RMF
> framing (evaluating autonomous systems before deployment) is real but should be attributed to
> the official documents if used.
