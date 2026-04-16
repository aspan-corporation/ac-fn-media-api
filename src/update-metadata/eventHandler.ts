import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    const { tags } = JSON.parse(event.body ?? "{}");

    logger.debug("updateMetadata", { id, tags });

    const { Attributes: updated } = await dynamoDBService.updateCommand({
      TableName: metaTableName,
      Key: { id },
      UpdateExpression: "SET tags = :tags",
      ExpressionAttributeValues: { ":tags": tags },
      ReturnValues: "ALL_NEW",
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: updated?.id ?? id, tags: updated?.tags ?? tags }),
    };
  };
