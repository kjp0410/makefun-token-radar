# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kjp0410/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kjp0410/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over a sealed snapshot of every protocol DefiLlama tracks. It finds the protocols that still record no token — and are not a wrapped or staked product of one that trades — and ranks them by implied launch value: each protocol's TVL priced at the median market-cap/TVL multiple its own category's tokenised protocols trade at in the same snapshot, adjusted for 7-day TVL growth and for how long it has run with no token. The static dashboard shows the ranked board, a detail view per protocol with the model's arithmetic and a concrete farm plan (steps, costs, durations), and category / chain / watchlist filters. Every watchlist protocol is covered, plus every defensible pre-token protocol below the watchlist floor.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

The program (Node 22, standard library only) reads a DefiLlama-shaped snapshot and writes `board.json`, the dashboard (with its generated `data.js`), the screenshots and `dossier.json` into the output directory. In the grading sandbox the snapshot is provided at `/input/snapshot.json` and the output defaults to `/output`. Two runs over the same snapshot write the same bytes.

---
<sub>Entered on [make.fun](https://make.fun/?ref=4s3d9qw1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
