// .analysis/diff-snapshots.mjs
//
// Read two heap snapshots and find what's growing between them.
// Strategy:
//   1. For each snapshot, count occurrences of identical (type, name) combos.
//      Strings/clones with the same shape count grow together.
//   2. Report deltas. Things with high COUNT diff are the leak surface.
//
// Caveats: v8 heap snapshots don't allocate stable IDs to plain JS objects,
// so we match by (type, name) and by approximate size.

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const [, , a, b] = process.argv;
if (!a || !b) { console.error('usage: node diff-snapshots.mjs <snap-a> <snap-b>'); process.exit(2); }

function loadSnapshot(path) {
  const t0 = Date.now();
  const snap = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const meta = snap.snapshot.meta;
  const NF = meta.node_fields.length;
  const NODE = snap.nodes;
  const STRINGS = snap.strings;
  const NODE_COUNT = Math.floor(NODE.length / NF);
  const NTYPES = meta.node_types[0];
  const NODE_FIELD = Object.fromEntries(meta.node_fields.map((f, i) => [f, i]));
  function readNodeAt(i, field) { return NODE[i * NF + NODE_FIELD[field]]; }
  function tname(t) { return NTYPES[t] || `t${t}`; }
  console.error(`[load] ${basename(path)}: ${NODE_COUNT.toLocaleString()} nodes in ${Date.now()-t0}ms`);
  // Build type+name histogram of objects. Group by (type, name) and count.
  const counts = new Map();
  const selfSums = new Map();
  const ids = new Map();
  for (let i = 0; i < NODE_COUNT; i++) {
    const type = readNodeAt(i, 'type');
    const name = readNodeAt(i, 'name');
    const self = readNodeAt(i, 'self_size');
    const tn = tname(type);
    const s = typeof name === 'number' ? (STRINGS[name] || `s#${name}`) : '';
    const key = `${tn}\0${s}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    selfSums.set(key, (selfSums.get(key) || 0) + self);
    if (type === 8 || type === 12) { // shared_function_info or code
      const id = readNodeAt(i, 'id');
      if (typeof id === 'number' && id > 0) ids.set(key, id);
    }
  }
  return { counts, selfSums, ids, NODE_COUNT };
}

const A = loadSnapshot(a);
const B = loadSnapshot(b);

const keys = new Set([...A.counts.keys(), ...B.counts.keys()]);
const diffs = [];
for (const k of keys) {
  const ca = A.counts.get(k) || 0;
  const cb = B.counts.get(k) || 0;
  if (cb - ca > 50) {
    const sa = A.selfSums.get(k) || 0;
    const sb = B.selfSums.get(k) || 0;
    diffs.push({ key: k, ca, cb, dCount: cb - ca, dSelf: sb - sa });
  }
}
diffs.sort((a, b) => b.dSelf - a.dSelf);
console.error(`[diff] ${diffs.length} entries with Δcount > 50, sorted by Δself_size`);
console.log('Top 30 growing (type+name) buckets:');
console.log('Δcount  Δself_KiB  type  name (first line)');
for (const d of diffs.slice(0, 30)) {
  const [t, ...rest] = d.key.split('\0');
  const name = rest.join('\0').split('\n')[0].slice(0, 120);
  console.log(`${String(d.dCount).padStart(7)}  ${(d.dSelf/1024).toFixed(1).padStart(11)}  ${t.padEnd(10)}  ${name}`);
}
