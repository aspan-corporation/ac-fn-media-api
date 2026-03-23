import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const mediaBucketName = assertEnvVar("AC_MEDIA_BUCKET_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { s3Service } = acServices;
    assert(s3Service, "s3Service is required");

    const id = event.pathParameters?.id ?? "";
    const pageSize = parseInt(event.queryStringParameters?.pageSize ?? "20", 10);
    const nextToken = event.queryStringParameters?.nextToken;

    logger.debug("listFolder", { id, pageSize, nextToken });

    const result = await s3Service.listObjectsV2({
      Bucket: mediaBucketName,
      Prefix: decodeURIComponent(id),
      Delimiter: "/",
      MaxKeys: pageSize,
      ContinuationToken: nextToken
    });

    // Folder prefixes (sub-folders)
    const folderEntries = (result.CommonPrefixes ?? []).map(({ Prefix }) => ({
      id: Prefix ?? ""
    }));

    // File entries — only .jpg / .jpeg
    const fileEntries = (result.Contents ?? [])
      .filter(({ Key }) => /\.(jpg|jpeg)$/i.test(Key ?? ""))
      .map(({ Key }) => ({ id: Key ?? "" }));

    const entries = [...folderEntries, ...fileEntries].map(({ id }) => ({ id, tags: [] }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries,
        ...(result.NextContinuationToken ? { nextToken: result.NextContinuationToken } : {})
      })
    };
  };
