import tseslint from "typescript-eslint";
import durablePlugin from "@aws/durable-execution-sdk-js-eslint-plugin";

export default [
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@aws/durable-functions": durablePlugin,
    },
    rules: {
      ...durablePlugin.configs.recommended.rules,
    },
  },
];
