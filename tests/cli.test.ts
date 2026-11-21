import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturePath, projectRoot } from './helpers.js';

const run = (args: string[], cwd = projectRoot) => {
  const proc = Bun.spawnSync(['bun', 'run', path.join(projectRoot, 'src/cli.ts'), ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'circdeps-'));

describe('cli', () => {
  it('prints help and version', () => {
    expect(run(['--help']).stdout).toContain('Usage: circdeps');
    expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('writes text, html and json reports and exits 1 on critical findings by default', () => {
    const out = tmpDir();
    const res = run([fixturePath('01-basic'), '--out', out]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[C1] CRITICAL');
    expect(res.stdout).toContain('Reports written');
    for (const f of ['circular-deps.txt', 'circular-deps.html', 'circular-deps.json']) {
      expect(fs.existsSync(path.join(out, f))).toBe(true);
    }
    const txt = fs.readFileSync(path.join(out, 'circular-deps.txt'), 'utf8');
    expect(txt).toContain('[C5] INFO'); // the file version is always verbose
    expect(txt).not.toMatch(/\x1b\[/);
    const json = JSON.parse(fs.readFileSync(path.join(out, 'circular-deps.json'), 'utf8')) as { counts: Record<string, number> };
    expect(json.counts.critical).toBe(1);
  });

  it('honours --fail-on', () => {
    const out = tmpDir();
    expect(run([fixturePath('01-basic'), '--out', out, '--fail-on', 'none']).code).toBe(0);
    expect(run([fixturePath('01-basic'), '--out', out, '--fail-on', 'critical']).code).toBe(1);
    // fixture 02 has only critical + low; failing on medium still fails because critical is worse
    expect(run([fixturePath('02-barrels'), '--out', out, '--fail-on', 'medium']).code).toBe(1);
    expect(run([fixturePath('02-barrels'), '--out', out, '--fail-on', 'bogus']).code).toBe(2);
  });

  it('supports --json output on stdout', () => {
    const out = tmpDir();
    const res = run([fixturePath('03-angular-app'), '--out', out, '--format', 'json', '--json', '--fail-on', 'none']);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as { findings: { kind: string }[]; options: { entries: string[] } };
    expect(json.findings.map((f) => f.kind)).toContain('di-cycle');
    expect(json.options.entries).toEqual(['src/main.ts']);
    expect(fs.existsSync(path.join(out, 'circular-deps.html'))).toBe(false);
  });

  it('supports --entry, --no-tests, --include and --quiet', () => {
    const out = tmpDir();
    const res = run([
      fixturePath('01-basic'),
      '--out',
      out,
      '--entry',
      'src/app/base.component.ts',
      '--no-tests',
      '--include',
      'src/app/**/*.ts',
      '--quiet',
      '--fail-on',
      'none',
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Entries: src/app/base.component.ts');
    expect(res.stdout).toContain('1 CRITICAL'); // extends cycle now breaks from the chosen entry
    expect(res.stdout).not.toContain('[C1]');
    expect(res.stdout).toContain('Scanned 5 files');
  });

  it('fails with exit code 2 for a missing root', () => {
    const res = run([path.join(os.tmpdir(), 'does-not-exist-circdeps')]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Root directory not found');
  });

  it('reads circdeps.config.json from the root', () => {
    const root = tmpDir();
    fs.cpSync(fixturePath('01-basic'), root, { recursive: true });
    fs.writeFileSync(path.join(root, 'circdeps.config.json'), JSON.stringify({ noTestEntries: true, reportTypeOnly: false }), 'utf8');
    const out = tmpDir();
    const res = run([root, '--out', out, '--fail-on', 'none', '--verbose']);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('INFO  Type-only');
    expect(res.stdout).not.toContain('Breaks in tests');
    expect(res.stdout).toContain('LOW  Order-dependent');
    expect(res.stdout).toContain('0 MEDIUM');
  });
});

describe('cli subcommands (query layer)', () => {
  const shop = fixturePath('07-shop-app');

  it('summary and list print small answers, as text or JSON', () => {
    const summary = run(['summary', shop]);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain('verdict: 4 load-time crashes when the app or a lazy route loads');
    expect(summary.stdout.length).toBeLessThan(7000);
    const list = run(['list', shop, '--min-severity', 'high']);
    expect(list.stdout).toContain('total: 6');
    expect(list.stdout).toMatch(/- C1 critical \[runtime-break, group \d+\]: Load-time crash: HEADER_HEIGHT/);
    const json = JSON.parse(run(['list', shop, '--kind', 'di-cycle', '--json']).stdout) as { total: number; findings: { key: string }[] };
    expect(json.total).toBe(1);
    expect(json.findings[0]!.key).toBe('di:CartService+CouponService');
  });

  it('explain and plan take a finding id, then the root', () => {
    const explain = run(['explain', 'C1', shop]);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain('code: export const STICKY_OFFSET = HEADER_HEIGHT + 8;');
    expect(explain.stdout).toContain('loadOrder:');
    const plan = run(['plan', 'C2', shop]);
    expect(plan.stdout).toContain('change: import directly');
    expect(plan.stdout).toContain('nextCrashes:');
    expect(plan.stdout).toContain('replay: replayed 1 entry point with every step done: no crash left in this group');
    const missing = run(['explain', 'C99', shop]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('No finding "C99"');
    expect(run(['explain']).code).toBe(2);
  });

  it('simulate tries import changes without editing anything', () => {
    const sim = run(['simulate', shop, '--direct', 'order-list.component.ts,src/app/shared/index.ts']);
    expect(sim.code).toBe(0);
    expect(sim.stdout).toContain('newlyFailing:' + String.fromCharCode(10) + '  - at: src/app/shared/widgets/table-presets.ts:4');
    const defer = run(['simulate', shop, '--defer', 'category-node.component.ts,category-tree.component.ts', '--json']);
    expect((JSON.parse(defer.stdout) as { resolved: string[] }).resolved).toHaveLength(1);
    expect(run(['simulate', shop]).stderr).toContain('Nothing to simulate');
    expect(run(['simulate', shop, '--remove', 'only-one-file.ts']).stderr).toContain('expects "<importing file>,<imported file>"');
  });

  it('diff compares with a saved JSON report and fails on new problems', () => {
    const root = tmpDir();
    fs.cpSync(fixturePath('06-fix-order'), root, { recursive: true });
    const out = tmpDir();
    run([root, '--out', out, '--format', 'json', '--quiet', '--fail-on', 'none']);
    const baseline = path.join(out, 'circular-deps.json');
    const same = run(['diff', baseline, root]);
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('verdict: no change');
    // the first step of the fix alone: the old crash is gone, a new one surfaced
    const feature = path.join(root, 'src/feature.ts');
    fs.writeFileSync(feature, fs.readFileSync(feature, 'utf8').replace("from './shared'", "from './shared/helper'"));
    const changed = run(['diff', baseline, root]);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain('key: read:src/shared/widget.ts>src/feature.ts');
    expect(changed.stdout).toContain('verdict: 1 finding resolved, 1 new (1 of them a crash or possible crash), 1 changed');
    expect(run(['diff', baseline, root, '--fail-on', 'none']).code).toBe(0);
    expect(run(['diff', path.join(out, 'missing.json'), root]).stderr).toContain('Cannot read the baseline report');
  });

  it('documents the subcommands and the MCP server in --help', () => {
    const help = run(['--help']).stdout;
    expect(help).toContain('circdeps simulate [root]');
    expect(help).toContain('circdeps mcp');
    expect(run(['mcp', '--help']).stdout).toContain('Tools: analyze, list_findings, get_finding, get_fix_plan, simulate_changes, recheck.');
  });
});
