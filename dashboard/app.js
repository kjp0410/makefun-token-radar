
'use strict';

const R = window.RADAR;
const M = R.model;
const $ = (id) => document.getElementById(id);

const C = { slug: 0, name: 1, cat: 2, chains: 3, tvl: 4, chg: 5, listed: 6, val: 7, rank: 8, watch: 9, mult: 10, adj: 11, lo: 12, hi: 13, fam: 14 };
const bySlug = new Map(R.rows.map((r) => [r[C.slug], r]));
const maxVal = Math.max(...R.rows.map((r) => r[C.val]));


function trimNum(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.replace(/\.0+$|(\.\d)0$/, '$1');
}
function fmtUsd(v) {
  if (v >= 1e9) return `$${trimNum(v / 1e9)}B`;
  if (v >= 1e6) return `$${trimNum(v / 1e6)}M`;
  if (v >= 1e3) return `$${trimNum(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
function fmtFull(v) {
  return `$${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
function fmtPct(x) {
  if (x === null) return '<span class="na">n/a</span>';
  const cls = x > 0 ? 'pos' : x < 0 ? 'neg' : '';
  return `<span class="${cls}">${x > 0 ? '+' : ''}${x.toFixed(1)}%</span>`;
}
function ageText(listed) {
  if (!listed) return '<span class="na">unknown</span>';
  const days = Math.round((Date.parse(`${R.asOf}T00:00:00Z`) - Date.parse(`${listed}T00:00:00Z`)) / 86400000);
  if (days < 365) return `${days} d`;
  return `${(days / 365.25).toFixed(1)} yrs`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}


function farmSteps(row) {
  const steps = R.templates[row[C.fam]] || R.templates.generic;
  const chain = row[C.chains][0] || 'its main chain';
  return steps.map((s) =>
    s.replaceAll('{name}', row[C.name]).replaceAll('{chain}', chain)
      .replaceAll('{cat}', row[C.cat] || 'DeFi').replaceAll('{tvl}', fmtUsd(row[C.tvl])),
  );
}


function renderScatter() {
  const W = 720, H = 400, P = { l: 58, r: 14, t: 12, b: 40 };
  const pts = M.peers;
  const xs = pts.map((p) => p[0] / 100);
  const ys = pts.map((p) => p[1] / 100);
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const X = (lx) => P.l + ((lx - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (ly) => H - P.b - ((ly - y0) / (y1 - y0)) * (H - P.t - P.b);
  let g = '';
  for (let e = x0; e <= x1; e++) {
    g += `<line class="grid" x1="${X(e)}" y1="${P.t}" x2="${X(e)}" y2="${H - P.b}"/><text class="tick" x="${X(e)}" y="${H - P.b + 16}" text-anchor="middle">${fmtUsd(10 ** e)}</text>`;
  }
  for (let e = y0; e <= y1; e++) {
    g += `<line class="grid" x1="${P.l}" y1="${Y(e)}" x2="${W - P.r}" y2="${Y(e)}"/><text class="tick" x="${P.l - 6}" y="${Y(e) + 4}" text-anchor="end">${fmtUsd(10 ** e)}</text>`;
  }
  const lineAt = (tvl) => (M.intercept + M.slope * Math.log(tvl)) / Math.LN10;
  const ta = 10 ** x0, tb = 10 ** x1;
  g += `<line class="axis" x1="${P.l}" y1="${H - P.b}" x2="${W - P.r}" y2="${H - P.b}"/><line class="axis" x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${H - P.b}"/>`;
  g += `<line class="fit" x1="${X(x0)}" y1="${Y(lineAt(ta))}" x2="${X(x1)}" y2="${Y(lineAt(tb))}"/>`;
  g += pts.map((p) => `<circle class="peer" cx="${X(p[0] / 100).toFixed(1)}" cy="${Y(p[1] / 100).toFixed(1)}" r="3"/>`).join('');
  g += R.rows.slice(0, 12).map((r) => {
    const cx = X(Math.log10(r[C.tvl])), cy = Y(Math.log10(r[C.val]));
    return `<rect class="cand" x="${(cx - 4.5).toFixed(1)}" y="${(cy - 4.5).toFixed(1)}" width="9" height="9" transform="rotate(45 ${cx.toFixed(1)} ${cy.toFixed(1)})"><title>${esc(r[C.name])}</title></rect>`;
  }).join('');
  g += `<text class="tick" x="${(P.l + W - P.r) / 2}" y="${H - 4}" text-anchor="middle">TVL of launched protocols</text>`;
  $('scatter').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of launched protocols, TVL versus market cap, with the fitted curve">${g}</svg>`;
}

function renderModel() {
  $('eqIntercept').textContent = M.intercept.toFixed(2);
  $('eqSlope').textContent = M.slope.toFixed(2);
  $('modelBadge').textContent = `fit on ${M.nTrain} launched protocols · 5-fold CV`;
  const pct = (v) => Math.round((Math.exp(v) - 1) * 100);
  const wFit = Math.max(6, (M.cvFitted / M.cvBaseline) * 100);
  $('cvBox').innerHTML = `
    <div class="cv-row win"><span class="cv-name">Fitted power law (this board)</span><span class="cv-bar"><i style="width:${wFit.toFixed(0)}%"></i></span><span class="cv-val">median error ${pct(M.cvFitted)}%</span></div>
    <div class="cv-row"><span class="cv-name">Median multiple × growth × maturity</span><span class="cv-bar"><i style="width:100%"></i></span><span class="cv-val">median error ${pct(M.cvBaseline)}%</span></div>`;
  $('offTable').querySelector('tbody').innerHTML = M.offsets
    .map(([c, n, m]) => `<tr><td>${c === null ? 'Uncategorised' : esc(c)}</td><td class="n">${n} peers</td><td class="m">${(m / 1000).toFixed(2)}×</td></tr>`)
    .join('');
  renderScatter();
}


function readState() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  return {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    watch: params.get('watch') === '1',
    sort: params.get('sort') || 'implied',
    slug: path.startsWith('p/') ? decodeURIComponent(path.slice(2)) : null,
  };
}
function writeState(state, slug) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.cat) params.set('cat', state.cat);
  if (state.chain) params.set('chain', state.chain);
  if (state.watch) params.set('watch', '1');
  if (state.sort && state.sort !== 'implied') params.set('sort', state.sort);
  const qs = params.toString();
  const target = slug ? `#/p/${encodeURIComponent(slug)}` : `#/${qs ? `?${qs}` : ''}`;
  if (location.hash !== target) history.replaceState(null, '', target);
}


function filteredRows(state) {
  let rows = R.rows.slice();
  if (state.watch) rows = rows.filter((r) => r[C.watch] === 1);
  if (state.cat) rows = rows.filter((r) => (r[C.cat] || 'Uncategorised') === state.cat);
  if (state.chain) rows = rows.filter((r) => r[C.chains].includes(state.chain));
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => r[C.name].toLowerCase().includes(q) || r[C.slug].toLowerCase().includes(q));
  }
  const by = {
    implied: (a, b) => b[C.val] - a[C.val],
    tvl: (a, b) => b[C.tvl] - a[C.tvl],
    change: (a, b) => (b[C.chg] ?? -Infinity) - (a[C.chg] ?? -Infinity),
    age: (a, b) => String(a[C.listed] || '9999').localeCompare(String(b[C.listed] || '9999')),
    name: (a, b) => a[C.name].localeCompare(b[C.name]),
  };
  rows.sort(by[state.sort] || by.implied);
  return rows;
}

