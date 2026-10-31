#!/usr/bin/env node
/**
 * Static accessibility audit for form controls.
 *
 * `eslint-plugin-jsx-a11y` has a structural blind spot: `label-has-associated-control`
 * only inspects <label> elements it can see. An <input> with no label anywhere is
 * invisible to it. That is precisely the WCAG 3.3.2 / 4.1.2 failure that gets shipped,
 * so we parse the real TSX with the TypeScript compiler API and check every control.
 *
 * Checks
 *   unlabelled  — control has no accessible name by any mechanism (WCAG 4.1.2 A, 3.3.2 A)
 *   autocomplete— personal-data field missing an autocomplete token (WCAG 1.3.5 AA)
 *
 * Usage: node scripts/a11y-audit.mjs [--json]
 * Exits 1 when any violation is found, so it can gate CI.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const CONTROLS = new Set(['input', 'select', 'textarea']);
/** Input types that carry no user-facing value and need no label. */
const EXEMPT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/**
 * WCAG 1.3.5 covers input fields "collecting information about the user". A staff
 * member typing a *driver's* email, or a company's billing phone, is not covered — so
 * the check is scoped to the self-service routes where the person at the keyboard is
 * the data subject. Applying it more broadly produces false positives and would push
 * meaningless autocomplete tokens onto admin CRUD screens.
 */
const SELF_SERVICE_ROUTES = ['src/app/login/', 'src/app/request-access/', 'src/app/sign/'];

/**
 * name/id fragments that identify a field about the *user themselves*, which is what
 * WCAG 1.3.5 Identify Input Purpose covers. Business data (vehicle reg, mileage,
 * tenant name) is explicitly out of scope for that criterion.
 */
const AUTOCOMPLETE_EXPECTED = [
  { match: /^(email|user_email|contact_email)$/i, token: 'email' },
  { match: /^(phone|mobile|tel|contact_phone)$/i, token: 'tel' },
  { match: /^(full_?name|your_?name|contact_name)$/i, token: 'name' },
  { match: /^(password)$/i, token: 'current-password' },
  { match: /^(otp|code|one_?time_?code)$/i, token: 'one-time-code' },
  { match: /^(postcode|post_code|zip)$/i, token: 'postal-code' },
  { match: /^(address|address_line1|street)$/i, token: 'address-line1' },
];

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Read a JSX attribute's literal string value, or null when absent/dynamic. */
function attrValue(attrs, name) {
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue;
    if (!a.initializer) return true; // bare boolean attribute
    if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
    if (
      ts.isJsxExpression(a.initializer) &&
      a.initializer.expression &&
      ts.isStringLiteral(a.initializer.expression)
    ) {
      return a.initializer.expression.text;
    }
    return '__dynamic__';
  }
  return null;
}

function hasAttr(attrs, name) {
  return attrs.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
}

/**
 * Components whose root element is a <label>, e.g. the several local `Field` wrappers:
 *
 *   function Field({ label, children }) {
 *     return <label className="block"><span>{label}</span>{children}</label>;
 *   }
 *
 * Anything rendered as their child is implicitly associated with that label, exactly as
 * if it were nested in the raw tag. Without this the audit reports ~100 false positives.
 */
function collectLabelWrappers(sf, into) {
  const rootIsLabel = (body) => {
    if (!body) return false;
    let expr = null;
    if (ts.isBlock(body)) {
      for (const stmt of body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) expr = stmt.expression;
      }
    } else {
      expr = body;
    }
    while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return !!expr && ts.isJsxElement(expr) && expr.openingElement.tagName.getText() === 'label';
  };

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && rootIsLabel(node.body)) {
      into.add(node.name.getText());
    }
    if (ts.isVariableDeclaration(node) && node.name && node.initializer) {
      const init = node.initializer;
      if (
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
        rootIsLabel(init.body)
      ) {
        into.add(node.name.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** True when the control sits inside a <label>, or inside a label-rendering component. */
function insideLabel(node, labelWrappers) {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isJsxElement(p)) continue;
    const tag = p.openingElement.tagName.getText();
    if (tag === 'label' || labelWrappers.has(tag)) return true;
  }
  return false;
}

const findings = [];

// Pass 1 — learn which components render a <label>, across the whole tree.
const LABEL_WRAPPERS = new Set();
for (const file of walkFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  collectLabelWrappers(sf, LABEL_WRAPPERS);
}

for (const file of walkFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  // Every htmlFor target in this file — an explicit <label htmlFor="x"> association.
  const htmlForTargets = new Set();
  (function collect(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText() === 'label') {
        const v = attrValue(node.attributes, 'htmlFor');
        if (typeof v === 'string') htmlForTargets.add(v);
      }
    }
    ts.forEachChild(node, collect);
  })(sf);

  (function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (CONTROLS.has(tag)) {
        const attrs = node.attributes;
        const type = attrValue(attrs, 'type');
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const name = attrValue(attrs, 'name');
        const id = attrValue(attrs, 'id');

        // A control marked aria-hidden is removed from the accessibility tree entirely —
        // e.g. the spam honeypot on /request-access, which is also tabIndex={-1}. Naming
        // it would be meaningless, and flagging it would be a false positive.
        const ariaHidden = attrValue(attrs, 'aria-hidden');
        const hidden = ariaHidden === 'true' || ariaHidden === true;

        if (!hidden && !(typeof type === 'string' && EXEMPT_TYPES.has(type))) {
          const named =
            hasAttr(attrs, 'aria-label') ||
            hasAttr(attrs, 'aria-labelledby') ||
            (typeof id === 'string' && htmlForTargets.has(id)) ||
            insideLabel(node, LABEL_WRAPPERS);

          if (!named) {
            findings.push({
              rule: 'unlabelled',
              file: rel,
              line,
              detail: `<${tag}${name && name !== '__dynamic__' ? ` name="${name}"` : ''}> has no accessible name`,
            });
          }

          // WCAG 1.3.5 — only for fields describing the user.
          const key = typeof name === 'string' ? name : typeof id === 'string' ? id : null;
          const selfService = SELF_SERVICE_ROUTES.some((r) => rel.startsWith(r));
          if (key && selfService && !hasAttr(attrs, 'autoComplete')) {
            const expect = AUTOCOMPLETE_EXPECTED.find((e) => e.match.test(key));
            if (expect) {
              findings.push({
                rule: 'autocomplete',
                file: rel,
                line,
                detail: `<${tag} name="${key}"> should set autoComplete="${expect.token}"`,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
}

export { findings };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const byRule = findings.reduce((m, f) => ((m[f.rule] ??= []).push(f), m), {});
  for (const [rule, items] of Object.entries(byRule)) {
    console.log(`\n${rule}  (${items.length})`);
    for (const f of items) console.log(`  ${f.file}:${f.line}  ${f.detail}`);
  }
  console.log(`\n${findings.length} total form-accessibility findings.`);
}

if (findings.length && !process.env.A11Y_AUDIT_NO_EXIT) process.exitCode = 1;
