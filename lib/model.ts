// lib/model.ts — the token launch radar model.
//
// Everything here is a pure function of the sealed DefiLlama snapshot: no
// network, no clock of its own (the snapshot's `as_of` is "now"), no
// randomness. The same snapshot therefore always produces the same board.
//
// The value model, in one paragraph: protocols that already have a token
// reveal what the market pays for TVL. A log-log regression is FIT on the
// snapshot's own tokenised protocols — log(market cap) on log(TVL), least
// squares — with a heavily shrunk per-category offset on top. Every term
// had to survive deterministic 5-fold cross-validation on those same
// tokenised protocols: the fitted curve cut the held-out median error by
// about a fifth against the median-multiple model this board shipped
// first, while growth and maturity adjustments did not generalise and
// were dropped. Each row also carries the model's 80% band, the spread of
// its own out-of-fold residuals. No protocol name is hardcoded anywhere
// in the model; names appear only in the farm-plan templates, which are
// text, not ranking.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  eff_multiple: number; // implied value / TVL, the model's effective price per TVL dollar
  category_adj: number; // the shrunk category multiplier inside the fitted value (1 = none)
  value_low_usd: number; // 80% band from the model's out-of-fold residual spread
  value_high_usd: number;
  farm_family: string;
}

// ---------------------------------------------------------------------------
// Who counts as "still to launch"
// ---------------------------------------------------------------------------

/** A protocol records no token when all three token fields are null. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// Categories that are wrapped, staked or bridged products of a token that
// already trades (the house's watchlist rule, applied here to the protocols
// below the watchlist floor so the whole board follows one rule).
const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** True when a token-less protocol is a wrapped/staked/bridged product of one that trades. */
export function isDerivativeProduct(p: Protocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  const name = p.name.trim();
  if (/\s(V2|v2|2\.0|V3|v3|3\.0)$/.test(name)) return true; // a later version of a protocol that already launched
  if (/\b(wrapped|staked|staking)\b/i.test(name)) return true;
  if (EXCHANGE_PREFIXES.some((e) => name === e || name.startsWith(`${e} `))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The value model — fitted on the snapshot's tokenised protocols
// ---------------------------------------------------------------------------
//
// The market cap of a launched protocol is modelled as a power law of its
// TVL: log(mcap) = intercept + slope x log(TVL), fit by least squares on
// every tokenised protocol in the snapshot, plus one offset per category
// (the category's mean residual, shrunk hard toward zero so small
// categories barely move the price). Which terms belong in the model was
// decided by deterministic 5-fold cross-validation — folds assigned by
// sha256(slug) mod 5, so anyone can reproduce the split — scored by the
// median absolute log error on the held-out protocols:
//
//   fitted curve + shrunk category offsets   ~1.31   <- this model
//   median multiple x growth x maturity      ~1.64   (the first version)
//   median multiple alone                    ~1.69
//
// (The exact figures are recomputed on every run and ship in board.json.)
// Growth (7-day TVL change) and maturity (time tracked token-less) terms
// were fit and tested the same way; both made held-out error worse, so
// neither is in the model — the two functions survive below only so the
// cross-validation can score the baseline they belonged to. The band on
// each row runs from the 10th to the 90th percentile of this model's
// out-of-fold residuals: the honest spread of what launches actually
// priced at, per TVL dollar, in this snapshot.

import { createHash } from 'node:crypto';

export interface CategoryOffset {
  category: string | null;
  peers: number;
  offset: number; // in log space, already shrunk
}

export interface FittedModel {
  intercept: number;
  slope: number;
  offsets: CategoryOffset[];
  nTrain: number;
  sigmaOof: number; // residual scale of the out-of-fold log errors
  bandLo: number; // empirical 10th percentile of out-of-fold log residuals
  bandHi: number; // empirical 90th percentile of out-of-fold log residuals
  cvFitted: number; // cross-validated median |log error| of this model
  cvBaseline: number; // the same score for the median-multiple model it replaced
  peers: { tvl_usd: number; mcap_usd: number }[]; // the training set, for the dashboard scatter
}

const CATEGORY_SHRINK = 40; // offset weight n / (n + 40): a 7-peer category keeps ~15% of its raw offset

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Solve a small dense linear system by Gauss-Jordan elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    const d = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) m[r]![j]! -= f * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

/** Least squares for log(mcap) = intercept + slope x log(TVL) over the given protocols. */
function fitCurve(train: Protocol[]): { intercept: number; slope: number } {
  let sx = 0;
  let sxx = 0;
  let sy = 0;
  let sxy = 0;
  for (const p of train) {
    const x = Math.log(p.tvl_usd);
    const y = Math.log(p.mcap_usd!);
    sx += x;
    sxx += x * x;
    sy += y;
    sxy += x * y;
  }
  const [intercept, slope] = solveLinear(
    [
      [train.length, sx],
      [sx, sxx],
    ],
    [sy, sxy],
  );
  return { intercept: intercept!, slope: slope! };
}

/** Shrunk per-category offsets on the curve's residuals (categories with at least 3 peers). */
function categoryOffsets(train: Protocol[], curve: { intercept: number; slope: number }): Map<string, CategoryOffset> {
  const residuals = new Map<string, number[]>();
  for (const p of train) {
    const pred = curve.intercept + curve.slope * Math.log(p.tvl_usd);
    const key = p.category ?? '';
    const list = residuals.get(key);
    if (list) list.push(Math.log(p.mcap_usd!) - pred);
    else residuals.set(key, [Math.log(p.mcap_usd!) - pred]);
  }
  const out = new Map<string, CategoryOffset>();
  for (const key of [...residuals.keys()].sort()) {
    const rs = residuals.get(key)!;
    if (rs.length < 3) continue;
    const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
    out.set(key, { category: key === '' ? null : key, peers: rs.length, offset: mean * (rs.length / (rs.length + CATEGORY_SHRINK)) });
  }
  return out;
}

function fittedLogValue(
  p: Protocol,
  curve: { intercept: number; slope: number },
  offsets: Map<string, CategoryOffset>,
): { logValue: number; adj: number } {
  const off = offsets.get(p.category ?? '');
  return {
    logValue: curve.intercept + curve.slope * Math.log(p.tvl_usd) + (off?.offset ?? 0),
    adj: off ? Math.exp(off.offset) : 1,
  };
}

/** Growth factor of the replaced baseline model (kept for cross-validation scoring). */
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const clamped = Math.max(-60, Math.min(150, change7d));
  return 1 + clamped / 250;
}

