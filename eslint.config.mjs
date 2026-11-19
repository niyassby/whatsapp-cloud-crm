import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // k6 load tests (Phase 4.5): k6 provides __ENV to every script.
    files: ['load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly' } },
  },
  {
    // NestJS DI reads constructor param types at runtime (emitDecoratorMetadata). Telling the
    // parser keeps consistent-type-imports from turning injected classes into `import type`.
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
  },
  {
    // wapi-cloud may only be imported inside packages/whatsapp
    files: ['apps/**/*.{ts,tsx}', 'packages/!(whatsapp)/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'wapi-cloud', message: 'Import wapi-cloud only inside packages/whatsapp.' },
          ],
        },
      ],
    },
  },
  {
    // Raw SQL only as tagged templates, which bind every value as a parameter. The string forms
    // would let a value be concatenated into SQL. Prisma.raw splices text in, so it stays in
    // packages/db, where it is used for fixed table and column names only. Tests may use both.
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.ts'],
    ignores: ['**/test/**', '**/*.test.ts', 'e2e/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^\\$(queryRaw|executeRaw)Unsafe$/]',
          message: 'Use the $queryRaw / $executeRaw tagged templates, which bind values.',
        },
      ],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/!(db)/**/*.ts'],
    ignores: ['**/test/**', '**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Prisma',
          property: 'raw',
          message: 'Prisma.raw splices text into SQL; keep it in packages/db for fixed names.',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
