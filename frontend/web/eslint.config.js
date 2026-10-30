export default [{
  files: ["**/*.js"],
  ignores: ["node_modules/**", "test-results/**", "playwright-report/**"],
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  rules: {
    "no-unreachable": "error", "no-constant-condition": "error",
    "no-dupe-args": "error", "no-dupe-keys": "error",
    "no-unsafe-finally": "error", "valid-typeof": "error", "constructor-super": "error"
  }
}];
