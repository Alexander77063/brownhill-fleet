import jsxA11y from 'eslint-plugin-jsx-a11y';
import tsParser from '@typescript-eslint/parser';

/**
 * Accessibility-only ESLint config.
 *
 * Deliberately scoped to `jsx-a11y` and nothing else: this repo has no other lint
 * config, so pulling in `eslint-config-next` would bury the accessibility signal
 * under hundreds of unrelated style/hooks findings. Run with `pnpm lint:a11y`.
 *
 * See docs/accessibility/README.md for how this fits the WCAG 2.1 AA programme.
 */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'supabase/**', '.claude/**', 'public/**'],
  },
  {
    files: ['src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    // The `@next/next` stub below defines a no-op rule, so the existing disable
    // comments for it always read as "unused". That is expected, not a finding.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: {
      'jsx-a11y': jsxA11y,
      // Stub: the codebase carries `eslint-disable-next-line @next/next/no-img-element`
      // comments from the Next preset. Without a definition ESLint 9 hard-errors on the
      // unknown rule name, which would drown out the accessibility findings.
      '@next/next': { rules: { 'no-img-element': { create: () => ({}) } } },
    },
    settings: {
      // Teach the linter which DOM element each in-house primitive actually renders,
      // so rules fire on `<Button>` / `<Th>` / `<Td>` the same as on the raw tags.
      'jsx-a11y': {
        components: {
          Button: 'button',
          Th: 'th',
          Td: 'td',
          Table: 'table',
          Card: 'div',
          Badge: 'span',
        },
      },
    },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,

      // `role` is a domain prop on our own components (<AppShell role="driver">), not an
      // ARIA role. Only validate the attribute on real DOM elements.
      'jsx-a11y/aria-role': ['error', { ignoreNonDOM: true }],

      // Our labels legitimately nest their text inside wrapper spans for layout
      // (label > span > span > text). The default depth of 2 flags those as nameless
      // even though the accessible name computes correctly in every browser and AT.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 6 }],
    },
  },
];
