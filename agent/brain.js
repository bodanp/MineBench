// ─────────────────────────────────────────────
// BRAIN — the decision policy. Owns the conversation, the system prompt, and turns an
// observation into the next action by calling the (swappable) model.
//
// OWNER: Agent: Brain & Models (Role 4)
//
// Public API:
//   createAgent({ model, goal, toolSchemas }) -> {
//     start(),
//     act(observation, nudge?) -> { thought, tool, args, toolCallId } | { thought, done, reason },
//     recordResult(toolCallId, result)
//   }
//
// Contract: one action per step (we take the first tool_call). The harness executes it
// and feeds the result back via recordResult before the next act().
// ─────────────────────────────────────────────

function buildSystemPrompt(goal) {
  return `You are an AI agent playing Minecraft, controlled entirely through tool calls.

Your goal: ${goal}

Available tools:
- read_data(item): look up the raw game data for an item/block — returns ALL its crafting recipes (ingredient names + amounts, and whether each needs a crafting_table) and, for blocks, what they drop and which tools yield a drop. It gives you FACTS, not steps; you decide what to do with them.
- look_around(): scan nearby blocks and entities
- move_to(x, y, z): pathfind to a coordinate (handles most obstacles automatically)
- move_forward(seconds): walk forward while auto-jumping; use to hop a 1-block step or get unstuck
- mine_block(block_type): walk to and mine the nearest matching block (e.g. "oak_log", "stone")
- place_block(block_type, dx, dy, dz): place a block at an offset from you; use (0,0,0) to pillar up (climb by placing a block beneath yourself)
- craft(item, count): craft an item; some recipes require a crafting_table placed within ~8 blocks
- smelt(input, fuel, count): smelt items in the nearest furnace using the fuel you name; waits, collects the output, and reports what actually came out
- equip(item): hold an item (equip a pickaxe before mining stone/ore)
- turn(direction), jump(), chat(message)
- stop(): call ONLY when the goal is fully complete or you are truly stuck

Each observation is your senses — READ it before acting:
- "position" + "facing": where you are and which way you're looking.
- "surroundings": the blocks right next to you — "block_in_front", "can_step_up", "blocked" (a 2-tall wall), "standing_on", "above_head", "drop_ahead".
- "nearby": the nearest resources/hazards with coordinates ("at"), "dist", "dir", and "exposed" — e.g. the closest tree, ore, your crafting_table, water/lava. "exposed": true means the block touches air, so you can path and mine straight to its "at" coords; "exposed": false means it is buried inside rock — do NOT move_to it, dig down/into the terrain toward it instead. Use these coordinates with move_to / mine_block instead of wandering blindly.
- "inventory": what you have — track progress and prerequisites here.

Rules:
- When you are unsure of a recipe or what a block needs/drops, call read_data(item) to get the facts, then reason it out YOURSELF: look at the recipes, pick one whose ingredients you can actually obtain, and work backwards (what does the goal need -> what do those need -> ... -> something you can mine by hand). Decide only the SINGLE next action each step.
- Only tool calls change the world. Your thoughts and chat() do NOT mine, craft, move, or pick anything up — narrating "I am mining the tree" does nothing unless you actually call mine_block. Never say or assume an action happened that you did not call.
- After every action, read the tool result and your new "inventory": if the item/effect you expected is not there, the action FAILED — do not pretend it worked or move on. Diagnose and try a different approach.
- Take ONE action at a time, then read the new observation before choosing the next.
- If "nearby" lists what you need with "exposed": true, go to its "at" coordinates. If that entry is "exposed": false (buried) or NOT listed, do not path straight to it — explore or dig toward it (move_to an open point ~15 blocks away, or dig down) and re-check "nearby" until an exposed one appears.
- Respect crafting dependencies: logs -> planks -> sticks; place a crafting_table to make a wooden_pickaxe; mine cobblestone with a pickaxe to make a stone_pickaxe.
- If a tool call returns an error, read it and try a different approach instead of repeating the same call.
- If "surroundings.blocked" is true (a 2-tall wall) or your position barely changes between steps, mine_block the block in front or move_to around it. If "surroundings.can_step_up" is true, use move_forward to hop it. Do not keep repeating the same failing move_to.
- Entities and players are NOT resources or destinations. Never navigate toward a player or your own past position — only travel to block coordinates (from "nearby") or to genuinely new, unexplored areas.
- Never call the same tool with the same arguments twice in a row. If an action did not change your position or inventory, it FAILED — switch strategy (mine the blocking block, or explore a different direction) rather than repeating it.
- Do not claim success early. Call stop() only when the goal item/condition is actually present in your inventory or state.
- EVERY tool call includes a "thought" argument: fill it with one short sentence explaining WHY you are taking this action right now (your reasoning). Never leave it blank.`
}

