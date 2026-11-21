// lib/model.ts — the token launch radar model.
//
// Everything here is a pure function of the sealed DefiLlama snapshot: no
// network, no clock of its own (the snapshot's `as_of` is "now"), no
// randomness. The same snapshot therefore always produces the same board.
//
// The value model, in one paragraph: protocols that already have a token
// reveal what the market pays per dollar of TVL. For each category we take
// the median market-cap/TVL multiple of that category's tokenised protocols
// (the global median when a category has fewer than three). A protocol that
// records no token is then valued as if its launch were priced like its
// category's typical launch: implied value = TVL x peer multiple, adjusted
// by a growth factor from its 7-day TVL change and a maturity factor from
// how long DefiLlama has tracked it with no token. No protocol name is
// hardcoded anywhere in the model; names appear only in the farm-plan
// templates, which are text, not ranking.

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
  peer_multiple: number;
  growth_factor: number;
  maturity_factor: number;
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
// The value model
// ---------------------------------------------------------------------------

export interface PeerBenchmark {
  category: string | null; // null = the global benchmark across all categories
  peers: number;
  multiple: number; // median market-cap / TVL among tokenised protocols
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * What the market pays per TVL dollar, learned from the snapshot itself:
 * one benchmark per category with at least three tokenised protocols, plus
 * a global one used for every other category.
 */
export function peerBenchmarks(snapshot: Snapshot): { byCategory: Map<string, PeerBenchmark>; global: PeerBenchmark } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list) list.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  all.sort((a, b) => a - b);
  const global: PeerBenchmark = { category: null, peers: all.length, multiple: median(all) };
  const byCategory = new Map<string, PeerBenchmark>();
  for (const [key, ratios] of ratiosByCategory) {
    if (ratios.length < 3) continue;
    ratios.sort((a, b) => a - b);
    byCategory.set(key, { category: key === '' ? null : key, peers: ratios.length, multiple: median(ratios) });
  }
  return { byCategory, global };
}

/** The multiple a protocol is priced with: its category's, or the global one. */
export function multipleFor(p: Protocol, bench: { byCategory: Map<string, PeerBenchmark>; global: PeerBenchmark }): PeerBenchmark {
  if (p.category !== null) {
    const hit = bench.byCategory.get(p.category);
    if (hit) return hit;
  }
  return bench.global;
}

/**
 * Growth factor from the 7-day TVL change (a percentage in the snapshot).
 * Clamped hard so one wild week cannot dominate a launch price: a protocol
 * that grew 150% in a week is priced 1.6x its peer multiple, one that fell
 * 60% is priced 0.76x. Unreported change is neutral.
 */
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const clamped = Math.max(-60, Math.min(150, change7d));
  return 1 + clamped / 250;
}

/**
 * Maturity factor from how long the protocol has run with no token: the
 * longer the track record, the more a launch is worth, saturating at four
 * years. Unknown listing date is neutral.
 */
export function maturityFactor(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 1;
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(listed) || !Number.isFinite(now) || listed > now) return 1;
  const years = (now - listed) / (365.25 * 24 * 60 * 60 * 1000);
  return 0.9 + 0.1 * Math.min(years, 4);
}

