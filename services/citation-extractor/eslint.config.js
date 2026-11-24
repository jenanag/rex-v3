import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "contract/**"] },
  ...tseslint.configs.recommended,
];
