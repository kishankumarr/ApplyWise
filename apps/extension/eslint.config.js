import { createConfig } from "@applywise/config/eslint";

export default [
  ...createConfig({ react: true, ignores: [".plasmo/**", "build/**"] }),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // The extension must never submit forms or click buttons on third-party pages.
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.property.name='submit']", message: "Submitting forms is prohibited in the extension." },
        { selector: "CallExpression[callee.property.name='requestSubmit']", message: "Submitting forms is prohibited in the extension." },
        { selector: "CallExpression[callee.property.name='click']", message: "Programmatic clicks are prohibited in the extension." },
      ],
    },
  },
];
