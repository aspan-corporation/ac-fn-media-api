import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { validateTagsInput } from "../shared/tagValidation.js";
import { hasHiddenTag, requireAdmin } from "../shared/auth.js";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

const SYSTEM_TAU_PREFIX = "ac:tau:";

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    if (!id) return json(400, { message: "id is required" });

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(event.body ?? "{}");
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }

    // Validate incoming tags. Strict on shape & length, lenient on
    // ac:tau:* — those are silently stripped (server reads authoritative
    // values from DB and reattaches them).
    const validated = validateTagsInput(parsedBody.tags);
    if (!validated.ok) {
      return json(400, { message: validated.message });
    }
    const userTags = validated.tags;
    if (validated.strippedSystemTagCount > 0) {
      logger.warn("updateMetadata stripped client-supplied system tags", {
        id,
        stripped: validated.strippedSystemTagCount,
      });
    }

    logger.debug("updateMetadata", { id, incomingTags: userTags });

    // Server-authoritative merge of system tags. Clients cannot create,
    // modify, or delete ac:tau:* tags via this endpoint — we always read
    // them fresh from the existing item and reattach them on write.
    const { Item: existing } = await dynamoDBService.getCommand({
      TableName: metaTableName,
      Key: { id },
    });

    const existingTags = (existing?.tags ?? []) as Array<{ key: string; value: string }>;

    // Adding or removing the hidden tag is an admin-only operation. Other tag
    // edits (favorites, albums, user tags) stay open to any signed-in member.
    if (hasHiddenTag(existingTags) !== hasHiddenTag(userTags)) {
      const denied = requireAdmin(event);
      if (denied) return denied;
    }

    const systemTags = existingTags.filter((t) => t.key.startsWith(SYSTEM_TAU_PREFIX));

    const finalTags = [...userTags, ...systemTags];

    const { Attributes: updated } = await dynamoDBService.updateCommand({
      TableName: metaTableName,
      Key: { id },
      UpdateExpression: "SET tags = :tags",
      ExpressionAttributeValues: { ":tags": finalTags },
      ReturnValues: "ALL_NEW",
    });

    return json(200, {
      id: updated?.id ?? id,
      tags: updated?.tags ?? finalTags,
    });
  };
