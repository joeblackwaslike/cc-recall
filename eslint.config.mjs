import importX from 'eslint-plugin-import-x';
import noSecrets from 'eslint-plugin-no-secrets';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  unicorn.configs['flat/recommended'],
  sonarjs.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    plugins: { 'no-secrets': noSecrets },
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `// TODO(§…)` markers are an intentional convention here; the work itself is
      // tracked in beads, so a TODO comment is a signpost, not a lint failure.
      'sonarjs/todo-tag': 'off',
      'sonarjs/cognitive-complexity': ['error', 10],
      'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
      'max-lines-per-function': [
        'warn',
        // biome-ignore lint/style/useNamingConvention: `IIFEs` is an ESLint rule option name.
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', { max: 5 }],
      'max-depth': ['error', { max: 5 }],
      'max-statements': ['warn', { max: 20 }, { ignoreTopLevelFunctions: true }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'unicorn/error-message': 'error',
      'unicorn/catch-error-name': 'error',
      'unicorn/custom-error-definition': 'error',
      // tsc (NodeNext) is authoritative for module resolution; import-x's resolver
      // does not understand `.js` specifiers that map to `.ts` sources or node: builtins.
      'import-x/no-unresolved': 'off',
      // The build is plain `tsc` (no path rewrite), so the `@/` alias would not resolve
      // at runtime in dist/. Relative imports across the small src tree are intentional.
      'import-x/no-relative-parent-imports': 'off',
      'import-x/no-cycle': ['error', { maxDepth: 10 }],
      'import-x/order': 'off',
      'import-x/no-duplicates': 'off',
      'no-secrets/no-secrets': ['error', { tolerance: 4.5 }],
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2, 10, 100, 1000],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          enforceConst: true,
        },
      ],
      'unicorn/name-replacements': [
        'error',
        {
          replacements: {
            props: false,
            ref: false,
            ctx: false,
            req: false,
            res: false,
            err: false,
            db: false,
            id: false,
            env: false,
            fn: false,
            dir: false,
            src: false,
            dest: false,
            tmp: false,
            config: false,
            args: false,
          },
        },
      ],
      'unicorn/no-null': 'off',
      'unicorn/filename-case': ['error', { case: 'kebabCase', multipleFileExtensions: true }],
      'unicorn/no-process-exit': 'off',
    },
  },
  {
    // Plain Node scripts (hooks, etc.) are not part of the TS program; lint them
    // without type-aware rules so the type-checked parser does not choke on them.
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { project: false, projectService: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Plain JS (hooks, configs) cannot carry type annotations.
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'ops/**', // unrelated claude-mem watchdog — not part of cc-recall
      '*.config.mjs',
      'vitest.config.ts',
    ],
  },
);