function renderBoard(state) {
  const rows = filteredRows(state);
  $('showing').textContent = `Showing ${rows.length} of ${R.rows.length} protocols`;
  const tb = $('boardTable').querySelector('tbody');
  tb.innerHTML = rows
    .map(
      (r) => `<tr data-slug="${esc(r[C.slug])}"${r[C.rank] <= 3 ? ' class="top"' : ''}>
        <td class="rank num">${r[C.rank]}</td>
        <td class="proto"><b>${esc(r[C.name])}</b>${r[C.watch] ? '<span class="badge">Watchlist</span>' : ''}<small>${esc(r[C.slug])}</small></td>
        <td class="cat">${esc(r[C.cat] || 'Uncategorised')}</td>
        <td class="chains">${esc(r[C.chains].slice(0, 3).join(', '))}${r[C.chains].length > 3 ? ` +${r[C.chains].length - 3}` : ''}</td>
        <td class="num">${fmtUsd(r[C.tvl])}</td>
        <td class="num">${fmtPct(r[C.chg])}</td>
        <td class="num val"><span class="v">${fmtUsd(r[C.val])}</span><span class="band">${fmtUsd(r[C.lo])} – ${fmtUsd(r[C.hi])}</span><span class="bar"><i style="width:${Math.max(2, (r[C.val] / maxVal) * 100).toFixed(1)}%"></i></span></td>
        <td class="num">${(r[C.mult] / 1000).toFixed(3)}×</td>
        <td class="num">${ageText(r[C.listed])}</td>
      </tr>`,
    )
    .join('');
  tb.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => showDetail(tr.dataset.slug));
  });
}


