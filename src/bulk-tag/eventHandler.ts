import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { requireAdmin, TAG_HIDDEN } from "../shared/auth.js";
import { collectFolderTree, FolderQueryClient } from "../shared/folderTree.js";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const CASCADE_CONCURRENCY = 25;

// Keys whose presence implies hasDate=true. Setting any of these
// automatically ensures the hasDate sentinel is consistent.
const DATE_KEYS = new Set([
  "ac:tau:yearCreated",
  "ac:tau:monthCreated",
  "ac:tau:dayCreated",
]);

// Keys whose presence implies hasLocation=true.
const LOCATION_KEYS = new Set(["ac:tau:country"]);

/**
 * POST /api/metadata/bulk-tag
 *
 * Body: {
 *   ids:   string[]                          — list of item ids to update
 *   merge: Array<{ key: string; value: string }> — tags to set/overwrite
 * }
 *
 * Unlike PUT /api/metadata/{id}, this endpoint is allowed to write
 * `ac:tau:*` tags directly. This is intentional: it exists specifically to
 * let the user manually correct system metadata (country, date taken, …) on
 * old files that were never processed by the extractor or that have no EXIF.
 *
 * Merge semantics per item:
 *   - Existing tags whose key matches a key in `merge` are replaced.
 *   - All other existing tags (system or user) are preserved.
 *   - If any date keys are in `merge`, the `ac:tau:hasDate` sentinel is
 *     forced to "true" so the "undated" filter stops matching the file.
 *   - If any location keys are in `merge`, `ac:tau:hasLocation` is forced
 *     to "true" similarly.
 *
 * The handler is idempotent: re-running with the same payload writes the
 * same result.
 */
export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    // ── Parse + validate body ─────────────────────────────────────────────
    // Targets are EITHER an explicit `ids` list (≤500, e.g. multi-select) OR a
    // `folder` prefix, in which case the merge cascades to every media item
    // inside the folder recursively (used by the folder meta-edit quick assign).
    let ids: string[] = [];
    let merge: Array<{ key: string; value: string }>;
    let folderPrefix: string | null = null;

    try {
      const body = JSON.parse(event.body ?? "{}");

      if (!Array.isArray(body.merge) || body.merge.length === 0) {
        return json(400, { message: "body.merge must be a non-empty array" });
      }
      merge = body.merge.filter(
        (t: unknown) =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as any).key === "string" &&
          (t as any).key.trim() &&
          typeof (t as any).value === "string",
      );
      if (!merge.length) {
        return json(400, { message: "merge must contain valid entries" });
      }

      if (typeof body.folder === "string" && body.folder.trim()) {
        folderPrefix = body.folder.endsWith("/") ? body.folder : `${body.folder}/`;
      } else {
        if (!Array.isArray(body.ids) || body.ids.length === 0) {
          return json(400, { message: "body.ids or body.folder is required" });
        }
        if (body.ids.length > 500) {
          return json(400, { message: "body.ids must not exceed 500 items" });
        }
        ids = body.ids.filter((id: unknown) => typeof id === "string" && id.trim());
        if (!ids.length) {
          return json(400, { message: "ids must contain valid entries" });
        }
      }
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }

    // Writing the hidden tag (in bulk) is an admin-only operation. Other
    // bulk tag edits stay open to any signed-in member.
    if (merge.some((t) => t.key === TAG_HIDDEN)) {
      const denied = requireAdmin(event);
      if (denied) return denied;
    }

    // Folder mode: resolve the prefix to the media item ids inside it via the
    // `by-folder` GSI (reads only the subtree, not the whole table). Marker
    // rows (ids ending in "/") are excluded so date/country tags only land on
    // actual photos/videos, not folder rows (which would pollute date search).
    if (folderPrefix) {
      const items = await collectFolderTree(
        dynamoDBService as unknown as FolderQueryClient,
        metaTableName,
        folderPrefix,
        { includeMarkers: false },
      );
      for (const item of items) ids.push(item.id);
      logger.info("bulkTag folder cascade", { folderPrefix, matched: ids.length });
      if (!ids.length) return json(200, { updatedCount: 0 });
    }

    // ── Derive sentinel updates implied by the merge set ──────────────────
    const mergeKeys = new Set(merge.map((t) => t.key));
    const extraSentinels: Array<{ key: string; value: string }> = [];
    if ([...DATE_KEYS].some((k) => mergeKeys.has(k))) {
      extraSentinels.push({ key: "ac:tau:hasDate", value: "true" });
    }
    if ([...LOCATION_KEYS].some((k) => mergeKeys.has(k))) {
      extraSentinels.push({ key: "ac:tau:hasLocation", value: "true" });
    }

    // Full set of keys to overwrite (merge + auto-sentinels, deduped).
    const allMerge = [...merge];
    for (const sentinel of extraSentinels) {
      if (!mergeKeys.has(sentinel.key)) allMerge.push(sentinel);
    }
    const allMergeMap = new Map(allMerge.map((t) => [t.key, t.value]));

    logger.info("bulkTag", { idCount: ids.length, mergeKeys: [...allMergeMap.keys()] });

    // ── Apply to each item ─────────────────────────────────────────────────
    let updatedCount = 0;

    const applyToOne = async (id: string): Promise<void> => {
      const { Item } = await dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id },
      });
      if (!Item) return;

      const existing = (Item.tags ?? []) as Array<{ key: string; value: string }>;

      // Replace matching keys; preserve everything else.
      const merged = existing.map((t) =>
        allMergeMap.has(t.key) ? { key: t.key, value: allMergeMap.get(t.key)! } : t,
      );
      // Add keys that didn't exist at all.
      for (const [key, value] of allMergeMap) {
        if (!merged.some((t) => t.key === key)) {
          merged.push({ key, value });
        }
      }

      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id },
        UpdateExpression: "SET tags = :tags",
        ExpressionAttributeValues: { ":tags": merged },
      });
      updatedCount++;
    };

    for (let i = 0; i < ids.length; i += CASCADE_CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CASCADE_CONCURRENCY).map(applyToOne));
    }

    logger.info("bulkTag complete", { updatedCount });

    return json(200, { updatedCount });
  };
