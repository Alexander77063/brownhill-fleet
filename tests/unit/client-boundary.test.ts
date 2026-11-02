// tests/unit/client-boundary.test.ts
//
// THE RULE
// --------
// A `'use client'` module may not reach a module marked `import 'server-only'`.
//
// `server-only` is the marker this repository puts on code that must never
// leave the server. Today there is one such file — `src/lib/auth/password.ts` —
// and everything that reaches it reaches the application's direct database
// connection, which connects as the table owner and therefore bypasses RLS.
//
// WHY IT NEEDS ITS OWN GATE
// -------------------------
// Next.js enforces the rule at BUILD time and nowhere else. `vitest.config.ts`
// aliases `server-only` to `tests/helpers/server-only-stub.ts`, because the
// real package throws "you are not in a Server Component" and that throw
// would mask the failure the test was actually written to find.
//
// The consequence is that a server-only module imported into a client
// component is INVISIBLE to the test suite. It was invisible once already:
//
//   src/components/accounting/VoidInvoiceButton.tsx  ('use client')
//     -> src/lib/accounting/invoice-register.ts
//       -> src/lib/auth/local-store.ts
//         -> src/lib/auth/password.ts                  (import 'server-only')
//
// The vitest suite was green. `pnpm typecheck` was green. The production
// build failed with "You're importing a component that needs server-only",
// five minutes and a whole container image after the work was written.
//
// The fix was to split the client-safe half of the register out into
// `src/lib/accounting/invoice-shared.ts` and import that from the client
// component. This file is the gate that makes the same mistake fail in a
// second, in the fast lane, without a container.
//
// IT ALSO CHECKS THE OTHER DIRECTION OF THE SAME RULE
// ----------------------------------------------------
// A client component importing a SERVER module that happens not to carry the
// `server-only` marker still works — the module is simply bundled for the
// browser — but it usually means a database helper has leaked into the client
// bundle without anybody noticing, because nothing failed. The gate below is
// specifically about the marker, because the marker is the promise; the
// broader "no database in the browser" question is a separate piece of work
// and pretending otherwise would make this gate a lie.
//
// THE NEGATIVE TEST AT THE BOTTOM
// -------------------------------
// A gate that cannot fail is not a gate. The last test in this file builds a
// synthetic import graph with exactly the shape that broke the build and
// asserts that the walker reports it. If someone rewrites the walker and
// breaks it, that test says so.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REPO_ROOT,
  SRC_DIR,
  extractImports,
  findServerOnlyChain,
  isClientComponent,
  isServerAction,
  isServerOnly,
  isTypeOnlyClause,
  listSourceFiles,
  readSource,
  resolveLocalImport,
} from '../helpers/client-boundary';

const SOURCE_FILES = listSourceFiles(SRC_DIR);

/** Repo-relative, for a message a human can act on. */
function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** Read a file from the repository. */
function read(file: string): string {
  return readSource(file);
}

/** The file name without its directory. */
function basename(file: string): string {
  return path.basename(file);
}

/**
 * Build a throwaway module graph on disk and walk it.
 *
 * Real files, not an in-memory stub: the walker reads each module's imports
 * off disk, so a fake graph would have to fake the reader too, and a gate
 * that is proven against a fake is not proven at all.
 */