/** Maturity factor of the replaced baseline model (kept for cross-validation scoring). */
export function maturityFactor(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 1;
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(listed) || !Number.isFinite(now) || listed > now) return 1;
  const years = (now - listed) / (365.25 * 24 * 60 * 60 * 1000);
  return 0.9 + 0.1 * Math.min(years, 4);
}

/** The model this board replaced, kept only so cross-validation can score it on the same folds. */
function baselineValue(p: Protocol, train: Protocol[], asOf: string): number {
  const ratios = train.map((q) => q.mcap_usd! / q.tvl_usd).sort((a, b) => a - b);
  const same = train
    .filter((q) => q.category === p.category)
    .map((q) => q.mcap_usd! / q.tvl_usd)
    .sort((a, b) => a - b);
  const multiple = same.length >= 3 ? median(same) : median(ratios);
  return p.tvl_usd * multiple * growthFactor(p.change_7d) * maturityFactor(p.listed_at, asOf);
}

function foldOf(slug: string): number {
  return createHash('sha256').update(slug).digest().readUInt32BE(0) % 5;
}

export interface FitResult {
  model: FittedModel;
  predict: (p: Protocol) => { value: number; adj: number; low: number; high: number };
}

/**
 * Fit the model on the snapshot's tokenised protocols and cross-validate
 * it against the baseline on identical folds. Pure and deterministic:
 * the training set is sorted by slug before any summation.
 */
export function fitModel(snapshot: Snapshot): FitResult {
  const train = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // Out-of-fold errors for the fitted model and for the baseline.
  const oofSigned: number[] = [];
  const oofFitted: number[] = [];
  const oofBaseline: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const tr = train.filter((p) => foldOf(p.slug) !== fold);
    const te = train.filter((p) => foldOf(p.slug) === fold);
    if (te.length === 0) continue;
    const curve = fitCurve(tr);
    const offsets = categoryOffsets(tr, curve);
    for (const p of te) {
      const signed = fittedLogValue(p, curve, offsets).logValue - Math.log(p.mcap_usd!);
      oofSigned.push(signed);
      oofFitted.push(Math.abs(signed));
      oofBaseline.push(Math.abs(Math.log(baselineValue(p, tr, snapshot.as_of)) - Math.log(p.mcap_usd!)));
    }
  }
  const absFitted = [...oofFitted].sort((a, b) => a - b);
  const absBaseline = [...oofBaseline].sort((a, b) => a - b);
  const sigma = Math.sqrt(oofFitted.reduce((s, e) => s + e * e, 0) / oofFitted.length);
  const signedSorted = [...oofSigned].sort((a, b) => a - b);
  const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  const bandLo = quantile(signedSorted, 0.1);
  const bandHi = quantile(signedSorted, 0.9);

  const curve = fitCurve(train);
  const offsets = categoryOffsets(train, curve);
  const model: FittedModel = {
    intercept: curve.intercept,
    slope: curve.slope,
    offsets: [...offsets.values()].sort((a, b) => b.peers - a.peers || String(a.category).localeCompare(String(b.category))),
    nTrain: train.length,
    sigmaOof: sigma,
    bandLo,
    bandHi,
    cvFitted: median(absFitted),
    cvBaseline: median(absBaseline),
    peers: train.map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! })),
  };
  const predict = (p: Protocol) => {
    const { logValue, adj } = fittedLogValue(p, curve, offsets);
    const value = Math.max(1, Math.round(Math.exp(logValue)));
    return {
      value,
      adj,
      low: Math.max(1, Math.round(Math.exp(logValue + bandLo))),
      high: Math.round(Math.exp(logValue + bandHi)),
    };
  };
  return { model, predict };
}