// Reasoning models (e.g. gpt-5.x) usually return an EMPTY `content` when they emit a tool
// call — their rationale lives in a separate reasoning field instead. Coalesce the known
// shapes into a single readable string so the trace captures the thought when it's exposed
// (best-effort: some models hide reasoning entirely, leaving this empty).
function extractThought(msg) {
  if (!msg) return ''
  const flatten = (r) => {
    if (!r) return ''
    if (typeof r === 'string') return r
    if (Array.isArray(r)) return r.map(flatten).filter(Boolean).join('\n')
    if (typeof r === 'object') return flatten(r.summary ?? r.text ?? r.content ?? '')
    return ''
  }
  const thought = msg.content || msg.reasoning_content || flatten(msg.reasoning)
  return (typeof thought === 'string' ? thought : flatten(thought)).trim()
}

// gpt-5.x (and other reasoning models) return NO `content` and NO readable reasoning when
// they emit a tool call — the chain-of-thought is encrypted server-side and never surfaced
// (confirmed for Copilot gpt-5.4 via both chat-completions and the Responses API summary).
// So the only model-agnostic way to capture a rationale is to ASK the model to state one as
// a tool-call argument. We inject a `thought` string into every tool's schema; the model
// fills it in, and we read it back deterministically — works for every model, reasoning or not.
function addThoughtParam(toolSchemas) {
  return (toolSchemas || []).map(t => {
    if (t.type !== 'function' || !t.function) return t
    const params = t.function.parameters || { type: 'object', properties: {} }
    // `thought` first so the model articulates intent BEFORE choosing the action's args.
    const properties = {
      thought: { type: 'string', description: 'One short sentence: WHY you are taking this action right now (your reasoning). Always fill this in.' },
      ...(params.properties || {})
    }
    const required = Array.from(new Set([...(params.required || []), 'thought']))
    return { ...t, function: { ...t.function, parameters: { ...params, type: params.type || 'object', properties, required } } }
  })
}

function createAgent({ model, goal, toolSchemas }) {
  let messages = []
  let pendingToolCalls = []   // tool_calls from the latest assistant msg still awaiting a tool reply
  const tools = addThoughtParam(toolSchemas)   // every tool gains a `thought` arg we read back
  return {
    model: model.name,

    start() {
      messages = [{ role: 'system', content: buildSystemPrompt(goal) }]
      pendingToolCalls = []
    },

    async act(observation, nudge = '') {
      messages.push({
        role: 'user',
        content: `Current state:\n${JSON.stringify(observation)}${nudge}\nWhat do you do next?`
      })
      const msg = await model.complete({ messages, tools })
      messages.push(msg)
      // The model may emit several tool_calls in one turn; we execute only the first, but
      // the API REQUIRES a tool reply for EVERY id — track them all so recordResult can
      // close out the rest (otherwise the next request 400s on the unanswered ids).
      pendingToolCalls = (msg.tool_calls || []).slice()

      // Some models (notably Claude) occasionally narrate a turn as plain prose without
      // calling a tool, intending to act next. Don't end the episode on that — nudge once
      // for an explicit action. stop() is itself a tool, so completion still flows through it.
      let lastMsg = msg
      if (!pendingToolCalls.length) {
        messages.push({
          role: 'user',
          content: 'You did not call a tool. Respond with exactly ONE tool call. Call stop() only if the goal is fully complete.'
        })
        lastMsg = await model.complete({ messages, tools })
        messages.push(lastMsg)
        pendingToolCalls = (lastMsg.tool_calls || []).slice()
      }

      const call = pendingToolCalls[0]
      if (!call) return { thought: extractThought(lastMsg), done: true, reason: 'no_tool_call' }

      let args = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
      // The model writes its rationale into the injected `thought` arg. Pull it out for the
      // trace/logs, then strip it so the tool impl only sees its real parameters. Fall back
      // to any message content/reasoning for models that DO expose it.
      const argThought = typeof args.thought === 'string' ? args.thought.trim() : ''
      if ('thought' in args) delete args.thought
      const thought = argThought || extractThought(lastMsg)
      return { thought, toolCallId: call.id, tool: call.function.name, args }
    },

    recordResult(toolCallId, result) {
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: String(result) })
      // Close out any sibling tool_calls from the same turn we chose not to run, so every
      // tool_call_id has a response and the next request stays valid.
      for (const c of pendingToolCalls) {
        if (c.id && c.id !== toolCallId) {
          messages.push({ role: 'tool', tool_call_id: c.id, content: 'Skipped: only one action is executed per step.' })
        }
      }
      pendingToolCalls = []
    }
  }
}

module.exports = { createAgent, buildSystemPrompt, extractThought, addThoughtParam }
