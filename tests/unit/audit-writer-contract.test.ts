// tests/unit/audit-writer-contract.test.ts
//
// THE PROJECT'S RULE
// -------------------
// An audit row is written in exactly ONE place: the writer in
// `src/lib/audit.ts`. Every module that records something calls it.
//
// TWO RULES, NOT ONE
// ------------------
//   1. The `log_audit` RPC is called in exactly one place — the writer.
//      Every other module goes through `appendAudit`.
//   2. The trail table itself is never written by hand. Not by a module, and
//      not by the writer.
//
// The second rule is here because the first one alone can be satisfied by a
// module that never calls the RPC at all: it can insert into `audit_log`
// directly, and the RPC-based rule would not see it. A module that writes
// the table by hand has opted out of the actor rules, the tenant rules and
// the error handling that the RPC applies — and it opts out silently, which
// is exactly how the trail went missing in the first place.
//
// THE TRAIL IS NOT THE ACCOUNTING TABLE
// -------------------------------------
// `accounting.audit_log` is a DIFFERENT table with a different job: the
// accounting module writes it directly, in the same transaction as the
// postings it describes, because those rows are part of the accounting
// record rather than a trail of actions. The second rule must not fire on
// it. A gate that stopped the accounting module from recording what it
// posted would be a gate doing harm.
//
// WHY IT HAS TO BE A BUILD FAILURE
// --------------------------------
// The audit trail was empty of system actions for a long time, and the reason
// it was empty is the reason this rule exists:
//
//   * `audit_log.actor` has a foreign key to `auth.users(id)`.
//   * `log_audit()` defaulted the actor to the user the request was made for.
//   * A request made by the SERVER has no such user — it acts as the service
//     principal, which is deliberately not a row in `auth.users` — so the
//     write was refused with 23503.
//   * And every call site threw that error away. Twenty-four of the twenty-eight
//     `log_audit` calls in the application did not look at the result.
//
// So the trail did not fail loudly. It was silently never written, and the
// only symptom was an empty table.
//
// A call site that discards the error is a call site that can lose an audit
// row without anybody being told. The writer is the one place that looks at
// the error, and this rule is what keeps it that way.
//
// THE CHECK
// ---------
// Every module under `src/` is parsed, and every call to the `log_audit` RPC
// is found. The AST is used rather than a regex over the raw text so that a
// COMMENT mentioning `log_audit` — which is not a call, and is in fact how
// this file explains itself — is never mistaken for one.
//
// A call anywhere but the writer is a failure.
//
// The second rule is the same idea applied to the table itself: the AST is
// walked for `.from('audit_log').insert(…)` and for SQL that writes the
// table. SQL inside a tagged template is read out of the AST, so a comment
// that quotes a statement is not a statement.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkFiles } from '../helpers/schema-model';
import { REPO_ROOT, SRC_DIR } from '../helpers/repo-schema';

/**
 * The one module allowed to write an audit row.
 *
 * It is the module that looks at the error, and it is the module the audit
 * page's "system" fallback was written against.
 */
const WRITER = 'src/lib/audit.ts';

interface AuditCall {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line. */
  line: number;
}