function renderDetail(row) {
  const steps = farmSteps(row);
  const curve = row[C.val] / (row[C.adj] / 100); // the curve component: implied value with the category adjustment divided back out
  const adj = row[C.adj] / 100;
  const offRow = M.offsets.find(([c]) => c === row[C.cat]);
  const lo = Math.log(row[C.lo]), hi = Math.log(row[C.hi]), v = Math.log(row[C.val]);
  const markPct = hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50;
  $('detailView').innerHTML = `
    <div class="card detail">
      <div class="detail-head">
        <div>
          <h2>${esc(row[C.name])}${row[C.watch] ? '<span class="badge">Watchlist</span>' : ''}</h2>
          <p class="detail-sub">${esc(row[C.slug])} &middot; ${esc(row[C.cat] || 'Uncategorised')} &middot; ${esc(row[C.chains].join(', ') || 'chain n/a')} &middot; rank #${row[C.rank]} of ${R.rows.length}</p>
        </div>
        <a class="back" href="#/">&larr; Back to the board</a>
      </div>
      <div class="kpis">
        <div class="kpi"><b>${fmtFull(row[C.val])}</b><span>Implied launch value</span></div>
        <div class="kpi"><b>${fmtUsd(row[C.lo])} – ${fmtUsd(row[C.hi])}</b><span>80% model band</span></div>
        <div class="kpi"><b>${fmtFull(row[C.tvl])}</b><span>TVL in snapshot</span></div>
        <div class="kpi"><b>${row[C.chg] === null ? 'n/a' : `${row[C.chg] > 0 ? '+' : ''}${row[C.chg].toFixed(1)}%`}</b><span>TVL change, 7d</span></div>
        <div class="kpi"><b>${ageText(row[C.listed])}</b><span>Running with no token</span></div>
      </div>
      <div class="bandbar">
        <div class="track"><span class="mark" style="left:${markPct.toFixed(1)}%"></span></div>
        <div class="ends"><span>low <b>${fmtFull(row[C.lo])}</b></span><span>model value <b>${fmtFull(row[C.val])}</b></span><span>high <b>${fmtFull(row[C.hi])}</b></span></div>
      </div>
      <p class="why">Why this value: the fitted curve prices a launch at TVL <b>${fmtUsd(row[C.tvl])}</b> as
        <b>${fmtFull(Math.round(curve))}</b> (log value = ${M.intercept.toFixed(2)} + ${M.slope.toFixed(2)} &times; log TVL, fit on
        ${M.nTrain} launched protocols)${offRow
          ? `, adjusted <b>${adj.toFixed(2)}&times;</b> by the shrunk ${esc(row[C.cat])} category offset (${offRow[1]} launched peers)`
          : ', with <b>no category adjustment</b> (fewer than three launched peers in its category to fit one)'}
        &asymp; <b>${fmtFull(row[C.val])}</b>. That is <b>${(row[C.mult] / 1000).toFixed(3)}&times;</b> per TVL dollar. The band is where
        80% of the model's held-out pricing errors landed — launches scatter widely around any curve, and this board shows the scatter
        instead of hiding it. Nothing about ${esc(row[C.name])} itself is in the model: only its TVL and category are.</p>
      <h3>Farm plan</h3>
      <ol class="farm">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>`;
}


function showDetail(slug) {
  const row = bySlug.get(slug);
  if (!row) return;
  writeState(readState(), slug);
  renderDetail(row);
  $('boardView').hidden = true;
  $('detailView').hidden = false;
  $('detailView').scrollIntoView();
}
function showBoard() {
  const state = readState();
  $('q').value = state.q;
  $('cat').value = state.cat;
  $('chain').value = state.chain;
  $('watch').checked = state.watch;
  $('sort').value = state.sort;
  renderBoard(state);
  $('detailView').hidden = true;
  $('boardView').hidden = false;
}
function route() {
  const state = readState();
  if (state.slug && bySlug.has(state.slug)) showDetail(state.slug);
  else showBoard();
}
function init() {
  $('mastStats').innerHTML = [
    [R.counts.board, 'pre-token protocols ranked'],
    [R.counts.watchlist, 'on the snapshot watchlist'],
    [R.counts.protocols, 'protocols in the snapshot'],
    [R.asOf, 'snapshot date'],
  ]
    .map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
    .join('');
  renderModel();
  const cats = [...new Set(R.rows.map((r) => r[C.cat] || 'Uncategorised'))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r[C.chains]))].sort();
  $('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  const current = () => ({ q: $('q').value.trim(), cat: $('cat').value, chain: $('chain').value, watch: $('watch').checked, sort: $('sort').value });
  for (const id of ['q', 'cat', 'chain', 'watch', 'sort']) {
    $(id).addEventListener('input', () => {
      const s = current();
      writeState(s, null);
      renderBoard(s);
    });
  }
  window.addEventListener('hashchange', route);
  route();
}
init();
