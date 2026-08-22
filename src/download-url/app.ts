import {
  AcServices,
  S3Service,
  withMiddlewares,
} from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

const region = process.env.AWS_REGION || "us-east-1";

export const handler = withMiddlewares(lambdaHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    // The media library and the diary both live in the same consolidated
    // bucket now (see MediaBucket, AcAppStack) — the Lambda's own execution
    // role is granted GetObject directly. No cross-account assume-role
    // needed any more.
    const sourceS3Service = new S3Service({ region, logger });

    const acServices: AcServices = {
      sourceS3Service,
    };

    context.acServices = acServices;
  },
});