interface AuditWrite extends AuditCall {
  /** What the write looked like, for the message. */
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
 * Every call to the `log_audit` RPC in one file.
 *
 * One shape counts: `something.rpc('log_audit', …)`. The function name is a
 * string literal, because that is how PostgREST is reached.
 */
function auditCalls(file: string, text: string): AuditCall[] {
  const sf = parse(file, text);
  const out: AuditCall[] = [];

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'rpc' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'log_audit'
    ) {
      out.push({ file, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ── the second rule: the trail is not written by hand ──────────────────────

/**
 * The trail's table.
 *
 * `public.audit_log` is the trail. `accounting.audit_log` is a different
 * table, and the accounting module writes that one directly, on purpose.
 */
const TRAIL = 'audit_log';

/** The verbs that can put a row into a table. */
const WRITE_VERBS = ['insert', 'upsert', 'update', 'delete'];

/**
 * The calls whose string argument is a statement.
 *
 * Only a call that RUNS SQL is read this way. A string that merely happens
 * to say "insert into audit_log" — in a message, a label, a sentence about
 * this rule — is prose, and a rule that fires on prose is a rule people
 * learn to ignore.
 */
const SQL_CALL_NAMES = ['query', 'unsafe', 'execute', 'exec', 'raw', 'sql'];

/**
 * A statement that writes the trail, in SQL.
 *
 * The table name has to be the trail's own — bare, or `public.`-qualified.
 * `insert into accounting.audit_log` does not match, because `accounting.` is
 * neither `public.` nor nothing, and that is the whole point: the accounting
 * module's own trail is not this trail.
 *
 * The word boundary after the name keeps `audit_log_backup` out.
 */
const TRAIL_WRITE_SQL = /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?audit_log\b/i;

/**
 * Is this a reference to the project's audit trail?
 *
 * `audit_log` and `public.audit_log` are the trail. `accounting.audit_log` is
 * not, and neither is `audit_log_backup`.
 */
function isTrailTable(name: string): boolean {
  const table = name.trim().toLowerCase();
  return table === TRAIL || table === `public.${TRAIL}`;
}

/**
 * The tables a query builder in this file points at.
 *
 * The builder is read by walking DOWN the receiver chain of a call, so
 * `sb.from('audit_log').insert(…)` and `sb.from('audit_log').eq(…).insert(…)`
 * are the same shape to it. A builder held in a variable —
 * `const rows = sb.from('audit_log')` — is followed one step further, through
 * the variable's name.
 *
 * A name that has been used for two different tables in one file is not
 * followed at all: a gate that guesses is a gate that cries wolf.
 */
function chainTables(expr: ts.Expression, builders: Map<string, Set<string>>): string[] {
  const found: string[] = [];
  let node: ts.Expression | undefined = expr;
  let guard = 0;
  while (node && guard++ < 64) {
    if (ts.isCallExpression(node)) {
      // The annotation is load-bearing. Without it the type of `callee` depends
      // on the narrowed type of `node`, and `node` is assigned from `callee`
      // below -- a cycle, which the compiler reports as TS7022 ("'callee'
      // implicitly has type 'any' because it does not have a type annotation and
      // is referenced directly or indirectly in its own initializer"). The suite
      // runs without typechecking, so only the build saw it.
      const callee: ts.Expression = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'from' &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        found.push(node.arguments[0].text);
      }
      node = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (
      ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    if (ts.isIdentifier(node)) {
      // A name that has been used for two different tables is not followed:
      // a gate that guesses is a gate that cries wolf.
      const known = builders.get(node.text);
      if (known && known.size === 1) found.push(...known);
      break;
    }
    break;
  }
  return found;
}

function builderTables(file: string, text: string): Map<string, Set<string>> {
  const sf = parse(file, text);
  const out = new Map<string, Set<string>>();

  // Every declaration in the file, not only the ones at the top: a builder
  // held in a variable is usually held in one inside a function.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const tables = chainTables(node.initializer, out);
      if (tables.length === 1) {
        const known = out.get(node.name.text) ?? new Set<string>();
        known.add(tables[0]);
        out.set(node.name.text, known);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return out;
}

/**
 * The text of a template, with its substitutions put back where they were.
 *
 * A substitution that is a string literal is put back verbatim, so
 * ``sql`insert into ${'audit_log'} …` `` reads as the statement it is. A
 * substitution that is not a literal becomes a placeholder, because nothing
 * can be known about the table name at this point — and a gate that claims
 * to know would be guessing.
 */
function templateText(template: ts.TemplateLiteral | ts.NoSubstitutionTemplateLiteral): string {
  // A template with nothing substituted into it has no head and no spans —
  // it is one string, and that string is the statement.
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;

  let out = template.head.text;
  for (const span of template.templateSpans) {
    out += ts.isStringLiteralLike(span.expression) ? span.expression.text : ' ? ';
    out += span.literal.text;
  }
  return out;
}

/**
 * Every direct write to the trail in one file.
 *
 * Two shapes count:
 *
 *   * a query builder pointed at the trail and then a write verb —
 *     `sb.from('audit_log').insert(…)`, and the same through a variable;
 *   * SQL that writes the trail — `insert into audit_log`, `update
 *     public.audit_log`, `delete from audit_log` — in a tagged template or
 *     in a string.
 *
 * A READ of the trail is not a write. `sb.from('audit_log').select(…)` is
 * how the audit page gets its rows, and the rule must not fire on it.
 */
function directWrites(file: string, text: string): AuditWrite[] {
  const sf = parse(file, text);
  const out: AuditWrite[] = [];
  const builders = builderTables(file, text);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // A query builder pointed at the trail, and then a write verb.
      if (ts.isPropertyAccessExpression(callee) && WRITE_VERBS.includes(callee.name.text)) {
        const trail = chainTables(callee.expression, builders).find(isTrailTable);
        if (trail) {
          out.push({
            file,
            line: lineOf(node),
            how: `.from('${trail}').${callee.name.text}(…)`,
          });
        }
      }

      // A statement handed to a query as a string.
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (SQL_CALL_NAMES.includes(calleeName)) {
        for (const argument of node.arguments) {
          if (!ts.isStringLiteralLike(argument)) continue;
          const match = TRAIL_WRITE_SQL.exec(argument.text);
          if (match) {
            out.push({ file, line: lineOf(node), how: match[0] });
          }
        }
      }
    }

    // SQL that writes the trail, in a tagged template.
    if (ts.isTaggedTemplateExpression(node)) {
      const match = TRAIL_WRITE_SQL.exec(templateText(node.template));
      if (match) {
        out.push({ file, line: lineOf(node), how: match[0] });
      }
      // The template is not walked again as a plain string: the statement has
      // already been read out of it, and reading it twice would report it
      // twice.
      ts.forEachChild(node.tag, visit);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

/** Every module under `src/`, with its text. */
function sourceFiles(): Array<{ file: string; text: string }> {
  return walkFiles(SRC_DIR, (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')).map((full) => ({
    file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

const files = sourceFiles();

describe('the audit row is written in one place', () => {
  it('has the writer', () => {
    // The guard on the guard. If the writer were deleted, every rule below
    // would pass vacuously — there would be nothing writing audit rows, and
    // therefore nothing wrong with writing them badly.
    const writer = files.find((f) => f.file === WRITER);
    expect(writer, `${WRITER} is missing — there is nowhere to write an audit row`).toBeDefined();
  });

  it('writes every audit row through the writer', () => {
    const offenders: string[] = [];
    for (const { file, text } of files) {
      if (file === WRITER) continue;
      for (const call of auditCalls(file, text)) {
        offenders.push(
          `${call.file}:${call.line} — writes an audit row by hand. A call that discards the ` +
            'result loses the row without telling anybody, which is how the whole system trail ' +
            'went missing. Call `appendAudit` from src/lib/audit.ts instead.',
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('writes the row once, in the writer', () => {
    const writer = files.find((f) => f.file === WRITER)!;
    const calls = auditCalls(writer.file, writer.text);
    expect(
      calls.length,
      `the writer makes ${calls.length} calls to log_audit — it should make exactly one`,
    ).toBe(1);
  });

  it('notices a module that writes an audit row by hand', () => {
    // The negative control. This is the shape the gate exists to catch, and
    // the shape twenty-four of the twenty-eight call sites had. If this test
    // ever passes, the gate has stopped working.
    const calls = auditCalls(
      'src/lib/example.ts',
      [
        'export async function record(sb: Sb, tenantId: string) {',
        "  await sb.rpc('log_audit', { p_tenant: tenantId, p_action: 'thing.done' });",
        '}',
      ].join('\n'),
    );
    expect(calls.length, 'the gate did not notice the hand-written write').toBe(1);
  });

  it('does not mistake another rpc for an audit row', () => {
    // The positive control. Only `log_audit` is the audit trail; other
    // functions are somebody else's business.
    const calls = auditCalls(
      'src/lib/example.ts',
      [
        "export async function other(sb: Sb) {",
        "  await sb.rpc('charge_customer', { amount: 100 });",
        '}',
      ].join('\n'),
    );
    expect(calls).toEqual([]);
  });

  it('does not mistake a comment for a call', () => {
    // The positive control for the parser. A comment that NAMES the function
    // is not a call to it, and a gate that cannot tell the difference is a
    // gate that fires on the very file that explains the rule.
    const calls = auditCalls(
      'src/lib/example.ts',
      [
        "// Every module calls `appendAudit` — see src/lib/audit.ts.",
        "/* sb.rpc('log_audit', …) was the old way. */",
        'export const note = "log_audit";',
      ].join('\n'),
    );
    expect(calls).toEqual([]);
  });
});

describe('the trail is not written by hand', () => {
  /** The rule, over a set of files. */
  const offenders = (sources: Array<{ file: string; text: string }>): string[] => {
    const found: string[] = [];
    for (const { file, text } of sources) {
      for (const write of directWrites(file, text)) {
        found.push(
          `${write.file}:${write.line} — writes the audit trail directly (${write.how}). ` +
            (write.file === WRITER
              ? 'The writer writes through the log_audit RPC: a direct insert skips the actor, ' +
                'the tenant and the error handling the RPC applies, and nobody would be told.'
              : 'A direct insert skips the actor, the tenant and the error handling the RPC ' +
                'applies. Call `appendAudit` from src/lib/audit.ts instead.'),
        );
      }
    }
    return found;
  };

  it('has nothing to complain about in this tree', () => {
    const found = offenders(files);
    expect(found, found.join('\n')).toEqual([]);
  });

  it('notices a module that inserts into the trail through the client', () => {
    // The negative control. This is the shape the rule exists to catch: a
    // module that never calls the RPC, so the first rule cannot see it.
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function record(sb: Sb, tenantId: string) {',
        "  await sb.from('audit_log').insert({ tenant_id: tenantId, action: 'thing.done' });",
        '}',
      ].join('\n'),
    );
    expect(writes.length, 'the gate did not notice the direct insert').toBe(1);
  });

  it('notices a module that writes the trail in SQL', () => {
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function record(sql: Sql, tenantId: string) {',
        '  await sql`insert into audit_log (tenant_id, action) values (${tenantId}, ${\'thing.done\'})`;',
        '}',
      ].join('\n'),
    );
    expect(writes.length, 'the gate did not notice the raw insert').toBe(1);
  });

  it('notices a statement handed to a query as a string', () => {
    // The bypass around the tagged-template shape. A statement passed to a
    // query as a string is still a statement, and it is still a write.
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function record(db: Db) {',
        "  await db.query('insert into audit_log (tenant_id, action) values ($1, $2)');",
        '}',
      ].join('\n'),
    );
    expect(writes.length, 'the gate did not notice the statement passed as a string').toBe(1);
  });

  it('notices a module that deletes from the trail', () => {
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function purge(sql: Sql) {',
        '  await sql`delete from public.audit_log where created_at < now()`;',
        '}',
      ].join('\n'),
    );
    expect(writes.length, 'the gate did not notice the delete').toBe(1);
  });

  it('notices a direct write made through a variable', () => {
    // The shape that a naive "look for `.from(…)` right next to the write"
    // rule misses, and a real one: a builder held in a variable and written
    // to later.
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function record(sb: Sb, tenantId: string) {',
        "  const rows = sb.from('audit_log');",
        "  await rows.insert({ tenant_id: tenantId, action: 'thing.done' });",
        '}',
      ].join('\n'),
    );
    expect(writes.length, 'the gate did not notice the write through a variable').toBe(1);
  });

  it('does not mistake the accounting module’s own trail for this one', () => {
    // The positive control that matters most. `accounting.audit_log` is a
    // different table, written directly on purpose, in the same transaction
    // as the postings it describes.
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function record(sql: Sql, tenantId: string) {',
        '  await sql`insert into accounting.audit_log (user_id, action) values (${tenantId}, ${\'posted\'})`;',
        '}',
      ].join('\n'),
    );
    expect(writes, 'the gate fired on the accounting module’s own trail').toEqual([]);
  });

  it('does not mistake a read of the trail for a write', () => {
    // The positive control. The audit page reads the trail; that is the
    // whole point of it.
    const writes = directWrites(
      'src/lib/example.ts',
      [
        'export async function read(sb: Sb) {',
        "  return sb.from('audit_log').select('id, action, created_at').limit(50);",
        '}',
      ].join('\n'),
    );
    expect(writes, 'the gate fired on a read').toEqual([]);
  });

  it('does not mistake a comment for a write', () => {
    const writes = directWrites(
      'src/lib/example.ts',
      [
        "// We used to `insert into audit_log` here.",
        "/* await sb.from('audit_log').insert(row); */",
        'export const NOTE = "insert into audit_log is not how this is done";',
      ].join('\n'),
    );
    expect(writes, 'the gate fired on something that was only words').toEqual([]);
  });

  it('fails against this tree when a module writes the trail by hand', () => {
    // The negative control for the RULE, over the REAL tree — not a made-up
    // example. The tree is the one this gate is about, with one module
    // changed to do the thing the rule forbids. The rule must notice, and
    // it must notice in the file that was changed.
    const changed = files.map((f) =>
      f.file === 'src/lib/queries-audit.ts'
        ? {
            file: f.file,
            text: [
              f.text,
              '',
              '// Injected for the negative control.',
              'export async function injected(sb: Sb, tenantId: string) {',
              "  await sb.from('audit_log').insert({ tenant_id: tenantId, action: 'injected' });",
              '}',
            ].join('\n'),
          }
        : f,
    );

    const found = offenders(changed);

    expect(found.length, 'the rule passed against a tree that writes the trail by hand').toBe(1);
    expect(found[0]).toContain('src/lib/queries-audit.ts');
  });
});
