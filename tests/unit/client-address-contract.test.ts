// tests/unit/client-address-contract.test.ts
//
// THE PROJECT'S RULE
// -------------------
// The caller's address is read in exactly ONE place: `clientIpFrom` in
// `src/lib/auth/client-ip.ts`. Every module that needs the address calls it.
//
// WHY IT HAS TO BE A BUILD FAILURE
// --------------------------------
// The application sits behind nginx, and nginx sets the forwarding headers
// like this:
//
//     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
//     proxy_set_header X-Real-IP       $remote_addr;
//
// `$proxy_add_x_forwarded_for` APPENDS: whatever the caller sent is kept, and
// the address nginx actually saw is added to the END. So the header arrives
// as:
//
//     1.2.3.4, 5.6.7.8, <the address nginx saw>
//     ^^^^^^^^  ^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
//     the        the        the truth
//     caller's   caller's
//
// Reading the FIRST element — which is what
// `headers.get('x-forwarded-for')?.split(',')[0]` does — reads the address the
// CALLER chose. Every place that did it had the same defect:
//
//   * the one-time code route counted its per-address limit against it, so a
//     caller who sent a different address on every request walked past ten
//     codes an hour;
//   * the signing route wrote it into `signing_sessions.signer_ip` and into
//     the audit trail, so the record of who signed was a record of what the
//     signer said;
//   * the legal acceptance action wrote it into the legal trail, for the same
//     reason.
//
// None of that fails a typecheck, a lint, or a test. The first two had no
// test at all. So the rule is asserted statically instead, and the rule is
// about the SHAPE of the code rather than about any one call site: there is
// one reader, and everybody else asks it.
//
// THE CHECK
// ---------
// Every module under `src/` is parsed, and every READ of `x-forwarded-for` or
// `x-real-ip` is found. The AST is used rather than a regex over the raw text
// so that a COMMENT mentioning the header — which is not a read, and is in
// fact how this file explains itself — is never mistaken for one.
//
// A read anywhere but the one module is a failure, and so is a module that
// needs the address and does not ask the helper for it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkFiles } from '../helpers/schema-model';
import { REPO_ROOT, SRC_DIR } from '../helpers/repo-schema';

/**
 * The headers that carry a client address.
 *
 * Lower case, because HTTP header names are case insensitive and a module
 * that spells it `X-Forwarded-For` is reading the same header.
 */
const ADDRESS_HEADERS = new Set(['x-forwarded-for', 'x-real-ip']);

/**
 * The one module allowed to read them.
 *
 * It is the module that knows which end of the list is the truth.
 */
const THE_HELPER = 'src/lib/auth/client-ip.ts';

/**
 * The modules that need the caller's address.
 *
 * Each of them records it somewhere that matters — a limit, an audit trail —
 * so each of them has to take it from the helper rather than from the raw
 * header.
 */
const MUST_ASK_THE_HELPER = [
  'src/app/api/auth/local/otp/request/route.ts',
  'src/app/api/sign/[token]/submit/route.ts',
  'src/lib/actions/legal.ts',
];

interface AddressRead {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line. */
  line: number;
  /** How the read was written, for the message. */
  how: string;
}

/** A source file the parser can read. */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Every read of an address header in one file.
 *
 * Two shapes count, and only two:
 *
 *   * `headers.get('x-forwarded-for')` — a method call whose first argument
 *     is the header name;
 *   * `headers['x-forwarded-for']` — a computed member access.
 *
 * Anything else that happens to contain the name — a comment, a log message,
 * a constant — is not a read of the header.
 */
