/**
 * Jest config for the media-api Lambda handlers.
 * Uses ts-jest with ESM support; handlers themselves use .js imports for ESM.
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // Handlers import sibling files with explicit `.js` (ESM convention).
    // Strip the suffix so ts-jest resolves the source `.ts` file.
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // ac-shared is fully dependency-injected at runtime through `acServices`,
    // so tests don't need the real implementation. Map to a tiny stub that
    // sidesteps the package's ESM compiled output (Jest resolver can't follow
    // the package.json `exports` field for it).
    "^@aspan-corporation/ac-shared$":
      "<rootDir>/test/__mocks__/ac-shared.ts",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.json",
        // Suppress ts-jest's hybrid-module warning — the source uses
        // NodeNext for runtime, but tests run via ts-jest's CJS bridge.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  clearMocks: true,
  // Allow Jest to transform ESM modules from ac-shared.
  transformIgnorePatterns: [
    "node_modules/(?!(@aspan-corporation)/)",
  ],
};
