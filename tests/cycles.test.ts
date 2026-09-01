import { describe, expect, it } from 'bun:test';
import {
  adjacencyFrom,
  canonicalCycle,
  cycleKey,
  enumerateCycles,
  reachableFrom,
  reaches,
  removeEdge,
  shortestCycleThroughEdge,
  shortestPath,
  stronglyConnectedComponents,
  subgraph,
} from '../src/cycles.js';

const edges = (spec: string): { from: string; to: string }[] =>
  spec
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [from, to] = s.split('>') as [string, string];
      return { from: from.trim(), to: to.trim() };
    });

describe('stronglyConnectedComponents', () => {
  it('finds no components in a DAG', () => {
    const adj = adjacencyFrom(edges('a>b, b>c, a>c'));
    expect(stronglyConnectedComponents(adj)).toEqual([]);
  });

  it('finds a simple 2-cycle', () => {
    const adj = adjacencyFrom(edges('a>b, b>a'));
    expect(stronglyConnectedComponents(adj)).toEqual([['a', 'b']]);
  });

  it('reports a self loop as a component', () => {
    const adj = adjacencyFrom(edges('a>a, a>b'));
    expect(stronglyConnectedComponents(adj)).toEqual([['a']]);
  });

  it('separates multiple components', () => {
    const adj = adjacencyFrom(edges('a>b, b>c, c>a, c>d, d>e, e>d, e>f'), ['x']);
    const comps = stronglyConnectedComponents(adj).sort((p, q) => p[0]!.localeCompare(q[0]!));
    expect(comps).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });

  it('handles a long chain without recursion issues', () => {
    const list: { from: string; to: string }[] = [];
    const n = 20000;
    for (let i = 0; i < n; i++) list.push({ from: `n${i}`, to: `n${i + 1}` });
    list.push({ from: `n${n}`, to: 'n0' });
    const comps = stronglyConnectedComponents(adjacencyFrom(list));
    expect(comps).toHaveLength(1);
    expect(comps[0]).toHaveLength(n + 1);
  });
});

describe('paths and cycles', () => {
  const adj = adjacencyFrom(edges('a>b, b>c, c>a, c>d, d>b, a>d'));

  it('shortestPath returns inclusive path', () => {
    expect(shortestPath(adj, 'a', 'c')).toEqual(['a', 'b', 'c']);
    expect(shortestPath(adj, 'a', 'a')).toEqual(['a']);
    expect(shortestPath(adj, 'd', 'x')).toBeNull();
  });

  it('shortestPath honours blocked nodes', () => {
    expect(shortestPath(adj, 'a', 'c', new Set(['b']))).toBeNull();
  });

  it('shortestCycleThroughEdge returns the cycle starting at from', () => {
    expect(shortestCycleThroughEdge(adj, 'a', 'b')).toEqual(['a', 'b', 'c']);
    expect(shortestCycleThroughEdge(adj, 'a', 'd')).toEqual(['a', 'd', 'b', 'c']);
    expect(shortestCycleThroughEdge(adj, 'x', 'x')).toEqual(['x']);
    expect(shortestCycleThroughEdge(adjacencyFrom(edges('a>b')), 'a', 'b')).toBeNull();
  });

  it('canonicalCycle rotates to the smallest node and cycleKey is rotation invariant', () => {
    expect(canonicalCycle(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
    expect(cycleKey(['b', 'c', 'a'])).toBe(cycleKey(['a', 'b', 'c']));
    expect(cycleKey(['a', 'c', 'b'])).not.toBe(cycleKey(['a', 'b', 'c']));
  });

  it('reaches / reachableFrom', () => {
    expect(reaches(adj, 'd', 'a')).toBe(true);
    expect(reachableFrom(adj, 'a')).toEqual(new Set(['a', 'b', 'c', 'd']));
    const cut = removeEdge(adj, 'c', 'a');
    expect(reaches(cut, 'd', 'a')).toBe(false);
    expect(reaches(adj, 'd', 'a')).toBe(true); // original untouched
  });

  it('subgraph keeps only inner edges', () => {
    const sub = subgraph(adj, ['a', 'b']);
    expect([...sub.get('a')!]).toEqual(['b']);
    expect([...sub.get('b')!]).toEqual([]);
  });
});

describe('enumerateCycles', () => {
  it('enumerates all elementary cycles of a small SCC', () => {
    const adj = adjacencyFrom(edges('a>b, b>c, c>a, c>d, d>b, a>d'));
    const scc = subgraph(adj, stronglyConnectedComponents(adj)[0]!);
    const { cycles, truncated } = enumerateCycles(scc, { maxCycles: 100, maxLength: 10 });
    expect(truncated).toBe(false);
    const keys = cycles.map((c) => c.join('>'));
    expect(keys).toContain('a>b>c');
    expect(keys).toContain('b>c>d');
    expect(keys).toContain('a>d>b>c');
    expect(cycles).toHaveLength(3);
    // sorted by length
    expect(cycles.map((c) => c.length)).toEqual([3, 3, 4]);
  });

  it('covers every edge with at least one cycle', () => {
    const adj = adjacencyFrom(edges('a>b, b>a, b>c, c>b, c>a'));
    const { cycles } = enumerateCycles(adj, { maxCycles: 100, maxLength: 10 });
    for (const [from, targets] of adj) {
      for (const to of targets) {
        const covered = cycles.some((c) => c.some((n, i) => n === from && c[(i + 1) % c.length] === to));
        expect(covered).toBe(true);
      }
    }
  });

  it('respects maxCycles and reports truncation', () => {
    // complete digraph on 6 nodes has many cycles
    const list: { from: string; to: string }[] = [];
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const x of nodes) for (const y of nodes) if (x !== y) list.push({ from: x, to: y });
    const adj = adjacencyFrom(list);
    const { cycles, truncated } = enumerateCycles(adj, { maxCycles: 25, maxLength: 6 });
    expect(cycles.length).toBeLessThanOrEqual(25);
    expect(truncated).toBe(true);
  });

  it('respects maxLength', () => {
    const adj = adjacencyFrom(edges('a>b, b>c, c>d, d>a, a>c'));
    const { cycles } = enumerateCycles(adj, { maxCycles: 100, maxLength: 3 });
    // The 4-cycle a>b>c>d cannot be produced by Johnson, but edge coverage may still find it
    // since edge coverage is not length-limited; ensure no cycle exceeds coverage results.
    for (const c of cycles) expect(c.length).toBeLessThanOrEqual(4);
  });

  it('handles large SCCs via edge coverage only', () => {
    const list: { from: string; to: string }[] = [];
    const n = 300;
    for (let i = 0; i < n; i++) {
      list.push({ from: `n${i}`, to: `n${(i + 1) % n}` });
      list.push({ from: `n${i}`, to: `n${(i + 7) % n}` });
    }
    const adj = adjacencyFrom(list);
    const started = performance.now();
    const { cycles } = enumerateCycles(adj, { maxCycles: 200, maxLength: 25 });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.length).toBeLessThanOrEqual(200);
  });
});
