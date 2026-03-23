import {
  AcServices,
  DynamoDBService,
  withMiddlewares,
} from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

const region = process.env.AWS_REGION || "us-east-1";

export const handler = withMiddlewares(lambdaHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    const dynamoDBService = new DynamoDBService({
      region,
      logger,
    });

    const acServices: AcServices = {
      dynamoDBService,
    };

    context.acServices = acServices;
  },
});
