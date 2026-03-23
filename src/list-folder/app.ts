import { AcServices, S3Service, withMiddlewares } from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

const region = process.env.AWS_REGION || "us-east-1";

export const handler = withMiddlewares(lambdaHandler).use({
  before: async ({ context }) => {
    const { logger } = context;
    const s3Service = new S3Service({ region, logger });
    const acServices: AcServices = { s3Service };
    context.acServices = acServices;
  }
});
