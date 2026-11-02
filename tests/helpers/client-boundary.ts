/**
 * tests/helpers/client-boundary.ts
 *
 * The import-graph walk behind the client-boundary gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Next.js refuses to bundle a module marked `import 'server-only'` into a
 * client component. That refusal is the ONLY thing standing between the
 * repository's direct database connection and the browser, and it is enforced
 * in exactly one place: the production build.
 *
 * The test suite cannot see it, and that is not an accident — `vitest.config.ts`
 * aliases `server-only` to `tests/helpers/server-only-stub.ts` so that the
 * real package's "you are not in a Server Component" throw does not mask an
 * unrelated test failure. A unit test importing a client component therefore
 * loads the server-only module perfectly happily.
 *
 * The consequence, which this project has now felt once: a `'use client'`
 * component imported a helper from a module that reached the database, the
 * vitest suite was GREEN, `tsc --noEmit` was GREEN, and the production build
 * failed — five minutes and a full container image later, after the work was
 * already written.
 *
 * So the rule is checked here instead: statically, in a unit test that takes
 * under a second.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const SRC_DIR = path.join(REPO_ROOT, 'src');

/** One import edge out of a module. */
export interface ModuleEdge {
  /** The specifier as it was written in the source. */
  specifier: string;
  /**
   * Whether the import is erased at compile time.
   *
   * A type-only import does not put the target module in the bundle, so it
   * cannot drag `server-only` into the browser. `import type { X } from './y'`
   * and `import { type X } from './y'` are both erased; `import { X } from
   * './y'` is not.
   */
  typeOnly: boolean;
}

/**
 * `import ... from '...'`, `export ... from '...'`, bare `import '...'` and
 * `import('...')`.
 *
 * The `from` clause is matched non-greedily so it stops at the first ` from `
 * in the statement, which is the one that carries the specifier.
 */
const FROM_CLAUSE = /(?:^|\n)[ \t]*(?:import|export)\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2/g;
const BARE_IMPORT = /(?:^|\n)[ \t]*import\s*(['"])([^'"]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Whether a `from` clause names only types.
 *
 * `type { A }` and `type *` are type-only. A braced clause is type-only when
 * EVERY binding in it is marked `type` — one value binding in the braces
 * pulls the whole module into the bundle, so `import { type A, b }` is a value
 * import.
 */
export function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type[\s{*]/.test(c)) return true;
  if (c.startsWith('{')) {
    const close = c.lastIndexOf('}');
    if (close < 0) return false;
    const bindings = c
      .slice(1, close)
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    if (bindings.length === 0) return false;
    return bindings.every((b) => /^type\s/.test(b));
  }
  return false;
}

/** Every import edge out of a module's source. */
export function extractImports(source: string): ModuleEdge[] {
  const edges: ModuleEdge[] = [];

  for (const match of source.matchAll(FROM_CLAUSE)) {
    const clause = match[1] ?? '';
    const specifier = match[3] ?? '';
    if (!specifier) continue;
    edges.push({ specifier, typeOnly: isTypeOnlyClause(clause) });
  }

  for (const match of source.matchAll(BARE_IMPORT)) {
    const specifier = match[2] ?? '';
    if (!specifier) continue;
    edges.push({ specifier, typeOnly: false });
  }

  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[2] ?? '';
    if (!specifier) continue;
    edges.push({ specifier, typeOnly: false });
  }

  return edges;
}

/**
 * Whether a module opens with the `'use client'` directive.
 *
 * The directive has to be the FIRST statement in the file, so this looks at
 * the head of the file rather than searching it — a comment that mentions
 * "use client" (this file's own header does) must not count.
 */
