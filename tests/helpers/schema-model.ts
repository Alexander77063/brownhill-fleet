/**
 * tests/helpers/schema-model.ts
 *
 * Builds the database schema the migrations describe, and extracts the raw SQL
 * the application actually sends — both by static analysis, with no database
 * involved.
 *
 * WHY THIS EXISTS
 * ---------------
 * The accounting module broke four separate ways on the same day: migration
 * 0069 renamed `accounting.mtd_credentials` to `accounting.firs_credentials`
 * and every query still naming the old table died with 42P01; it replaced
 * `unique (year, month)` on `accounting.periods` with
 * `unique (tenant_id, year, month)` and every `on conflict (year, month)`
 * died with 42P10; it replaced `unique (period_id)` on
 * `accounting.vat_submissions` the same way; and it added a `tenant_id`
 * column to a dozen tables that the application code then kept reading
 * without filtering on. None of that fails a build. All of it fails the
 * first time a customer presses a button, which is exactly the complaint
 * this project exists to fix.
 *
 * So the contract is asserted statically instead: the migrations are replayed
 * into a model of the final schema, the application's SQL is extracted, and
 * the two are cross-checked. A renamed table, a stale ON CONFLICT target and
 * a missing tenant predicate are all build failures from now on.
 *
 * This is deliberately a *parser*, not a Postgres. It reads the DDL the
 * migrations contain — create table, alter table, rename, add/drop constraint,
 * create unique index — and nothing more. If a migration uses a form of DDL
 * this parser does not understand, the parser skips it and the corresponding
 * assertion is simply not enforced for that table. That is a safe failure
 * mode: an unrecognised DDL form weakens a check, it never invents one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface TableModel {
  schema: string;
  name: string;
  /** Lower-cased column names. */
  columns: Set<string>;
  /**
   * Unique constraints and primary keys, keyed by constraint name, each
   * holding the column list in declaration order. Postgres infers an
   * ON CONFLICT target from a unique index whose columns match in order, so
   * the order matters here too.
   */
  uniques: Map<string, string[]>;
  /** The migration file that first created the table. */
  origin: string;
}

export interface SqlStatement {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line of the tagged template the statement came from. */
  line: number;
  /** The statement, with `${...}` interpolations replaced by a space. */
  text: string;
}

/** Tables whose names are functions or SQL keywords, not relations. */
const NON_RELATION_NAMES = new Set([
  'generate_series',
  'unnest',
  'jsonb_array_elements',
  'jsonb_each',
  'jsonb_each_text',
  'jsonb_object_keys',
  'regexp_split_to_table',
  'values',
  'select',
  'lateral',
  'only',
]);

/** Words that can precede `from` without introducing a relation. */
const NOT_A_FROM_SOURCE = new Set([
  'extract',
  'substring',
  'position',
  'overlay',
  'trim',
  'both',
  'leading',
  'trailing',
]);

const IDENT = '[a-zA-Z_][\\w$]*';
const QUALIFIED = `${IDENT}(?:\\.${IDENT})?`;

/* ────────────────────────── SQL text helpers ────────────────────────── */

/**
 * Splits SQL into statements on top-level semicolons. String literals are
 * respected so a `;` inside a quoted value does not split a statement.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        // A doubled quote is an escaped quote, not the end of the literal.
        if (sql[i + 1] === quote) {
          cur += sql[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth <= 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Removes comments and dollar-quoted bodies, returning the remaining SQL and
 * the dollar-quoted bodies separately. The bodies are scanned separately
 * because PL/pgSQL DO blocks can contain literal DDL (migration 0069 renames
 * a table inside one).
 */
export function stripNoise(sql: string): { code: string; bodies: string[] } {
  const bodies: string[] = [];
  // Dollar-quoted bodies: $$ ... $$ or $tag$ ... $tag$
  const withoutBodies = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, (m) => {
    bodies.push(m);
    return ' ';
  });
  const withoutBlockComments = withoutBodies.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutLineComments = withoutBlockComments.replace(/--[^\n]*/g, ' ');
  return { code: withoutLineComments, bodies };
}

