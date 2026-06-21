import {
  AcServices,
  DynamoDBService,
  S3Service,
  SQSService,
  withMiddlewares,
} from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

const region = process.env.AWS_REGION || "us-east-1";

export const handler = withMiddlewares(lambdaHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    const dynamoDBService = new DynamoDBService({ region, logger });

    // The diary bucket is in this account; the lambda's own role is granted
    // scoped access to it (no cross-account assume-role like the media bucket).
    const sourceS3Service = new S3Service({ region, logger });

    // For dispatching uploaded diary images to the processing queues on save.
    const sqsService = new SQSService({ region, logger });

    const acServices: AcServices = {
      dynamoDBService,
      sourceS3Service,
      sqsService,
    };

    context.acServices = acServices;
  },
});
