import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { requireAdmin } from "../shared/auth.js";
import { normalizeAlbum } from "../shared/albumNormalize.js";
import { TAG_VIRTUAL_ALBUM } from "../shared/albumTags.js";
import { searchPartitionKey } from "../shared/searchKey.js";

const albumsTableName = assertEnvVar("AC_ALBUMS_TABLE_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
// Reads the date-ordered V2 index (pk=`key#value`, sk=`sortDate#id`).
const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");

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
 * Removes the album from the albums table. For a MANUAL album, also removes
 * the membership tag (`ac:ediacara:va: <id>`) from every entry currently in
 * it — a SMART album has no per-item membership to cascade (its "members"
 * are just whatever currently matches its saved search), so deleting one is
 * just the row delete. The search-table mirrors of the membership tag are
 * cleaned up by the stream-driven ac-fn-calculate-relationship-updates
 * Lambda when the meta items update, so this handler doesn't touch the
 * search table's write side directly.
 *
 * Order of operations (manual album):
 *   1. GetItem on albums → resolve kind (normalizeAlbum)
 *   2. Query the V2 index's `va#<id>` partition to enumerate member entry IDs
 *      (a single-partition Query — membership is keyed by album id, not name)
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

    // Deleting an album (and cascading the membership-tag removal) is an
    // admin-only operation.
    const denied = requireAdmin(event);
    if (denied) return denied;

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    if (!id) return json(400, { message: "id is required" });

    // ── 1. Resolve album kind ────────────────────────────────────────────
    const { Item: albumRow } = await dynamoDBService.getCommand({
      TableName: albumsTableName,
      Key: { id },
    });
    if (!albumRow) {
      return json(404, { message: "Album not found" });
    }
    const album = normalizeAlbum({
      id,
      name: albumRow.name as string,
      kind: albumRow.kind,
      search: albumRow.search,
    });
    logger.info("deleteAlbum", { id, name: album.name, kind: album.kind });

    // A smart album has no per-item membership tag to cascade — its members
    // are just whatever currently matches its saved search.
    let removedCount = 0;
    if (album.kind === "manual") {
      // ── 2. Enumerate member entry IDs from the V2 index ────────────────
      // Membership is keyed by album ID (`va#<id>`), a single partition —
      // project only `id` so the round-trip stays small.
      const pk = searchPartitionKey(TAG_VIRTUAL_ALBUM, id);
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

      logger.info("deleteAlbum cascade plan", { id, memberCount: memberIds.size });

      // ── 3. Remove the membership tag from each member entry ───────────
      // Read-modify-write per item: read tags, filter out the matching one,
      // write back. DynamoDB has no list-element-remove-by-predicate operator,
      // so the read is unavoidable. We dispatch in concurrency-limited batches
      // to keep write pressure bounded.
      const ids = [...memberIds];

      const removeFromOne = async (entryId: string): Promise<void> => {
        const { Item } = await dynamoDBService.getCommand({
          TableName: metaTableName,
          Key: { id: entryId },
        });
        if (!Item) return; // already deleted from meta
        const tags = (Item.tags ?? []) as Array<{ key: string; value: string }>;
        const filtered = tags.filter(
          (t) => !(t.key === TAG_VIRTUAL_ALBUM && t.value === id),
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

    logger.info("deleteAlbum complete", { id, name: album.name, removedCount });

    return json(200, {
      id,
      name: album.name,
      removedFromCount: removedCount,
    });
  };
