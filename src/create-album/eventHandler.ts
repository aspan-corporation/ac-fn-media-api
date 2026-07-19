import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { TAG_VIRTUAL_ALBUM } from "../shared/albumTags.js";
import type { AlbumKind, MediaType, SavedSearch } from "../shared/types.js";

const albumsTableName = assertEnvVar("AC_ALBUMS_TABLE_NAME");

type Tag = { key: string; value: string };

// Bug fixed here: this used to be `["both", "pictures", "videos"]` — a smart
// album saved with the "diary" or "audio" media type failed validation and
// silently fell back to "both" (now "all"), dropping the type filter entirely.
const MEDIA_TYPES = new Set<MediaType>(["all", "photo", "video", "audio", "diary"]);

/**
 * Validate an optional saved-search payload for a "smart" album. Returns the
 * cleaned search or null if absent/invalid (invalid → treated as a manual album).
 */
const parseSearch = (raw: unknown): SavedSearch | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tags)) return null;
  const tags: Tag[] = [];
  for (const t of r.tags) {
    if (t && typeof t === "object" &&
        typeof (t as Tag).key === "string" &&
        typeof (t as Tag).value === "string") {
      tags.push({ key: (t as Tag).key, value: (t as Tag).value });
    } else {
      return null;
    }
  }
  if (tags.length === 0) return null;
  // Legacy persisted albums may still carry the old "both" sentinel; map it
  // forward so old data keeps working under the renamed "all".
  const rawMediaType = r.mediaType === "both" ? "all" : r.mediaType;
  const mediaType = MEDIA_TYPES.has(rawMediaType as MediaType)
    ? (rawMediaType as MediaType)
    : "all";
  return { tags, mediaType };
};

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    let body: { name?: string; search?: unknown };
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Invalid JSON body" }),
      };
    }

    const name = (body.name ?? "").trim();
    if (!name) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "name is required" }),
      };
    }

    // Optional saved search → a "smart" album defined by search params rather
    // than per-item membership tags.
    const providedSearch = parseSearch(body.search);
    const id = randomUUID();
    const kind: AlbumKind = providedSearch ? "smart" : "manual";
    // A manual album's search is synthesized: its single membership tag. This
    // is the ONLY thing that makes an item belong to a manual album — see
    // ac-cocobolo's ThumbActions/VirtualAlbumButton, which write
    // `{key: TAG_VIRTUAL_ALBUM, value: id}` onto member items directly.
    const search: SavedSearch =
      providedSearch ?? {
        tags: [{ key: TAG_VIRTUAL_ALBUM, value: id }],
        mediaType: "all",
      };

    logger.info("createAlbum", { id, name, kind });

    await dynamoDBService.putCommand({
      TableName: albumsTableName,
      Item: { id, name, kind, search },
    });

    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, kind, search }),
    };
  };
