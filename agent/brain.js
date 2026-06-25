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
- look_around(radius): actively scan the area for blocks and entities you cannot see in your current observation. "radius" is how far out (in blocks) to scan and defaults to 8. It returns "nearby_blocks" (a count of each block type — how abundant each is) AND "block_coords" (up to the 3 NEAREST [x,y,z] coordinates per block type, sorted closest-first). Every coordinate in "block_coords" is guaranteed to be that exact block type — so once you spot the block/ore you wanted, take the FIRST (closest) coordinate from its list and act on it: move_to(x,y,z) to walk there, or mine_block(block_type, x, y, z) to mine that exact block. Do not just store the coords and ignore them — pick the closest instance and pass its coordinates into your next move/mine. This is your "search" move — call it deliberately whenever you are stuck, lost, or hunting for a block/ore that is not already in "nearby". It also returns "entities" (nearby mobs by type/distance) and "players" (other players with their "username" and live "at" coordinates) — use "players" to relocate a kill target that has wandered out of your observation. If a scan does NOT turn up what you need, call it again with a LARGER radius (e.g. 16, then 24, then 32) to widen your search — it is up to you to expand the radius until you find it or have clearly searched far enough.
- move_to(x, y, z): pathfind to a coordinate (handles most obstacles automatically)
- move_forward(seconds): walk forward while auto-jumping; use to hop a 1-block step or get unstuck
- mine_block(block_type): walk to and mine the nearest matching block of the given type. For common, plentiful blocks, prefer this plain form — it auto-picks the nearest REACHABLE one. You may also pass exact coordinates — mine_block(block_type, x, y, z) — to mine a SPECIFIC block you located via look_around's "block_coords" (e.g. a particular ore). If that exact coordinate can't be reached, it automatically falls back to mining the nearest matching block, so prefer coords only when you genuinely need that one instance.
- place_block(block_type, dx, dy, dz): place a block at an offset from you; use (0,0,0) to pillar up (climb by placing a block beneath yourself)
- craft(item, count): craft an item; some recipes require a crafting_table placed within ~8 blocks
- smelt(input, fuel, count): smelt items in the nearest furnace using the fuel you name; waits, collects the output, and reports what actually came out
- equip(item): hold an item (equip a pickaxe before mining stone/ore)
- attack_entity(entity_type): walk to the nearest mob of that type and kill it to get its drops. Check look_around's "entities" to see what's nearby. Swings with whatever you have equipped and collects the drops; reports the items you actually gained. Use this whenever your goal needs something a mob drops, or to clear a hostile mob in your way.
- attack_player(username): walk to another player with that exact username and kill them, using the same combat as attack_entity. Find their live coordinates in your observation's "nearby_players" (or look_around's "players") — move_to those coords first if they're far, then attack_player(username). Never attack the human or yourself.
- turn(direction), jump(), chat(message)
- stop(): end the task. Call ONLY when the goal is fully complete. KEEP FUCKING TRYING. NEVER BACK DOWN NEVER GIVE UP.

Each observation is your senses — READ it before acting:
- "position" + "facing": where you are and which way you're looking.
- "surroundings": the blocks right next to you — "block_in_front", "can_step_up", "blocked" (a 2-tall wall), "standing_on", "above_head", "drop_ahead".
- "nearby": the nearest resources/hazards with coordinates ("at"), "dist", "dir", and "exposed" — e.g. the closest tree, ore, your crafting_table, water/lava. "exposed": true means the block touches air, so you can path and mine straight to its "at" coords; "exposed": false means it is buried inside rock — do NOT move_to it, dig down/into the terrain toward it instead. Use these coordinates with move_to / mine_block instead of wandering blindly.
- "inventory": what you have — track progress and prerequisites here.
- "nearby_players": other players currently visible, each with "username", live "at" coordinates, "dist", and "dir". This updates every step, so use it to TRACK a moving target — when your goal is to kill a named player, read their latest "at" here, move_to it to close distance, then attack_player(username).

Rules:
- When you are unsure of a recipe or what a block needs/drops, call read_data(item) to get the facts, then reason it out YOURSELF: look at the recipes, pick one whose ingredients you can actually obtain, and work backwards (what does the goal need -> what do those need -> ... -> something you can mine by hand). Decide only the SINGLE next action each step.
- Only tool calls change the world. Your thoughts and chat() do NOT mine, craft, move, or pick anything up — narrating "I am mining the tree" does nothing unless you actually call mine_block. Never say or assume an action happened that you did not call.
- After every action, read the tool result and your new "inventory": if the item/effect you expected is not there, the action FAILED — do not pretend it worked or move on. Diagnose and try a different approach.
- Take ONE action at a time, then read the new observation before choosing the next.
- If "nearby" lists what you need with "exposed": true, go to its "at" coordinates. If that entry is "exposed": false (buried) or NOT listed, do not path straight to it — explore or dig toward it (move_to an open point ~15 blocks away, or dig down) and re-check "nearby" until an exposed one appears.
- Respect crafting dependencies: most items are built from intermediate products that must themselves be crafted or mined first, and some recipes only work with a crafting_table placed nearby and the right tool equipped.
- If a tool call returns an error, read it and try a different approach instead of repeating the same call.
- If "surroundings.blocked" is true (a 2-tall wall) or your position barely changes between steps, mine_block the block in front or move_to around it. If "surroundings.can_step_up" is true, use move_forward to hop it. Do not keep repeating the same failing move_to.
- When you are STUCK, lost, or cannot find what you need — the resource you want is NOT in "nearby", a move keeps failing, or you simply don't know where to go — consciously call look_around() to scan the wider area BEFORE wandering or digging blindly. Treat look_around() as your first response to being stuck or to needing an ore/block that is out of your direct sight, then act on whatever it surfaces. If that scan still does not reveal it, call look_around again with a bigger "radius" to search farther out before giving up or moving on.
- Entities are not destinations for gathering — to get a mob's drops use attack_entity, don't move_to it. Do not navigate to your own past position. EXCEPTION: when your goal is to kill a named player, the opponent IS a valid destination — move_to their "nearby_players" coordinates to close in, then attack_player.
- Never call the same tool with the same arguments twice in a row. If an action did not change your position or inventory, it FAILED — switch strategy (mine the blocking block, or explore a different direction) rather than repeating it.
- Do not claim success early. Call stop() only when the goal item/condition is actually present in your inventory or state.
- A failed or unexpected result is a problem to SOLVE, not a reason to quit. If an action did not do what you expected (e.g. a craft did not appear in your inventory), diagnose WHY: re-read the result and inventory, check prerequisites (do you need a crafting_table placed within reach? the right tool equipped? more ingredients first?), then try a DIFFERENT approach. You almost always have an action available — giving up early wastes the run.
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
