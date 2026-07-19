import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { normalizeAlbum } from "../shared/albumNormalize.js";

const albumsTableName = assertEnvVar("AC_ALBUMS_TABLE_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const pageSize = parseInt(event.queryStringParameters?.pageSize ?? "100", 10);
    const safePage = Math.max(1, Math.min(isNaN(pageSize) ? 100 : pageSize, 1000));
    const nextTokenRaw = event.queryStringParameters?.nextToken;

    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
    };

    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (nextTokenRaw) {
      try {
        exclusiveStartKey = JSON.parse(nextTokenRaw);
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: "Invalid nextToken" }),
        };
      }
    }

    logger.debug("getAlbums", { pageSize: safePage, exclusiveStartKey });

    const result = await dynamoDBService.scanCommand({
      TableName: albumsTableName,
      Limit: safePage,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });

    const albums = (result.Items ?? [])
      .map((item: Record<string, unknown>) =>
        normalizeAlbum({
          id: item.id as string,
          name: item.name as string,
          kind: item.kind,
          search: item.search,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        albums,
        ...(result.LastEvaluatedKey
          ? { nextToken: JSON.stringify(result.LastEvaluatedKey) }
          : {}),
      }),
    };
  };
