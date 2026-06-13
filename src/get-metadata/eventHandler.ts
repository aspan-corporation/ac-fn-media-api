import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
    };

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    logger.debug("getMetadata", { id });

    const { Item: item } = await dynamoDBService.getCommand({
      TableName: metaTableName,
      Key: { id },
    });

    if (!item) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ id, tags: [] }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        id: item.id,
        tags: item.tags ?? [],
        ...(item.blurhash ? { blurhash: item.blurhash } : {}),
        ...(item.width && item.height
          ? { width: item.width, height: item.height }
          : {}),
      }),
    };
  };
