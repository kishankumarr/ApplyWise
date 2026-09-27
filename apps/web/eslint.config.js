import nextPlugin from "@next/eslint-plugin-next";
import { createConfig } from "@applywise/config/eslint";

export default [
  ...createConfig({ react: true, ignores: ["playwright-report/**", "test-results/**"] }),
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    // Guardrail: application code must never programmatically submit third-party forms.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='requestSubmit']",
          message: "Programmatic form submission is prohibited (final submit must stay user-controlled).",
        },
      ],
    },
  },
];
