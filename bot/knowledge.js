// ─────────────────────────────────────────────
// MINECRAFT KNOWLEDGE BASE
// Curated early-game rules/systems injected into the agent's system prompt so the
// model understands HOW Minecraft works before it starts calling tools.
// Keep this concise — it is sent with every request.
// ─────────────────────────────────────────────
const MINECRAFT_KNOWLEDGE = `MINECRAFT KNOWLEDGE BASE (early game):

TOOL TIERS (worst -> best): hand < wooden < stone < iron < diamond < netherite.

MINING RULES — you must EQUIP the right pickaxe or the block breaks but drops NOTHING:
- Get a drop by hand (no tool needed): dirt, sand, gravel, logs, planks, leaves, crops, glass(needs silk).
- Need a PICKAXE of ANY tier: stone, cobblestone, coal_ore, copper_ore, furnace, nether ores' basics.
- Need a STONE pickaxe or better: iron_ore, lapis_ore.
- Need an IRON pickaxe or better: gold_ore, redstone_ore, diamond_ore, emerald_ore.
- Need a DIAMOND pickaxe or better: obsidian, ancient_debris.
Rule of thumb: ALWAYS equip a pickaxe before mining stone or any ore. Mining with too low a tier wastes the block.

FASTEST TOOL (speed only): pickaxe -> stone/ore, axe -> wood/logs, shovel -> dirt/sand/gravel, hoe -> leaves/crops.

WHAT BLOCKS DROP:
- stone -> cobblestone (use cobblestone for tools/furnace).
- coal_ore -> coal. iron_ore -> raw_iron (must be smelted). gold_ore -> raw_gold (smelt). diamond_ore -> diamond.
- oak_log -> oak_log item. grass_block/dirt -> dirt.

CRAFTING TECH TREE (recipes):
- 1 log -> 4 planks (no table needed).
- 2 planks -> 4 sticks (no table needed).
- 4 planks -> 1 crafting_table (no table needed).
- These need a crafting_table placed within reach (~3-4 blocks):
  - wooden_pickaxe = 3 planks + 2 sticks
  - stone_pickaxe  = 3 cobblestone + 2 sticks
  - iron_pickaxe   = 3 iron_ingot + 2 sticks
  - furnace        = 8 cobblestone

SMELTING (needs a furnace + fuel such as coal, planks, or logs):
- raw_iron -> iron_ingot. raw_gold -> gold_ingot. raw_copper -> copper_ingot.

STANDARD PROGRESSION to stronger tools:
wood -> planks + sticks -> crafting_table -> wooden_pickaxe -> mine stone (cobblestone) ->
stone_pickaxe -> mine iron_ore -> furnace + smelt -> iron_pickaxe -> mine diamond_ore.

PRACTICAL TIPS:
- Trees are vertical stacks of log blocks; mine each oak_log.
- Stone and ores are underground, in caves, or in exposed cliffs/hillsides — dig down or into terrain to reach them.
- Diamonds are deep (low Y, around Y -59 to Y 16) and require an iron pickaxe.
- Keep a crafting_table with you (place it, craft, optionally take it back) so tool recipes are available.`

module.exports = { MINECRAFT_KNOWLEDGE }
