# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kjp0410/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kjp0410/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over a sealed snapshot of every protocol DefiLlama tracks. It finds the protocols that still record no token — and are not a wrapped or staked product of one that trades — and ranks them by implied launch value under a model **fitted** on the snapshot itself: a power law, log(market cap) = intercept + slope × log(TVL), fit by least squares on all 128 tokenised protocols, plus a heavily shrunk per-category offset. Every model term had to survive deterministic 5-fold cross-validation on the launched protocols — the fitted curve cut held-out median pricing error from 373% (the median-multiple model this board shipped first) to 280%, while growth and maturity adjustments raised held-out error and were dropped. Each row also carries the model's 80% band, from the spread of its out-of-fold residuals. The static dashboard shows the ranked board with bands, the fit itself (equation, cross-validation scores, a TVL-versus-market-cap scatter with the fitted curve), a detail view per protocol with the model's arithmetic and a concrete farm plan (steps, costs, durations), and category / chain / watchlist filters. Every watchlist protocol is covered, plus every defensible pre-token protocol below the watchlist floor.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

The program (Node 22, standard library only) reads a DefiLlama-shaped snapshot and writes `board.json`, the dashboard (with its generated `data.js`), the screenshots and `dossier.json` into the output directory. In the grading sandbox the snapshot is provided at `/input/snapshot.json` and the output defaults to `/output`. Two runs over the same snapshot write the same bytes.

---
<sub>Entered on [make.fun](https://make.fun/?ref=4s3d9qw1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