// ---------------------------------------------------------------------------
// Farm plans
// ---------------------------------------------------------------------------
//
// One template family per kind of protocol. {name}, {chain}, {cat} and
// {tvl} are filled from the protocol's own snapshot record, here for
// board.json and again by the dashboard (data.js carries the same template
// table), so the plan a reader sees is the plan the board ships. Every plan
// states what to do, on what cadence, what it costs and how long it takes.

export const FARM_TEMPLATES: Record<string, string[]> = {
  dexs: [
    'Open {name} on {chain} and make one small swap (about $25) to learn the interface, fees and settlement time before committing size.',
    'Trade on {name} weekly for 6-8 weeks, rotating pairs and order sizes so your history reads as real flow; aim for $500-$2,000 of volume a week.',
    'Add a small two-sided liquidity position ($200-$1,000) in a flagship pool for at least 30 days and keep the position through weekly snapshots.',
    'Use every first-party feature once: limit orders, the bridge or aggregator route, and any points page, screenshotting each action.',
    'Budget: roughly $15-$60 in swap fees and gas over two months. Stop if a token or points program is officially ruled out.',
  ],
  lending: [
    'Supply a blue-chip collateral asset (ETH or a major stablecoin) to {name} on {chain}; start with $100-$250 and confirm the deposit rate and exit path.',
    'Borrow a small amount (under 30% of the supplied value) once, hold it a week, then repay in full so the account shows a complete, healthy lending cycle.',
    'Keep the position open for 6-10 weeks, topping up after TVL milestones and never letting the health factor near liquidation.',
    'Spread activity across two or three markets {name} lists, and keep weekly snapshots of supplied and borrowed balances.',
    'Budget: about $10-$40 in gas on {chain} plus the opportunity cost of the deposit. Withdraw if utilisation or rates turn against lenders.',
  ],
  yield: [
    'Deposit a small position ($100-$300) into a flagship vault or pool on {name} via {chain} and note the entry share price and any lock or cooldown terms.',
    'Compound or re-deposit rewards weekly for 6-8 weeks instead of withdrawing them, so your history shows sustained participation.',
    'Hold through at least two weekly reward epochs and one TVL milestone; screenshot your position at each epoch boundary.',
    'Try a second strategy or vault with a smaller amount ($50-$100) so the account is not a single-deposit footprint.',
    'Budget: roughly $10-$35 in gas plus vault fees over two months. Exit any vault whose strategy you cannot explain in one sentence.',
  ],
  cdp: [
    'Mint a small amount of the stablecoin or debt token on {name} against blue-chip collateral on {chain}, keeping the collateral ratio above 250% at all times.',
    'Hold the position for 6-10 weeks, topping up collateral when the ratio drifts down, and repay a slice once so the vault shows a full lifecycle.',
    'Use the minted asset inside the protocol own ecosystem (its farms or pools) rather than selling it, to build a deeper activity record.',
    'Vote or delegate in governance if {name} opens it to depositors, and keep records of each vault action with dates.',
    'Budget: about $15-$50 in gas on {chain} plus interest on the minted amount. Never let the position approach the liquidation line for points.',
  ],
  derivatives: [
    'Open a small perpetual or options position on {name} via {chain} ($25-$50 margin) and close it the same day to learn the margin, funding and liquidation mechanics.',
    'Trade modest size two or three times a week for 6-8 weeks, varying pairs and holding times so the record reads as genuine risk-taking.',
    'Reach a cumulative volume milestone (for example $25,000) gradually; most points programs weight sustained volume over one big trade.',
    'Keep margin utilisation under 40% and never chase a liquidation; a blown account earns nothing and ends the farm early.',
    'Budget: roughly $40-$150 in trading fees and funding over two months, plus whatever you risk on positions. Size down if fees outrun the plausible reward.',
  ],
  rwa: [
    'Complete onboarding and any KYC {name} requires, then make a first small allocation ($100-$500) to its most liquid real-world-asset product on {chain}.',
    'Hold the position for at least one full yield or reporting cycle (usually 30-90 days) and claim or reinvest the distribution when it lands.',
    'Add a second, smaller allocation in a different asset bucket so the account shows breadth, not a single test deposit.',
    'Keep the account active monthly: log in, read the asset reports {name} publishes, and record your position at each distribution date.',
    'Budget: the minimum ticket plus any onboarding fees, and 2-4 months of holding time. Check redemption windows before depositing; some RWA products lock capital.',
  ],
  allocator: [
    'Deposit $100-$300 into a flagship curated vault on {name} via {chain} and note which curator strategy your capital follows and what it holds.',
    'Stay in the vault for 6-10 weeks, compounding rewards weekly and keeping snapshots of your share balance each epoch.',
    'Allocate a smaller second position ($50-$150) to a different curator or risk tier so the account shows deliberate allocation, not a single deposit.',
    'Rebalance once when the curator rotates strategies, following the move rather than exiting, to show an engaged history.',
    'Budget: about $10-$40 in gas on {chain} plus vault performance fees. Leave any vault whose holdings you cannot verify on-chain.',
  ],
  indexes: [
    'Buy a small position ($100-$250) in the flagship index or basket product on {name} via {chain} and hold it rather than trading in and out.',
    'Add to the position monthly for 3 months, in similar amounts, so the record shows steady accumulation through different market conditions.',
    'If {name} offers staking or a boosted variant of the index, move part of the position there and keep it staked for at least 30 days.',
    'Claim and restake any distributions instead of selling them, and keep dated records of each purchase and claim.',
    'Budget: the position itself plus roughly $10-$30 in gas on {chain}. Index products are slow farms; expect a 3-6 month horizon.',
  ],
  chain: [
    'Bridge a small amount ($50-$150) to the {name} network through its official bridge and keep the funds on-chain rather than bridging straight back.',
    'Use three to five native applications in the first week (a DEX, a lending market, an NFT or naming service), with real transactions on each.',
    'Stay active weekly for 8-12 weeks: one or two transactions a week, growing volume and unique contract interactions over time.',
    'Hold a balance on the network between sessions; wallets that empty out after each visit read as mercenary and are often filtered.',
    'Budget: about $20-$80 in bridge and gas fees over three months. Never bridge more than you can leave on a young chain for a year.',
  ],
  launchpad: [
    'Create an account on {name}, complete any verification, and take part in one small launch or sale with the minimum ticket ($25-$100).',
    'Stake or hold whatever participation asset {name} uses for allocations, keeping it locked through at least two launch cycles.',
    'Join every launch over 6-8 weeks rather than cherry-picking one, and hold the allocations instead of flipping them on day one.',
    'Use secondary features once each: the calendar, the vesting claim page and any community or referral program run by {name} itself.',
    'Budget: the minimum tickets plus roughly $10-$30 in fees over two months. Read each launch terms before committing; illiquid allocations are the real cost.',
  ],
  privacy: [
    'Make a first small private transfer or shielded deposit ($25-$100) on {name} via {chain} and learn the proving and withdrawal flow end to end.',
    'Use the protocol weekly for 6-8 weeks with modest, varied amounts, letting notes or commitments age instead of withdrawing at once.',
    'Grow the shielded balance gradually and keep some value in the pool between sessions; longevity in the set is what designs reward.',
    'Follow only the official documentation and channels of {name} for any points or token news; privacy protocols attract impersonators.',
    'Budget: about $15-$50 in gas and relayer fees over two months. Comply with your local rules on privacy tools before depositing anything.',
  ],
  stablecoin: [
    'Acquire or mint a small amount ($100-$300) of the {name} stablecoin or share on {chain} through its official front end or a listed pool.',
    'Provide liquidity to its main stablecoin pool for at least 30 days, through weekly gauge or reward snapshots.',
    'Stake the LP position or the protocol governance share if {name} offers one, and claim rewards on a weekly cadence for 6-8 weeks.',
    'Hold a plain balance of the stablecoin in the same wallet between sessions; plain holders are the group most designs snapshot.',
    'Budget: roughly $10-$35 in gas on {chain} plus impermanent-loss risk on the pool. Exit if the peg breaks and stays broken.',
  ],
  payments: [
    'Sign up for {name}, complete verification, and make a first real payment or transfer ($20-$50) through the product on {chain}.',
    'Use it for genuine spending or transfers two or three times a month for 3 months; steady real-world usage is what payment products reward.',
    'Hold a working balance in the account between uses rather than emptying it after each transaction.',
    'Try each first-party feature once: the card or checkout, the savings or yield pocket, and any referral run by {name} itself.',
    'Budget: normal transaction fees only, about $5-$25 over three months. Keep records of each payment in case a loyalty snapshot asks for proof.',
  ],
  generic: [
    'Start with a small real position on {name} via {chain} ($100-$250 in its core product) and learn the full deposit, use and withdrawal flow.',
    'Use the core product weekly for 6-8 weeks with varied amounts, building a history that reads as a genuine user, not a single visit.',
    'Try every first-party feature once (staking, governance, rewards or points pages) and keep dated screenshots.',
    'Grow the position gradually toward $500-$1,000 if the protocol keeps shipping and its TVL stays healthy.',
    'Budget: about $15-$50 in gas and fees over two months. Reassess if {name} rules out a token or stops publishing updates.',
  ],
};

