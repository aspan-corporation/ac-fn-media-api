/**
 * Test-only stub for @aspan-corporation/ac-shared.
 *
 * Handlers receive their dependencies (logger, dynamoDBService, etc.) via
 * the AcContext injected at the Lambda layer, so the only symbols they
 * actually pull from ac-shared at *load* time are `assertEnvVar` and the
 * `AcContext` type. We re-export tiny test versions here.
 */

export const assertEnvVar = (envVar: string): string => {
  const value = process.env[envVar];
  if (!value) throw new Error(`${envVar} is not set in test env`);
  return value;
};

export type AcContext = {
  logger: unknown;
  acServices?: { dynamoDBService?: unknown; [k: string]: unknown };
};
