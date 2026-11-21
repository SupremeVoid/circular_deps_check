import { describe, expect, it } from 'bun:test';
import { renderHtmlReport, renderTextReport, toJsonReport } from '../src/index.js';
import { setColor, stripAnsi } from '../src/util/ansi.js';
import { analyzeFixture } from './helpers.js';

describe('text report', () => {
  it('contains summary, findings with file:line locations, evaluation order and fix plan', async () => {
    const r = await analyzeFixture('01-basic');
    setColor(false);
    const text = renderTextReport(r, { verbose: true });
    expect(text).toContain('Summary');
    expect(text).toContain('1 CRITICAL');
    expect(text).toContain('[C1] CRITICAL');
    expect(text).toContain('src/app/config.ts:4:30');
    expect(text).toContain("ReferenceError: Cannot access 'routes' before initialization");
    expect(text).toContain('Evaluation order (from src/main.ts)');
    expect(text).toContain('src/main.ts → src/app/app.ts ⟳ → src/app/config.ts ✖');
    expect(text).toContain('Breaks in tests (1 spec): src/app/base.component.spec.ts');
    // groups with their verified fix come first, before the per-finding details
    expect(text).toContain('Problems – fix these first');
    expect(text).toContain('✖ Group #1: 2 files – 1 critical (C1)');
    expect(text).toContain('✔ fix (verified, 1 import):');
    expect(text.indexOf('Problems – fix these first')).toBeLessThan(text.indexOf('[C1] CRITICAL'));
    expect(text).toContain('[C5] INFO');
    expect(text).not.toMatch(/\x1b\[/);
  });

  it('hides low/info findings unless verbose and supports quiet', async () => {
    const r = await analyzeFixture('01-basic');
    setColor(false);
    const normal = renderTextReport(r);
    expect(normal).not.toContain('[C5] INFO');
    expect(normal).toContain('hidden – run with --verbose');
    const quiet = renderTextReport(r, { quiet: true });
    expect(quiet).toContain('Summary');
    expect(quiet).not.toContain('[C1]');
  });

  it('renders colours when enabled and strips them cleanly', async () => {
    const r = await analyzeFixture('01-basic');
    setColor(true);
    const coloured = renderTextReport(r);
    setColor(false);
    expect(coloured).toMatch(/\x1b\[/);
    expect(stripAnsi(coloured)).toBe(renderTextReport(r));
  });

  it('caps findings per severity', async () => {
    const r = await analyzeFixture('01-basic');
    setColor(false);
    const text = renderTextReport(r, { verbose: true, maxPerSeverity: 1 });
    expect(text).toContain('… 2 more info findings');
  });
});

describe('json report', () => {
  it('is path-relative, complete and serialisable', async () => {
    const r = await analyzeFixture('02-barrels');
    const json = toJsonReport(r, '1.2.3');
    const text = JSON.stringify(json);
    const parsed = JSON.parse(text) as typeof json;
    expect(parsed.tool).toEqual({ name: 'circular-deps-check', version: '1.2.3' });
    expect(parsed.counts.critical).toBe(1);
    expect(parsed.findings[0]!.cycle!.nodes).toEqual(['src/shared/state.ts', 'src/features/user/user.component.ts', 'src/shared/index.ts']);
    expect(parsed.findings[0]!.failures[0]!.from).toBe('src/shared/state.ts');
    expect(parsed.findings[0]!.failures[0]!.entries[0]!.chain[0]).toBe('src/main.ts');
    expect(parsed.groups[0]!.barrels).toEqual(['src/shared/index.ts']);
    expect(parsed.fixPlans[0]!.cuts[0]!.from).toBe('src/features/user/user.component.ts');
    expect(parsed.entries.map((e) => e.kind).sort()).toEqual(['main', 'test']);
    // no absolute paths leak into findings/groups (only the top-level root field is absolute)
    expect(JSON.stringify({ ...json, root: '' })).not.toContain(r.root);
  });
});

describe('display root', () => {
  it('replaces the path on this machine in every report and switches editor links off', async () => {
    const r = await analyzeFixture('02-barrels');
    const json = toJsonReport(r, '1', { displayRoot: 'my-app' });
    expect(json.root).toBe('my-app');
    expect(json.editorLinks).toBe(false);
    expect(toJsonReport(r, '1').editorLinks).toBe(true);
    expect(JSON.stringify(json)).not.toContain(r.root);
    const html = renderHtmlReport(r, '1', { displayRoot: 'my-app' });
    expect(html).not.toContain(r.root);
    setColor(false);
    expect(renderTextReport(r, { displayRoot: 'my-app' })).toContain('circular-deps-check  my-app');
  });
});

describe('html report', () => {
  it('is self-contained, embeds the data safely and renders all sections', async () => {
    const r = await analyzeFixture('03-angular-app');
    const html = renderHtmlReport(r, '0.0.1');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<script id="report-data" type="application/json">');
    expect(html).not.toMatch(/<script src=|<link /);
    expect(html).toContain('prefers-color-scheme: dark');
    const dataStart = html.indexOf('type="application/json">') + 'type="application/json">'.length;
    const dataEnd = html.indexOf('</script>', dataStart);
    const embedded = JSON.parse(html.slice(dataStart, dataEnd)) as { findings: unknown[]; groups: unknown[] };
    expect(embedded.findings).toHaveLength(r.findings.length);
    expect(embedded.groups).toHaveLength(r.sccs.length);
    expect(html).toContain("'Guide'");
    expect(html).toContain('Problems (');
    expect(html).toContain('vscode://file/');
    expect(html).toContain('forwardRef');
    // the code popup of the cycle diagram: edges carry their import statement and usage lines
    const withCycle = (embedded.findings as { cycle?: { edges: { imports?: { line: number; text: string }[]; uses?: { line: number; snippet: string }[] }[] } }[]).find((f) => f.cycle)!;
    expect(withCycle.cycle!.edges.every((e) => Array.isArray(e.imports) && Array.isArray(e.uses))).toBe(true);
    expect(withCycle.cycle!.edges.some((e) => e.imports!.some((i) => i.text.startsWith('import {')) && e.uses!.length > 0)).toBe(true);
    expect(html).toContain('class="hit"');
    expect(html).toContain("tip.id = 'tip'");
  });

  it('escapes closing script tags inside the data', async () => {
    const r = await analyzeFixture('01-basic');
    r.findings[0]!.title = 'x</script><script>alert(1)</script>';
    const html = renderHtmlReport(r, '0');
    const dataStart = html.indexOf('type="application/json">');
    const dataEnd = html.indexOf('</script>', dataStart);
    expect(html.slice(dataStart, dataEnd)).not.toContain('</script>');
    expect(html).toContain('<\\/script>');
  });
});
