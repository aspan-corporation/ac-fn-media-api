import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import assert from "node:assert";
import { requireAdmin } from "../shared/auth.js";
import { searchPartitionKey } from "../shared/searchKey.js";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");
const tagsTableName = assertEnvVar("AC_TAGS_TABLE_NAME");

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

// See delete-album/eventHandler.ts — same throttling rationale.
const CASCADE_CONCURRENCY = 25;

/**
 * DELETE /api/labels — path is "labels", not "tags": default ad-blocker
 * filter lists block request paths containing "tag"/"tags". See api.ts's
 * GetTags endpoint comment on the frontend for the full story.
 *
 * Body: { key: string, value: string }
 *
 * Admin-only. Removes the exact (key, value) tag from every item that has
 * it, then deletes the tag's own catalog row so it stops appearing in
 * GetTags. Shape mirrors delete-album's membership cascade: enumerate
 * matching items via a single SearchTableV2 partition Query (pk =
 * `key#value` — the same partition the search endpoint itself reads), then
 * read-modify-write each item's tags in the meta table. The stream-driven
 * ac-fn-calculate-relationship-updates Lambda cleans up the search table's
 * own rows after each meta update — this handler never writes the search
 * table directly.
 *
 * Order matters: the item cascade runs BEFORE the catalog row is deleted,
 * so a failure partway through leaves the tag still discoverable (and the
 * whole operation retryable) rather than orphaning items that carry a tag
 * nothing can find or re-delete anymore.
 *
 * Idempotent: an item whose tag is already gone is skipped without a
 * write, and deleting an already-absent catalog row is a no-op — a retry
 * after a partial failure converges cleanly.
 */
export const lambdaHandler: Handler<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> = async (event, ctx) => {
  const { logger, acServices = {} } = ctx as unknown as AcContext;
  const { dynamoDBService } = acServices;
  assert(dynamoDBService, "dynamoDBService is required in context.acServices");

  // Deleting a tag (and cascading its removal across every item that has
  // it) is an admin-only operation.
  const denied = requireAdmin(event);
  if (denied) return denied;

  let key: string;
  let value: string;
  try {
    const body = JSON.parse(event.body ?? "{}");
    if (typeof body.key !== "string" || !body.key.trim()) {
      return json(400, { message: "body.key is required" });
    }
    if (typeof body.value !== "string") {
      return json(400, { message: "body.value must be a string" });
    }
    key = body.key;
    value = body.value;
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }

  logger.info("deleteTag", { key, value });

  // ── 1. Enumerate every item carrying this exact tag ───────────────────
  const pk = searchPartitionKey(key, value);
  const memberIds = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await dynamoDBService.queryCommand({
      TableName: searchTableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": pk },
      ProjectionExpression: "id",
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    for (const item of Items ?? []) {
      if (typeof item.id === "string") memberIds.add(item.id);
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  logger.info("deleteTag cascade plan", {
    key,
    value,
    memberCount: memberIds.size,
  });

  // ── 2. Remove the tag from each member's item ─────────────────────────
  let removedFromCount = 0;
  const ids = [...memberIds];

  const removeFromOne = async (id: string): Promise<void> => {
    const { Item } = await dynamoDBService.getCommand({
      TableName: metaTableName,
      Key: { id },
    });
    if (!Item) return; // already deleted from meta
    const tags = (Item.tags ?? []) as Array<{ key: string; value: string }>;
    const filtered = tags.filter((t) => !(t.key === key && t.value === value));
    if (filtered.length === tags.length) return; // already absent — idempotent
    await dynamoDBService.updateCommand({
      TableName: metaTableName,
      Key: { id },
      UpdateExpression: "SET tags = :tags",
      ExpressionAttributeValues: { ":tags": filtered },
    });
    removedFromCount++;
  };

  for (let i = 0; i < ids.length; i += CASCADE_CONCURRENCY) {
    const slice = ids.slice(i, i + CASCADE_CONCURRENCY);
    await Promise.all(slice.map(removeFromOne));
  }

  // ── 3. Delete the tag's own catalog row ────────────────────────────────
  // DynamoDBService doesn't surface a deleteCommand helper (see
  // delete-album/eventHandler.ts) — drop to the underlying documentClient.
  await dynamoDBService.documentClient.send(
    new DeleteCommand({
      TableName: tagsTableName,
      Key: { "key#value": pk },
    }),
  );

  logger.info("deleteTag complete", { key, value, removedFromCount });

  return json(200, { key, value, removedFromCount });
};
