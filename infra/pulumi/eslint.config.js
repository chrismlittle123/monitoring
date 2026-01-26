import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      // TypeScript-ESLint rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Code quality limits
      'max-depth': ['error', { max: 4 }],
      'max-params': ['error', { max: 4 }],
      'max-lines-per-function': 'error',
      'max-lines': ['error', { max: 400 }],
      complexity: 'error',
      'no-console': ['error', { allow: ['error', 'warn'] }],

      // Best practices
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // Security
      'no-eval': 'error',
      'no-implied-eval': 'error',

      // Bug prevention
      'array-callback-return': 'error',
      'no-template-curly-in-string': 'error',
      'consistent-return': 'error',

      // Import rules
      'import/no-cycle': ['error', { maxDepth: 2 }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  }
);
