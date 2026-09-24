/**
 * ESLint configuration.
 *
 * `npm run lint` existed in package.json for months but ESLint was never
 * installed and there was no config, so the script could only ever fail — which
 * is worse than having no lint step, because CI and reviewers assume it ran.
 *
 * Rule selection is deliberately narrow. A large existing codebase flooded with
 * stylistic warnings teaches everyone to ignore lint output; the rules enabled
 * here are the ones that catch defects, plus `eslint-plugin-security` for the
 * patterns a reviewer genuinely misses.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      "zoom-bot/build/**",
      "public/**",
      "migrations/**",
      // Vendored shadcn/ui primitives: upstream code, updated by re-vendoring
      // rather than by editing, so linting it only creates noise we cannot act on.
      "src/components/ui/**",
      "src/vendor/**",
      "*.config.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // An unused variable is usually a half-finished edit. Underscore-prefixed
      // names are the documented way to say "intentionally discarded".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // `any` is sometimes the honest type at a boundary (D1 rows, Zoom payloads);
      // warn so it stays visible without blocking, rather than being silenced.
      "@typescript-eslint/no-explicit-any": "warn",

      // This is a Japanese product: the ideographic space (U+3000) appears
      // legitimately in comments and in a normalisation regex, and csv.ts emits a
      // UTF-8 BOM on purpose so Excel opens exports correctly. Only genuinely
      // stray whitespace in code should be an error.
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true },
      ],

      // React Compiler-era advisories. Both are reasonable guidance, but they fire
      // on the ordinary "load on mount" effect used throughout the existing
      // screens. Kept visible as warnings rather than made blocking, so the lint
      // output stays worth reading.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",

      "no-console": "off", // structured console logging is the Workers log pipeline
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "off",

      // Security rules that produce more noise than signal in this codebase:
      // object injection fires on every `record[key]` lookup, and non-literal
      // fs/regexp do not apply to a Worker that has no filesystem.
      "security/detect-object-injection": "off",
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  // Tests assert on internals and deliberately construct odd inputs.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "security/detect-unsafe-regex": "off",
    },
  },
);