/** Splits `a, b, (c, d)` on top-level commas only. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Returns the contents of the first parenthesised group in `text`. */
function parenBody(text: string): string[] | null {
  const open = text.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        return splitTopLevel(text.slice(open + 1, i));
      }
    }
  }
  return null;
}

/* ────────────────────────── The schema model ────────────────────────── */

export class SchemaModel {
  readonly tables = new Map<string, TableModel>();
  /** Every unique constraint across every table, for reverse lookups. */
  uniqueIndex = new Map<string, Set<string>>();

  static key(schema: string, name: string): string {
    return `${schema}.${name}`;
  }

  get(schema: string, name: string): TableModel | undefined {
    return this.tables.get(SchemaModel.key(schema, name));
  }

  ensure(schema: string, name: string, origin: string): TableModel {
    const key = SchemaModel.key(schema, name);
    let t = this.tables.get(key);
    if (!t) {
      t = { schema, name, columns: new Set(), uniques: new Map(), origin };
      this.tables.set(key, t);
    }
    return t;
  }

  rename(schema: string, from: string, to: string, origin: string): void {
    const key = SchemaModel.key(schema, from);
    const t = this.tables.get(key);
    if (!t) return;
    this.tables.delete(key);
    t.name = to;
    t.origin = origin;
    this.tables.set(SchemaModel.key(schema, to), t);
  }

  addUnique(table: TableModel, name: string, cols: string[]): void {
    const normalised = cols.map((c) => c.trim().toLowerCase().replace(/^"|"$/g, '')).filter(Boolean);
    if (!normalised.length) return;
    table.uniques.set(name, normalised);
    let set = this.uniqueIndex.get(SchemaModel.key(table.schema, table.name));
    if (!set) {
      set = new Set();
      this.uniqueIndex.set(SchemaModel.key(table.schema, table.name), set);
    }
    set.add(normalised.join(','));
  }

  removeUnique(table: TableModel, name: string): void {
    table.uniques.delete(name);
    const set = this.uniqueIndex.get(SchemaModel.key(table.schema, table.name));
    if (!set) return;
    set.clear();
    for (const cols of table.uniques.values()) set.add(cols.join(','));
  }

  /** True when the table declares a unique constraint on exactly these columns, in order. */
  hasUniqueOn(table: TableModel, cols: string[]): boolean {
    const normalised = cols.map((c) => c.trim().toLowerCase().replace(/^"|"$/g, '')).filter(Boolean);
    for (const declared of table.uniques.values()) {
      if (declared.length !== normalised.length) continue;
      if (declared.every((c, i) => c === normalised[i])) return true;
    }
    return false;
  }
}

/**
 * Replays a set of SQL files in order into a SchemaModel.
 *
 * `defaultSchema` is the schema bare table names resolve to when a file has
 * not set a `search_path` — 'public', which is what the application uses.
 */
