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
    expect(res.stdout).toContain('MEDIUM  Order-dependent');
  });
});
