import tseslint from "typescript-eslint";

// eslint 9 flat config. Mirrors the workspace convention (ac-cocobolo):
// eslint recommended + @typescript-eslint recommended, minimal custom rules.
export default tseslint.config(
  {
    // tsc compiles in place, so emitted .js/.d.ts sit next to sources —
    // lint only the TypeScript. cdk.out holds synthesized assets.
    ignores: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "cdk.out/"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore prefix marks intentionally unused (e.g. `_input`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests fake the AWS service objects with structurally-typed `any`
    // throughout (established convention in this repo) — don't fight it.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
