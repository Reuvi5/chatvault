// @ts-check
/**
 * Lint configuration.
 *
 * ESLint is pinned to 9.x on purpose: `eslint-plugin-jsx-a11y` does not yet
 * declare support for 10, and the accessibility rules are worth more here than
 * being on the newest major. Revisit when that plugin ships 10 support.
 *
 * Type-aware rules are on for our own source. They are what catch the mistakes
 * that matter in this codebase — an unawaited promise in an upload loop, a
 * mishandled rejection in a route handler — rather than style, which Prettier
 * settles.
 */
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '.data/**',
      'fixtures-generated/**',
      'next-env.d.ts',
    ],
  },

  // Type-aware linting for every TypeScript file in the workspace.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `void somePromise()` is how this codebase says "deliberately not awaited".
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Template literals are used for user-facing copy; numbers in them are fine
      // because the strict-boolean style is handled by explicit String() calls.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Async generators that yield from a synchronous source are a legitimate
      // way to build an async iterable; TypeScript already checks the return
      // type, so this rule only fights the pattern.
      '@typescript-eslint/require-await': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Plain JS/MJS config files are not part of any tsconfig, so type-aware
  // rules cannot apply to them.
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // React: hooks correctness and accessibility, for the interface only.
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Decrypted attachments are rendered from in-memory blob URLs, so the
      // image optimiser cannot help and alt text comes from the file name.
      'jsx-a11y/alt-text': ['error', { img: ['img'] }],

      /*
       * The rest of this plugin's rules are kept: `set-state-in-effect` and
       * `refs` both found real bugs here (a response landing after unmount, a
       * ref written during render).
       *
       * This one is different. It reports where the React Compiler would give
       * up on an existing useMemo — useful only if the compiler is turned on,
       * which this project does not do. Enable the compiler in next.config.mjs
       * and this should come back on in the same change.
       */
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },

  // Tests and local scripts: a few rules that only make sense in library code.
  {
    files: ['**/*.test.ts', 'apps/web/tests/**/*.ts', 'apps/web/scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  // Must stay last: turns off everything Prettier already decides.
  prettier,
);
