// main.ts — token launch radar: the entrypoint the grader runs.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Reads the sealed DefiLlama snapshot, ranks every protocol that records no
// token (and is not a wrapped or staked product of one that trades) by
// implied launch value, and writes into the output directory:
//   board.json    the ranked board, one row per protocol, with farm plans
//   dashboard/    the static dashboard (source copied from this repository,
//                 plus a generated data.js carrying the board and the model)
//   screenshots/  the dashboard screenshots, copied from this repository
//   dossier.json  buildDossier's dossier of the dashboard and screenshots
//
// Standard library only, no network, no wall clock: the snapshot's as_of is
// the model's "now", so two runs over the same snapshot write the same bytes.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { FARM_TEMPLATES, buildBoard } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';

const root = dirname(fileURLToPath(import.meta.url));


function inputPath(): string {
  const i = process.argv.indexOf('--input');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return '/input/snapshot.json';
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

function main(): void {
  const out = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const snapshot = JSON.parse(readFileSync(inputPath(), 'utf8')) as Snapshot;
  const { rows, model } = buildBoard(snapshot);
  const watchCount = rows.filter((r) => r.watchlist).length;

  mkdirSync(out, { recursive: true });

  // The board: the ranked rows with their farm plans, plus the model stated
  // in the open so any reader can recompute every number on it.
  const board = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      implied_value: 'exp(intercept + slope x log(tvl_usd) + category_offset), rounded to whole dollars — a power law FIT by least squares on the snapshot tokenised protocols, not a hand-set multiple',
      fit: {
        trained_on: model.nTrain,
        intercept: model.intercept,
        slope: model.slope,
        category_offsets: 'per-category mean residual in log space, shrunk by n/(n+40); categories with fewer than 3 tokenised peers get no offset',
      },
      validation: {
        method: 'deterministic 5-fold cross-validation over the tokenised protocols (fold = sha256(slug) mod 5), median absolute log error on held-out protocols',
        fitted_model: model.cvFitted,
        median_multiple_baseline: model.cvBaseline,
        rejected_terms: '7-day growth and token-less maturity adjustments were fit and tested on the same folds; both raised held-out error and are not in the model',
      },
      band: 'value_low_usd..value_high_usd = the point value shifted by the 10th..90th percentiles of the out-of-fold log residuals',
      selection: 'protocols that record no token (mcap, gecko id and symbol all null), minus wrapped/staked/bridged products of tokenised protocols; the snapshot watchlist is included in full',
    },
    rows,
  };
  writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 1)}\n`);

  // The dashboard: static source from this repository, data generated here
  // so the page and the board can never drift apart. Rows are compact
  // arrays: [slug, name, category, chains, tvl, change_7d, listed_at,
  // implied, rank, watchlist, effective multiple x1000, category
  // adjustment x100, band low, band high, farm family]. The farm-plan
  // templates ship with the data and are expanded by the page, the same
  // strings lib/model.ts expands into board.json.
  copyTree(join(root, 'dashboard'), join(out, 'dashboard'));
  const data = {
    asOf: snapshot.as_of,
    floorUsd: snapshot.floor_usd,
    counts: {
      protocols: snapshot.protocols.length,
      tokenless: snapshot.protocols.filter((p) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null).length,
      board: rows.length,
      watchlist: watchCount,
    },
    model: {
      intercept: Math.round(model.intercept * 10000) / 10000,
      slope: Math.round(model.slope * 10000) / 10000,
      nTrain: model.nTrain,
      cvFitted: Math.round(model.cvFitted * 1000) / 1000,
      cvBaseline: Math.round(model.cvBaseline * 1000) / 1000,
      bandLo: Math.round(model.bandLo * 1000) / 1000,
      bandHi: Math.round(model.bandHi * 1000) / 1000,
      offsets: model.offsets.map((o) => [o.category, o.peers, Math.round(Math.exp(o.offset) * 1000)] as const),
      // Peer coordinates are for the scatter only: log10 values x100 as
      // integers — compact, and all the plot needs.
      peers: model.peers.map((p) => [Math.round(Math.log10(p.tvl_usd) * 100), Math.round(Math.log10(p.mcap_usd) * 100)] as const),
    },
    templates: FARM_TEMPLATES,
    rows: rows.map((r) => [
      r.slug,
      r.name,
      r.category,
      r.chains.slice(0, 4),
      r.tvl_usd,
      r.change_7d === null ? null : Math.round(r.change_7d * 100) / 100,
      r.listed_at,
      r.implied_value_usd,
      r.rank,
      r.watchlist ? 1 : 0,
      Math.round(r.eff_multiple * 1000),
      Math.round(r.category_adj * 100),
      r.value_low_usd,
      r.value_high_usd,
      r.farm_family,
    ]),
  };
  writeFileSync(join(out, 'dashboard', 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`);

  copyTree(join(root, 'screenshots'), join(out, 'screenshots'));

  // The dossier the judge reads, written by the house library from the
  // output itself, byte for byte what the scorer recomputes.
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65536 }));

  console.log(`protocols ${snapshot.protocols.length}, board rows ${rows.length}, watchlist covered ${watchCount}/${snapshot.watchlist.length}`);
}

main();