/** Implied launch value of one pre-token protocol, with the model's working shown. */
export function impliedValue(
  p: Protocol,
  bench: { byCategory: Map<string, PeerBenchmark>; global: PeerBenchmark },
  asOf: string,
): { value: number; multiple: number; growth: number; maturity: number } {
  const multiple = multipleFor(p, bench).multiple;
  const growth = growthFactor(p.change_7d);
  const maturity = maturityFactor(p.listed_at, asOf);
  const value = Math.max(1, Math.round(p.tvl_usd * multiple * growth * maturity));
  return { value, multiple, growth, maturity };
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
    'Open {name} on {chain} and make one small swap (about $25) to learn the interface, the fee tier and the settlement time before committing size.',
    'Trade on {name} weekly for 6-8 weeks, rotating pairs and order sizes so your history reads as real flow; aim for $500-$2,000 of volume a week if capital allows.',
    'Add a small two-sided liquidity position ($200-$1,000) in a flagship pool for at least 30 days and keep the position through weekly snapshots.',
    'Use every first-party feature once: limit orders, the bridge or aggregator route, and any points or season page, screenshotting each completed action.',
    'Budget: roughly $15-$60 in swap fees and gas over two months. Stop adding size if a token or points program is officially ruled out.',
  ],
  lending: [
    'Supply a blue-chip collateral asset (ETH or a major stablecoin) to {name} on {chain}; start with $100-$250 and confirm the deposit rate and withdrawal path.',
    'Borrow a small amount (under 30% of the supplied value) once, hold it a week, then repay in full so the account shows a complete, healthy lending cycle.',
    'Keep the position open for 6-10 weeks, topping up after TVL milestones and never letting the health factor drift near liquidation.',
    'Spread activity across two or three markets {name} lists rather than one, and keep weekly snapshots of your supplied and borrowed balances.',
    'Budget: about $10-$40 in gas on {chain} plus the opportunity cost of the deposit. Withdraw if utilisation or rates turn against lenders.',
  ],
  yield: [
    'Deposit a small position ($100-$300) into a flagship vault or pool on {name} via {chain} and note the entry share price and any lock or cooldown terms.',
    'Compound or re-deposit rewards weekly for 6-8 weeks instead of withdrawing them, so your history shows sustained, growing participation.',
    'Hold through at least two weekly reward epochs and one TVL milestone; screenshot your position and shares at each epoch boundary.',
    'Try a second strategy or vault with a smaller amount ($50-$100) so the account is not a single-deposit footprint.',
    'Budget: roughly $10-$35 in gas plus vault fees over two months. Exit any vault whose underlying strategy you cannot explain in one sentence.',
  ],
  cdp: [
    'Mint a small amount of the stablecoin or debt token on {name} against blue-chip collateral on {chain}, keeping the collateral ratio above 250% at all times.',
    'Hold the position for 6-10 weeks, topping up collateral whenever the ratio drifts down, and repay a slice once so the vault shows a full lifecycle.',
    'Use the minted asset inside the protocol own ecosystem (its farms or pools) rather than selling it, to build a deeper activity record.',
    'Vote or delegate in governance if {name} opens it to depositors, and keep records of each vault action with dates.',
    'Budget: about $15-$50 in gas on {chain} plus interest on the minted amount. Never let the position approach the liquidation line for points.',
  ],
  derivatives: [
    'Open a small perpetual or options position on {name} via {chain} ($25-$50 margin) and close it the same day to learn the margin, funding and liquidation mechanics.',
    'Trade modest size two or three times a week for 6-8 weeks, varying pairs and holding times so the record reads as genuine risk-taking, not wash flow.',
    'Reach a cumulative volume milestone (for example $25,000) gradually; most points programs weight sustained volume over one large trade.',
    'Keep margin utilisation under 40% and never chase a liquidation; a blown account earns nothing and ends the farm early.',
    'Budget: roughly $40-$150 in trading fees and funding over two months, plus whatever you risk on positions. Size down if fees outrun the plausible reward.',
  ],
  rwa: [
    'Complete the onboarding and any KYC {name} requires, then make a first small allocation ($100-$500) to its most liquid real-world-asset product on {chain}.',
    'Hold the position for at least one full yield or reporting cycle (usually 30-90 days) and claim or reinvest the distribution when it lands.',
    'Add a second, smaller allocation in a different asset bucket so the account shows breadth, not a single test deposit.',
    'Keep the account active monthly: log in, read the asset reports {name} publishes, and record your position value at each distribution date.',
    'Budget: the minimum ticket plus any onboarding fees, and 2-4 months of holding time. Check redemption windows before depositing; some RWA products lock capital.',
  ],
  allocator: [
    'Deposit $100-$300 into a flagship curated vault on {name} via {chain} and note which curator strategy your capital follows and what it holds.',
    'Stay in the vault for 6-10 weeks, compounding rewards weekly and keeping snapshots of your share balance at each epoch.',
    'Allocate a smaller second position ($50-$150) to a different curator or risk tier so the account shows deliberate allocation, not a single deposit.',
    'Rebalance once when the curator rotates strategies, following the move rather than exiting, to show an engaged allocator history.',
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
    'Use three to five native applications in the first week (a DEX, a lending market, an NFT or naming service) with real transactions on each.',
    'Stay active weekly for 8-12 weeks: one or two transactions a week, growing total volume and unique contract interactions over time.',
    'Hold a balance on the network between sessions; wallets that empty out after each visit read as mercenary and are often filtered.',
    'Budget: about $20-$80 in bridge and gas fees over three months. Never bridge more than you can leave on a young chain for a year.',
  ],
  launchpad: [
    'Create an account on {name}, complete any verification, and take part in one small launch or sale with the minimum ticket ($25-$100).',
    'Stake or hold whatever participation asset {name} uses for allocations, keeping it locked through at least two launch cycles.',
    'Join every launch over 6-8 weeks rather than cherry-picking one, and claim and hold the allocations instead of flipping them on day one.',
    'Use secondary features once each: the calendar, the vesting claim page and any community or referral program run by {name} itself.',
    'Budget: the minimum tickets plus roughly $10-$30 in fees over two months. Read each launch terms before committing; illiquid allocations are the real cost.',
  ],
  privacy: [
    'Make a first small private transfer or shielded deposit ($25-$100) on {name} via {chain} and learn the proving and withdrawal flow end to end.',
    'Use the protocol weekly for 6-8 weeks with modest, varied amounts, letting notes or commitments age instead of withdrawing immediately.',
    'Grow the shielded balance gradually and keep some value in the pool between sessions; longevity in the set is what most designs reward.',
    'Follow only the official documentation and channels of {name} for any points or token news; privacy protocols attract impersonators.',
    'Budget: about $15-$50 in gas and relayer fees over two months. Comply with your local rules on privacy tools before depositing anything.',
  ],
  stablecoin: [
    'Acquire or mint a small amount ($100-$300) of the {name} stablecoin or share on {chain} through its official front end or a listed pool.',
    'Provide liquidity to its main stablecoin pool for at least 30 days, keeping the position through weekly gauge or reward snapshots.',
    'Stake the LP position or the protocol governance share if {name} offers one, and claim rewards on a weekly cadence for 6-8 weeks.',
    'Hold a plain balance of the stablecoin in the same wallet between sessions; plain holders are the group most designs snapshot.',
    'Budget: roughly $10-$35 in gas on {chain} plus impermanent-loss risk on the pool. Exit if the peg breaks and stays broken.',
  ],
  payments: [
    'Sign up for {name}, complete verification, and make a first real payment or transfer ($20-$50) through the product on {chain}.',
    'Use it for genuine spending or transfers two or three times a month for 3 months; steady real-world usage is the metric payment products reward.',
    'Hold a working balance in the account between uses rather than emptying it after each transaction.',
    'Try each first-party feature once: the card or checkout, the savings or yield pocket, and any referral run by {name} itself.',
    'Budget: normal transaction fees only, about $5-$25 over three months. Keep records of each payment in case a loyalty snapshot asks for proof.',
  ],
  generic: [
    'Start with a small real position on {name} via {chain} ($100-$250 in its core product) and learn the full deposit, use and withdrawal flow.',
    'Use the core product weekly for 6-8 weeks with varied amounts, building a history that reads as a genuine user rather than a single visit.',
    'Try every first-party feature once (staking, governance, rewards or points pages) and keep dated screenshots of your positions.',
    'Grow the position gradually toward $500-$1,000 if the protocol keeps shipping and its TVL trend stays healthy.',
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
export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; benchmarks: PeerBenchmark[]; globalBenchmark: PeerBenchmark } {
  const bench = peerBenchmarks(snapshot);
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

  const scored = candidates.map((p) => {
    const iv = impliedValue(p, bench, snapshot.as_of);
    return { p, ...iv };
  });
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
    peer_multiple: s.multiple,
    growth_factor: s.growth,
    maturity_factor: s.maturity,
    farm_family: farmFamily(s.p),
  }));
  const benchmarks = [...bench.byCategory.values()].sort((a, b) => b.peers - a.peers || (String(a.category) < String(b.category) ? -1 : 1));
  return { rows, benchmarks, globalBenchmark: bench.global };
}