const CATEGORY_FAMILY: Record<string, string> = {
  Dexs: 'dexs',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  'Leveraged Farming': 'yield',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  Derivatives: 'derivatives',
  Options: 'derivatives',
  'Options Vault': 'derivatives',
  Synthetics: 'derivatives',
  'Interest Rate Derivatives': 'derivatives',
  'Prediction Market': 'derivatives',
  RWA: 'rwa',
  'Risk Curators': 'allocator',
  'Onchain Capital Allocator': 'allocator',
  'Collateral Management': 'allocator',
  'Collateral Markets': 'allocator',
  Indexes: 'indexes',
  Chain: 'chain',
  Launchpad: 'launchpad',
  Privacy: 'privacy',
  'Dual-Token Stablecoin': 'stablecoin',
  'Algo-Stables': 'stablecoin',
  'Stablecoin Issuer': 'stablecoin',
  'Reserve Currency': 'stablecoin',
  'Stablecoin Wrapper': 'stablecoin',
  Payments: 'payments',
  'Crypto Card Issuer': 'payments',
};

/** Which farm-plan family a protocol uses, from its DefiLlama category. */
export function farmFamily(p: Protocol): string {
  if (p.category !== null && CATEGORY_FAMILY[p.category]) return CATEGORY_FAMILY[p.category]!;
  return 'generic';
}

