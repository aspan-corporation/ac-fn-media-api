import {
  AcServices,
  assertEnvVar,
  S3Service,
  STSService,
  withMiddlewares,
} from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "./eventHandler.js";

const region = process.env.AWS_REGION || "us-east-1";

export const handler = withMiddlewares(lambdaHandler).use({
  before: async ({ context }) => {
    const { logger } = context;

    const stsService = new STSService({ region, logger });

    const assumeRoleCommandOutput = await stsService.assumeRole({
      RoleArn: assertEnvVar("AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN"),
      RoleSessionName: "audio-url",
      ExternalId: "ac",
    });

    const sourceS3Service = new S3Service({
      region,
      assumeRoleCommandOutput,
      logger,
    });

    const acServices: AcServices = {
      sourceS3Service,
    };

    context.acServices = acServices;
  },
});
