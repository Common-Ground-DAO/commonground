// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Successor to the `eslintConfig: { extends: ["react-app"] }` block in
 * package.json. Those presets shipped *inside* react-scripts, so removing CRA
 * orphaned linting entirely — and until now the webpack build was the only
 * place lint ever ran (constraint 10). `yarn lint` is a standalone step now and
 * the docker build scripts run it.
 *
 * Composition, per the roadmap decision: `typescript-eslint` recommended +
 * `eslint-plugin-react` + `eslint-plugin-react-hooks`. Explicitly *not* the
 * type-checked presets — those are a separate follow-up, not part of a
 * build-stack migration.
 *
 * ## Severity model
 *
 * react-scripts ran ESLintPlugin with `failOnError` in production builds, so
 * *errors* failed the build and warnings did not. `eslint .` behaves the same
 * way, and the build scripts rely on it.
 *
 * `react-app` was almost entirely a "warn" ruleset; its complete error set was
 * `no-undef` (off again for TS), `no-restricted-globals`,
 * `no-restricted-properties`, `no-unused-expressions`, `react/jsx-no-undef`,
 * `react/no-typos`, `react/require-render-return`,
 * `react-hooks/rules-of-hooks` and three `import/*` rules from a plugin this
 * config does not carry. Everything the modern recommended presets add on top
 * is therefore registered at "warn" here: it surfaces the debt without turning
 * a toolchain swap into a code-cleanup mandate. Raising any of them is a policy
 * decision for a later PR, and the counts are recorded in
 * docs/todo/ROADMAP_BUILD_STACK_VITE.md.
 */

import js from '@eslint/js';
import confusingBrowserGlobals from 'confusing-browser-globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'build/**',
      'dist/**',
      'node_modules/**',
      '.yarn/**',
      // Out of scope: separate packages with their own toolchains.
      'srv/**',
      'contracts/**',
      // Not source.
      'public/**',
      'docker/**',
      'pipelines/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- react-app calibration, everywhere ----------------------------------
  {
    rules: {
      // react-app's error set that this config can reproduce.
      'no-restricted-globals': ['error', ...confusingBrowserGlobals],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
      ],

      // react-app severities.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      'no-useless-escape': 'warn',

      // Rules the recommended presets add that react-app did not have. Kept
      // visible, but not build-breaking.
      'no-async-promise-executor': 'warn',
      'no-case-declarations': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unsafe-optional-chaining': 'warn',
      'no-useless-catch': 'warn',
      'no-var': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      // `!!x` in a boolean position is a deliberate, pervasive idiom here.
      'no-extra-boolean-cast': 'off',
    },
  },

  // --- browser sources ----------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,

      // The new JSX transform (`jsx: react-jsx`) means React is never in scope
      // and never needs importing — as under CRA.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      // TypeScript checks props; react-app disables this for the same reason.
      'react/prop-types': 'off',
      // Neither was in react-app, and both fire broadly on deliberate patterns
      // here (typographic apostrophes in copy, anonymous forwardRef/memo
      // components).
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      'react/jsx-key': 'warn',
      'react/no-children-prop': 'warn',
      // react-app had this at "warn"; eslint-plugin-react's own recommended
      // preset raises it to an error.
      'react/jsx-no-target-blank': 'warn',

      // Only the two rules react-app carried, at its severities. Deliberately
      // *not* `reactHooks.configs['recommended-latest']`: eslint-plugin-react-
      // hooks 7 folds the React Compiler rules (react-hooks/refs,
      // set-state-in-effect, purity, immutability, …) into that preset — 365
      // findings on this tree and an entirely new policy, out of scope here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // --- TypeScript ---------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // react-app turns this off for TS: the compiler already resolves names,
      // and the rule cannot see type-only declarations.
      'no-undef': 'off',
    },
  },

  // --- build tooling (Node) -----------------------------------------------
  {
    files: [
      'vite.config.ts',
      'vite/**/*.ts',
      'tools/**/*.mjs',
      'eslint.config.mjs',
      'postcss.config.js',
      'tailwind.config.js',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      // Build scripts report to a terminal; that is their whole UI.
      'no-console': 'off',
    },
  },
);
