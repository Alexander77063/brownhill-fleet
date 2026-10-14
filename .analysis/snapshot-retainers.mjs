// .analysis/snapshot-retainers.mjs
//
// Compute retained sizes and find the few paths from GC root that hold
// most of the heap. Different strategy than snapshot-leaks.mjs: rather
// than "what's the largest single node", we want "what retained-set is
// the largest", which is the answer to "why is the heap full".
//
// Approach:
//   1. Index edges by destination node (incoming map).
//   2. Identify synthetic / closure / object nodes whose dominant
//      identifying name hints at a Next.js framework singleton.
//   3. For each suspect, walk backward to its root closure, count how
//      many subnodes it transitively retains.
//
// This is a fuzzy heuristic — but V8 leak heaps are usually dominated by
// a small number of oversized "this is the cache" or "this is the
// module export" structures, and a few targeted walks find them.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

if (process.argv.length < 3) {
  console.error('usage: node snapshot-retainers.mjs <snapshot>');
  process.exit(2);
}
const path = resolve(process.argv[2]);
const t0 = Date.now();
const snap = JSON.parse(readFileSync(path, 'utf8'));
const meta = snap.snapshot.meta;
const NF = meta.node_fields.length;
const EF = meta.edge_fields.length;
const NODE = snap.nodes;
const EDGES = snap.edges;
const STRINGS = snap.strings;
const LOCATIONS = snap.locations;
const NODE_COUNT = Math.floor(NODE.length / NF);
const NTYPES = meta.node_types[0];
const ETYPES = meta.edge_types[0];
const NODE_FIELD = Object.fromEntries(meta.node_fields.map((f, i) => [f, i]));
const EDGE_FIELD = Object.fromEntries(meta.edge_fields.map((f, i) => [f, i]));

function readNodeAt(i, field) { return NODE[i * NF + NODE_FIELD[field]]; }
function readEdgeAt(j, field) { return EDGES[j * EF + EDGE_FIELD[field]]; }
function tname(t) { return NTYPES[t] || `t${t}`; }
function ename(t) { return ETYPES[t] || `e${t}`; }
function s(i) { const v = readNodeAt(i, 'name'); return typeof v === 'number' ? (STRINGS[v] || '') : ''; }

console.error(`[load] ${NODE_COUNT.toLocaleString()} nodes, ${EDGES.length / EF.toLocaleString()} edges, ${STRINGS.length.toLocaleString()} strings in ${Date.now()-t0}ms`);

// Build edges-out per node and edges-in per node. Edges reference nodes by
// POSITION in the flat `nodes` array (a multiple of NF), not by ordinal.
// So ordinal = position / NF.
const EDGE_OUT = new Array(NODE_COUNT);
const EDGE_IN = new Array(NODE_COUNT);
for (let i = 0; i < NODE_COUNT; i++) {
  EDGE_OUT[i] = [];
  EDGE_IN[i] = [];
}
for (let j = 0; j < EDGES.length / EF; j++) {
  const fromPos = readEdgeAt(j, 'from_node');
  const toPos = readEdgeAt(j, 'to_node');
  if (fromPos < 0 || toPos < 0) continue;
  if (fromPos % NF !== 0 || toPos % NF !== 0) continue;
  const from = fromPos / NF;
  const to = toPos / NF;
  if (from >= NODE_COUNT || to >= NODE_COUNT) continue;
  EDGE_OUT[from].push({ edgeIndex: j, to });
  EDGE_IN[to].push({ edgeIndex: j, from });
}

// Find synthetic / closure / object nodes whose name mentions heap-warming
// suspects: any Next.js framework path, "use cache", module exports,
// route handler names, "Response", "Render", "Headers", etc.
const SUSPECT_KEYWORDS = [
  'use cache', 'Response', 'Headers', 'Request', 'renderToStream',
  'ServerComponent', 'ClientReferenceManifest', 'HotReloader',
  'onError', 'setRequestMeta', 'Cookies', 'RSC', 'renderFlight',
  'renderHTML', 'prerender', 'require', 'module.exports',
  '__webpack_require__', 'webpackBootstrap', 'webpackChunk',
  'route', 'route_module', '/login', 'metadata',
];
const suspectClosure = [];
const suspectHighSelf = [];
for (let i = 0; i < NODE_COUNT; i++) {
  const t = readNodeAt(i, 'type');
  const name = s(i);
  const tn = tname(t);
  if (tn !== 'closure' && tn !== 'object' && tn !== 'code' && tn !== 'hidden') continue;
  if (!name) continue;
  let matched = SUSPECT_KEYWORDS.some((kw) => name.includes(kw));
  if (!matched) continue;
  if (tn === 'closure') suspectClosure.push({ i, name, self: readNodeAt(i, 'self_size'), type: tn });
  else suspectHighSelf.push({ i, name, self: readNodeAt(i, 'self_size'), type: tn });
}

console.error(`[susp] closure-like: ${suspectClosure.length}; big-object: ${suspectHighSelf.length}`);
suspectClosure.sort((a, b) => b.self - a.self);
suspectHighSelf.sort((a, b) => b.self - a.self);
console.error('[susp] top 20 closure candidates:');
for (const s of suspectClosure.slice(0, 20)) console.error(`  ${s.self.toString().padStart(8)}  ${s.name.split('\n')[0].slice(0, 100)}`);
console.error('[susp] top 20 object candidates:');
for (const s of suspectHighSelf.slice(0, 20)) console.error(`  ${s.self.toString().padStart(8)}  ${s.type.padEnd(10)}  ${s.name.split('\n')[0].slice(0, 100)}`);

// Now: for the top suspects, walk back up to a module / script root, and
// count how much the suspect's subtree retains.
function retainedSizeSubtree(nodeIdx, depth = 4) {
  const seen = new Set();
  let total = 0;
  const stack = [{ idx: nodeIdx, depth: 0 }];
  while (stack.length) {
    const { idx, depth: d } = stack.pop();
    if (seen.has(idx)) continue;
    seen.add(idx);
    total += readNodeAt(idx, 'self_size');
    if (d >= depth) continue;
    for (const e of EDGE_OUT[idx]) stack.push({ idx: e.to, depth: d + 1 });
    if (seen.size > 50000) break;
  }
  return total;
}

const CANDIDATE_CLOSURES = suspectClosure.slice(0, 30);
const CANDIDATE_OBJECTS = suspectHighSelf.slice(0, 30);
const results = [];
for (const c of [...CANDIDATE_CLOSURES, ...CANDIDATE_OBJECTS]) {
  const sub = retainedSizeSubtree(c.i, 3);
  results.push({ name: c.name.slice(0, 200), type: c.type, self: c.self, subtree_3hop_bytes: sub });
}
results.sort((a, b) => b.subtree_3hop_bytes - a.subtree_3hop_bytes);
console.error('[susp] sorted by 3-hop retained size:');
for (const r of results.slice(0, 30)) {
  console.error(`  ${(r.subtree_3hop_bytes/1024).toFixed(1).padStart(8)} KiB  ${r.type.padEnd(10)}  ${r.name.split('\n')[0].slice(0, 200)}`);
}

writeFileSync(resolve('heap-retainers.json'), JSON.stringify({
  snapshot_file: basename(path),
  results,
}, null, 2), 'utf8');
console.error('[done] wrote heap-retainers.json');
