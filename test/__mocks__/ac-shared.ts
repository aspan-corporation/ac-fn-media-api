/**
 * Test-only stand-in for @aspan-corporation/ac-shared.
 *
 * The package is ESM-only with an `exports` map that has no `require`
 * condition, which Jest's resolver can't follow from this repo (no
 * `"type": "module"`). Handlers are dependency-injected through `acServices`,
 * so at module-load time they only need `assertEnvVar`, the `AcContext` type,
 * and the pure utils (diary/thumbsKey/helpers — the diary handler tokenizes,
 * extracts embeds, derives folders at runtime). Re-export the real compiled
 * utils by file path — bypassing the exports map — so tests exercise the real
 * logic, not a parallel implementation. AWS service classes stay out: tests
 * fake them.
 */

export * from "../../node_modules/@aspan-corporation/ac-shared/lib/utils/index.js";

export type AcContext = {
  logger: unknown;
  acServices?: { dynamoDBService?: unknown; [k: string]: unknown };
};