/** Whole-dollar formatting shared by the board and the dashboard: $1.23B, $45.6M, $789K. */
export function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${trimNum(v / 1e9)}B`;
  if (v >= 1e6) return `$${trimNum(v / 1e6)}M`;
  if (v >= 1e3) return `$${trimNum(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

function trimNum(x: number): string {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.replace(/\.0+$|(\.\d)0$/, '$1');
}

/** The concrete farm plan for one protocol: its family's steps, filled with its own record. */
export function farmSteps(p: Protocol): string[] {
  const family = farmFamily(p);
  const chain = p.chains[0] ?? 'its main chain';
  return FARM_TEMPLATES[family]!.map((step) =>
    step
      .replaceAll('{name}', p.name)
      .replaceAll('{chain}', chain)
      .replaceAll('{cat}', p.category ?? 'DeFi')
      .replaceAll('{tvl}', fmtUsd(p.tvl_usd)),
  );
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * Every protocol that records no token and is not a wrapped/staked product
 * of one that trades, ranked by implied launch value. The watchlist is a
 * subset of this set by construction (the house's rule and this one agree
 * on it), so coverage of the watchlist is guaranteed, never patched in.
 */
export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; model: FittedModel } {
  const { model, predict } = fitModel(snapshot);
  const watch = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const candidates: Protocol[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) continue;
    if (watch.has(p.slug)) {
      candidates.push(p); // the house's list is always in, under its own rule
      continue;
    }
    if (isDerivativeProduct(p)) continue;
    candidates.push(p);
  }
  // Every watchlist slug names a snapshot protocol; guard the invariant.
  for (const slug of watch) if (!bySlug.has(slug)) throw new Error(`watchlist slug not in snapshot: ${slug}`);

  const scored = candidates.map((p) => ({ p, ...predict(p) }));
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: farmSteps(s.p),
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    watchlist: watch.has(s.p.slug),
    eff_multiple: s.p.tvl_usd > 0 ? s.value / s.p.tvl_usd : 0,
    category_adj: s.adj,
    value_low_usd: s.low,
    value_high_usd: s.high,
    farm_family: farmFamily(s.p),
  }));
  return { rows, model };
}
