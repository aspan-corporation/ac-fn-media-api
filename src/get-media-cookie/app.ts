import { withMiddlewares } from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

// No acServices needed — the handler reads its signing config directly from
// SSM (cached) and signs cookies in-process.
export const handler = withMiddlewares(lambdaHandler);