function addressReads(file: string, text: string): AddressRead[] {
  const sf = parse(file, text);
  const out: AddressRead[] = [];

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const name = node.arguments[0].text.toLowerCase();
      if (ADDRESS_HEADERS.has(name)) {
        out.push({ file, line: lineOf(node), how: `.get('${node.arguments[0].text}')` });
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      const name = node.argumentExpression.text.toLowerCase();
      if (ADDRESS_HEADERS.has(name)) {
        out.push({ file, line: lineOf(node), how: `['${node.argumentExpression.text}']` });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every call to `clientIpFrom` in one file. */
function callsTheHelper(file: string, text: string): number {
  const sf = parse(file, text);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'clientIpFrom'
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/** Every module under `src/`, with its text. */
function sourceFiles(): Array<{ file: string; text: string }> {
  return walkFiles(SRC_DIR, (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')).map((full) => ({
    file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

const files = sourceFiles();

describe('the client address is read in one place', () => {
  it('has the helper', () => {
    // The guard on the guard. If the helper were deleted, every rule below
    // would pass vacuously — there would be nothing to read the header, and
    // therefore nothing wrong with not asking.
    const helper = files.find((f) => f.file === THE_HELPER);
    expect(helper, `${THE_HELPER} is missing — there is nowhere to read the address from`).toBeDefined();
  });

  it('is read nowhere else', () => {
    const offenders: string[] = [];
    for (const { file, text } of files) {
      if (file === THE_HELPER) continue;
      for (const read of addressReads(file, text)) {
        offenders.push(
          `${read.file}:${read.line} — ${read.how} reads the client's address by hand. ` +
            'nginx APPENDS the address it saw to whatever the caller sent, so the first element ' +
            'is the caller\'s own claim. Use `clientIpFrom` from src/lib/auth/client-ip.ts.',
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('is asked of the helper by every module that needs it', () => {
    const missing: string[] = [];
    for (const file of MUST_ASK_THE_HELPER) {
      const found = files.find((f) => f.file === file);
      if (!found) {
        missing.push(`${file} — the file is gone, so the rule that listed it needs updating`);
        continue;
      }
      if (callsTheHelper(found.file, found.text) === 0) {
        missing.push(`${file} — does not call clientIpFrom, so it has no address to record`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('notices a module that reads the address by hand', () => {
    // The negative control. This is the shape the gate exists to catch, and
    // it is the shape the three defects had. If this test ever passes, the
    // gate has stopped working.
    const offender = addressReads(
      'src/app/api/example/route.ts',
      [
        "export async function POST(request: Request) {",
        "  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;",
        '  return new Response(ip);',
        '}',
      ].join('\n'),
    );
    expect(offender.length, 'the gate did not notice the hand-written read').toBe(1);
    expect(offender[0].how).toContain('x-forwarded-for');
  });

  it('notices a module that reads the address out of a headers object', () => {
    // The other shape. A server action has a headers object, not a request,
    // and `headers['x-real-ip']` reads it just as well as `.get()` does.
    const offender = addressReads(
      'src/lib/actions/example.ts',
      ["const ip = (await headers())['x-real-ip'] ?? null;"].join('\n'),
    );
    expect(offender.length, 'the gate did not notice the hand-written read').toBe(1);
    expect(offender[0].how).toContain('x-real-ip');
  });

  it('does not mistake a comment for a read', () => {
    // The positive control. A comment that NAMES the header is not a read of
    // it, and a gate that cannot tell the difference is a gate that fires on
    // the very file that explains the rule.
    const reads = addressReads(
      'src/lib/example.ts',
      [
        '// nginx sets X-Forwarded-For to $remote_addr, and the caller sends',
        '// its own first — see src/lib/auth/client-ip.ts.',
        '/* x-real-ip is overwritten too. */',
        'export const note = "x-forwarded-for";',
      ].join('\n'),
    );
    expect(reads).toEqual([]);
  });

  it('accepts a module that asks the helper', () => {
    // The positive control for the whole rule: the shape the code is
    // supposed to have is not reported.
    const reads = addressReads(
      'src/app/api/example/route.ts',
      [
        "import { clientIpFrom } from '@/lib/auth/client-ip';",
        'export async function POST(request: Request) {',
        '  const ip = clientIpFrom(request.headers);',
        '  return new Response(ip ?? "unknown");',
        '}',
      ].join('\n'),
    );
    expect(reads).toEqual([]);
  });
});