export function buildSchemaModel(files: Array<{ name: string; sql: string }>, defaultSchema = 'public'): SchemaModel {
  const model = new SchemaModel();
  for (const file of files) {
    let searchPath = defaultSchema;
    const { code, bodies } = stripNoise(file.sql);
    const statements = splitStatements(code);
    // DO blocks are scanned for literal DDL (a rename, a drop) before the
    // statements that follow them, so the model sees the same order Postgres
    // would.
    // A DO block can contain literal DDL. Migration 0069 renames
    // accounting.mtd_credentials inside one, and the statements that follow in
    // the same file refer to the new name — so the rename is applied before
    // the file's own statements are replayed.
    for (const body of bodies) {
      const renRe = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(${QUALIFIED})\\s+rename\\s+to\\s+(${IDENT})`, 'gi');
      let rm: RegExpExecArray | null;
      while ((rm = renRe.exec(body)) !== null) {
        const { schema, name } = resolve(rm[1], searchPath);
        model.rename(schema, name, rm[2].toLowerCase(), file.name);
      }
      // A DO block can also add a unique constraint — migration 0081 adds
      // `firs_credentials_tenant_key` inside one, and the application then
      // upserts on `on conflict (tenant_id)`. Without this the constraint
      // would be invisible to the model and the ON CONFLICT contract test
      // would report a false failure.
      const uniqRe = new RegExp(
        `alter\\s+table\\s+(?:if\\s+exists\\s+)?(${QUALIFIED})\\s+add\\s+constraint\\s+(\\w+)\\s+unique\\s*\\(([^)]*)\\)`,
        'gi',
      );
      let um: RegExpExecArray | null;
      while ((um = uniqRe.exec(body)) !== null) {
        const { schema, name } = resolve(um[1], searchPath);
        const table = model.ensure(schema, name, file.name);
        model.addUnique(table, um[2], um[3].split(',').map((c) => c.trim()));
      }
      // A DO block can add a column to a whole list of tables at once.
      // Migration 0017 tenant-scopes sixteen domain tables this way:
      //
      //   tables constant text[] := array['agreements', ..., 'payments', ...];
      //   foreach t in array tables loop
      //     execute format(
      //       'alter table %I add column tenant_id uuid not null default %L references tenants(id)',
      //       t, default_tenant);
      //
      // The table list and the column name are both literals, so the block can
      // be read statically. Without this the model believes none of those
      // tables carry a tenant_id, and every query that correctly filters on
      // one is reported as broken.
      const loopArrays = new Map<string, string[]>();
      const foreachRe = /foreach\s+([A-Za-z_]\w*)\s+in\s+array\s+([A-Za-z_]\w*)\s+loop/gi;
      let fe: RegExpExecArray | null;
      while ((fe = foreachRe.exec(body)) !== null) {
        const loopVar = fe[1].toLowerCase();
        const arrName = fe[2].toLowerCase();
        const arrRe = new RegExp(`\\b${arrName}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\s*\\[([^\\]]*)\\]`, 'i');
        const arrM = arrRe.exec(body);
        if (!arrM) continue;
        loopArrays.set(
          loopVar,
          arrM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '').trim()).filter(Boolean),
        );
      }
      const fmtRe = /execute\s+format\(\s*'([^']*)'\s*,\s*([A-Za-z_]\w*)/gi;
      let fm: RegExpExecArray | null;
      while ((fm = fmtRe.exec(body)) !== null) {
        const colM = /alter\s+table\s+%I\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([A-Za-z_]\w*)/i.exec(fm[1]);
        if (!colM) continue;
        const list = loopArrays.get(fm[2].toLowerCase());
        if (!list) continue;
        const col = colM[1].toLowerCase();
        for (const t of list) {
          const { schema, name } = resolve(t, searchPath);
          model.ensure(schema, name, file.name).columns.add(col);
        }
      }
    }
    for (const stmt of statements) {
      applyStatement(model, stmt, searchPath, file.name);
        const sp = /^\s*set\s+search_path\b\s*(?:to\s*)?=?\s*(.+)$/i.exec(stmt.trim());
        if (sp) {
          searchPath = sp[1].split(',')[0].trim().replace(/"/g, '');
          continue;
        }
    }
  }
  return model;
}

/** Applies one DDL statement to the model. Unknown forms are ignored. */
function applyStatement(
  model: SchemaModel,
  stmt: string,
  searchPath: string,
  origin: string,
  setSearchPath: () => void = () => {},
): void {
  const s = stmt.trim();
  if (!s) return;

  if (/^set\s+search_path\b/i.test(s)) {
    setSearchPath();
    return;
  }

  // create table [if not exists] <name> ( ... )
  const ct = new RegExp(`^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${QUALIFIED})\\s*\\(`, 'i').exec(s);
  if (ct) {
    const body = parenBody(s.slice(s.indexOf('(', ct[0].length - 1)));
    const { schema, name } = resolve(ct[1], searchPath);
    const table = model.ensure(schema, name, origin);
    if (!body) return;
    let unnamed = 0;
    for (const part of body) {
      const p = part.trim();
      if (!p) continue;
      const cols = parenBody(p);
      const uniqMatch = /^(?:constraint\s+(\w+)\s+)?unique\b/i.exec(p);
      const pkMatch = /^(?:constraint\s+(\w+)\s+)?primary\s+key\b/i.exec(p);
      if (uniqMatch) {
        const c = cols ?? [];
        model.addUnique(table, uniqMatch[1] ?? `unnamed_unique_${unnamed++}`, c);
        continue;
      }
      if (pkMatch) {
        const c = cols ?? [];
        model.addUnique(table, pkMatch[1] ?? `unnamed_pk_${unnamed++}`, c);
        continue;
      }
      if (/^(foreign\s+key|check|exclude|like)\b/i.test(p)) continue;
      const col = new RegExp(`^(${IDENT})`).exec(p);
      if (!col) continue;
      const colName = col[1].toLowerCase();
      table.columns.add(colName);
      // A column-level `unique` / `primary key` is a single-column unique
      // constraint, and ON CONFLICT can infer it.
      const rest = p.slice(col[0].length);
      if (/\bunique\b/i.test(rest)) model.addUnique(table, `${colName}_unique`, [colName]);
      else if (/\bprimary\s+key\b/i.test(rest)) model.addUnique(table, `${colName}_pk`, [colName]);
    }
    return;
  }

  // drop table [if exists] <name>
  const dt = new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?(${QUALIFIED})\\s*$`, 'i').exec(s);
  if (dt) {
    const { schema, name } = resolve(dt[1], searchPath);
    model.tables.delete(SchemaModel.key(schema, name));
    return;
  }

  // create unique index <name> on <table> (cols)
  const cui = new RegExp(`^create\\s+unique\\s+index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?(\\w+)\\s+on\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`, 'i').exec(s);
  if (cui) {
    const { schema, name } = resolve(cui[2], searchPath);
    const table = model.ensure(schema, name, origin);
    model.addUnique(table, cui[1], cui[3].split(',').map((c) => c.trim()));
    return;
  }

  // alter table <name> <action...>
  const at = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(${QUALIFIED})\\s+([\\s\\S]+)$`, 'i').exec(s);
  if (at) {
    const { schema, name } = resolve(at[1], searchPath);
    const table = model.ensure(schema, name, origin);
    for (const action of splitTopLevel(at[2])) {
      const a = action.trim();
      if (!a) continue;

      const ren = new RegExp(`^rename\\s+to\\s+(${IDENT})\\s*$`, 'i').exec(a);
      if (ren) {
        model.rename(schema, name, ren[1].toLowerCase(), origin);
        continue;
      }
      const renCol = new RegExp(`^rename\\s+column\\s+(${IDENT})\\s+to\\s+(${IDENT})\\s*$`, 'i').exec(a);
      if (renCol) {
        table.columns.delete(renCol[1].toLowerCase());
        table.columns.add(renCol[2].toLowerCase());
        continue;
      }
      const addCol = new RegExp(`^add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\b`, 'i').exec(a);
      if (addCol) {
        table.columns.add(addCol[1].toLowerCase());
        continue;
      }
      const dropCol = new RegExp(`^drop\\s+column\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s*$`, 'i').exec(a);
      if (dropCol) {
        table.columns.delete(dropCol[1].toLowerCase());
        continue;
      }
      const addUniq = new RegExp(`^add\\s+constraint\\s+(\\w+)\\s+unique\\s*\\(([^)]*)\\)`, 'i').exec(a);
      if (addUniq) {
        model.addUnique(table, addUniq[1], addUniq[2].split(','));
        continue;
      }
      const addPk = new RegExp(`^add\\s+constraint\\s+(\\w+)\\s+primary\\s+key\\s*\\(([^)]*)\\)`, 'i').exec(a);
      if (addPk) {
        model.addUnique(table, addPk[1], addPk[2].split(','));
        continue;
      }
      const dropCon = new RegExp(`^drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(\\w+)`, 'i').exec(a);
      if (dropCon) {
        model.removeUnique(table, dropCon[1]);
        continue;
      }
      // Everything else (enable rls, owner to, set not null, alter type,
      // add foreign key, create policy) does not change this model.
    }
    return;
  }
}

function resolve(name: string, searchPath: string): { schema: string; name: string } {
  const clean = name.replace(/"/g, '');
  if (clean.includes('.')) {
    const [schema, ...rest] = clean.split('.');
    return { schema: schema.toLowerCase(), name: rest.join('.').toLowerCase() };
  }
  return { schema: searchPath.toLowerCase(), name: clean.toLowerCase() };
}

/* ────────────────────────── Application SQL ────────────────────────── */

/** Walks a directory tree, returning files that match `filter`. */
export function walkFiles(dir: string, filter: (f: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.next') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/**
 * Extracts every SQL statement the application sends, by walking the
 * TypeScript AST for tagged template expressions.
 *
 * The AST is used rather than a regex over the raw file text so that SQL
 * quoted inside a comment is never mistaken for SQL that runs — the exact
 * false positive that would have made a comment like "`on conflict (year,
 * month)`" look like a broken statement.
 */
export function extractSqlStatements(srcDir: string, repoRoot: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  const files = walkFiles(srcDir, (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const raw = templateText(node.template);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        for (const stmt of splitStatements(raw)) {
          const s = stmt.trim();
          if (!s) continue;
          if (!/^(select\b|insert\s+into\b|update\b|delete\s+from\b|with\b)/i.test(s)) continue;
          out.push({
            file: path.relative(repoRoot, file).split(path.sep).join('/'),
            line: line + 1,
            text: s,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Flattens a template literal, replacing `${...}` with a space.
 *
 * `ts.TemplateLiteral` is a UNION alias in TypeScript 5 (`TemplateExpression |
 * NoSubstitutionTemplateLiteral`), so casting to it does not give you `head`.
 * The interface that actually carries `head` and `templateSpans` is
 * `ts.TemplateExpression`.
 */
function templateText(t: ts.TemplateLiteral): string {
  if (!ts.isTemplateExpression(t)) return t.text;
  let s = t.head.text;
  for (const span of t.templateSpans) s += ' ' + span.literal.text;
  return s;
}

/** The relation a statement names, for `insert into` / `update` / `from`. */
export interface TableRef {
  schema: string | null;
  name: string;
  /** The exact text as it appeared, for error messages. */
  raw: string;
}

/**
 * Extracts the relations a statement touches. CTE names and set-returning
 * functions are excluded — they are not relations.
 */
export function extractTables(statement: string): TableRef[] {
  const ctes = new Set<string>();
  const cteRe = /\b(?:with|,)\s*([A-Za-z_]\w*)\s+as\s*\(/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cteRe.exec(statement)) !== null) ctes.add(cm[1].toLowerCase());

  const out: TableRef[] = [];
  const re = new RegExp(`\\b(from|join|update|into)\\s+(${QUALIFIED})`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const keyword = m[1].toLowerCase();
    const raw = m[2];
    // `extract(month from issued_at)` — the `from` there names a column.
    if (keyword === 'from') {
      const before = statement.slice(Math.max(0, m.index - 24), m.index);
      const prevWord = /([A-Za-z_]\w*)\s*$/.exec(before)?.[1]?.toLowerCase();
      if (prevWord && NOT_A_FROM_SOURCE.has(prevWord)) continue;
    }
    // `on conflict (...) do update set x = ...` — the `update` there is the
    // conflict action, not a table.
    if (keyword === 'update') {
      const before = statement.slice(Math.max(0, m.index - 8), m.index);
      if (/\bdo\s*$/i.test(before)) continue;
    }
    const clean = raw.replace(/"/g, '');
    const [maybeSchema, maybeName] = clean.includes('.') ? clean.split('.') : [null, clean];
    const name = (maybeName ?? '').toLowerCase();
    if (!name) continue;
    if (!maybeSchema && (NON_RELATION_NAMES.has(name) || ctes.has(name))) continue;
    out.push({ schema: maybeSchema ? maybeSchema.toLowerCase() : null, name, raw });
  }
  return out;
}

/** The ON CONFLICT target columns of a statement, if it has one. */
export function extractConflictTarget(statement: string): string[] | null {
  const m = /\bon\s+conflict\s*\(([^)]*)\)/i.exec(statement);
  if (!m) return null;
  return splitTopLevel(m[1]).map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/** The table an `insert into` statement targets. */
export function extractInsertTarget(statement: string): TableRef | null {
  const m = new RegExp(`\\binsert\\s+into\\s+(${QUALIFIED})`, 'i').exec(statement);
  if (!m) return null;
  const clean = m[1].replace(/"/g, '');
  const [schema, name] = clean.includes('.') ? clean.split('.') : [null, clean];
  return { schema: schema ? schema.toLowerCase() : null, name: name.toLowerCase(), raw: m[1] };
}

/* ──────────────────── Aliases and column references ──────────────────── */

/**
 * Words that may follow a table name in a FROM/JOIN clause but are not an
 * alias for it. Without this list `from x where …` binds the alias "where",
 * and every `where.id` in the statement is then checked against the wrong
 * table.
 */
const SQL_KEYWORDS = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'on', 'and', 'or', 'not', 'inner', 'left', 'right', 'full', 'cross',
  'join', 'using', 'natural', 'set', 'returning', 'values', 'select', 'from',
  'for', 'window', 'fetch', 'into', 'as', 'with', 'lateral', 'only', 'distinct',
  'all', 'by', 'asc', 'desc', 'nulls', 'first', 'last', 'else', 'end', 'when',
  'then', 'case', 'both', 'leading', 'trailing', 'null', 'true', 'false',
]);

/**
 * A table a statement binds, together with the alias it is referenced by.
 *
 * `from accounting.bank_accounts ba` binds the alias `ba`; an unaliased
 * table binds its own name.
 */
export interface TableBinding {
  schema: string | null;
  name: string;
  alias: string;
  raw: string;
}

/** The tables a statement binds, with their aliases. */
export function extractTableBindings(statement: string): TableBinding[] {
  const ctes = new Set<string>();
  const cteRe = /\b(?:with|,)\s*([A-Za-z_]\w*)\s+as\s*\(/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cteRe.exec(statement)) !== null) ctes.add(cm[1].toLowerCase());

  const out: TableBinding[] = [];
  const re = new RegExp(`\\b(from|join|update|into)\\s+(${QUALIFIED})`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const keyword = m[1].toLowerCase();
    if (keyword === 'from') {
      const before = statement.slice(Math.max(0, m.index - 24), m.index);
      const prevWord = /([A-Za-z_]\w*)\s*$/.exec(before)?.[1]?.toLowerCase();
      if (prevWord && NOT_A_FROM_SOURCE.has(prevWord)) continue;
    }
    if (keyword === 'update') {
      const before = statement.slice(Math.max(0, m.index - 8), m.index);
      if (/\bdo\s*$/i.test(before)) continue;
    }
    const clean = m[2].replace(/"/g, '');
    const [maybeSchema, maybeName] = clean.includes('.') ? clean.split('.') : [null, clean];
    const name = (maybeName ?? '').toLowerCase();
    if (!name) continue;
    if (!maybeSchema && (NON_RELATION_NAMES.has(name) || ctes.has(name))) continue;

    // The alias is the next word, if it is a word at all and not a keyword.
    // It is read with a lookahead so the main scan is not advanced past a
    // following `join`.
    let alias = name;
    const aliasM = /^\s+(?:as\s+)?([A-Za-z_]\w*)/.exec(statement.slice(m.index + m[0].length));
    if (aliasM) {
      const candidate = aliasM[1].toLowerCase();
      if (!SQL_KEYWORDS.has(candidate) && !ctes.has(candidate)) alias = candidate;
    }
    out.push({
      schema: maybeSchema ? maybeSchema.toLowerCase() : null,
      name,
      alias,
      raw: m[2],
    });
  }
  return out;
}

/**
 * Every `<alias>.<column>` reference in a statement.
 *
 * The alias is not resolved here — the caller matches it against the
 * statement's own table bindings, so a reference to a CTE column or to a
 * JavaScript variable inside a template hole is simply never matched.
 */
export function extractColumnRefs(statement: string): Array<{ alias: string; column: string }> {
  const out: Array<{ alias: string; column: string }> = [];
  const re = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    out.push({ alias: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return out;
}
