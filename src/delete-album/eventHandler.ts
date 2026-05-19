import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const albumsTableName = assertEnvVar("AC_ALBUMS_TABLE_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");

// The virtual-album membership tag. Must match
// ac-cocobolo/src/common/constants.ts:TAG_VIRTUAL_ALBUM. Hardcoded here
// (rather than imported) because ac-fn-media-api doesn't depend on cocobolo.
const TAG_VIRTUAL_ALBUM = "ac:ediacara:va";

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

// Limit on concurrent meta UpdateItem calls during cascade. Each call is
// independent (different partition key) so this is just throttling DynamoDB
// write pressure, not a correctness boundary. 25 is comfortably below the
// default 500 WCU/s burst for a small table.
const CASCADE_CONCURRENCY = 25;

/**
 * DELETE /api/albums/{id}
 *
 * Removes the album from the albums table AND removes the album-membership
 * tag (`ac:ediacara:va: <name>`) from every entry currently in the album.
 * The search-table mirrors of those tags are cleaned up by the stream-driven
 * ac-fn-calculate-relationship-updates Lambda when the meta items update,
 * so this handler doesn't touch the search table directly.
 *
 * Order of operations:
 *   1. GetItem on albums → resolve name
 *   2. Query search table to enumerate member entry IDs (no full scan)
 *   3. For each member: UpdateItem on meta to filter out the tag, throttled
 *      by CASCADE_CONCURRENCY
 *   4. DeleteItem on albums
 *
 * The cascade comes BEFORE the album row deletion so that if anything fails
 * mid-cascade the album still exists and the user can retry. The opposite
 * order would leave orphaned membership tags pointing at a non-existent
 * album, which would confuse the UI (the album wouldn't render but files
 * would still be in it).
 *
 * The handler is idempotent at the cascade step: removing a tag that's
 * already absent is a no-op. So a retry after a partial failure converges
 * cleanly.
 */
export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    if (!id) return json(400, { message: "id is required" });

    // ── 1. Resolve album name from id ────────────────────────────────────
    const { Item: album } = await dynamoDBService.getCommand({
      TableName: albumsTableName,
      Key: { id },
    });
    if (!album) {
      return json(404, { message: "Album not found" });
    }
    const name = album.name as string;
    logger.info("deleteAlbum", { id, name });

    // ── 2. Enumerate member entry IDs from the search table ─────────────
    // The search table is keyed by `key` and filtered by `value`. We project
    // only `id` so the round-trip stays small.
    const memberIds = new Set<string>();
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const { Items, LastEvaluatedKey } = await dynamoDBService.queryCommand({
        TableName: searchTableName,
        KeyConditionExpression: "#key = :key",
        FilterExpression: "#value = :value",
        ExpressionAttributeNames: { "#key": "key", "#value": "value" },
        ExpressionAttributeValues: { ":key": TAG_VIRTUAL_ALBUM, ":value": name },
        ProjectionExpression: "id",
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      });
      for (const item of Items ?? []) {
        if (typeof item.id === "string") memberIds.add(item.id);
      }
      exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    logger.info("deleteAlbum cascade plan", { name, memberCount: memberIds.size });

    // ── 3. Remove the membership tag from each member entry ─────────────
    // Read-modify-write per item: read tags, filter out the matching one,
    // write back. DynamoDB has no list-element-remove-by-predicate operator,
    // so the read is unavoidable. We dispatch in concurrency-limited batches
    // to keep write pressure bounded.
    const ids = [...memberIds];
    let removedCount = 0;

    const removeFromOne = async (entryId: string): Promise<void> => {
      const { Item } = await dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id: entryId },
      });
      if (!Item) return; // already deleted from meta
      const tags = (Item.tags ?? []) as Array<{ key: string; value: string }>;
      const filtered = tags.filter(
        (t) => !(t.key === TAG_VIRTUAL_ALBUM && t.value === name),
      );
      if (filtered.length === tags.length) return; // tag already absent — idempotent
      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id: entryId },
        UpdateExpression: "SET tags = :tags",
        ExpressionAttributeValues: { ":tags": filtered },
      });
      removedCount++;
    };

    for (let i = 0; i < ids.length; i += CASCADE_CONCURRENCY) {
      const slice = ids.slice(i, i + CASCADE_CONCURRENCY);
      await Promise.all(slice.map(removeFromOne));
    }

    // ── 4. Delete the album row itself ──────────────────────────────────
    // DynamoDBService doesn't surface a deleteCommand helper, so we drop to
    // the underlying documentClient. Same client, same auth.
    await dynamoDBService.documentClient.send(
      new DeleteCommand({
        TableName: albumsTableName,
        Key: { id },
      }),
    );

    logger.info("deleteAlbum complete", { id, name, removedCount });

    return json(200, {
      id,
      name,
      removedFromCount: removedCount,
    });
  };
