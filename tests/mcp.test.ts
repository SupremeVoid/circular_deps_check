/**
 * The MCP server end to end: a real client over stdio, the way an agent host starts it –
 * analyse, look at a finding, try the fix on paper, edit the project, recheck.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixturePath, projectRoot } from './helpers.js';

let client: Client;
let project: string;

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
};

beforeAll(async () => {
  // a private copy of the example project: the session below edits it
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'circdeps-mcp-'));
  fs.cpSync(fixturePath('06-fix-order'), project, { recursive: true });
  client = new Client({ name: 'circdeps-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: 'bun', args: ['run', path.join(projectRoot, 'src/cli.ts'), 'mcp', '--root', project], stderr: 'pipe' }));
});

afterAll(async () => {
  await client.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('mcp server', () => {
  it('introduces itself and its six read-only tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'circdeps' });
    expect(client.getInstructions()).toContain('simulate_changes');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['analyze', 'list_findings', 'get_finding', 'get_fix_plan', 'simulate_changes', 'recheck']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && (t.description ?? '').length > 40)).toBe(true);
    const sim = tools.find((t) => t.name === 'simulate_changes')!;
    expect(JSON.stringify(sim.inputSchema)).toContain('"remove","direct","defer"');
  });

  it('walks through a fix: analyse, explain, plan, simulate, edit, recheck', async () => {
    const summary = await call('analyze');
    expect(summary.isError).toBe(false);
    expect(summary.text).toContain('verdict: 1 load-time crash when the app or a lazy route loads');
    expect(summary.text).toContain('C1 critical: Load-time crash: Feature read before initialisation in src/shared/widget.ts at src/shared/widget.ts:6 (on app start)');
    expect(summary.text).toContain('fix: verified, 2 imports to change');

    const list = await call('list_findings', { minSeverity: 'high' });
    expect(list.text).toContain('total: 1');

    const finding = await call('get_finding', { finding: 'C1' });
    expect(finding.text).toContain('code: static owner = Feature.name;');
    expect(finding.text).toContain("error: ReferenceError: Cannot access 'Feature' before initialization");
    expect(finding.text).toContain("- L1: import { Feature } from '../feature';");
    expect(finding.text).toContain('files: src/main.ts, src/feature.ts, src/shared/index.ts, src/shared/widget.ts');

    const plan = await call('get_fix_plan', { group: 'C1' });
    expect(plan.text).toContain('change: import directly');
    expect(plan.text).toContain('importFrom: src/shared/helper.ts');
    expect(plan.text).toContain('nextCrashes:');

    // on paper: the first step alone resolves the crash but surfaces another one
    const sim = await call('simulate_changes', { changes: [{ from: 'src/feature.ts', to: 'src/shared/index.ts', action: 'direct' }] });
    expect(sim.text).toContain('resolved:\n  - C1 critical');
    expect(sim.text).toContain('newlyFailing:\n  - at: src/shared/theme.ts:5\n    reads: Panel\n    when: app start');
    expect(sim.text).toContain('verdict: resolves 1 of 1 crash findings, but 1 read that is fine today would fail');

    // the agent makes exactly that edit …
    const feature = path.join(project, 'src/feature.ts');
    fs.writeFileSync(feature, fs.readFileSync(feature, 'utf8').replace("from './shared'", "from './shared/helper'"));
    // … and the recheck reports what the simulation predicted
    const after = await call('recheck');
    expect(after.text).toContain('comparedWith: previous analysis');
    expect(after.text).toContain('resolved:\n  - key: read:src/shared/widget.ts>src/feature.ts');
    expect(after.text).toContain('key: read:src/shared/theme.ts>src/panel.ts');
    expect(after.text).toContain('verdict: 1 finding resolved, 1 new (1 of them a crash or possible crash), 1 changed');

    // second step of the plan: panel.ts no longer imports the barrel
    const panel = path.join(project, 'src/panel.ts');
    fs.writeFileSync(panel, "export class Panel {\n  static kind = 'panel';\n}\n");
    const done = await call('recheck', { since: 'baseline' });
    expect(done.text).toContain('comparedWith: first analysis of this session');
    expect(done.text).toMatch(/after:\n {2}critical: 0\n {2}high: 0\n {2}medium: 0/);
    expect(done.text).toContain('introduced: none');
  });

  it('answers a bad request with a message instead of failing', async () => {
    const unknown = await call('get_finding', { finding: 'C99' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No finding "C99"');
    const badFile = await call('simulate_changes', { changes: [{ from: 'nope.ts', to: 'src/panel.ts', action: 'remove' }] });
    expect(badFile.isError).toBe(true);
    expect(badFile.text).toContain('No analysed file matches "nope.ts"');
    const badRoot = await call('analyze', { root: 'does-not-exist' });
    expect(badRoot.isError).toBe(true);
    expect(badRoot.text).toContain('Project root not found');
  });
});
