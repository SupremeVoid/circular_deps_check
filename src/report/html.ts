import type { AnalysisResult } from '../types.js';
import { toJsonReport, type ReportOptions } from './json.js';

/**
 * Self-contained HTML report (no external assets). All rendering happens client-side from the
 * embedded JSON so the file stays small even for large projects.
 *
 * Layout: findings are grouped by the cyclic group ("problem") they belong to, because one fix –
 * the group's verified fix plan – usually resolves all of them. Each finding is a collapsible row
 * that expands into the evidence (failing line, call chain, load order, cycle diagram, fixes).
 */
export const renderHtmlReport = (result: AnalysisResult, version: string, opts: ReportOptions = {}): string => {
  const data = toJsonReport(result, version, opts);
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

const CSS = String.raw`
:root {
  --bg: #f5f6f8; --panel: #ffffff; --panel-2: #fafbfc; --text: #1b1f24; --muted: #5d6673; --faint: #8a939e;
  --border: #e2e5e9; --code: #f1f3f5;
  --critical: #c62828; --high: #d4471a; --medium: #a87700; --low: #1f7a8c; --info: #6b7280;
  --eager: #c62828; --deferred: #a87700; --type: #8a939e; --none: #8a939e; --barrel: #7b3fa0; --ok: #2e7d32;
  --accent: #2456c4; --shadow: 0 1px 2px rgba(0,0,0,.05), 0 2px 10px rgba(0,0,0,.04);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1216; --panel: #171b21; --panel-2: #1b2027; --text: #e6e9ee; --muted: #a0a9b6; --faint: #7d8794;
    --border: #2a313b; --code: #0c0f13;
    --critical: #ff6b6b; --high: #ff8a5c; --medium: #e6c15a; --low: #4fb3c8; --info: #9aa4b2;
    --eager: #ff6b6b; --deferred: #e6c15a; --type: #8a939e; --none: #8a939e; --barrel: #c48be8; --ok: #6cc070; --accent: #7aa2ff;
    --shadow: 0 1px 2px rgba(0,0,0,.4); }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
code { background: var(--code); padding: 0 4px; border-radius: 4px; overflow-wrap: anywhere; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; color: inherit; }
header { padding: 18px 24px 14px; background: var(--panel); border-bottom: 1px solid var(--border); }
header h1 { margin: 0; font-size: 19px; }
header .root { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
header .meta { color: var(--faint); font-size: 12px; margin-top: 2px; }
main { padding: 18px 24px 64px; max-width: 1280px; margin: 0 auto; }
.verdict { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border-radius: 10px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--shadow); margin-bottom: 14px; }
.verdict .big { font-size: 15px; font-weight: 600; }
.verdict .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
.verdict.bad { border-left: 4px solid var(--critical); } .verdict.warn { border-left: 4px solid var(--medium); } .verdict.good { border-left: 4px solid var(--ok); }
.cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
@media (max-width: 760px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.card { text-align: left; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; box-shadow: var(--shadow); cursor: pointer; }
.card:focus-visible { outline: 2px solid var(--accent); }
.card.off { opacity: .45; }
.card .n { font-size: 22px; font-weight: 700; line-height: 1.2; }
.card .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
.card .d { font-size: 12px; color: var(--muted); }
.card.critical .n { color: var(--critical); } .card.high .n { color: var(--high); } .card.medium .n { color: var(--medium); } .card.low .n { color: var(--low); } .card.info .n { color: var(--info); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 6px 0 14px; overflow-x: auto; }
.tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: var(--muted); cursor: pointer; white-space: nowrap; }
.tabs button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 12px; }
.toolbar input[type=search] { flex: 1 1 240px; min-width: 0; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }
.toolbar label { font-size: 12.5px; color: var(--muted); display: flex; gap: 5px; align-items: center; }
.problem { background: var(--panel); border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 10px; margin-bottom: 14px; box-shadow: var(--shadow); overflow: hidden; }
.problem.critical { border-left-color: var(--critical); } .problem.high { border-left-color: var(--high); } .problem.medium { border-left-color: var(--medium); } .problem.low { border-left-color: var(--low); }
.problem.quiet { box-shadow: none; }
.problem-head { padding: 12px 16px 10px; }
.problem-head h2 { margin: 0; font-size: 15px; display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; }
.problem-head .facts { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
.chip.critical { color: var(--critical); border-color: currentColor; } .chip.high { color: var(--high); border-color: currentColor; } .chip.medium { color: var(--medium); border-color: currentColor; } .chip.low { color: var(--low); border-color: currentColor; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 5px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #fff; background: var(--info); white-space: nowrap; }
.badge.critical { background: var(--critical); } .badge.high { background: var(--high); } .badge.medium { background: var(--medium); } .badge.low { background: var(--low); }
@media (prefers-color-scheme: dark) { .badge { color: #111; } }
.fixbox { margin: 0 16px 12px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--ok) 8%, var(--panel)); border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border)); }
.fixbox.unverified { background: var(--panel-2); border-color: var(--border); }
.fixbox .t { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.cut { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; font-size: 13px; padding: 4px 0; }
.cut .act { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding-top: 2px; white-space: nowrap; }
.cut .edge { font-weight: 600; overflow-wrap: anywhere; }
.cut .why { grid-column: 2; color: var(--muted); }
.cut .then { grid-column: 2; font-size: 12.5px; color: var(--muted); }
.cut .then.next { color: var(--medium); font-weight: 600; }
.cut .step { font-weight: 700; color: var(--muted); }
.replay { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 12.5px; color: var(--muted); }
.replay.good b { color: var(--ok); } .replay.bad b { color: var(--medium); }
.gate { font-size: 12.5px; margin: 2px 0; }
.gate .who { color: var(--muted); }
.rows { border-top: 1px solid var(--border); }
.sect { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: var(--muted); padding: 12px 16px 6px; }
.lead { border-top: 1px solid var(--border); }
.lead-head { padding: 0 16px 2px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; }
.lead-head .what { font-size: 15px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.lead-head .where { color: var(--muted); font-size: 12.5px; font-weight: 400; }
.lead-head .trig { color: var(--muted); font-size: 12px; white-space: nowrap; }
.lead-body { padding: 0 16px 14px; }
.lead-body .summary { margin: 6px 0 10px; }
.lead .fixbox { margin-top: 0; }
.lead-fixes { padding: 0 16px 12px; }
@media (max-width: 760px) { .lead-head { grid-template-columns: auto minmax(0, 1fr); } .lead-head .trig { grid-column: 2; white-space: normal; } }
details.row { border-bottom: 1px solid var(--border); }
details.row:last-child { border-bottom: none; }
details.row > summary { list-style: none; cursor: pointer; padding: 9px 16px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; }
details.row > summary::-webkit-details-marker { display: none; }
details.row > summary:hover { background: var(--panel-2); }
details.row > summary .what { min-width: 0; overflow-wrap: anywhere; }
details.row > summary .where { color: var(--muted); font-size: 12.5px; }
details.row > summary .trig { color: var(--muted); font-size: 12px; white-space: nowrap; }
details.row > summary .caret { display: inline-block; width: 1em; color: var(--faint); transition: transform .12s; }
details.row[open] > summary .caret { transform: rotate(90deg); }
@media (max-width: 760px) { details.row > summary { grid-template-columns: auto minmax(0, 1fr); } details.row > summary .trig { grid-column: 2; white-space: normal; } }
.detail { padding: 4px 16px 16px 40px; background: var(--panel-2); }
@media (max-width: 760px) { .detail { padding-left: 16px; } }
.detail .summary { margin: 4px 0 10px; }
.st { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 14px 0 6px; font-weight: 700; }
.codeblock { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin: 6px 0; min-width: 0; }
.codeblock .loc { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 12.5px; }
.codeblock .loc .file { font-weight: 600; overflow-wrap: anywhere; }
.codeblock pre { margin: 6px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.codeblock .why { color: var(--muted); font-size: 12.5px; }
.via { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
.via code { color: var(--text); }
.chain { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 12.5px; }
.chain .node { padding: 1px 7px; border-radius: 6px; background: var(--panel); border: 1px solid var(--border); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chain .node.start { border-color: var(--medium); color: var(--medium); font-weight: 600; }
.chain .node.end { border-color: var(--critical); color: var(--critical); font-weight: 600; }
.chain .arrow { color: var(--faint); }
.evidence { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 16px; align-items: start; }
@media (max-width: 980px) { .evidence { grid-template-columns: minmax(0, 1fr); } }
.evidence > * { min-width: 0; }
.evidence.long { grid-template-columns: minmax(0, 1fr); }
.evidence:not(.long) .fc .mono { max-width: 20ch; }
.evidence:not(.long) td.syms { min-width: 150px; }
.tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: var(--panel-2); white-space: nowrap; }
td.path { white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
td.syms { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; min-width: 220px; }
td.where { color: var(--muted); min-width: 160px; }
tr.fail td { background: color-mix(in srgb, var(--critical) 9%, transparent); }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; white-space: nowrap; line-height: 1.5; }
.tag.eager { color: var(--eager); } .tag.deferred { color: var(--deferred); } .tag.type, .tag.none { color: var(--type); } .tag.barrel { color: var(--barrel); } .tag.ok { color: var(--ok); }
.diagram { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
.diagram svg { display: block; max-width: 100%; height: auto; margin: auto; }
.diagram .hit { cursor: pointer; outline: none; }
.diagram path.edge { transition: stroke-width .08s; }
.diagram path.edge.hot { stroke-width: 4px; }
.diagram .hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
#tip { position: fixed; z-index: 50; display: none; width: max-content; max-width: min(620px, calc(100vw - 16px)); background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12); padding: 10px 12px; font-size: 12.5px; pointer-events: none; }
#tip.pinned { pointer-events: auto; border-color: var(--accent); }
#tip .th { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-weight: 600; }
#tip .tp { color: var(--muted); font-size: 11.5px; margin: 1px 0 6px; overflow-wrap: anywhere; }
#tip .tc { background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 4px 0; overflow-x: auto; }
#tip .ln { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: baseline; padding: 1px 8px 1px 0; }
#tip .ln .no { text-align: right; padding-right: 8px; color: var(--faint); font-size: 11.5px; user-select: none; }
#tip .ln a.no:hover { color: var(--accent); }
#tip .ln pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
#tip .ln .nt { grid-column: 2; color: var(--muted); font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 11.5px; margin-bottom: 2px; }
#tip .ln.fail { background: color-mix(in srgb, var(--critical) 10%, transparent); box-shadow: inset 3px 0 0 var(--critical); }
#tip .ln.fail .nt { color: var(--critical); font-weight: 600; }
#tip .ln.gap .no { color: var(--faint); }
#tip .tf { color: var(--faint); font-size: 11.5px; margin-top: 6px; display: flex; justify-content: space-between; gap: 12px; }
#tip .tf button { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font-size: 11.5px; }
svg text { font-size: 11px; fill: var(--text); paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
svg .lbl { font-size: 10px; fill: var(--muted); }
.legend { display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); margin-top: 6px; }
.legend span { white-space: nowrap; }
.legend span::before { content: ""; display: inline-block; width: 16px; height: 3px; margin-right: 5px; vertical-align: middle; border-radius: 2px; background: currentColor; }
.fix { margin: 6px 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; }
.fix .mark { font-weight: 700; color: var(--ok); white-space: nowrap; font-size: 12px; padding-top: 1px; }
.fix .mark.u { color: var(--muted); }
.fix .details { grid-column: 2; color: var(--muted); font-size: 12.5px; }
.fix .details pre { margin: 4px 0; padding: 6px 8px; background: var(--code); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
details.more > summary { cursor: pointer; color: var(--accent); font-size: 12.5px; margin-top: 8px; }
.files { columns: 3 240px; column-gap: 18px; font-size: 12.5px; padding: 6px 16px 12px; }
.files div { break-inside: avoid; overflow-wrap: anywhere; }
.foot { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 8px 16px; border-top: 1px solid var(--border); background: var(--panel-2); }
.foot details { flex: 1 1 100%; }
.foot summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
.muted { color: var(--muted); }
.empty { padding: 28px; text-align: center; color: var(--muted); background: var(--panel); border: 1px dashed var(--border); border-radius: 10px; }
.section-head { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; margin: 22px 0 8px; }
.prose { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 20px 16px; }
.prose h3 { margin: 18px 0 6px; font-size: 15px; }
.prose p, .prose li { max-width: 860px; }
.edlink { font-size: 11.5px; white-space: nowrap; }
.fc { display: flex; flex-direction: column; min-width: 0; }
.fc .mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30ch; }
.fc .dir { color: var(--faint); font-size: 11px; }
td.syms .muted { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow-wrap: normal; }
.linkbtn { background: none; border: none; color: var(--accent); cursor: pointer; padding: 6px 0; font-size: 12.5px; }
`;

/* Client script: written without backticks / template placeholders so it can live in String.raw. */
const CLIENT_JS = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var store = { get: function (k, d) { try { var v = localStorage.getItem('circdeps:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
                set: function (k, v) { try { localStorage.setItem('circdeps:' + k, JSON.stringify(v)); } catch (e) {} } };
  var state = { tab: 'problems', sev: store.get('sev2', { critical: true, high: true, medium: true, low: true, info: false }), q: '', editor: data.editorLinks !== false && store.get('editor', true) };
  var app = document.getElementById('app');
  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  var RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function md(s) { return esc(s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>'); }
  function short(p) { var parts = String(p).split('/'); return parts.length > 2 ? parts.slice(-2).join('/') : p; }
  function base(p) { return String(p).split('/').pop(); }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'html') el.innerHTML = attrs[k]; else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]); else el.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (ch) { if (ch == null) return; el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch); });
    return el;
  }
  function tag(kind, text) { return '<span class="tag ' + kind + '">' + esc(text || kind) + '</span>'; }
  function usageLabel(u) { return u === 'eager' ? 'load time' : u === 'deferred' ? 'later' : u === 'type' ? 'type only' : 'no binding'; }
  function usageTag(u) { return tag(u === 'none' ? 'none' : u, usageLabel(u)); }
  function editorUrl(rel, line, col) {
    var abs = /^([a-zA-Z]:)?\//.test(rel) ? rel : data.root.replace(/\/$/, '') + '/' + rel;
    return 'vscode://file/' + encodeURI(abs).replace(/#/g, '%23') + ':' + (line || 1) + ':' + (col || 1);
  }
  /** File name first (what people scan for), folder underneath in muted text. */
  function fileCell(p) {
    var parts = String(p).split('/'); var name = parts.pop(); var dir = parts.slice(-2).join('/');
    return '<div class="fc" title="' + esc(p) + '"><span class="mono">' + esc(name) + '</span>' + (dir ? '<span class="dir mono">' + esc(dir) + '/</span>' : '') + '</div>';
  }
  function loc(rel, line, col) {
    var text = rel + (line ? ':' + line + (col ? ':' + col : '') : '');
    var link = state.editor ? ' <a class="edlink" href="' + esc(editorUrl(rel, line, col)) + '" title="Open in VS Code">open ↗</a>' : '';
    return '<span class="file mono" title="' + esc(rel) + '">' + esc(text) + '</span>' + link;
  }

  // ------------------------------------------------------------------ model
  var findings = data.findings;
  var byGroup = {};
  findings.forEach(function (f) { if (f.kind === 'di-cycle' || f.kind === 'type-only-cycle') return; (byGroup[f.sccId] = byGroup[f.sccId] || []).push(f); });
  function worst(list) { return list.reduce(function (w, f) { return RANK[f.severity] < RANK[w] ? f.severity : w; }, 'info'); }
  function planOf(id) { return data.fixPlans.filter(function (p) { return p.sccId === id; })[0]; }
  function groupOf(id) { return data.groups.filter(function (g) { return g.id === id; })[0]; }
  function matches(f) {
    if (!state.sev[f.severity]) return false;
    if (!state.q) return true;
    var q = state.q.toLowerCase();
    var hay = [f.title, f.summary, f.cycle ? f.cycle.nodes.join(' ') : '', f.di ? f.di.nodes.map(function (n) { return n.name + ' ' + n.path; }).join(' ') : '',
      f.failures.map(function (fp) { return fp.symbol + ' ' + fp.binding + ' ' + fp.from; }).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  var KIND_LABEL = { 'runtime-break': 'crashes on app load', 'test-break': 'crashes in tests', 'possible-break': 'possible crash', 'latent-cycle': 'order-dependent', 'deferred-cycle': 'no load-time risk', 'di-cycle': 'DI cycle', 'type-only-cycle': 'type only' };

  // ------------------------------------------------------------------ ring diagram
  function ring(nodes, edges, failing) {
    var n = nodes.length; var R = Math.max(90, Math.min(190, 60 + n * 16));
    var W = 2 * (R + 190); var H = 2 * (R + 78);
    var cx = W / 2, cy = H / 2; var pos = {};
    nodes.forEach(function (node, i) { var a = -Math.PI / 2 + (2 * Math.PI * i) / n; pos[node] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; });
    // long cycles: only the failing imports are labelled – the popup has the rest
    var showAll = n <= 5;
    function trunc(t, max) { return t.length > max ? t.slice(0, max - 1) + '…' : t; }
    function place(x, y) { var anchor = Math.abs(x - cx) < 14 ? 'middle' : x < cx ? 'end' : 'start'; var dy = Math.abs(x - cx) < 14 ? (y < cy ? -4 : 12) : 4; return { anchor: anchor, dy: dy }; }
    var colors = { eager: 'var(--eager)', deferred: 'var(--deferred)', type: 'var(--type)', none: 'var(--none)' };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" role="img" aria-label="Import cycle diagram">';
    s += '<defs>';
    ['eager', 'deferred', 'type', 'none', 'fail'].forEach(function (k) {
      s += '<marker id="m-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + (k === 'fail' ? 'var(--critical)' : colors[k]) + '"/></marker>';
    });
    s += '</defs>';
    var hits = '';
    var failCount = edges.filter(function (e) { return failing.some(function (f) { return f.from === e.from && f.to === e.to; }); }).length;
    edges.forEach(function (e, ei) {
      var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
      var isFail = failing.some(function (f) { return f.from === e.from && f.to === e.to; });
      var col = isFail ? 'var(--critical)' : colors[e.usage] || colors.none;
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len; var pad = 22;
      var x1 = a.x + ux * pad, y1 = a.y + uy * pad, x2 = b.x - ux * pad, y2 = b.y - uy * pad;
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      var rx = mx - cx, ry = my - cy, rl = Math.sqrt(rx * rx + ry * ry);
      var ox, oy;
      if (n === 2 || rl < 1) { ox = -uy; oy = ux; } else { ox = rx / rl; oy = ry / rl; }
      var bend = n === 2 ? 44 : Math.max(14, (R - rl) * 0.9);
      var cxp = mx + ox * bend, cyp = my + oy * bend;
      var d = 'M' + x1 + ',' + y1 + ' Q' + cxp + ',' + cyp + ' ' + x2 + ',' + y2;
      s += '<path class="edge" data-e="' + ei + '" d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + (isFail ? 3 : e.usage === 'eager' ? 2 : 1.5) + '" ' + (e.usage === 'type' || e.usage === 'none' ? 'stroke-dasharray="4 3" ' : '') + 'marker-end="url(#m-' + (isFail ? 'fail' : (colors[e.usage] ? e.usage : 'none')) + ')"></path>';
      // wide transparent twin: an easy target for the code popup (hover, click or keyboard focus)
      hits += '<path class="hit" data-e="' + ei + '" d="' + d + '" fill="none" stroke="transparent" stroke-width="18" tabindex="0" role="button" aria-label="' + esc('Show the code behind ' + e.from + ' importing ' + e.to) + '"></path>';
      if (!showAll && (!isFail || failCount > 2)) return;
      var ax = (x1 + 2 * cxp + x2) / 4, ay = (y1 + 2 * cyp + y2) / 4;
      var lx = ax + ox * 10, ly = ay + oy * 10;
      var pl = place(lx, ly);
      if (!showAll) {
        lx = ax - ox * 14; ly = ay - oy * 14;
        pl = { anchor: Math.abs(lx - cx) < 14 ? 'middle' : lx > cx ? 'end' : 'start', dy: 4 };
      }
      var label = trunc(e.symbols.slice(0, 2).join(', ') + (e.symbols.length > 2 ? ' +' + (e.symbols.length - 2) : ''), 24);
      if (isFail) label = '⚡ ' + label;
      s += '<text class="lbl" x="' + lx + '" y="' + (ly + pl.dy) + '" text-anchor="' + pl.anchor + '" style="' + (isFail ? 'fill:var(--critical);font-weight:700' : '') + '"><title>' + esc(e.symbols.join(', ')) + '</title>' + esc(label) + '</text>';
    });
    nodes.forEach(function (node) {
      var p = pos[node]; var isFailNode = failing.some(function (f) { return f.from === node; });
      var isBarrel = edges.some(function (e) { return e.to === node && e.viaBarrel; });
      s += '<g><circle cx="' + p.x + '" cy="' + p.y + '" r="16" fill="var(--panel)" stroke="' + (isFailNode ? 'var(--critical)' : isBarrel ? 'var(--barrel)' : 'var(--muted)') + '" stroke-width="' + (isFailNode ? 3 : 1.5) + '"><title>' + esc(node) + '</title></circle>';
      var nx = (p.x - cx) / R, ny = (p.y - cy) / R;
      var tx = p.x + nx * 44, ty = p.y + ny * 44;
      var np = place(tx, ty);
      s += '<text class="node-lbl" x="' + tx + '" y="' + (ty + np.dy) + '" text-anchor="' + np.anchor + '" style="' + (isFailNode ? 'font-weight:700' : '') + '"><title>' + esc(node) + '</title>' + esc(trunc((/^index\.[cm]?tsx?$/.test(base(node)) ? short(node) : base(node)).replace(/\.[cm]?tsx?$/, ''), np.anchor === 'middle' ? 36 : 24)) + '</text></g>';
    });
    return s + hits + '</svg>';
  }

  // ------------------------------------------------------------------ code popup on diagram edges
  var tip = null, tipPinned = false, tipEdge = null;
  function tipEl() {
    if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    return tip;
  }
  function hideTip() {
    if (tip) { tip.style.display = 'none'; tip.className = ''; }
    tipPinned = false; tipEdge = null;
    Array.prototype.forEach.call(document.querySelectorAll('path.edge.hot'), function (p) { p.classList.remove('hot'); });
  }
  /** The code behind one import: the import statement and the lines that use it, failing reads marked. */
  function tipHtml(e, fails, pinned) {
    var file = e.file || e.from;
    var rows = {};
    function row(line) { return rows[line] || (rows[line] = { line: line, code: '', notes: [], fail: false }); }
    (e.imports || []).forEach(function (im) { var r = row(im.line); r.code = im.text; });
    (e.uses || []).forEach(function (u) {
      var r = row(u.line); if (u.snippet) r.code = u.snippet;
      r.notes.push(u.timing === 'di' ? u.context : (u.timing === 'eager' ? 'runs at load time' : u.timing === 'deferred' ? 'runs later' : 'type only') + ' · ' + u.context);
    });
    fails.forEach(function (x) {
      var r = row(x.line); if (x.snippet) r.code = x.snippet; r.fail = true;
      var why = x.state === 'tdz' ? 'is not initialised yet → ReferenceError' : 'is still undefined here';
      var when = x.entries && x.entries.length && x.entries[0].kind === 'hypothetical' ? ' if ' + base(x.entries[0].entry) + ' is imported first' : '';
      r.notes = ['⚡ ' + (x.via && x.via.length ? x.symbol + '() reads ' + x.binding + ', which ' : x.binding + ' ') + why + when + (x.uncertain ? ' (possible)' : '')];
    });
    var list = Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return a.line - b.line; });
    var code = '', prev = 0;
    list.forEach(function (r) {
      if (prev && r.line > prev + 1) code += '<div class="ln gap"><span class="no">⋮</span><pre></pre></div>';
      prev = r.line;
      var no = pinned && state.editor ? '<a class="no" href="' + esc(editorUrl(file, r.line, 1)) + '" title="Open in VS Code">' + r.line + '</a>' : '<span class="no">' + r.line + '</span>';
      code += '<div class="ln' + (r.fail ? ' fail' : '') + '">' + no + '<pre class="mono">' + esc(r.code) + '</pre>' + r.notes.map(function (n) { return '<span class="nt">' + md(n) + '</span>'; }).join('') + '</div>';
    });
    if (e.moreUses) code += '<div class="ln gap"><span class="no">⋮</span><span class="nt" style="grid-column:2">' + plural(e.moreUses, 'more line') + ' use this import</span></div>';
    return '<div class="th"><span class="mono">' + esc(base(e.from)) + '</span><span class="muted" style="font-weight:400">' + (e.verb || 'imports') + '</span><span class="mono">' + esc(base(e.to)) + '</span>' +
      (e.verb ? '' : usageTag(e.usage)) + (e.viaBarrel ? tag('barrel', 'barrel') : '') + '</div>' +
      '<div class="tp mono">' + esc(file) + '</div>' +
      (code ? '<div class="tc">' + code + '</div>' : '<div class="muted">No binding of this import is used – it only loads the file.</div>') +
      '<div class="tf"><span>' + (pinned ? 'Esc or click elsewhere to close' : 'Click the arrow to keep this open') + '</span>' + (pinned ? '<button type="button" data-close="1">close</button>' : '') + '</div>';
  }
  function placeTip(x, y) {
    var t = tipEl(); t.style.display = 'block';
    var w = t.offsetWidth, hgt = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(8, Math.min(x + 14, vw - w - 8));
    var top = y + 18; if (top + hgt > vh - 8) top = Math.max(8, y - hgt - 14);
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  /** Wire the edges of one diagram: hover shows the code, click or Enter pins the popup. */
  function bindTips(box, edges, failures) {
    function edgeOf(target) { var i = target && target.getAttribute && target.getAttribute('data-e'); return i == null ? null : edges[Number(i)]; }
    function show(target, x, y, pinned) {
      var e = edgeOf(target); if (!e) return;
      var fails = failures.filter(function (f) { return f.from === e.from && f.to === e.to; });
      var t = tipEl();
      if (tipEdge !== e || pinned !== t.classList.contains('pinned')) { t.innerHTML = tipHtml(e, fails, pinned); t.className = pinned ? 'pinned' : ''; }
      tipEdge = e; tipPinned = pinned;
      Array.prototype.forEach.call(box.querySelectorAll('path.edge'), function (p) { p.classList.toggle('hot', p.getAttribute('data-e') === target.getAttribute('data-e')); });
      placeTip(x, y);
    }
    function center(target) { var r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    box.addEventListener('mousemove', function (ev) { if (!tipPinned && ev.target.classList && ev.target.classList.contains('hit')) show(ev.target, ev.clientX, ev.clientY, false); });
    box.addEventListener('mouseout', function (ev) { if (!tipPinned && ev.target.classList && ev.target.classList.contains('hit')) hideTip(); });
    box.addEventListener('click', function (ev) {
      if (!ev.target.classList || !ev.target.classList.contains('hit')) return;
      ev.stopPropagation();
      if (tipPinned && tipEdge === edgeOf(ev.target)) { hideTip(); return; }
      show(ev.target, ev.clientX, ev.clientY, true);
    });
    box.addEventListener('focusin', function (ev) { if (!tipPinned && ev.target.classList && ev.target.classList.contains('hit')) { var c = center(ev.target); show(ev.target, c.x, c.y, false); } });
    box.addEventListener('focusout', function () { if (!tipPinned) hideTip(); });
    box.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('hit')) { ev.preventDefault(); var c = center(ev.target); show(ev.target, c.x, c.y, true); }
    });
  }
  document.addEventListener('click', function (ev) {
    if (!tipPinned) return;
    if (tip && tip.contains(ev.target) && !(ev.target.getAttribute && ev.target.getAttribute('data-close'))) return;
    hideTip();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', function () { if (!tipPinned) hideTip(); }, true);
  var DIAGRAM_HINT = '<div class="hint">Hover an arrow to see the lines of code behind it; click to keep it open.</div>';
  var LEGEND = '<div class="legend"><span style="color:var(--critical)">breaking import</span><span style="color:var(--eager)">read at load time</span><span style="color:var(--deferred)">read later</span><span style="color:var(--type)">type only / no binding</span><span style="color:var(--barrel)">barrel file</span></div>';

  // ------------------------------------------------------------------ header, verdict, cards
  function renderHeader() {
    var st = data.stats;
    var meta = num(st.files) + ' files · ' + num(st.loc) + ' lines · ' + num(st.runtimeEdges) + ' runtime imports (' + num(st.erasedEdges) + ' type-only erased, ' + num(st.dynamicEdges) + ' lazy) · ' +
      'replayed ' + plural(data.entries.length, 'entry', 'entries') + ' + ' + plural(st.replayedOrders || 0, 'hypothetical order') + ' · ' + st.durationMs + ' ms · ' + new Date(data.generatedAt).toLocaleString();
    return h('header', {}, [
      h('h1', {}, ['Circular dependency report']),
      h('div', { class: 'root' }, [data.root]),
      h('div', { class: 'meta' }, [meta]),
    ]);
  }
  function renderVerdict() {
    var c = data.counts;
    var crashGroups = {}, cuts = 0, verified = true;
    findings.forEach(function (f) { if (f.failures.length && f.sccId && RANK[f.severity] <= RANK.medium) crashGroups[f.sccId] = true; });
    var fragile = findings.filter(function (f) { return f.kind === 'latent-cycle'; });
    var fragileReads = fragile.reduce(function (n, f) { return n + f.failures.length; }, 0);
    Object.keys(crashGroups).forEach(function (id) { var p = planOf(Number(id)); if (p) { cuts += p.cuts.length; verified = verified && p.verified; } });
    var groups = Object.keys(crashGroups).length;
    var cls = c.critical ? 'bad' : c.high || c.medium ? 'warn' : 'good';
    var big = c.critical
      ? plural(c.critical, 'load-time crash', 'load-time crashes') + ' when the app (or a lazy route) loads'
      : c.high ? 'No crash on app load – but ' + plural(c.high, 'problem') + ' in tests or Angular DI'
      : c.medium ? 'No proven crash – ' + plural(c.medium, 'possible crash', 'possible crashes') + ' to check'
      : fragile.length ? 'Nothing is broken in any current load order'
      : data.stats.sccs ? 'No crash under any import order' : 'No runtime import cycles';
    var sub = groups ? 'Changing ' + plural(cuts, 'import') + ' ' + (verified ? '(verified) ' : '') + 'removes every cycle that crashes today – each problem below shows how it breaks, then the fix.'
      : fragile.length ? plural(fragileReads, 'load-time read') + ' in ' + plural(fragile.length, 'group') + ' depend' + (fragileReads === 1 ? 's' : '') + ' on today\'s import order (low). Nothing to fix now; untangle when you touch them.'
      : data.stats.sccs ? plural(data.stats.sccs, 'cyclic group') + ' remain, all safe at load time.' : '';
    if (!data.options.entries.length) sub = 'No entry point found – pass --entry src/main.ts so the app load order can be replayed. ' + sub;
    return h('div', { class: 'verdict ' + cls }, [h('div', {}, [h('div', { class: 'big' }, [big]), sub ? h('div', { class: 'sub' }, [sub]) : null])]);
  }
  var SEV_DESC = { critical: 'crash on app load', high: 'test crash / DI cycle', medium: 'possible crash', low: 'order-dependent, fine today', info: 'cannot crash' };
  function renderCards() {
    var wrap = h('div', { class: 'cards', role: 'group', 'aria-label': 'Filter by severity' });
    SEV.forEach(function (sev) {
      wrap.appendChild(h('button', { class: 'card ' + sev + (state.sev[sev] ? '' : ' off'), 'aria-pressed': String(state.sev[sev]), title: (state.sev[sev] ? 'Hide ' : 'Show ') + sev,
        onclick: function () { state.sev[sev] = !state.sev[sev]; store.set('sev2', state.sev); render(); } },
        [h('div', { class: 'n' }, [String(data.counts[sev] || 0)]), h('div', { class: 'l' }, [sev]), h('div', { class: 'd' }, [SEV_DESC[sev]])]));
    });
    return wrap;
  }
  function renderTabs() {
    var t = h('div', { class: 'tabs', role: 'tablist' });
    var problems = Object.keys(byGroup).length + findings.filter(function (f) { return f.kind === 'di-cycle'; }).length;
    [['problems', 'Problems (' + problems + ')'], ['entries', 'Load orders (' + data.entries.length + ')'], ['howto', 'Guide']].forEach(function (p) {
      t.appendChild(h('button', { role: 'tab', 'aria-selected': String(state.tab === p[0]), class: state.tab === p[0] ? 'active' : '', onclick: function () { state.tab = p[0]; render(); } }, [p[1]]));
    });
    return t;
  }

  // ------------------------------------------------------------------ problems
  function renderProblems() {
    var wrap = h('div');
    var tb = h('div', { class: 'toolbar' }, [
      h('input', { type: 'search', placeholder: 'Filter by file, symbol or text…', 'aria-label': 'Filter findings', value: state.q, oninput: function (e) { state.q = e.target.value; renderList(); } }),
      data.editorLinks === false ? null : h('label', {}, [h('input', { type: 'checkbox', onchange: function (e) { state.editor = e.target.checked; store.set('editor', state.editor); renderList(); } }), 'VS Code links'])
    ]);
    if (state.editor) tb.querySelector('input[type=checkbox]').checked = true;
    wrap.appendChild(tb);
    var list = h('div');
    wrap.appendChild(list);
    function renderList() {
      list.innerHTML = '';
      var cards = [];
      Object.keys(byGroup).forEach(function (id) {
        var all = byGroup[id];
        var shown = all.filter(matches);
        if (shown.length) cards.push({ sev: worst(all), weight: all.length, el: function () { return groupCard(Number(id), all, shown); } });
      });
      findings.filter(function (f) { return f.kind === 'di-cycle' && matches(f); }).forEach(function (f) { cards.push({ sev: f.severity, weight: 1, el: function () { return diCard(f); } }); });
      cards.sort(function (a, b) { return RANK[a.sev] - RANK[b.sev] || b.weight - a.weight; });
      cards.forEach(function (c) { list.appendChild(c.el()); });
      var typeOnly = findings.filter(function (f) { return f.kind === 'type-only-cycle' && matches(f); });
      if (typeOnly.length) {
        list.appendChild(h('div', { class: 'section-head' }, ['Type-only cycles – erased by the compiler, no action needed (' + typeOnly.length + ')']));
        var box = h('div', { class: 'problem' }, [h('div', { class: 'rows' })]);
        typeOnly.forEach(function (f) { box.firstChild.appendChild(findingRow(f, false)); });
        list.appendChild(box);
      }
      if (!list.childNodes.length) list.appendChild(h('div', { class: 'empty' }, [findings.length ? 'Nothing matches the current filter – click the severity cards above to show more.' : 'No circular dependencies found.']));
    }
    renderList();
    return wrap;
  }

  function countChips(list) {
    var counts = {};
    list.forEach(function (f) { counts[f.kind] = (counts[f.kind] || 0) + 1; });
    var reads = 0;
    list.forEach(function (f) { if (f.kind === 'latent-cycle') reads += f.failures.length; });
    return ['runtime-break', 'test-break', 'possible-break', 'latent-cycle', 'deferred-cycle'].filter(function (k) { return counts[k]; }).map(function (k) {
      var sev = k === 'runtime-break' ? 'critical' : k === 'test-break' ? 'high' : k === 'possible-break' ? 'medium' : k === 'latent-cycle' ? 'low' : '';
      return '<span class="chip ' + sev + '">' + (k === 'latent-cycle' ? plural(reads, 'order-dependent read') : counts[k] + ' ' + esc(KIND_LABEL[k])) + '</span>';
    }).join(' ');
  }

  var ACTION = { 'rewire-barrel': 'Import directly', 'drop-reexport': 'Barrel re-export', 'move-code': 'Break import', 'remove-import': 'Remove import' };
  function previewRef(x) {
    var when = x.entryKind === 'test' ? 'in ' + esc(short(x.entry)) : x.entryKind === 'lazy' ? 'when ' + esc(short(x.entry)) + ' loads' : 'on app load';
    return '<span class="mono">' + esc(short(x.from)) + ':' + x.line + '</span> reads <code>' + esc(x.binding) + '</code> too early ' + when + (x.uncertain ? ' (possible)' : '') +
      (x.knownAs ? ' – ' + (x.knownKind === 'latent-cycle' ? 'today only order-dependent, ' : x.knownKind === 'test-break' ? 'today only in specs, ' : 'see ') + '<a href="#' + esc(x.knownAs) + '">' + esc(x.knownAs) + '</a>' : '');
  }
  function fixBox(plan, total) {
    if (!plan || !plan.cuts.length) return null;
    var steps = plan.preview && plan.preview.simulated ? plan.preview.steps : [];
    var done = {};
    var cuts = plan.cuts.map(function (c, i) {
      var then = '';
      var st = steps[i];
      if (st) {
        var newly = st.resolved.filter(function (id) { return !done[id]; });
        st.resolved.forEach(function (id) { done[id] = true; });
        if (newly.length) then += '<span class="then">then: ' + newly.map(function (id) { return '<a href="#' + esc(id) + '">' + esc(id) + '</a>'; }).join(', ') + ' no longer crash' + (newly.length === 1 ? 'es' : '') + '</span>';
        st.exposed.slice(0, 3).forEach(function (x) { then += '<span class="then next">then: next crash – ' + previewRef(x) + '</span>'; });
        if (st.exposed.length > 3) then += '<span class="then next">… and ' + (st.exposed.length - 3) + ' more reads surface</span>';
      }
      return '<div class="cut"><span class="act">' + (plan.cuts.length > 1 ? '<span class="step">' + (i + 1) + '.</span> ' : '') + esc(ACTION[c.action] || c.action) + '</span><span class="edge mono" title="' + esc(c.from + ' → ' + c.to) + '">' + esc(short(c.from)) + ' → ' + esc(short(c.to)) +
        ' <span class="muted">{ ' + esc(c.symbols.slice(0, 4).join(', ')) + (c.symbols.length > 4 ? ', …' : '') + ' }</span></span><span class="why">' + md(c.reason) + '</span>' + then + '</div>';
    }).join('');
    var title = plan.verified
      ? '✔ Fix: change ' + plural(plan.cuts.length, 'import') + ' – verified to make this group acyclic' + (total > 1 ? ', which resolves all ' + total + ' findings of this group' : '')
      : 'Suggested cuts (the group is still cyclic after these – see the findings)';
    var replay = '';
    var last = steps[plan.cuts.length - 1];
    if (last) {
      var left = last.remaining.length + last.exposed.length;
      var scope = 'Replayed ' + plural(plan.preview.entries, 'entry point') + (plan.preview.skippedTests ? ' (app only, ' + plural(plan.preview.skippedTests, 'spec') + ' not replayed)' : '') + ' with ' + (plan.cuts.length === 1 ? 'this import gone' : 'all ' + plan.cuts.length + ' imports changed') + ': ';
      replay = left === 0
        ? '<div class="replay good">' + scope + '<b>' + (plan.preview.skippedTests ? 'no app-load crash left' : 'no crash left') + ' in this group, and none surfaces elsewhere.</b>' + (plan.cuts.length > 1 ? ' Applying only some of them changes the load order – the lines marked “next crash” show what would surface.' : '') + '</div>'
        : '<div class="replay bad">' + scope + '<b>' + (left === 1 ? '1 read still fails' : left + ' reads still fail') + '</b> – e.g. ' + previewRef(last.exposed[0] || last.remaining[0]) + '.</div>';
    } else if (plan.preview && !plan.preview.simulated) {
      replay = '<div class="replay">Not replayed: ' + esc(plan.preview.reason) + '.</div>';
    }
    return h('div', { class: 'fixbox' + (plan.verified ? '' : ' unverified') }, [h('div', { class: 't' }, [title]), h('div', { html: cuts + replay })]);
  }

  function groupEdges(g) {
    var map = {};
    g.cycles.forEach(function (cy) { cy.edges.forEach(function (e) { var k = e.from + '>' + e.to; if (!map[k]) map[k] = { e: e, n: 0 }; map[k].n++; }); });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.n - a.n; });
  }

  function groupCard(id, all, shown) {
    var g = groupOf(id) || { files: [], barrels: [], cycles: [], edgeCount: 0 };
    var sev = worst(all);
    var el = h('section', { class: 'problem ' + sev, id: 'group-' + id });
    var title = all.length === 1 && all[0].kind === 'deferred-cycle' ? 'Import cycle without load-time risk' : all.length === 1 && all[0].kind === 'latent-cycle' ? 'Order-dependent import cycle – fine today' : 'Import cycle group';
    if (RANK[sev] >= RANK.low) el.className += ' quiet';
    el.appendChild(h('div', { class: 'problem-head', html:
      '<h2><span class="badge ' + sev + '">' + sev + '</span> ' + esc(title) + ' <span class="muted" style="font-weight:400">#' + id + '</span> ' + countChips(all) + '</h2>' +
      '<div class="facts">' + plural(g.files.length, 'file') + ' · ' + plural(g.edgeCount, 'import') + (g.barrels.length ? ' · ' + plural(g.barrels.length, 'barrel') + ' (' + g.barrels.slice(0, 3).map(function (b) { return esc(short(b)); }).join(', ') + (g.barrels.length > 3 ? ', …' : '') + ')' : '') + ' · ' + plural(g.cycles.length, 'cycle') + (g.truncated ? '+' : '') + '</div>' }));
    // How it breaks comes first: the worst finding of the group is shown in full – failing line,
    // load order, cycle diagram – then the fix, then the other findings of the group as rows.
    // A group in which nothing breaks today has no such part and starts with its rows.
    var lead = shown.filter(function (f) { return f.failures.length && f.kind !== 'latent-cycle' && RANK[f.severity] <= RANK.medium; })[0];
    var fb = fixBox(planOf(id), all.length);
    if (lead) {
      var how = h('div', { class: 'lead', id: lead.id });
      how.appendChild(h('div', { class: 'sect' }, [lead.kind === 'possible-break' ? 'How it may break' : 'How it breaks']));
      how.appendChild(h('div', { class: 'lead-head', html: headHtml(lead, false) }));
      var evidence = h('div', { class: 'lead-body' });
      findingEvidence(lead, evidence, true);
      how.appendChild(evidence);
      el.appendChild(how);
      var fix = h('div', { class: 'lead' });
      fix.appendChild(h('div', { class: 'sect' }, ['How to fix']));
      if (fb) fix.appendChild(fb);
      if (lead.suggestions.length) {
        var own = h('div', { class: 'lead-fixes' });
        if (fb) {
          var more = h('details', { class: 'more' }, [h('summary', {}, ['Ways to fix this read on its own (' + lead.suggestions.length + ')'])]);
          findingFixes(lead, more, true);
          own.appendChild(more);
        } else findingFixes(lead, own, true);
        fix.appendChild(own);
      }
      el.appendChild(fix);
    } else if (fb) el.appendChild(fb);
    var rest = shown.filter(function (f) { return f !== lead; });
    if (rest.length) {
      var rows = h('div', { class: 'rows' });
      if (lead) rows.appendChild(h('div', { class: 'sect' }, ['Also in this group (' + rest.length + ')']));
      rest.forEach(function (f) { rows.appendChild(findingRow(f, !lead && rest.length === 1)); });
      el.appendChild(rows);
    }
    var foot = h('div', { class: 'foot' });
    var files = h('details', {}, [h('summary', {}, ['Files in this group (' + g.files.length + ')'])]);
    files.appendChild(h('div', { class: 'files mono', html: g.files.map(function (f) { return '<div>' + (g.barrels.indexOf(f) >= 0 ? tag('barrel', 'barrel') + ' ' : '') + esc(f) + '</div>'; }).join('') }));
    foot.appendChild(files);
    var edges = groupEdges(g);
    if (edges.length) {
      var ed = h('details', {}, [h('summary', {}, ['Imports inside this group (' + edges.length + '), most cycles first'])]);
      ed.addEventListener('toggle', function () {
        if (!ed.open || ed.querySelector('table')) return;
        var limit = 25;
        var draw = function (n) {
          var old = ed.querySelector('.tablewrap'); if (old) old.remove();
          var oldBtn = ed.querySelector('button'); if (oldBtn) oldBtn.remove();
          ed.appendChild(h('div', { class: 'tablewrap', style: 'margin-top:6px', html: '<table><thead><tr><th>From</th><th>Imports</th><th>Use</th><th>Symbols</th><th title="Cycles of this group that use the import">Cycles</th></tr></thead><tbody>' + edges.slice(0, n).map(function (x) {
            return '<tr><td>' + fileCell(x.e.from) + '</td><td>' + fileCell(x.e.to) + (x.e.viaBarrel ? ' ' + tag('barrel', 'barrel') : '') + '</td><td>' + usageTag(x.e.usage) + '</td><td class="syms">' + esc(x.e.symbols.slice(0, 5).join(', ')) + (x.e.symbols.length > 5 ? ', …' : '') + '</td><td>' + x.n + '</td></tr>';
          }).join('') + '</tbody></table>' }));
          if (n < edges.length) ed.appendChild(h('button', { class: 'linkbtn', onclick: function () { draw(edges.length); } }, ['Show all ' + edges.length + ' imports']));
        };
        draw(limit);
      });
      foot.appendChild(ed);
    }
    el.appendChild(foot);
    return el;
  }

  function triggerText(f) {
    if (!f.failures.length) return f.kind === 'deferred-cycle' ? 'safe in every order' : '';
    if (f.kind === 'latent-cycle') return 'only under another import order';
    var kinds = {}, tests = 0, hyp = null;
    f.failures.forEach(function (fp) { fp.entries.forEach(function (e) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; if (e.kind === 'test') tests++; if (e.kind === 'hypothetical' && !hyp) hyp = e.entry; }); });
    var maybe = f.kind === 'possible-break' ? 'possibly ' : '';
    if (kinds.main) return maybe + 'on app load' + (tests ? ' · ' + plural(tests, 'spec') : '');
    if (kinds.lazy) return maybe + 'when the lazy route loads';
    if (tests) return maybe + 'in ' + plural(tests, 'spec');
    if (hyp) return 'if ' + base(hyp) + ' loads first';
    return '';
  }

  /** Badge, what happens, where, and under which entry – the summary line of a row or of the lead finding. */
  function headHtml(f, caret) {
    var fp = f.failures[0];
    var what = f.kind === 'latent-cycle'
      ? plural(f.failures.length, 'load-time read') + ' that ' + (f.failures.length === 1 ? 'relies' : 'rely') + ' on today\'s import order'
      : fp
      ? (fp.via ? '<code>' + esc(fp.symbol) + '()</code> reads <code>' + esc(fp.binding) + '</code> too early' : '<code>' + esc(fp.symbol) + '</code> read too early')
      : f.kind === 'deferred-cycle' ? md(f.title.replace(/: \d+ files \(group #\d+\)$/, '')) : md(f.title);
    var where = fp && f.kind !== 'latent-cycle' ? ' <span class="where mono">' + esc(short(fp.from)) + ':' + fp.line + '</span>' : '';
    return '<span>' + (caret ? '<span class="caret">▸</span> ' : '') + '<span class="badge ' + f.severity + '">' + f.severity + '</span></span><span class="what">' + what + where + '</span><span class="trig">' + esc(triggerText(f)) + (caret ? '' : ' · ' + esc(f.id)) + '</span>';
  }

  function findingRow(f, open) {
    var d = h('details', { class: 'row', id: f.id });
    if (open) d.open = true;
    d.appendChild(h('summary', { html: headHtml(f, true) }));
    var body = null;
    d.addEventListener('toggle', function () { if (d.open && !body) { body = findingDetail(f); d.appendChild(body); } });
    if (open) { body = findingDetail(f); d.appendChild(body); }
    return d;
  }

  function chainHtml(chain, ancestor) {
    return '<div class="chain">' + chain.map(function (p, i) {
      var isAnc = p === ancestor; var cls = isAnc ? 'start' : i === chain.length - 1 ? 'end' : '';
      return (i > 0 ? '<span class="arrow">→</span>' : '') + '<span class="node ' + cls + '" title="' + esc(p) + '">' + esc(short(p)) + (isAnc ? ' ⟳' : i === chain.length - 1 ? ' ✖' : '') + '</span>';
    }).join('') + '</div>';
  }

  function failureBlock(fp) {
    var state = fp.state === 'tdz'
      ? 'still loading → <b>ReferenceError: Cannot access \'' + esc(fp.binding) + '\' before initialization</b>'
      : 'not evaluated yet → the binding is <b>undefined</b>';
    var via = '';
    if (fp.via && fp.via.length) {
      via = '<div class="via">' + '<code>' + esc(fp.symbol) + '()</code> is called here; ' + fp.via.map(function (v, i) {
        return (i ? '→ calls ' : '') + '<code>' + esc(v.fn) + '()</code> (' + loc(v.path, v.line) + ')';
      }).join(' ') + ' reads <code>' + esc(fp.binding) + '</code></div>';
    }
    return '<div class="codeblock"><div class="loc">' + loc(fp.from, fp.line, fp.column) + '</div><pre>' + esc(fp.snippet) + '</pre>' + via +
      '<div class="why"><code>' + esc(fp.binding) + '</code> (' + esc(fp.originKind) + ' in <span class="mono">' + esc(fp.originPath || fp.to) + '</span>) is ' + state + '. Context: ' + md(fp.context) + '.' + (fp.uncertain ? '<div style="margin-top:4px"><b>Not certain:</b> ' + md(fp.uncertain) + '.</div>' : '') + '</div></div>';
  }

  function findingDetail(f) {
    var el = h('div', { class: 'detail' });
    findingEvidence(f, el, false);
    findingFixes(f, el, false);
    return el;
  }

  /** How it breaks: the summary, the failing line(s), the load order and the cycle with its diagram. */
  function findingEvidence(f, el, lead) {
    // the lead finding of a card has its headline right above: no need to say it twice
    if (!lead) el.appendChild(h('div', { class: 'summary', html: md(f.summary) }));

    if (f.kind === 'latent-cycle') {
      var gates = f.enteredThrough || [];
      el.appendChild(h('div', { class: 'st' }, ['Why nothing breaks today']));
      el.appendChild(h('div', { html: gates.length
        ? '<div class="muted" style="font-size:12.5px;margin-bottom:4px">The first file of a cyclic group to be imported fixes the order of all the others. Every current entry point enters this group through:</div>' + gates.slice(0, 6).map(function (g) {
            var who = [g.main ? 'app start' : '', g.lazy ? plural(g.lazy, 'lazy chunk') : '', g.test ? plural(g.test, 'spec') : ''].filter(Boolean).join(', ');
            return '<div class="gate">' + loc(g.file) + ' <span class="who">– ' + esc(who) + '</span></div>';
          }).join('') + (gates.length > 6 ? '<div class="muted">… ' + (gates.length - 6) + ' more files</div>' : '')
        : '<div class="muted">No current entry point loads these files.</div>' }));
      el.appendChild(h('div', { class: 'st' }, ['Reads that would break under another order (' + f.failures.length + ')']));
      var rowsHtml = function (n) {
        return '<div class="tablewrap"><table><thead><tr><th>Read at load time</th><th>Needs</th><th>Breaks if this is imported first</th></tr></thead><tbody>' + f.failures.slice(0, n).map(function (x) {
          var more = (x.triggerCount || x.entries.length) - 1;
          var first = x.entries[0];
          return '<tr><td>' + loc(x.from, x.line, x.column) + '<div class="mono muted" style="font-size:11.5px;overflow-wrap:anywhere">' + esc(x.snippet) + '</div></td>' +
            '<td class="syms"><code>' + esc(x.binding) + '</code><div class="muted">' + esc(x.originKind) + ' in ' + esc(short(x.originPath || x.to)) + (x.via && x.via.length ? ', read inside ' + esc(x.symbol) + '()' : '') + (x.uncertain ? ' · not certain: ' + md(x.uncertain) : '') + '</div></td>' +
            '<td>' + (first ? fileCell(first.entry) : '') + (more > 0 ? '<span class="muted" style="font-size:11.5px">or ' + plural(more, 'other file') + ' of the group</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      };
      var tbl = h('div', { html: rowsHtml(12) });
      el.appendChild(tbl);
      if (f.failures.length > 12) el.appendChild(h('button', { class: 'linkbtn', onclick: function (e) { tbl.innerHTML = rowsHtml(f.failures.length); e.target.remove(); } }, ['Show all ' + f.failures.length + ' reads']));
    } else if (f.failures.length) {
      el.appendChild(h('div', { class: 'st' }, [f.failures.length > 1 ? 'Failing lines' : 'Failing line']));
      el.appendChild(h('div', { html: f.failures.slice(0, 3).map(failureBlock).join('') }));
      if (f.failures.length > 3) el.appendChild(h('div', { class: 'muted' }, ['… ' + (f.failures.length - 3) + ' more reads on the same import']));
      var fp = f.failures[0];
      var entries = fp.entries;
      var app = entries.filter(function (e) { return e.kind === 'main' || e.kind === 'lazy'; });
      var tests = entries.filter(function (e) { return e.kind === 'test'; });
      var hyp = entries.filter(function (e) { return e.kind === 'hypothetical'; });
      var first = app[0] || tests[0] || hyp[0];
      if (first) {
        var label = first.kind === 'hypothetical' ? 'Load order that crashes (if ' + short(first.entry) + ' is imported first)' : first.kind === 'lazy' ? 'Load order (lazy chunk ' + short(first.entry) + ')' : 'Load order from ' + first.entry;
        el.appendChild(h('div', { class: 'st' }, [label]));
        el.appendChild(h('div', { html: chainHtml(first.chain, fp.originPath) }));
      }
      if (tests.length) {
        var d = h('details', { class: 'more' }, [h('summary', {}, [(app.length ? 'Also crashes in ' : 'Crashes in ') + plural(tests.length, 'spec file')])]);
        d.appendChild(h('div', { class: 'mono muted', style: 'font-size:12px;columns:2 260px;margin-top:4px', html: tests.slice(0, 80).map(function (t) { return '<div>' + esc(t.entry) + '</div>'; }).join('') + (tests.length > 80 ? '<div>… +' + (tests.length - 80) + '</div>' : '') }));
        el.appendChild(d);
      }
    }

    if (f.cycle && f.cycle.nodes.length) {
      var failing = f.failures.slice();
      if (f.kind === 'latent-cycle') failing = failing.filter(function (x) { return f.cycle.edges.some(function (e) { return e.from === x.from && e.to === x.to; }); });
      el.appendChild(h('div', { class: 'st' }, [(f.kind === 'latent-cycle' ? 'One of the cycles (' : 'The cycle (') + plural(f.cycle.nodes.length, 'file') + ')']));
      var ev = h('div', { class: 'evidence' + (f.cycle.nodes.length > 5 ? ' long' : '') });
      var dia = h('div', { class: 'diagram', html: ring(f.cycle.nodes, f.cycle.edges, failing) + LEGEND + DIAGRAM_HINT });
      bindTips(dia, f.cycle.edges, failing);
      ev.appendChild(dia);
      var table = h('div', { class: 'tablewrap', html: '<table><thead><tr><th>File</th><th>imports</th><th>Use</th><th>Symbols · where</th></tr></thead><tbody>' + f.cycle.edges.map(function (e) {
        var isFail = failing.some(function (x) { return x.from === e.from && x.to === e.to; });
        var where = e.sample && e.usage !== 'none' ? '<div class="muted" style="font-size:11.5px">' + md(e.sample.context) + ' · L' + e.sample.line + '</div>' : '';
        return '<tr class="' + (isFail ? 'fail' : '') + '"><td>' + fileCell(e.from) + '</td><td>' + fileCell(e.to) + (e.viaBarrel ? ' ' + tag('barrel', 'barrel') : '') + '</td><td>' + usageTag(e.usage) + (isFail ? ' ⚡' : '') + '</td><td class="syms">' + esc(e.symbols.slice(0, 4).join(', ')) + (e.symbols.length > 4 ? ', …' : '') + where + '</td></tr>';
      }).join('') + '</tbody></table>' });
      if (lead && f.cycle.nodes.length > 5) {
        // a long cycle: the diagram (with its code popups) carries the picture, the table is one click away
        var all = h('details', { class: 'more' }, [h('summary', {}, ['The ' + f.cycle.edges.length + ' imports of this cycle as a table'])]);
        all.appendChild(h('div', { style: 'margin-top:6px' }, [table]));
        ev.appendChild(h('div', {}, [all]));
      } else ev.appendChild(table);
      el.appendChild(ev);
    }
  }

  /** The fix options of one finding (the group's plan is shown separately). */
  function findingFixes(f, el, plain) {
    var good = f.suggestions.filter(function (s) { return s.verified; });
    var other = f.suggestions.filter(function (s) { return !s.verified; });
    if (f.suggestions.length) {
      if (!plain) el.appendChild(h('div', { class: 'st' }, [good.length ? 'How to fix' : 'What to do']));
      (good.length ? good : other).forEach(function (s) { el.appendChild(fixHtml(s, good.length > 0)); });
      if (good.length && other.length) {
        var more = h('details', { class: 'more' }, [h('summary', {}, ['Other options considered (' + other.length + ') – not sufficient on their own'])]);
        other.forEach(function (s) { more.appendChild(fixHtml(s, false)); });
        el.appendChild(more);
      }
    }
  }

  function fixHtml(s, verified) {
    var details = (s.details || []);
    var code = details.filter(function (d) { return /^import /.test(d); });
    var text = details.filter(function (d) { return !/^import /.test(d); });
    return h('div', { class: 'fix', html: '<span class="mark' + (s.verified ? '' : ' u') + '">' + (s.verified ? '✔ verified' : '•') + '</span><span>' + md(s.text) + '</span>' +
      (details.length ? '<div class="details">' + (code.length ? '<pre>' + esc(code.join('\n')) + '</pre>' : '') + text.map(function (d) { return '<div>' + md(d) + '</div>'; }).join('') + '</div>' : '') });
  }

  function diCard(f) {
    var el = h('section', { class: 'problem ' + f.severity, id: f.id });
    el.appendChild(h('div', { class: 'problem-head', html: '<h2><span class="badge ' + f.severity + '">' + f.severity + '</span> Angular DI cycle (NG0200) <span class="chip">' + (f.di.certain ? 'certain' : 'verify: @SkipSelf/@Host involved') + '</span></h2><div class="facts">' + esc(f.di.nodes.map(function (n) { return n.name; }).join(' → ') + ' → ' + f.di.nodes[0].name) + '</div>' }));
    el.appendChild(h('div', { class: 'lead' }, [h('div', { class: 'sect' }, ['How it breaks'])]));
    var body = h('div', { class: 'lead-body' });
    body.appendChild(h('div', { class: 'summary', style: 'margin-top:0', html: md(f.summary) }));
    var ev = h('div', { class: 'evidence' });
    var names = f.di.nodes.map(function (n) { return n.name; });
    var edges = f.di.edges.map(function (e, i) {
      var how = e.via + (e.flags.length ? ' (' + e.flags.map(function (x) { return '@' + x; }).join(' ') + ')' : '');
      return { from: names[i], to: names[(i + 1) % names.length], file: e.path, verb: 'needs', usage: 'eager', symbols: [e.via], viaBarrel: false, imports: [],
        uses: [{ line: e.line, snippet: e.snippet || '', timing: 'di', context: 'injected while \x60' + names[i] + '\x60 is being constructed (' + how + ')' }] };
    });
    var dia = h('div', { class: 'diagram', html: ring(names, edges, []) + DIAGRAM_HINT });
    bindTips(dia, edges, []);
    ev.appendChild(dia);
    ev.appendChild(h('div', { class: 'tablewrap', html: '<table><thead><tr><th>Needs</th><th>Where</th><th>How</th></tr></thead><tbody>' + f.di.edges.map(function (e) {
      return '<tr><td><b>' + esc(e.from) + '</b> → <b>' + esc(e.to) + '</b></td><td>' + loc(e.path, e.line) + '</td><td>' + esc(e.via) + (e.flags.length ? ' (' + e.flags.map(function (x) { return '@' + x; }).join(' ') + ')' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' }));
    body.appendChild(ev);
    el.appendChild(body);
    var fix = h('div', { class: 'lead' }, [h('div', { class: 'sect' }, ['How to fix'])]);
    var fixes = h('div', { class: 'lead-fixes' });
    f.suggestions.forEach(function (s) { fixes.appendChild(fixHtml(s, true)); });
    fix.appendChild(fixes);
    el.appendChild(fix);
    return el;
  }

  // ------------------------------------------------------------------ entries
  function renderEntries() {
    var wrap = h('div');
    if (!data.entries.length) { wrap.appendChild(h('div', { class: 'empty' }, ['No entry points evaluated. Pass --entry src/main.ts (and keep spec files included) to replay the load order.'])); return wrap; }
    var rows = data.entries.slice().sort(function (a, b) { return b.breakages - a.breakages || (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : 0); });
    var withBreaks = rows.filter(function (e) { return e.breakages || e.kind !== 'test'; });
    var quiet = rows.length - withBreaks.length;
    var table = function (list) { return '<div class="tablewrap"><table><thead><tr><th>Entry</th><th>Kind</th><th>Modules loaded</th><th>Imports read too early</th></tr></thead><tbody>' + list.map(function (e) {
      return '<tr><td class="path" title="' + esc(e.entry) + '">' + esc(e.entry) + '</td><td>' + esc(e.kind) + '</td><td>' + num(e.evaluated) + '</td><td>' + (e.breakages ? '<b style="color:var(--critical)">' + e.breakages + '</b>' : '0') + '</td></tr>';
    }).join('') + '</tbody></table></div>'; };
    wrap.appendChild(h('div', { html: table(withBreaks) }));
    if (quiet) {
      var d = h('details', { class: 'more' }, [h('summary', {}, [quiet + ' spec files load without problems'])]);
      d.addEventListener('toggle', function () { if (d.open && d.childNodes.length === 1) d.appendChild(h('div', { html: table(rows.filter(function (e) { return withBreaks.indexOf(e) < 0; })) })); });
      wrap.appendChild(d);
    }
    if (data.unresolved.length) {
      var u = h('details', { class: 'more' }, [h('summary', {}, ['Unresolved imports (' + data.unresolved.length + ')'])]);
      u.appendChild(h('div', { class: 'mono muted', style: 'font-size:12px', html: data.unresolved.slice(0, 200).map(function (x) { return '<div>' + esc(x.from) + ':' + x.line + ' → ' + esc(x.specifier) + '</div>'; }).join('') }));
      wrap.appendChild(u);
    }
    return wrap;
  }

  // ------------------------------------------------------------------ how to
  function renderHowto() {
    return h('div', { class: 'prose', html: [
      '<h3>What this report shows</h3>',
      '<p>An import cycle only breaks when a module <em>reads</em> a binding from a module that has not finished loading. The tool replays the ES-module load order – from <code>main.ts</code>, every lazy route chunk on its own (as if the user deep-linked to it) and every spec file – and reports exactly those reads. Severity says how real the problem is <em>today</em>.</p>',
      '<h3>Severities</h3>',
      '<ul><li><b>Critical</b> – crashes when the app (or a lazy route) loads: <code>ReferenceError: Cannot access X before initialization</code> under native ESM / Vite / vitest, or an <code>undefined</code> value after bundling (<code>Class extends value undefined</code>, <code>Invalid provider … undefined</code>).</li>',
      '<li><b>High</b> – crashes only when a spec file is the entry (“works in the app, fails in tests”), and Angular DI cycles (NG0200).</li>',
      '<li><b>Medium</b> – a <em>possible</em> crash on a real load path: the read is reached when the app or a spec loads, but whether it runs depends on something the analysis cannot prove (a branch, a callback assumed to run synchronously, a file outside the analysed set). The reason is shown – check it.</li>',
      '<li><b>Low</b> – order-dependent: nothing breaks in any current load order. The group is replayed once more with each of its files imported first; the reads that would fail in one of those orders are listed, together with the files through which today\'s entry points enter the group. Good to know before you reorder imports or add a spec; not a bug. One finding per group.</li>',
      '<li><b>Info</b> – cycles that cannot crash: reads only happen inside functions or target hoisted functions (replayed in every order), or the files reference each other only as types, which the compiler erases.</li></ul>',
      '<h3>Why a new finding can appear after a fix</h3>',
      '<p>Changing an import changes the load order, and a read that was safe can become the next crash. Such reads are the <em>order-dependent</em> ones (low). To take the surprise out, each fix plan is replayed: the entry points are loaded again with the plan applied one change at a time, and a line “then: next crash – …” names what would surface after that step. “No crash left, none surfaces elsewhere” means the full plan was replayed clean.</p>',
      '<h3>Problems = cyclic groups</h3>',
      '<p>Files that can all reach each other form a group, and each group is one card. A card first shows <b>how it breaks</b> – the worst finding of the group with its failing line, the load order from the entry point and the cycle as a diagram (hover an arrow for the code). Then <b>how to fix</b> it: the fewest imports to change so the group becomes acyclic, replayed step by step. One change usually fixes every finding of a group; the other findings follow as rows. A group in which nothing breaks today starts with its fix plan and rows. Angular DI cycles get a card of their own with the same order.</p>',
      '<h3>Read at load time vs. later</h3>',
      '<ul><li><b>Load time</b>: top-level code, <code>extends</code>, decorator arguments (<code>@Component({ imports, providers })</code>), static fields, enum initialisers, route arrays, callbacks of <code>.map()</code>/<code>.forEach()</code>, and anything inside functions called while the module loads – including functions in other files.</li>',
      '<li><b>Later</b>: function and method bodies, constructors, instance fields (<code>inject()</code>), arrow functions, <code>forwardRef(() =&gt; X)</code>, <code>loadComponent: () =&gt; import(...)</code>.</li>',
      '<li><b>Type only</b>: annotations, <code>implements</code>, generics, <code>import type</code>, <code>const enum</code> members without <code>isolatedModules</code>. Erased at compile time. Angular constructor parameter types are <em>not</em> type-only: the compiler references them in the generated factory.</li></ul>',
      '<h3>Why “use <code>import type</code>” is usually not the fix</h3>',
      '<p>An import used only as a type is already erased, so it never shows up above <em>info</em>. Imports that matter are used as values (a base class, a component in <code>imports</code>, a service in <code>inject()</code>) and cannot become type imports. The one exception is <code>emitDecoratorMetadata</code> with non-Angular decorators, where typing a parameter with an interface does remove the read – the tool says so when it applies.</p>',
      '<h3>Links</h3>',
      '<p>File locations link to VS Code (<code>vscode://file/…</code>); turn this off with the checkbox above the problem list.</p>'
    ].join('') });
  }

  function render() {
    hideTip();
    app.innerHTML = '';
    app.appendChild(renderHeader());
    var main = h('main');
    main.appendChild(renderVerdict());
    main.appendChild(renderCards());
    main.appendChild(renderTabs());
    main.appendChild(state.tab === 'problems' ? renderProblems() : state.tab === 'entries' ? renderEntries() : renderHowto());
    app.appendChild(main);
  }
  render();
  function openHash() {
    if (!location.hash) return;
    var id = decodeURIComponent(location.hash.slice(1));
    var target = document.getElementById(id);
    if (target && target.tagName === 'DETAILS') target.open = true;
    if (target) target.scrollIntoView();
  }
  openHash();
  window.addEventListener('hashchange', openHash);
})();
`;
