import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import path from "node:path";

const mediaBucketName = assertEnvVar("AC_TAU_MEDIA_MEDIA_BUCKET_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { sourceS3Service } = acServices;
    assert(sourceS3Service, "sourceS3Service is required in context.acServices");

    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    logger.debug("getDownloadUrl", { id });

    if (!id || id.endsWith("/")) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "Cannot download a folder" }),
      };
    }

    const filename = path.basename(id);
    const disposition = `attachment; filename="${filename}"`;

    const url = await sourceS3Service.getSignedUrl({
      Bucket: mediaBucketName,
      Key: id,
      ResponseContentDisposition: disposition,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url }),
    };
  };