export function isClientComponent(source: string): boolean {
  const head = source.replace(/^#!.*/, '').trimStart();
  const comments = /^(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/)[ \t]*)*/.exec(head);
  const rest = comments ? head.slice(comments[0].length).trimStart() : head;
  return /^['"]use client['"]/.test(rest);
}

/**
 * Whether a module is marked server-only.
 *
 * The marker is the bare side-effect import — the form the Next.js package
 * documents and the form the repository uses.
 */
export function isServerOnly(source: string): boolean {
  return /(?:^|\n)[ \t]*import\s*(['"])server-only\1/.test(source);
}

/**
 * Whether a module opens with the `'use server'` directive.
 *
 * WHY THIS IS A BOUNDARY, NOT A LEAK
 * ----------------------------------
 * A `'use server'` module imported by a `'use client'` component is a SERVER
 * ACTION. Next.js compiles the module into the server bundle and leaves the
 * client holding a reference that makes a call back to the server — the
 * module's own body never reaches the browser. So a Server Action is allowed
 * to reach `server-only`; that is the entire point of the marker.
 *
 * This matters because the repository has twenty-seven Server Action modules
 * and most of them reach the credential store, which is where `server-only`
 * lives. A gate that reported those would report seven chains on the first
 * run and would be switched off within a week.
 */
export function isServerAction(source: string): boolean {
  const head = source.replace(/^#!.*/, '').trimStart();
  const comments = /^(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/)[ \t]*)*/.exec(head);
  const rest = comments ? head.slice(comments[0].length).trimStart() : head;
  return /^['"]use server['"]/.test(rest);
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx'];

/**
 * The source of a file, read once.
 *
 * The gate walks the import graph of every client component, and those graphs
 * overlap heavily — forty-two components share most of the same modules. A
 * cache takes the walk from several seconds to milliseconds, which matters
 * because this runs in the fast lane.
 */
const SOURCE_CACHE = new Map<string, string>();

export function readSource(file: string): string {
  const cached = SOURCE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(file, 'utf8');
  SOURCE_CACHE.set(file, source);
  return source;
}

/** The import edges of a file, extracted once. */
const EDGE_CACHE = new Map<string, ModuleEdge[]>();

export function sourceEdges(file: string): ModuleEdge[] {
  const cached = EDGE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const edges = extractImports(readSource(file));
  EDGE_CACHE.set(file, edges);
  return edges;
}

/**
 * Resolve a specifier to a file in the repository, or null.
 *
 * Only the two specifier forms the project uses are resolved: the `@/`
 * alias (tsconfig maps it to `src/*`) and relative paths. A bare package
 * specifier is null — those come from node_modules and are the bundler's
 * problem, not the repository's.
 */
export function resolveLocalImport(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = path.join(SRC_DIR, specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  const candidates: string[] = [];
  for (const ext of EXTENSIONS) candidates.push(base + ext);
  for (const ext of EXTENSIONS) {
    if (ext === '') continue;
    candidates.push(path.join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable — treat as unresolvable */
    }
  }
  return null;
}

/**
 * The shortest import chain from `root` to a server-only module, or null.
 *
 * The chain is returned rather than a boolean so the failure can name the
 * route the developer has to break: "VoidInvoiceButton -> invoice-register ->
 * local-store -> password" says which import to move, where "a client
 * component imports a server-only module" says nothing.
 *
 * The walk STOPS at a `'use server'` module: a Server Action never enters the
 * browser bundle, so everything it reaches is server-side already. See
 * `isServerAction`.
 */
export function findServerOnlyChain(
  root: string,
  resolve: (specifier: string, fromFile: string) => string | null,
  serverOnly: (file: string) => boolean,
  serverAction: (file: string) => boolean = () => false,
): string[] | null {
  const seen = new Set<string>([root]);
  const parent = new Map<string, string | null>([[root, null]]);
  const queue: string[] = [root];

  while (queue.length > 0) {
    const file = queue.shift() as string;

    // A Server Action is server-side by construction. Nothing beyond it can
    // reach the browser, so the walk stops here rather than reporting a leak.
    if (file !== root && serverAction(file)) continue;

    if (serverOnly(file)) {
      const chain: string[] = [];
      let cursor: string | null = file;
      while (cursor) {
        chain.unshift(cursor);
        cursor = parent.get(cursor) ?? null;
      }
      return chain;
    }

    let edges: ModuleEdge[];
    try {
      edges = sourceEdges(file);
    } catch {
      continue;
    }

    for (const edge of edges) {
      if (edge.typeOnly) continue;
      const target = resolve(edge.specifier, file);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      parent.set(target, file);
      queue.push(target);
    }
  }

  return null;
}