function walkTemp(files: Record<string, string>, root: string): string[] | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-boundary-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), source);
    }
    const resolve = (specifier: string, fromFile: string): string | null => {
      if (!specifier.startsWith('.')) return null;
      const base = path.resolve(path.dirname(fromFile), specifier);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    };
    return findServerOnlyChain(
      path.join(dir, root),
      resolve,
      (file) => isServerOnly(readFileSync(file, 'utf8')),
      (file) => isServerAction(readFileSync(file, 'utf8')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the client/server boundary', () => {
  it('finds the client components in the repository', () => {
    const clients = SOURCE_FILES.filter((f) => isClientComponent(read(f)));
    // A sanity floor, not an exact count: the count moves as the product
    // grows, and a gate that fails whenever a component is added is a gate
    // people will start skipping.
    expect(clients.length).toBeGreaterThan(20);
    expect(clients.some((f) => f.includes('VoidInvoiceButton'))).toBe(true);
  });

  it('does not mistake a mention of the directive for the directive', () => {
    // The module that this very rule lives next to mentions "use client" in
    // its header comment. A substring search would classify it as a client
    // component and then walk a server module's graph, which would be noise.
    expect(isClientComponent("// use client\nconst a = 1;\n")).toBe(false);
    expect(isClientComponent("/* 'use client' */\nconst a = 1;\n")).toBe(false);
    expect(isClientComponent("'use client';\nconst a = 1;\n")).toBe(true);
    expect(isClientComponent('"use client";\nconst a = 1;\n')).toBe(true);
  });

  it('no client component reaches a server-only module', () => {
    const clients = SOURCE_FILES.filter((f) => isClientComponent(read(f)));
    const leaks: string[] = [];

    for (const client of clients) {
      const chain = findServerOnlyChain(
        client,
        resolveLocalImport,
        (file) => isServerOnly(read(file)),
        (file) => isServerAction(read(file)),
      );
      if (chain) leaks.push(chain.map(relative).join('  ->  '));
    }

    expect(
      leaks,
      leaks.length
        ? 'These client components reach a module marked `import \'server-only\'`, so the ' +
            'production build cannot compile them. Split the client-safe half out (see ' +
            'src/lib/accounting/invoice-shared.ts for the pattern) and import that instead.'
        : '',
    ).toEqual([]);
  });

  it('does not report a Server Action as a leak', () => {
    // The repository has twenty-seven `'use server'` modules, and most of them
    // reach the credential store — which is where `server-only` lives. A
    // Server Action never enters the browser bundle: Next.js compiles it into
    // the server bundle and leaves the client holding a reference that calls
    // back. So those chains are correct, and a gate that reported them would
    // report seven chains on its first run and be switched off within a week.
    //
    // This test pins the boundary in both directions: the Server Action chain
    // is clean, and the plain-module chain is not.
    const serverActionChain = walkTemp(
      {
        'Widget.tsx': "'use client';\nimport { helper } from './helper';\n",
        'helper.ts': "'use server';\nimport 'server-only';\nexport const helper = async () => 1;\n",
      },
      'Widget.tsx',
    );
    expect(serverActionChain).toBeNull();

    const plainChain = walkTemp(
      {
        'Widget.tsx': "'use client';\nimport { helper } from './helper';\n",
        'helper.ts': "import 'server-only';\nexport const helper = 1;\n",
      },
      'Widget.tsx',
    );
    expect(plainChain?.map(basename)).toEqual(['Widget.tsx', 'helper.ts']);
  });

  it('reads a type-only import as erased', () => {
    expect(isTypeOnlyClause('type { A }')).toBe(true);
    expect(isTypeOnlyClause('type *')).toBe(true);
    expect(isTypeOnlyClause('{ type A, type B }')).toBe(true);
    expect(isTypeOnlyClause('{ type A, b }')).toBe(false);
    expect(isTypeOnlyClause('{ A }')).toBe(false);
    expect(isTypeOnlyClause('*')).toBe(false);
  });

  it('finds the specifiers in every import form', () => {
    const edges = extractImports(
      [
        "import 'server-only';",
        "import { a } from './a';",
        "import type { B } from './b';",
        "export { c } from './c';",
        "export * from './d';",
        "const e = await import('./e');",
      ].join('\n'),
    );
    const bySpecifier = new Map(edges.map((e) => [e.specifier, e.typeOnly]));
    expect(bySpecifier.get('server-only')).toBe(false);
    expect(bySpecifier.get('./a')).toBe(false);
    expect(bySpecifier.get('./b')).toBe(true);
    expect(bySpecifier.get('./c')).toBe(false);
    expect(bySpecifier.get('./d')).toBe(false);
    expect(bySpecifier.get('./e')).toBe(false);
  });

  it('PROVES THE GATE CAN FAIL — it reports the chain that broke the build', () => {
    // The graph that broke the production build, rebuilt for real on disk:
    //
    //   VoidInvoiceButton.tsx  ->  invoice-register.ts
    //                          ->  local-store.ts
    //                          ->  password.ts  (server-only)
    //
    // The walker must report it, and must report the WHOLE chain, because
    // the chain is what tells the developer which import to move.
    const chain = walkTemp(
      {
        'VoidInvoiceButton.tsx':
          "'use client';\nimport { formatPence } from './invoice-register';\n",
        'invoice-register.ts': "import { localDb } from './local-store';\nexport const formatPence = 1;\n",
        'local-store.ts': "import './password';\nexport const localDb = 1;\n",
        'password.ts': "import 'server-only';\nexport const hash = 1;\n",
      },
      'VoidInvoiceButton.tsx',
    );

    expect(chain).not.toBeNull();
    expect(chain?.map(basename)).toEqual([
      'VoidInvoiceButton.tsx',
      'invoice-register.ts',
      'local-store.ts',
      'password.ts',
    ]);
  });

  it('PROVES THE GATE CAN FAIL — a type-only import does not trip it', () => {
    // The same graph, except the edge to the server-only module is a
    // type-only import, which the compiler erases. Nothing is bundled, so
    // nothing can fail. The gate must not report a leak here — a gate that
    // cries wolf gets ignored.
    const chain = walkTemp(
      {
        'Widget.tsx': "'use client';\nimport type { Hash } from './password';\n",
        'password.ts': "import 'server-only';\nexport type Hash = string;\n",
      },
      'Widget.tsx',
    );

    expect(chain).toBeNull();
  });
});
