# Commands

Quick reference for running MineBench. See `context.md` for how things work.

## Start the Minecraft server
Run in the server folder, then `/op` the bots in the server console (needed for task setup).
```bash
java -Xms2G -Xmx2G -jar paper.jar nogui
# in the server console:  /op MineBenchBot   /op MineBenchBotA   /op MineBenchBotB
```

## Run a benchmark
```bash
node bench.js --task gather_wood --model copilot/gpt-4o     # Copilot model
node bench.js --goal "Mine 3 oak_log" --model copilot/claude-opus-4.8       # ad-hoc goal (no scoring)
node bench.js --task gather_wood --model copilot/gpt-5.4 --verbose  # show agent thoughts
```

## Compare two models (dual mode)
Opens two bot windows (one per model), then prints a side-by-side comparison.
```bash
node bench.js --task gather_wood --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o
```

## Duel: two bots kill each other (asymmetric dual mode)
Give each bot its OWN task with `--task-a` / `--task-b`. Bot A is `MineBenchBotA`, bot B is
`MineBenchBotB`, so point each task at the OTHER bot. Both are given a stone_sword and spawn a
short distance apart (via each task's `spawn_offset`), so they must close the gap and fight a
real duel. (Requires PvP enabled on the server and both bots `/op`'d.)
```bash
node bench.js --task-a kill_bot_b --task-b kill_bot_a --model-a copilot/gpt-5.4 --model-b copilot/gpt-4o
```
Each bot's scorecard reports success when the server confirms its target died.

## Other
```bash
node bot/bot.js              # smoke test: connect + walk 30s (npm run smoke)
node dashboard/build.js      # build the static results dashboard (npm run dashboard)
node dashboard/live-server.js  # live dashboard while a run is in progress (npm run dashboard:live)
```
