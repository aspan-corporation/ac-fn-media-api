import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const tagsTableName = assertEnvVar("AC_TAGS_TABLE_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const pageSize = parseInt(event.queryStringParameters?.pageSize ?? "20", 10);
    const safePage = Math.max(1, Math.min(isNaN(pageSize) ? 20 : pageSize, 1000));
    const nextTokenRaw = event.queryStringParameters?.nextToken;

    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (nextTokenRaw) {
      try {
        exclusiveStartKey = JSON.parse(nextTokenRaw);
      } catch {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Invalid nextToken" }),
        };
      }
    }

    logger.debug("getTags", { pageSize: safePage, exclusiveStartKey });

    const result = await dynamoDBService.scanCommand({
      TableName: tagsTableName,
      Limit: safePage,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });

    const tags = (result.Items ?? []).map((item: Record<string, unknown>) => {
      const composite = (item.id as string) ?? "";
      const separatorIndex = composite.indexOf("#");
      if (separatorIndex >= 0) {
        return {
          key: composite.substring(0, separatorIndex),
          value: composite.substring(separatorIndex + 1),
        };
      }
      return { key: composite, value: "" };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags,
        ...(result.LastEvaluatedKey
          ? { nextToken: JSON.stringify(result.LastEvaluatedKey) }
          : {}),
      }),
    };
  };
