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

## Give players infinite night vision
Run in the server console (or as an op'd player) to grant night vision that never expires.
```bash
/effect give @s night_vision infinite 0 true
```

## Other
```bash
node bot/bot.js              # smoke test: connect + walk 30s (npm run smoke)
node dashboard/build.js      # build the static results dashboard (npm run dashboard)
node dashboard/live-server.js  # live dashboard while a run is in progress (npm run dashboard:live)
```
