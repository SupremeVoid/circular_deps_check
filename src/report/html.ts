import type { AnalysisResult } from '../types.js';
import { toJsonReport } from './json.js';

/**
 * Self-contained HTML report (no external assets). All rendering happens client-side from the
 * embedded JSON so the file stays small even for large projects.
 */
export const renderHtmlReport = (result: AnalysisResult, version: string): string => {
  const data = toJsonReport(result, version);
  const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const title = `Circular dependencies – ${data.root.split('/').pop() ?? data.root}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"><noscript>This report needs JavaScript.</noscript></div>
<script id="report-data" type="application/json">${json}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1c2128; --muted: #5b6573; --border: #e3e6ea; --code: #f0f2f5;
  --critical: #c62828; --high: #d84315; --medium: #b8860b; --low: #1f7a8c; --info: #6b7280;
  --eager: #c62828; --deferred: #b8860b; --type: #8a939e; --none: #8a939e; --barrel: #7b3fa0; --ok: #2e7d32;
  --accent: #2456c4; --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1216; --panel: #171b21; --text: #e6e9ee; --muted: #9aa4b2; --border: #2a313b; --code: #0b0e12;
    --critical: #ff6b6b; --high: #ff8a65; --medium: #e6c15a; --low: #4fb3c8; --info: #9aa4b2;
    --eager: #ff6b6b; --deferred: #e6c15a; --type: #8a939e; --none: #8a939e; --barrel: #c48be8; --ok: #66bb6a; --accent: #7aa2ff;
    --shadow: 0 1px 2px rgba(0,0,0,.4); }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
a { color: var(--accent); }
header { padding: 20px 28px 12px; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 5; }
header h1 { margin: 0 0 2px; font-size: 20px; }
header .sub { color: var(--muted); font-size: 12.5px; }
main { padding: 20px 28px 60px; max-width: 1400px; margin: 0 auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; box-shadow: var(--shadow); cursor: pointer; transition: transform .08s; }
.card:hover { transform: translateY(-1px); }
.card.off { opacity: .45; }
.card .n { font-size: 26px; font-weight: 700; }
.card .l { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.card .d { font-size: 12px; color: var(--muted); margin-top: 2px; }
.card.critical .n { color: var(--critical); } .card.high .n { color: var(--high); } .card.medium .n { color: var(--medium); } .card.low .n { color: var(--low); } .card.info .n { color: var(--info); }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 8px 0 16px; }
.tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 14px; color: var(--muted); font-size: 14px; cursor: pointer; }
.tabs button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.toolbar input[type=search] { flex: 1; min-width: 220px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }
.toolbar label { font-size: 12.5px; color: var(--muted); display: flex; gap: 4px; align-items: center; }
.finding { background: var(--panel); border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 10px; padding: 14px 18px; margin-bottom: 14px; box-shadow: var(--shadow); }
.finding.critical { border-left-color: var(--critical); } .finding.high { border-left-color: var(--high); } .finding.medium { border-left-color: var(--medium); } .finding.low { border-left-color: var(--low); }
.finding h3 { margin: 0; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.finding h3 .id { color: var(--muted); font-weight: 500; font-size: 12.5px; }
.finding .summary { margin: 6px 0 4px; color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #fff; background: var(--info); }
.badge.critical { background: var(--critical); } .badge.high { background: var(--high); } .badge.medium { background: var(--medium); } .badge.low { background: var(--low); }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; }
.tag.eager { color: var(--eager); } .tag.deferred { color: var(--deferred); } .tag.type { color: var(--type); } .tag.none { color: var(--none); } .tag.barrel { color: var(--barrel); }
.tag.ok { color: var(--ok); }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 13px; }
.grid2 { display: grid; grid-template-columns: minmax(340px, 560px) 1fr; gap: 18px; align-items: start; margin-top: 10px; }
@media (max-width: 1000px) { .grid2 { grid-template-columns: 1fr; } }
.section-title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 12px 0 6px; font-weight: 700; }
.failure { background: var(--code); border-radius: 8px; padding: 10px 12px; margin: 6px 0; border: 1px solid var(--border); }
.failure .loc { font-weight: 600; }
.failure pre { margin: 6px 0; white-space: pre-wrap; word-break: break-all; }
.failure .why { color: var(--muted); font-size: 12.5px; }
.chain { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 12.5px; }
.chain .node { padding: 2px 8px; border-radius: 6px; background: var(--code); border: 1px solid var(--border); }
.chain .node.start { border-color: var(--medium); color: var(--medium); font-weight: 600; }
.chain .node.end { border-color: var(--critical); color: var(--critical); font-weight: 600; }
.chain .arrow { color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
tr.fail td { background: color-mix(in srgb, var(--critical) 10%, transparent); }
.sugg { margin: 4px 0; padding-left: 4px; }
.sugg .v { color: var(--ok); font-weight: 700; } .sugg .u { color: var(--medium); font-weight: 700; }
.sugg .details { color: var(--muted); font-size: 12.5px; margin-left: 20px; }
svg text { font-size: 11px; fill: var(--text); paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
svg .lbl { font-size: 10px; fill: var(--muted); }
svg .node-lbl { font-size: 11px; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend span::before { content: ""; display: inline-block; width: 18px; height: 3px; margin-right: 5px; vertical-align: middle; border-radius: 2px; background: currentColor; }
.group { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px; margin-bottom: 12px; box-shadow: var(--shadow); }
.group h3 { margin: 0; font-size: 15px; }
.files { columns: 3; column-gap: 20px; font-size: 12.5px; }
@media (max-width: 900px) { .files { columns: 1; } }
.files div { break-inside: avoid; }
.muted { color: var(--muted); }
.empty { padding: 30px; text-align: center; color: var(--muted); background: var(--panel); border: 1px dashed var(--border); border-radius: 10px; }
.howto h3 { margin-top: 18px; }
.howto p, .howto li { max-width: 900px; }
.kbd { background: var(--code); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.cut { font-size: 12.5px; padding: 3px 0; }
.mini { margin: 6px 0 12px; border: 1px solid var(--border); border-radius: 8px; padding: 6px; background: var(--code); }
`;

const CLIENT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var state = { tab: 'findings', sev: { critical: true, high: true, medium: true, low: true, info: false }, q: '', verifiedOnly: false };
  var app = document.getElementById('app');

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function md(s) { return esc(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>'); }
  function short(p) { var parts = p.split('/'); return parts.length > 2 ? parts.slice(-2).join('/') : p; }
  function base(p) { return p.split('/').pop(); }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'html') el.innerHTML = attrs[k]; else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]); else el.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (ch) { if (ch == null) return; el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch); });
    return el;
  }
  function tag(kind, text) { return '<span class="tag ' + kind + '">' + esc(text || kind) + '</span>'; }
  function usageLabel(u) { return u === 'eager' ? 'eager' : u === 'deferred' ? 'deferred' : u === 'type' ? 'type-only' : 'no binding use'; }

  // ---------------------------------------------------------------- SVG ring diagram
  function ring(nodes, edges, failing, width) {
    // Layout: nodes on a ring; edges bend outward; edge labels sit on the ring between the two
    // nodes they connect, file names sit further out. Everything radial, so labels never meet.
    var n = nodes.length; var R = Math.max(90, Math.min(160, 60 + n * 14));
    var W = width || 2 * (R + 175); var H = 2 * (R + 78);
    var cx = W / 2, cy = H / 2; var pos = {};
    nodes.forEach(function (node, i) { var a = -Math.PI / 2 + (2 * Math.PI * i) / n; pos[node] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; });
    var showAll = n <= 8;
    function trunc(t, max) { return t.length > max ? t.slice(0, max - 1) + '…' : t; }
    function place(x, y) { // text anchor + baseline from the position relative to the centre
      var anchor = Math.abs(x - cx) < 14 ? 'middle' : x < cx ? 'end' : 'start';
      var dy = Math.abs(x - cx) < 14 ? (y < cy ? -4 : 12) : 4;
      return { anchor: anchor, dy: dy };
    }
    var colors = { eager: 'var(--eager)', deferred: 'var(--deferred)', type: 'var(--type)', none: 'var(--none)' };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;display:block;margin:auto">';
    s += '<defs>';
    ['eager', 'deferred', 'type', 'none', 'fail'].forEach(function (k) {
      s += '<marker id="m-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + (k === 'fail' ? 'var(--critical)' : colors[k]) + '"/></marker>';
    });
    s += '</defs>';
    edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
      var isFail = failing.some(function (f) { return f.from === e.from && f.to === e.to; });
      var col = isFail ? 'var(--critical)' : colors[e.usage] || colors.none;
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len; var pad = 22;
      var x1 = a.x + ux * pad, y1 = a.y + uy * pad, x2 = b.x - ux * pad, y2 = b.y - uy * pad;
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      // Outward direction: radial from the centre through the chord midpoint. For two nodes the
      // midpoint is the centre, so fall back to the edge's perpendicular (opposite for each direction).
      var rx = mx - cx, ry = my - cy, rl = Math.sqrt(rx * rx + ry * ry);
      var ox, oy;
      if (n === 2 || rl < 1) { ox = -uy; oy = ux; } else { ox = rx / rl; oy = ry / rl; }
      var bend = n === 2 ? 44 : Math.max(14, (R - rl) * 0.9);
      var cxp = mx + ox * bend, cyp = my + oy * bend;
      s += '<path d="M' + x1 + ',' + y1 + ' Q' + cxp + ',' + cyp + ' ' + x2 + ',' + y2 + '" fill="none" stroke="' + col + '" stroke-width="' + (isFail ? 3 : e.usage === 'eager' ? 2 : 1.5) + '" ' + (e.usage === 'type' || e.usage === 'none' ? 'stroke-dasharray="4 3" ' : '') + 'marker-end="url(#m-' + (isFail ? 'fail' : (colors[e.usage] ? e.usage : 'none')) + ')"><title>' + esc(e.from + ' → ' + e.to + ' { ' + e.symbols.join(', ') + ' } ' + usageLabel(e.usage)) + '</title></path>';
      if (!showAll && !isFail && e.usage !== 'eager') return; // big rings: only the labels that matter
      // Label just outside the curve's apex (the apex is at the quadratic's t=0.5 point).
      var ax = (x1 + 2 * cxp + x2) / 4, ay = (y1 + 2 * cyp + y2) / 4;
      var lx = ax + ox * 10, ly = ay + oy * 10;
      var pl = place(lx, ly);
      var label = trunc(e.symbols.slice(0, 2).join(', ') + (e.symbols.length > 2 ? ' +' + (e.symbols.length - 2) : ''), 24);
      if (isFail) label = '⚡ ' + label;
      s += '<text class="lbl" x="' + lx + '" y="' + (ly + pl.dy) + '" text-anchor="' + pl.anchor + '" style="' + (isFail ? 'fill:var(--critical);font-weight:700' : '') + '"><title>' + esc(e.symbols.join(', ')) + '</title>' + esc(label) + '</text>';
    });
    nodes.forEach(function (node) {
      var p = pos[node]; var isFailNode = failing.some(function (f) { return f.from === node; });
      var isBarrel = edges.some(function (e) { return e.to === node && e.viaBarrel; });
      s += '<g><circle cx="' + p.x + '" cy="' + p.y + '" r="16" fill="var(--panel)" stroke="' + (isFailNode ? 'var(--critical)' : isBarrel ? 'var(--barrel)' : 'var(--muted)') + '" stroke-width="' + (isFailNode ? 3 : 1.5) + '"><title>' + esc(node) + '</title></circle>';
      // File name radially outside the node, beyond the edge labels.
      var nx = (p.x - cx) / R, ny = (p.y - cy) / R;
      var tx = p.x + nx * 44, ty = p.y + ny * 44;
      var np = place(tx, ty);
      s += '<text class="node-lbl" x="' + tx + '" y="' + (ty + np.dy) + '" text-anchor="' + np.anchor + '" style="' + (isFailNode ? 'font-weight:700' : '') + '"><title>' + esc(node) + '</title>' + esc(trunc(/^index\.[cm]?tsx?$/.test(base(node)) ? short(node) : base(node), 28)) + '</text></g>';
    });
    s += '</svg>';
    return s;
  }
  var LEGEND = '<div class="legend"><span style="color:var(--critical)">breaking edge</span><span style="color:var(--eager)">eager use</span><span style="color:var(--deferred)">deferred use</span><span style="color:var(--type)">type-only / no binding use</span><span style="color:var(--barrel)">barrel file</span></div>';

  // ---------------------------------------------------------------- header + cards
  function renderHeader() {
    var st = data.stats;
    var sub = num(st.files) + ' files · ' + num(st.loc) + ' lines · ' + num(st.edges) + ' import edges (' + num(st.runtimeEdges) + ' runtime, ' + num(st.erasedEdges) + ' erased type-only, ' + num(st.dynamicEdges) + ' dynamic) · ' + st.durationMs + ' ms · generated ' + new Date(data.generatedAt).toLocaleString();
    var entries = 'Entries: ' + (data.options.entries.length ? data.options.entries.join(', ') : '<span style="color:var(--medium)">none (pass --entry src/main.ts)</span>') + (data.options.testEntries.length ? ' · ' + num(data.options.testEntries.length) + ' test entries' : '') + (data.options.emitDecoratorMetadata ? ' · emitDecoratorMetadata on' : '');
    return h('header', {}, [h('h1', {}, ['Circular dependency report ', h('span', { class: 'muted', style: 'font-weight:400;font-size:14px' }, [data.root])]), h('div', { class: 'sub', html: esc(sub) }), h('div', { class: 'sub', html: entries })]);
  }
  var SEV_DESC = { critical: 'load-time crash from app entry', high: 'DI cycle / crash from tests', medium: 'order-dependent (eager use)', low: 'deferred usage only', info: 'type-only (erased)' };
  function renderCards() {
    var wrap = h('div', { class: 'cards' });
    ['critical', 'high', 'medium', 'low', 'info'].forEach(function (sev) {
      var card = h('div', { class: 'card ' + sev + (state.sev[sev] ? '' : ' off'), onclick: function () { state.sev[sev] = !state.sev[sev]; render(); } }, [h('div', { class: 'n' }, [String(data.counts[sev] || 0)]), h('div', { class: 'l' }, [sev]), h('div', { class: 'd' }, [SEV_DESC[sev]])]);
      wrap.appendChild(card);
    });
    var st = data.stats;
    wrap.appendChild(h('div', { class: 'card', onclick: function () { state.tab = 'groups'; render(); } }, [h('div', { class: 'n' }, [String(st.sccs)]), h('div', { class: 'l' }, ['cyclic groups']), h('div', { class: 'd' }, [num(st.cyclicFiles) + ' files · ' + num(st.cycles) + ' cycles'])]));
    return wrap;
  }
  function renderTabs() {
    var t = h('div', { class: 'tabs' });
    [['findings', 'Findings (' + data.findings.length + ')'], ['groups', 'Cyclic groups (' + data.groups.length + ')'], ['entries', 'Entry points (' + data.entries.length + ')'], ['howto', 'How to read this']].forEach(function (p) {
      t.appendChild(h('button', { class: state.tab === p[0] ? 'active' : '', onclick: function () { state.tab = p[0]; render(); } }, [p[1]]));
    });
    return t;
  }

  // ---------------------------------------------------------------- findings
  function findingMatches(f) {
    if (!state.sev[f.severity]) return false;
    if (state.verifiedOnly && !f.suggestions.some(function (s) { return s.verified; })) return false;
    if (state.q) { var q = state.q.toLowerCase(); var hay = (f.title + ' ' + f.summary + ' ' + (f.cycle ? f.cycle.nodes.join(' ') : '') + ' ' + (f.di ? f.di.nodes.map(function (n) { return n.name; }).join(' ') : '')).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
    return true;
  }
  function renderFindings() {
    var wrap = h('div');
    var tb = h('div', { class: 'toolbar' }, [
      h('input', { type: 'search', placeholder: 'Filter by file, symbol or text…', value: state.q, oninput: function (e) { state.q = e.target.value; renderList(); } }),
      h('label', {}, [h('input', { type: 'checkbox', onchange: function (e) { state.verifiedOnly = e.target.checked; renderList(); } }), 'verified fixes only'])
    ]);
    if (state.verifiedOnly) tb.querySelector('input[type=checkbox]').checked = true;
    wrap.appendChild(tb);
    var list = h('div');
    wrap.appendChild(list);
    function renderList() {
      list.innerHTML = '';
      var shown = data.findings.filter(findingMatches);
      if (shown.length === 0) { list.appendChild(h('div', { class: 'empty' }, [data.findings.length === 0 ? 'No cycles found. 🎉' : 'Nothing matches the current filter.'])); return; }
      shown.forEach(function (f) { list.appendChild(renderFinding(f)); });
    }
    renderList();
    return wrap;
  }
  function chainHtml(chain, ancestor) {
    return '<div class="chain">' + chain.map(function (p, i) { var isAnc = p === ancestor; var cls = isAnc ? 'start' : i === chain.length - 1 ? 'end' : ''; return (i > 0 ? '<span class="arrow">→</span>' : '') + '<span class="node ' + cls + '" title="' + esc(p) + '">' + esc(short(p)) + (isAnc ? ' ⟳' : i === chain.length - 1 ? ' ✖' : '') + '</span>'; }).join('') + '</div>';
  }
  function renderFinding(f) {
    var el = h('div', { class: 'finding ' + f.severity, id: f.id });
    el.appendChild(h('h3', { html: '<span class="badge ' + f.severity + '">' + f.severity + '</span><span class="id">' + f.id + '</span><span>' + md(f.title) + '</span>' }));
    el.appendChild(h('div', { class: 'summary', html: md(f.summary) }));

    if (f.failures.length) {
      el.appendChild(h('div', { class: 'section-title' }, ['Point of failure']));
      f.failures.slice(0, 6).forEach(function (fp) {
        var why = '<code>' + esc(fp.symbol) + '</code> (' + esc(fp.originKind) + ') is declared in <code>' + esc(fp.originPath || fp.to) + '</code>, which ' + (fp.state === 'tdz' ? 'is still initialising at this point → temporal dead zone → <b>ReferenceError: Cannot access \\'' + esc(fp.symbol) + '\\' before initialization</b>' : 'has not run yet → the binding is <b>undefined</b>') + '. Context: ' + esc(fp.context) + '.';
        el.appendChild(h('div', { class: 'failure', html: '<div class="loc mono">' + esc(fp.from) + ':' + fp.line + ':' + fp.column + '</div><pre>' + esc(fp.snippet) + '</pre><div class="why">' + why + '</div>' }));
      });
      var entries = {}; f.failures.forEach(function (fp) { fp.entries.forEach(function (e) { if (!entries[e.entry]) entries[e.entry] = e; }); });
      var app = Object.keys(entries).filter(function (k) { return entries[k].kind !== 'test'; });
      var tests = Object.keys(entries).filter(function (k) { return entries[k].kind === 'test'; });
      var ancestor = f.failures[0].to;
      if (app.length) {
        var first = entries[app[0]];
        el.appendChild(h('div', { class: 'section-title' }, ['Evaluation order from ' + app[0] + (first.kind === 'lazy' ? ' (lazy chunk)' : '')]));
        el.appendChild(h('div', { html: chainHtml(first.chain, ancestor) }));
        el.appendChild(h('div', { class: 'muted', style: 'font-size:12.5px;margin-top:4px' }, [short(ancestor) + ' starts loading and reaches ' + short(f.failures[0].from) + ' through its imports; that module reads back from ' + short(ancestor) + ' before its body has finished running.']));
        if (app.length > 1) el.appendChild(h('div', { class: 'muted', style: 'font-size:12.5px' }, ['Also reachable from: ' + app.slice(1, 6).join(', ') + (app.length > 6 ? ' +' + (app.length - 6) : '')]));
      }
      if (tests.length) {
        var d = h('details', {}, [h('summary', {}, [(app.length ? 'Also breaks' : 'Breaks') + ' in ' + tests.length + ' test file' + (tests.length === 1 ? '' : 's')])]);
        if (!app.length) d.appendChild(h('div', { html: chainHtml(entries[tests[0]].chain, ancestor), style: 'margin:6px 0' }));
        d.appendChild(h('div', { class: 'mono', style: 'font-size:12px;columns:2', html: tests.slice(0, 60).map(function (t) { return '<div>' + esc(t) + '</div>'; }).join('') + (tests.length > 60 ? '<div>… +' + (tests.length - 60) + '</div>' : '') }));
        el.appendChild(d);
      }
    }

    if (f.cycle) {
      var failing = f.failures.map(function (fp) { return { from: fp.from, to: fp.to }; });
      var grid = h('div', { class: 'grid2' });
      grid.appendChild(h('div', { html: '<div class="section-title">Cycle (' + f.cycle.nodes.length + ' files, group #' + f.sccId + ')</div>' + ring(f.cycle.nodes, f.cycle.edges, failing) + LEGEND }));
      var rows = f.cycle.edges.map(function (e) {
        var isFail = failing.some(function (x) { return x.from === e.from && x.to === e.to; });
        return '<tr class="' + (isFail ? 'fail' : '') + '"><td class="mono" title="' + esc(e.from) + '">' + esc(short(e.from)) + '</td><td class="mono" title="' + esc(e.to) + '">' + esc(short(e.to)) + (e.viaBarrel ? ' ' + tag('barrel', 'barrel') : '') + '</td><td class="mono">' + esc(e.symbols.slice(0, 6).join(', ')) + (e.symbols.length > 6 ? ' …' : '') + '</td><td>' + tag(e.usage === 'none' ? 'none' : e.usage, usageLabel(e.usage)) + (isFail ? ' ⚡' : '') + '</td><td class="muted">' + (e.sample && e.usage !== 'none' ? esc(e.sample.context) + ' <span class="mono">L' + e.sample.line + '</span>' : '') + '</td></tr>';
      }).join('');
      grid.appendChild(h('div', { html: '<div class="section-title">Edges</div><table><thead><tr><th>From</th><th>Imports from</th><th>Symbols</th><th>Use</th><th>Where</th></tr></thead><tbody>' + rows + '</tbody></table>' }));
      el.appendChild(grid);
    }

    if (f.di) {
      var rowsDi = f.di.edges.map(function (e) { return '<tr><td><b>' + esc(e.from) + '</b> needs <b>' + esc(e.to) + '</b></td><td class="mono">' + esc(e.path) + ':' + e.line + '</td><td>' + esc(e.via) + (e.flags.length ? ' (' + e.flags.map(function (x) { return '@' + x; }).join(' ') + ')' : '') + '</td></tr>'; }).join('');
      var nodesDi = f.di.nodes.map(function (n) { return n.path ? n.path + '#' + n.name : n.name; });
      var edgesDi = f.di.edges.map(function (e, i) { return { from: nodesDi[i], to: nodesDi[(i + 1) % nodesDi.length], usage: 'eager', symbols: [e.via], viaBarrel: false }; });
      var gridDi = h('div', { class: 'grid2' });
      gridDi.appendChild(h('div', { html: '<div class="section-title">Injection cycle</div>' + ring(nodesDi.map(function (n, i) { return f.di.nodes[i].name; }), edgesDi.map(function (e, i) { return { from: f.di.nodes[i].name, to: f.di.nodes[(i + 1) % f.di.nodes.length].name, usage: 'eager', symbols: [f.di.edges[i] ? f.di.edges[i].via : ''], viaBarrel: false }; }), []) }));
      gridDi.appendChild(h('div', { html: '<div class="section-title">Injection sites</div><table><thead><tr><th>Dependency</th><th>Location</th><th>Via</th></tr></thead><tbody>' + rowsDi + '</tbody></table>' }));
      el.appendChild(gridDi);
    }

    if (f.suggestions.length) {
      el.appendChild(h('div', { class: 'section-title' }, ['How to fix']));
      f.suggestions.forEach(function (s) {
        el.appendChild(h('div', { class: 'sugg', html: '<span class="' + (s.verified ? 'v' : 'u') + '">' + (s.verified ? '✔ verified' : '•') + '</span> ' + md(s.text) + (s.details && s.details.length ? '<div class="details">' + s.details.map(function (d) { return '<div>' + md(d) + '</div>'; }).join('') + '</div>' : '') }));
      });
    }
    return el;
  }

  // ---------------------------------------------------------------- groups
  function renderGroups() {
    var wrap = h('div');
    if (!data.groups.length && !data.typeOnlyGroups.length) { wrap.appendChild(h('div', { class: 'empty' }, ['No cyclic groups.'])); return wrap; }
    data.groups.forEach(function (g) { wrap.appendChild(renderGroup(g, false)); });
    if (data.typeOnlyGroups.length) {
      wrap.appendChild(h('div', { class: 'section-title' }, ['Type-only groups (erased at compile time)']));
      data.typeOnlyGroups.forEach(function (g) { wrap.appendChild(renderGroup(g, true)); });
    }
    return wrap;
  }
  function renderGroup(g, typeOnly) {
    var el = h('div', { class: 'group' });
    var findings = data.findings.filter(function (f) { return f.sccId === g.id; });
    var sevCounts = {}; findings.forEach(function (f) { sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1; });
    var badges = Object.keys(sevCounts).map(function (s) { return '<span class="badge ' + s + '">' + sevCounts[s] + ' ' + s + '</span>'; }).join(' ');
    el.appendChild(h('h3', { html: 'Group #' + g.id + ' <span class="muted" style="font-weight:400">– ' + g.files.length + ' files · ' + g.edgeCount + ' edges · ' + g.cycles.length + (g.truncated ? '+' : '') + ' cycles' + (g.barrels.length ? ' · ' + g.barrels.length + ' barrel' + (g.barrels.length === 1 ? '' : 's') : '') + (typeOnly ? ' · type-only' : '') + '</span> ' + badges }));
    var plan = data.fixPlans.filter(function (p) { return p.sccId === g.id; })[0];
    if (plan && plan.cuts.length) {
      var d = h('details', { open: '' }, [h('summary', {}, ['Fix plan: cut ' + plan.cuts.length + ' edge' + (plan.cuts.length === 1 ? '' : 's') + (plan.verified ? ' (verified: group becomes acyclic)' : ' (incomplete)')])]);
      plan.cuts.forEach(function (cut) { d.appendChild(h('div', { class: 'cut', html: '✂ <span class="mono" title="' + esc(cut.from) + '">' + esc(short(cut.from)) + '</span> <span class="muted">→</span> <span class="mono" title="' + esc(cut.to) + '">' + esc(short(cut.to)) + '</span> <span class="muted mono">{ ' + esc(cut.symbols.slice(0, 5).join(', ')) + (cut.symbols.length > 5 ? ', …' : '') + ' }</span> ' + tag(cut.usage === 'none' ? 'none' : cut.usage, usageLabel(cut.usage)) + ' <span class="muted">' + esc(cut.reason) + '</span>' })); });
      el.appendChild(d);
    }
    var files = h('details', {}, [h('summary', {}, ['Files (' + g.files.length + ')'])]);
    files.appendChild(h('div', { class: 'files mono', html: g.files.map(function (f) { return '<div>' + (g.barrels.indexOf(f) >= 0 ? tag('barrel', 'barrel') + ' ' : '') + esc(f) + '</div>'; }).join('') }));
    el.appendChild(files);
    var cyc = h('details', {}, [h('summary', {}, ['Cycles (' + g.cycles.length + (g.truncated ? ', truncated' : '') + ')'])]);
    var cycList = h('div');
    cyc.appendChild(cycList);
    var rendered = 0;
    function more() {
      var slice = g.cycles.slice(rendered, rendered + 20);
      slice.forEach(function (cy) {
        var row = h('div', { class: 'mini' });
        var txt = cy.nodes.map(function (n, i) { var e = cy.edges[i]; return '<span class="mono" title="' + esc(n) + '">' + esc(short(n)) + '</span>' + (e ? ' <span class="muted">→</span> ' + tag(e.usage === 'none' ? 'none' : e.usage, usageLabel(e.usage)) + (e.viaBarrel ? tag('barrel', 'barrel') : '') + ' ' : ''); }).join('') + ' <span class="muted">→ ' + esc(short(cy.nodes[0])) + '</span>';
        row.appendChild(h('div', { html: txt }));
        cycList.appendChild(row);
      });
      rendered += slice.length;
      if (rendered < g.cycles.length) { var btn = h('button', { onclick: function () { btn.remove(); more(); } }, ['Show more (' + (g.cycles.length - rendered) + ' left)']); cycList.appendChild(btn); }
    }
    cyc.addEventListener('toggle', function () { if (cyc.open && rendered === 0) more(); });
    el.appendChild(cyc);
    return el;
  }

  // ---------------------------------------------------------------- entries
  function renderEntries() {
    var wrap = h('div', { class: 'group' });
    if (!data.entries.length) { wrap.appendChild(h('div', { class: 'empty' }, ['No entry points evaluated. Pass --entry src/main.ts (and keep spec files included) to simulate the load order.'])); return wrap; }
    var rows = data.entries.map(function (e) { return '<tr><td class="mono">' + esc(e.entry) + '</td><td>' + esc(e.kind) + '</td><td>' + num(e.evaluated) + '</td><td>' + (e.breakages ? '<b style="color:var(--critical)">' + e.breakages + '</b>' : '0') + '</td></tr>'; }).join('');
    wrap.appendChild(h('div', { html: '<table><thead><tr><th>Entry</th><th>Kind</th><th>Modules evaluated</th><th>Back-edges with uninitialised bindings</th></tr></thead><tbody>' + rows + '</tbody></table>' }));
    if (data.unresolved.length) {
      var d = h('details', {}, [h('summary', {}, ['Unresolved imports (' + data.unresolved.length + ')'])]);
      d.appendChild(h('div', { class: 'mono', style: 'font-size:12px', html: data.unresolved.slice(0, 200).map(function (u) { return '<div>' + esc(u.from) + ':' + u.line + ' → ' + esc(u.specifier) + '</div>'; }).join('') }));
      wrap.appendChild(d);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- how to
  function renderHowto() {
    return h('div', { class: 'group howto', html: [
      '<h3>What this report shows</h3>',
      '<p>A circular import is only a problem when a module <em>reads</em> a binding from another module before that module finished running. This tool replays the ES-module evaluation order from your entry points (<code>main.ts</code>, lazy route chunks, every spec file) and flags exactly those reads.</p>',
      '<h3>Severities</h3>',
      '<ul><li><b>Critical</b> – a binding is read at load time while its module is still initialising, on the path from the application entry. This throws <code>ReferenceError: Cannot access X before initialization</code> (native ESM / Vite / vitest) or leaves <code>X</code> undefined (bundled by esbuild/webpack, e.g. <code>Class extends value undefined</code>, <code>Invalid provider … undefined</code>).</li>',
      '<li><b>High</b> – Angular DI cycles (NG0200: two injectables need each other during construction) and load-time crashes that only occur when a spec file is the entry point (the classic “works in the app, fails in tests”).</li>',
      '<li><b>Medium</b> – a cycle where some edge is used eagerly, but the current entry points happen to evaluate the modules in a safe order. Any new import, barrel reorder or spec can flip the order.</li>',
      '<li><b>Low</b> – all bindings are used inside functions, methods or instance fields (deferred), or only barrels/side-effect imports are involved. Works, but fragile.</li>',
      '<li><b>Info</b> – files that reference each other only in type positions. TypeScript and esbuild erase these imports entirely; nothing happens at runtime.</li></ul>',
      '<h3>Eager vs. deferred vs. type-only</h3>',
      '<ul><li><b>Eager</b>: top-level statements, <code>extends</code> clauses, decorator arguments (<code>@Component({ imports, providers })</code>, <code>@NgModule</code>), static fields, enum initialisers, route arrays, and functions that are called at module load.</li>',
      '<li><b>Deferred</b>: inside function bodies, methods, constructors, instance field initialisers (including <code>inject()</code> calls), arrow functions, <code>forwardRef(() =&gt; X)</code>, <code>loadComponent: () =&gt; import(...)</code>.</li>',
      '<li><b>Type-only</b>: type annotations, <code>implements</code>, generics, <code>import type</code>. Erased at compile time.</li></ul>',
      '<h3>Why “use <code>import type</code>” is usually pointless advice</h3>',
      '<p>If an import is only used as a type, TypeScript (with <code>isolatedModules</code>) and esbuild already drop it – the edge does not exist at runtime and it never shows up as more than <em>info</em> here. Where an import is used as a value (a class in <code>extends</code>, a component in <code>imports</code>, a service in <code>inject()</code>) you cannot switch it to <code>import type</code> at all. The findings above therefore focus on the value usages and on moving/deferring them.</p>',
      '<h3>Verified suggestions</h3>',
      '<p>Suggestions marked <span class="sugg"><span class="v">✔ verified</span></span> were checked against the dependency graph: replacing a barrel import by direct imports, or extracting the used symbol (whose own imports were traced) provably removes that cycle. Unverified suggestions describe what is needed but could not be proven from the graph alone.</p>',
      '<h3>Cyclic groups & fix plans</h3>',
      '<p>A cyclic group (strongly connected component) is a set of files where every file can reach every other. The fix plan lists the cheapest edges whose removal makes the whole group acyclic – barrel edges and imports without value usage first.</p>',
      '<h3>Tip for barrels</h3>',
      '<p><code>export * from</code> barrels drag every re-exported module into the evaluation of anything that imports the barrel. Importing the concrete file instead is often a one-line, verified fix.</p>'
    ].join('') });
  }

  function render() {
    app.innerHTML = '';
    app.appendChild(renderHeader());
    var main = h('main');
    main.appendChild(renderCards());
    main.appendChild(renderTabs());
    main.appendChild(state.tab === 'findings' ? renderFindings() : state.tab === 'groups' ? renderGroups() : state.tab === 'entries' ? renderEntries() : renderHowto());
    app.appendChild(main);
  }
  render();
  if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
})();
`;
