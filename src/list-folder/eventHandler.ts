import {
  AcContext,
  assertEnvVar,
  ALLOWED_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS
} from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const mediaBucketName = assertEnvVar("AC_MEDIA_BUCKET_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";
const S3_MAX_KEYS = 1000; // S3 hard limit per request
const allExtensions = [...ALLOWED_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS];
const MEDIA_EXTENSIONS = new RegExp(
  `\\.(${allExtensions.join("|")})$`,
  "i"
);

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { s3Service, dynamoDBService } = acServices;
    assert(s3Service, "s3Service is required");
    assert(dynamoDBService, "dynamoDBService is required");

    const id = event.pathParameters?.id ?? "";
    const pageSize = parseInt(event.queryStringParameters?.pageSize ?? "20", 10);
    const safePage = Math.max(1, Math.min(isNaN(pageSize) ? 20 : pageSize, 1000));
    const nextToken = event.queryStringParameters?.nextToken;

    logger.debug("listFolder", { id, pageSize: safePage, nextToken });

    // S3 caps MaxKeys at 1000 per call — paginate internally to satisfy safePage
    const folderEntries: Array<{ id: string }> = [];
    const fileEntries: Array<{ id: string }> = [];
    let continuationToken: string | undefined = nextToken;
    let remaining = safePage;

    do {
      const batchSize = Math.min(remaining, S3_MAX_KEYS);
      const result = await s3Service.listObjectsV2({
        Bucket: mediaBucketName,
        Prefix: decodeURIComponent(id),
        Delimiter: "/",
        MaxKeys: batchSize,
        ContinuationToken: continuationToken
      });

      // Folder prefixes (sub-folders)
      for (const { Prefix } of result.CommonPrefixes ?? []) {
        folderEntries.push({ id: Prefix ?? "" });
      }

      // File entries — images (jpg, jpeg, heic) and videos (mov)
      for (const { Key } of result.Contents ?? []) {
        if (MEDIA_EXTENSIONS.test(Key ?? "")) {
          fileEntries.push({ id: Key ?? "" });
        }
      }

      continuationToken = result.NextContinuationToken;
      remaining -= batchSize;
    } while (continuationToken && remaining > 0);

    // Filter hidden files by checking meta table in parallel
    const metaResults = await Promise.all(
      fileEntries.map(({ id }) =>
        dynamoDBService.getCommand({ TableName: metaTableName, Key: { id } })
      )
    );
    const visibleFileEntries = fileEntries.filter((_, i) => {
      const tags: { key: string }[] = metaResults[i].Item?.tags ?? [];
      return !tags.some((t) => t.key === TAG_HIDDEN);
    });

    const entries = [...folderEntries, ...visibleFileEntries].map(({ id }) => ({ id, tags: [] }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries,
        ...(continuationToken ? { nextToken: continuationToken } : {})
      })
    };
  };
