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
const { MINECRAFT_KNOWLEDGE } = require('./knowledge')

function buildSystemPrompt(goal) {
  return `You are an AI agent playing Minecraft, controlled entirely through tool calls.

Your goal: ${goal}

${MINECRAFT_KNOWLEDGE}

Available tools:
- look_around(): scan nearby blocks and entities
- move_to(x, y, z): pathfind to a coordinate (handles most obstacles automatically)
- move_forward(seconds): walk forward while auto-jumping; use to hop a 1-block step or get unstuck
- mine_block(block_type): walk to and mine the nearest matching block (e.g. "oak_log", "stone")
- place_block(block_type, dx, dy, dz): place a block at an offset from you; use (0,0,0) to pillar up (climb by placing a block beneath yourself)
- craft(item, count): craft an item; some recipes require a crafting_table placed within ~8 blocks
- equip(item): hold an item (equip a pickaxe before mining stone/ore)
- turn(direction), jump(), chat(message)
- stop(): call ONLY when the goal is fully complete or you are truly stuck

Each observation is your senses — READ it before acting:
- "position" + "facing": where you are and which way you're looking.
- "surroundings": the blocks right next to you — "block_in_front", "can_step_up", "blocked" (a 2-tall wall), "standing_on", "above_head", "drop_ahead".
- "nearby": the nearest resources/hazards with coordinates ("at"), "dist" and "dir" — e.g. the closest tree, ore, your crafting_table, water/lava. Use these coordinates with move_to / mine_block instead of wandering blindly.
- "inventory": what you have — track progress and prerequisites here.

Rules:
- Take ONE action at a time, then read the new observation before choosing the next.
- If "nearby" already lists what you need, go to its coordinates. If it is NOT listed, explore first (move_to a point ~15 blocks away, then re-check "nearby") until it appears.
- Respect crafting dependencies: logs -> planks -> sticks; place a crafting_table to make a wooden_pickaxe; mine cobblestone with a pickaxe to make a stone_pickaxe.
- If a tool call returns an error, read it and try a different approach instead of repeating the same call.
- If "surroundings.blocked" is true (a 2-tall wall) or your position barely changes between steps, mine_block the block in front or move_to around it. If "surroundings.can_step_up" is true, use move_forward to hop it. Do not keep repeating the same failing move_to.
- Entities and players are NOT resources or destinations. Never navigate toward a player or your own past position — only travel to block coordinates (from "nearby") or to genuinely new, unexplored areas.
- Never call the same tool with the same arguments twice in a row. If an action did not change your position or inventory, it FAILED — switch strategy (mine the blocking block, or explore a different direction) rather than repeating it.
- Do not claim success early. Call stop() only when the goal item/condition is actually present in your inventory or state.`
}

function createAgent({ model, goal, toolSchemas }) {
  let messages = []
  return {
    model: model.name,

    start() {
      messages = [{ role: 'system', content: buildSystemPrompt(goal) }]
    },

    async act(observation, nudge = '') {
      messages.push({
        role: 'user',
        content: `Current state:\n${JSON.stringify(observation)}${nudge}\nWhat do you do next?`
      })
      const msg = await model.complete({ messages, tools: toolSchemas })
      messages.push(msg)

      const thought = msg.content || ''
      const call = msg.tool_calls && msg.tool_calls[0]
      if (!call) return { thought, done: true, reason: 'no_tool_call' }

      let args = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
      return { thought, toolCallId: call.id, tool: call.function.name, args }
    },

    recordResult(toolCallId, result) {
      messages.push({ role: 'tool', tool_call_id: toolCallId, content: String(result) })
    }
  }
}

module.exports = { createAgent, buildSystemPrompt }
