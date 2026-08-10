import cds from "@sap/cds/eslint.config.mjs"

export default [
  ...cds,
  {
    ignores: ["**/__snapshots__/**"],
  },
  {
    files: ["**/*.js"],
    rules: {
      "no-await-in-loop": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**", "scripts/**"],
    rules: {
      "no-console": "off",
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
    },
  },
]
