// .analysis/snapshot-leaks.mjs
//
// Heap snapshot analyzer. Loads a Node V8 heap snapshot JSON and looks for
// retaining paths to the V8 heap root. We want to find objects that are
// (a) large by self-size, AND (b) reachable from a module-scope handle so
// they won't be garbage-collected.
//
// The v8 heap snapshot format encodes objects as parallel arrays:
//
//   meta.node_fields       = ["type","name","id","self_size","edge_count", ...]
//   meta.edge_fields       = ["type","name_or_index","to_node"]
//   nodes[i*N + k]         = field k of node i
//   edges[i*E + k]         = field k of edge i
//   meta.location_fields   = ["object_index","script_id","line","col"]
//   locations[i*L + k]     = field k of location i
//   meta.trace_function_info_fields = similar
//   meta.trace_node_fields = similar
//   meta.sample_fields      = similar
//
// index_node_type_to_string / index_edge_type_to_string / index_location_fields_script_id, etc.
//
// Specifically:
//   node_types: 0=hidden, 1=synthetic, 2=string, 3=number, 4=symbol,
//               5=simd_value, 6=closure, 7=regexp, 8=shared_function_info,
//               9=foreign, 10=array, 11=object, 12=code, 13=object_shape,
//               14=... , ...
//   edge_types: 0=context, 1=property, 2=internal, 3=hidden, 4=shortcut,
//               5=weak, ...
//
// Self size:    allocation attributable to the node itself.
// Retained:     total bytes reachable from this node's subtree.
//
// Node makes it easy: the snapshot JSON has a `snapshot.root_index` pointing
// at "GC roots". Anything reachable from roots with growing self_size is a
// leak.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

if (process.argv.length < 3) {
  console.error('usage: node snapshot-leaks.mjs <snapshot-file>');
  process.exit(2);
}

const path = resolve(process.argv[2]);
const t0 = Date.now();
const raw = readFileSync(path, 'utf8');
console.error(`[load] read ${raw.length} bytes from ${basename(path)} in ${Date.now()-t0}ms`);

const snap = JSON.parse(raw);
const meta = snap.snapshot.meta;
const NODE = snap.nodes;        // flat array
const EDGES = snap.edges;      // flat array
const STRINGS = snap.strings;  // string interning table
const LOCATIONS = snap.locations;
const NF = meta.node_fields.length;
// edge_types / edge_fields
const EF = meta.edge_fields.length;
const NODE_COUNT = Math.floor(NODE.length / NF);
if (!Number.isInteger(NODE_COUNT) || NODE_COUNT < 1) {
  console.error(`[load] unrecognised snapshot shape: nodes=${NODE.length} fields=${NF}`);
  process.exit(1);
}
const NODE_FIELD = Object.fromEntries(meta.node_fields.map((f, i) => [f, i]));
const EDGE_FIELD = Object.fromEntries(meta.edge_fields.map((f, i) => [f, i]));

// node_types[0] is the type-name table indexed by the `type` code from
// node_fields[0].  meta.node_types[1..] are the field-type annotations for
// the corresponding node_fields, but we don't need those for the analysis.
const NTYPES = meta.node_types[0];
const ETYPES = meta.edge_types[0];
function tname(t) { return NTYPES[t] || `t${t}`; }
function ename(t) { return ETYPES[t] || `e${t}`; }

function readNodeAt(i, field) {
  return NODE[i * NF + NODE_FIELD[field]];
}
function readEdgeAt(j, field) {
  return EDGES[j * EF + EDGE_FIELD[field]];
}

// nodes sorted by self_size desc
const all = [];
for (let i = 0; i < NODE_COUNT; i++) {
  all.push({
    i,
    type: readNodeAt(i, 'type'),
    name: readNodeAt(i, 'name'),
    self: readNodeAt(i, 'self_size'),
    edges: readNodeAt(i, 'edge_count'),
    id: readNodeAt(i, 'id'),
  });
}
console.error(`[load] ${NODE_COUNT.toLocaleString()} nodes`);

const TOTAL_SELF = all.reduce((a, n) => a + n.self, 0);
console.error(`[load] total self_size = ${(TOTAL_SELF / 1024 / 1024).toFixed(1)} MiB`);

const TYPE_NAME = NTYPES;

// 1. Top by self_size — large objects directly allocated
console.error('[step] top 30 by self_size:');
const topSelf = [...all].sort((a, b) => b.self - a.self).slice(0, 30);
const topSelfSummary = [];
for (const n of topSelf) {
  const s = STRINGS[n.name] ?? '(no name)';
  topSelfSummary.push({ self_kb: Math.round(n.self/1024), type: tname(n.type), name: s });
  console.error(`  ${n.self.toString().padStart(8)}  ${tname(n.type).padEnd(10)}  ${s}`);
}

// 2. Top by aggregate self_size per (type, name) — many small allocations of the same thing
console.error('[step] top 20 by aggregate self_size (type+name):');
const agg = new Map();
for (const n of all) {
  if (n.self <= 0) continue;
  const tn = tname(n.type);
  const s = STRINGS[n.name] || '';
  const key = `${tn}:${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
  const k = agg.get(key) || { self: 0, count: 0, sample_name: s };
  k.self += n.self; k.count++; agg.set(key, k);
}
const topAgg = [...agg.entries()].sort((a, b) => b[1].self - a[1].self).slice(0, 20);
for (const [k, v] of topAgg) {
  console.error(`  ${(v.self/1024/1024).toFixed(2).padStart(7)} MiB  ${String(v.count).padStart(5)}x  ${k}`);
}

// 3. Find top arrays/objects by self_size and see their size hint
console.error('[step] top 20 arrays/objects by self_size:');
const topContainers = all
  .filter(n => (tname(n.type) === 'array' || tname(n.type) === 'object' || tname(n.type) === 'object shape') && n.self >= 256)
  .sort((a, b) => b.self - a.self)
  .slice(0, 20);
for (const n of topContainers) {
  const s = STRINGS[n.name] ?? '(no name)';
  console.error(`  ${n.self.toString().padStart(8)}  ${tname(n.type).padEnd(10)}  edges=${n.edges}  ${s}`);
}

writeFileSync(resolve('heap-analysis-summary.json'), JSON.stringify({
  snapshot_file: basename(path),
  node_count: NODE_COUNT,
  total_self_bytes: TOTAL_SELF,
  top_self_by_node: topSelfSummary,
  top_aggregated_by_type_name: topAgg.map(([k, v]) => ({ key: k, ...v })),
  top_containers: topContainers.map(n => ({ self_kb: Math.round(n.self / 1024), type: tname(n.type), name: STRINGS[n.name] || '', edges: n.edges })),
}, null, 2), 'utf8');
console.error('[done] wrote heap-analysis-summary.json');
