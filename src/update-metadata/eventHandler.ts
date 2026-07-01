import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { validateTagsInput } from "../shared/tagValidation.js";
import { hasHiddenTag, requireAdmin } from "../shared/auth.js";
import { collectFolderTree, FolderQueryClient } from "../shared/folderTree.js";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

const SYSTEM_TAU_PREFIX = "ac:tau:";

// Concurrent DynamoDB write pressure cap for the folder→items tag cascade.
// Matches src/hide-folder/eventHandler.ts (well below the table's burst WCU).
const CASCADE_CONCURRENCY = 25;

type Tag = { key: string; value: string };
const sameTag = (a: Tag, b: Tag) => a.key === b.key && a.value === b.value;

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

    // ── Folder tag propagation ────────────────────────────────────────────
    // Editing a FOLDER's tags cascades the change to every item inside it,
    // recursively through subfolders: tags added to the folder are added to
    // each descendant, tags removed from the folder are removed from each.
    // Folder ids carry a trailing slash, so that is the folder test. Descendants
    // are found by walking the `by-folder` GSI. Only user tags cascade —
    // ac:tau:* system tags were
    // already stripped from `userTags` by validateTagsInput, and each item's
    // own system tags are preserved untouched. Cascaded writes flow through
    // the meta-table stream → search reindex, same as hide-folder/bulk-tag.
    let cascadedCount = 0;
    if (id.endsWith("/")) {
      const oldUserTags = existingTags.filter(
        (t) => !t.key.startsWith(SYSTEM_TAU_PREFIX),
      );
      const added = userTags.filter((n) => !oldUserTags.some((o) => sameTag(o, n)));
      const removed = oldUserTags.filter((o) => !userTags.some((n) => sameTag(o, n)));

      if (added.length || removed.length) {
        // Walk the `by-folder` GSI for all descendants (markers + items),
        // reading only the subtree instead of Scanning the whole table. The
        // walk returns descendants only (never the folder's own marker, whose
        // tags were just written above), matching the prior Scan-minus-self.
        const matches: Array<{ id: string; tags: Tag[] }> = await collectFolderTree(
          dynamoDBService as unknown as FolderQueryClient,
          metaTableName,
          id,
          { includeMarkers: true },
        );

        logger.info("updateMetadata folder cascade", {
          id,
          added: added.length,
          removed: removed.length,
          descendants: matches.length,
        });

        const applyToOne = async ({ id: itemId, tags }: { id: string; tags: Tag[] }) => {
          let next = removed.length
            ? tags.filter((t) => !removed.some((r) => sameTag(r, t)))
            : tags;
          for (const a of added) {
            if (!next.some((t) => sameTag(t, a))) next = [...next, a];
          }
          // Only write when the tag set actually changed (avoids needless
          // writes and stream/reindex churn on items that already match).
          if (next.length === tags.length && next.every((t, i) => sameTag(t, tags[i]))) {
            return;
          }
          await dynamoDBService.updateCommand({
            TableName: metaTableName,
            Key: { id: itemId },
            UpdateExpression: "SET tags = :tags",
            ExpressionAttributeValues: { ":tags": next },
          });
          cascadedCount++;
        };

        for (let i = 0; i < matches.length; i += CASCADE_CONCURRENCY) {
          await Promise.all(matches.slice(i, i + CASCADE_CONCURRENCY).map(applyToOne));
        }

        logger.info("updateMetadata folder cascade complete", { id, cascadedCount });
      }
    }

    return json(200, {
      id: updated?.id ?? id,
      tags: updated?.tags ?? finalTags,
      ...(id.endsWith("/") ? { cascadedCount } : {}),
    });
  };
