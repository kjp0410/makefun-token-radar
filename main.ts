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
  const { rows, benchmarks, globalBenchmark } = buildBoard(snapshot);
  const watchCount = rows.filter((r) => r.watchlist).length;

  mkdirSync(out, { recursive: true });

  // The board: the ranked rows with their farm plans, plus the model stated
  // in the open so any reader can recompute every number on it.
  const board = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      implied_value: 'tvl_usd x peer_multiple x growth_factor x maturity_factor, rounded to whole dollars',
      peer_multiple: 'median market-cap/TVL of the tokenised protocols in the same category in this snapshot (needs at least 3, else the global median)',
      growth_factor: '1 + clamp(change_7d percent, -60, 150) / 250; unreported change is 1',
      maturity_factor: '0.9 + 0.1 x min(years since listed_at, 4); unknown listing date is 1',
      selection: 'protocols that record no token (mcap, gecko id and symbol all null), minus wrapped/staked/bridged products of tokenised protocols; the snapshot watchlist is included in full',
    },
    rows,
  };
  writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 1)}\n`);

  // The dashboard: static source from this repository, data generated here
  // so the page and the board can never drift apart. Rows are compact
  // arrays: [slug, name, category, chains, tvl, change_7d, listed_at,
  // implied, rank, watchlist, multiple x1000, growth x100, maturity x100,
  // farm family]. The farm-plan templates ship with the data and are
  // expanded by the page, the same strings lib/model.ts expands into
  // board.json.
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
    benchmarks: [
      ...benchmarks.map((b) => [b.category, b.peers, Math.round(b.multiple * 1000)] as const),
      [null, globalBenchmark.peers, Math.round(globalBenchmark.multiple * 1000)] as const,
    ],
    templates: FARM_TEMPLATES,
    rows: rows.map((r) => [
      r.slug,
      r.name,
      r.category,
      r.chains,
      r.tvl_usd,
      r.change_7d,
      r.listed_at,
      r.implied_value_usd,
      r.rank,
      r.watchlist ? 1 : 0,
      Math.round(r.peer_multiple * 1000),
      Math.round(r.growth_factor * 100),
      Math.round(r.maturity_factor * 100),
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
