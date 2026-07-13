const runtimeGlobals = Object.fromEntries([
  'ALL_WORDS', 'AbortController', 'Blob', 'Buffer', 'DOMException', 'Element', 'Event', 'FileReader', 'Headers',
  'Intl', 'Request', 'Response', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams',
  'atob', 'clearTimeout', 'console', 'crypto', 'document', 'fetch', 'globalThis', 'localStorage',
  'navigator', 'performance', 'process', 'requestAnimationFrame', 'setTimeout', 'structuredClone', 'window'
].map(name => [name, 'readonly']));

export default [
  {
    ignores: ['node_modules/**', 'words-data.js', 'shared/words-data.mjs', '.wrangler/**']
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: runtimeGlobals
    },
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-undef': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-obj-calls': 'error',
      'no-promise-executor-return': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-with': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error'
    }
  },
  {
    files: ['shared/api-security.mjs', 'shared/workflow-mutation.mjs', 'functions/healthz.js', 'scripts/test-hardening.mjs'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];
