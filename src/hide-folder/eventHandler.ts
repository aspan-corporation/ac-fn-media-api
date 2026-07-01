import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { requireAdmin } from "../shared/auth.js";
import { collectFolderTree, FolderQueryClient } from "../shared/folderTree.js";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

// Tag applied to hidden items. Must match ac-cocobolo/src/common/constants.ts:TAG_HIDDEN.
const TAG_HIDDEN = "ac:ediacara:hidden";

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

// Concurrent DynamoDB write pressure cap. 25 is well below the 500 WCU/s
// default burst for a small single-tenant table.
const CASCADE_CONCURRENCY = 25;

/**
 * POST /api/folders/{id}/hide
 *
 * Body: { hidden: boolean }
 *
 * Sets or clears the `ac:ediacara:hidden` tag on the folder entry AND every
 * item recursively inside it (identified by DynamoDB Scan with begins_with on
 * the `id` key).  This lets the Browse UI hide entire folder trees in a
 * single call.
 *
 * The handler is idempotent: setting hidden=true when the tag is already
 * present (or hidden=false when it's already absent) is a no-op for that item.
 *
 * Order of operations:
 *   1. Validate and normalise the folder prefix (must end with "/")
 *   2. Walk the `by-folder` GSI to collect the folder's own marker plus every
 *      item recursively inside it (projecting id + tags)
 *   3. For each item: modify the tags array and UpdateItem, throttled by
 *      CASCADE_CONCURRENCY
 *
 * Performance note: the previous implementation Scanned the whole meta table
 * (~91k rows) on every call and filtered client-side. The GSI walk reads only
 * the subtree under the prefix, cutting read cost by orders of magnitude for
 * anything but the root. The write fan-out (one UpdateItem per matching item)
 * dominates wall-clock time. With CASCADE_CONCURRENCY=25 and ~5 ms per
 * round-trip, 1000 items → ~200 ms — well within the 29-second API GW limit.
 */
export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    // Hiding/unhiding is an admin-only operation.
    const denied = requireAdmin(event);
    if (denied) return denied;

    // ── 1. Parse and validate inputs ─────────────────────────────────────
    const rawId = decodeURIComponent(event.pathParameters?.id ?? "");
    if (!rawId) return json(400, { message: "id is required" });

    // Normalise: folder prefix must end with "/" so begins_with is
    // unambiguous (e.g. "media/2023" must not match "media/20234/").
    const prefix = rawId.endsWith("/") ? rawId : `${rawId}/`;

    let hidden: boolean;
    try {
      const body = JSON.parse(event.body ?? "{}");
      if (typeof body.hidden !== "boolean") {
        return json(400, { message: "body.hidden must be a boolean" });
      }
      hidden = body.hidden;
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }

    logger.info("hideFolder", { prefix, hidden });

    // ── 2. Collect the folder subtree via the `by-folder` GSI ────────────
    // The walk reads only items under the prefix (not the whole table). It
    // returns the descendants; the folder's own marker (id === prefix) has its
    // parent as its `folder` value, so we fetch it directly and prepend it —
    // hiding it is what removes the folder from its parent's listing.
    // The read-modify-write below is non-transactional, but this is an
    // admin-only, low-frequency operation so the (negligible) race risk is the
    // same the previous scan-time-tags approach carried.
    type Tag = { key: string; value: string };
    const matches: Array<{ id: string; tags: Tag[] }> = await collectFolderTree(
      dynamoDBService as unknown as FolderQueryClient,
      metaTableName,
      prefix,
      { includeMarkers: true },
    );

    const { Item: selfMarker } = await dynamoDBService.getCommand({
      TableName: metaTableName,
      Key: { id: prefix },
    });
    if (selfMarker && typeof selfMarker.id === "string") {
      matches.unshift({ id: selfMarker.id, tags: (selfMarker.tags ?? []) as Tag[] });
    }

    logger.info("hideFolder walk complete", { prefix, matchingCount: matches.length });

    // ── 3. Apply hidden tag to each matching item ─────────────────────────
    let updatedCount = 0;

    const applyToOne = async ({ id, tags }: { id: string; tags: Tag[] }): Promise<void> => {
      const alreadyHidden = tags.some((t) => t.key === TAG_HIDDEN);

      if (hidden && alreadyHidden) return; // already hidden — no-op
      if (!hidden && !alreadyHidden) return; // already visible — no-op

      const nextTags = hidden
        ? [...tags, { key: TAG_HIDDEN, value: "true" }]
        : tags.filter((t) => t.key !== TAG_HIDDEN);

      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id },
        UpdateExpression: "SET tags = :tags",
        ExpressionAttributeValues: { ":tags": nextTags },
      });
      updatedCount++;
    };

    for (let i = 0; i < matches.length; i += CASCADE_CONCURRENCY) {
      const slice = matches.slice(i, i + CASCADE_CONCURRENCY);
      await Promise.all(slice.map(applyToOne));
    }

    logger.info("hideFolder complete", { prefix, hidden, updatedCount });

    return json(200, {
      prefix,
      hidden,
      matchedCount: matches.length,
      updatedCount,
    });
  };
