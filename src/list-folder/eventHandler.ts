import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const META_FOLDER_INDEX = "by-folder";
const ROOT_FOLDER = "/";

const TAG_HIDDEN = "ac:ediacara:hidden";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
};

const normalizeFolder = (id: string): string => {
  if (!id) return ROOT_FOLDER;
  return id.endsWith("/") ? id : `${id}/`;
};

const isHidden = (tags: Array<{ key: string; value: string }>) =>
  tags.some((t) => t.key === TAG_HIDDEN);

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required");

    const rawId = decodeURIComponent(event.pathParameters?.id ?? "");
    const folder = normalizeFolder(rawId);
    const requestedPageSize = parseInt(
      event.queryStringParameters?.pageSize ?? "20",
      10
    );
    const pageSize = Math.max(
      1,
      Math.min(isNaN(requestedPageSize) ? 20 : requestedPageSize, 1000)
    );
    const nextToken = event.queryStringParameters?.nextToken;
    const startKey = nextToken
      ? (JSON.parse(Buffer.from(nextToken, "base64").toString("utf8")) as Record<
          string,
          unknown
        >)
      : undefined;

    logger.debug("listFolder", { rawId, folder, pageSize, nextToken });

    // Hidden items are filtered in the lambda, but pagination is corrected
    // by looping until we accumulate `pageSize` visible items (or exhaust
    // the partition). Previously the handler returned at most one Query
    // page minus hidden items, producing inconsistent page sizes for the
    // client. DynamoDB doesn't support FilterExpression on nested map
    // attributes (the `tags` list of `{key, value}` maps), so an in-lambda
    // loop is the cleanest correct fix without a schema change.
    //
    // For folders with low hidden ratios this is one Query (Limit=pageSize
    // mostly returns enough visible items). For high-hidden folders RCU
    // grows linearly with hidden count — acceptable for a family library.
    const MAX_ITERATIONS = 10;
    const visible: Array<{ id: string; tags: Array<{ key: string; value: string }> }> = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined = startKey;
    let iterations = 0;

    do {
      const remaining = pageSize - visible.length;
      const result = await dynamoDBService.queryCommand({
        TableName: metaTableName,
        IndexName: META_FOLDER_INDEX,
        KeyConditionExpression: "#folder = :folder",
        ExpressionAttributeNames: { "#folder": "folder" },
        ExpressionAttributeValues: { ":folder": folder },
        ProjectionExpression: "id, tags",
        Limit: remaining,
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      });

      for (const raw of (result.Items ?? []) as Array<{
        id: string;
        tags?: Array<{ key: string; value: string }>;
      }>) {
        const tags = raw.tags ?? [];
        if (!isHidden(tags)) {
          visible.push({ id: raw.id, tags });
          if (visible.length >= pageSize) break;
        }
      }

      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      iterations++;
    } while (
      lastEvaluatedKey &&
      visible.length < pageSize &&
      iterations < MAX_ITERATIONS
    );

    const responseNextToken = lastEvaluatedKey
      ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64")
      : undefined;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        entries: visible,
        ...(responseNextToken ? { nextToken: responseNextToken } : {}),
      }),
    };
  };
