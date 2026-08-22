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

    // The media bucket is same-account; the Lambda's own role is granted
    // scoped PutObject access directly (no assume-role, same pattern as the
    // diary upload-url route).
    const sourceS3Service = new S3Service({ region, logger });

    const acServices: AcServices = { sourceS3Service };

    context.acServices = acServices;
  },
});
