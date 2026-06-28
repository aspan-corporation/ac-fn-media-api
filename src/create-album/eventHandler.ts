import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { randomUUID } from "node:crypto";

const albumsTableName = assertEnvVar("AC_ALBUMS_TABLE_NAME");

type Tag = { key: string; value: string };
type SavedSearch = { tags: Tag[]; mediaType: "both" | "pictures" | "videos" };

const MEDIA_TYPES = new Set(["both", "pictures", "videos"]);

/**
 * Validate an optional saved-search payload for a "synthetic" album. Returns the
 * cleaned search or null if absent/invalid (invalid → treated as a plain album).
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
  const mediaType = MEDIA_TYPES.has(r.mediaType as string)
    ? (r.mediaType as SavedSearch["mediaType"])
    : "both";
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

    // Optional saved search → a "synthetic" album defined by search params
    // rather than per-item membership tags.
    const search = parseSearch(body.search);

    const id = randomUUID();
    logger.info("createAlbum", { id, name, synthetic: Boolean(search) });

    await dynamoDBService.putCommand({
      TableName: albumsTableName,
      Item: { id, name, ...(search ? { search } : {}) },
    });

    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, ...(search ? { search } : {}) }),
    };
  };
