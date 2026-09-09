import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**"],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
