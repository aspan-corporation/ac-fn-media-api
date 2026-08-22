import {
  AcServices,
  DynamoDBService,
  getPartialResponseHandler,
  SQSService,
  withMiddlewares,
} from "@aspan-corporation/ac-shared";
import type { Handler } from "aws-lambda";
import { recordHandler } from "./recordHandler.js";

const region = process.env.AWS_REGION || "us-east-1";
const partialHandler = getPartialResponseHandler(recordHandler);

export const handler: Handler = withMiddlewares(partialHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    const acServices: AcServices = {
      sqsService: new SQSService({ region, logger }),
      dynamoDBService: new DynamoDBService({ region, logger }),
    };

    context.acServices = acServices;
  },
});
