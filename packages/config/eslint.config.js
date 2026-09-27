// Shared flat ESLint config for all ApplyWise workspaces.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * @param {{ react?: boolean, ignores?: string[] }} [options]
 */
export function createConfig(options = {}) {
  return tseslint.config(
    {
      ignores: [
        "**/node_modules/**",
        "**/.next/**",
        "**/.plasmo/**",
        "**/build/**",
        "**/dist/**",
        "**/generated/**",
        "**/coverage/**",
        "**/next-env.d.ts",
        ...(options.ignores ?? []),
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: { ...globals.node, ...globals.browser },
      },
      rules: {
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
        ],
        "@typescript-eslint/consistent-type-imports": ["warn", { fixStyle: "inline-type-imports" }],
        "no-console": ["error", { allow: ["warn", "error"] }],
        eqeqeq: ["error", "smart"],
      },
    },
    ...(options.react
      ? [
          {
            plugins: { "react-hooks": reactHooks },
            rules: {
              "react-hooks/rules-of-hooks": "error",
              "react-hooks/exhaustive-deps": "warn",
            },
          },
        ]
      : []),
  );
}

export default createConfig();
