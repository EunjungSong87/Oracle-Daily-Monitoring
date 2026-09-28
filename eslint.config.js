const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    // client/**: React 파일럿(client/)은 자체 tsconfig/toolchain을 쓰는 별도 프로젝트라 여기서 제외.
    ignores: ['node_modules/**', 'dist/**', 'public/**', 'instantclient_19_25/**', 'eslint.config.js', 'client/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 이 코드베이스는 oracledb의 동적 결과 셋을 많이 다뤄서 any를 의도적으로 씀.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'off',
    },
  }
);
