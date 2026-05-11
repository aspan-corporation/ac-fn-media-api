import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";

// Local typing for batchGetCommand until ac-shared publishes the new method.
// Removed once ac-shared >= 1.2.27 is in the dependency manifest.
type BatchGetCapableDynamoDB = NonNullable<AcContext["acServices"]>["dynamoDBService"] & {
  batchGetCommand(input: {
    RequestItems: Record<string, { Keys: Array<Record<string, unknown>>; ProjectionExpression?: string }>;
  }): Promise<{
    Responses?: Record<string, Array<Record<string, unknown>>>;
    UnprocessedKeys?: Record<string, { Keys: Array<Record<string, unknown>> }>;
  }>;
};
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { findTokenIndex } from "./findTokenIndex.js";
import { FolderConnection, MetaData, SearchInput } from "../shared/types.js";

const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

// DynamoDB BatchGetItem caps at 100 keys per request.
const BATCH_GET_LIMIT = 100;

/**
 * Query the search table for one tag, paginating until we have all matching
 * IDs. Returns a Set so the caller can do O(1) intersections.
 */
const queryIdsForTag = async (
  dynamoDBService: BatchGetCapableDynamoDB,
  key: string,
  value?: string
): Promise<Set<string>> => {
  assert(dynamoDBService, "dynamoDBService is required");
  const ids = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await dynamoDBService.queryCommand({
      TableName: searchTableName,
      KeyConditionExpression: "#key = :key",
      ...(value
        ? { FilterExpression: "#value = :value" }
        : {}),
      ExpressionAttributeNames: {
        "#key": "key",
        ...(value ? { "#value": "value" } : {}),
      },
      ExpressionAttributeValues: {
        ":key": key,
        ...(value ? { ":value": value } : {}),
      },
      ProjectionExpression: "id",
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    for (const item of Items ?? []) {
      if (typeof item.id === "string") ids.add(item.id);
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return ids;
};

const intersect = (a: Set<string>, b: Set<string>): Set<string> => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const result = new Set<string>();
  for (const id of small) if (large.has(id)) result.add(id);
  return result;
};

const batchGetMeta = async (
  dynamoDBService: BatchGetCapableDynamoDB,
  ids: string[]
): Promise<MetaData[]> => {
  assert(dynamoDBService, "dynamoDBService is required");
  if (ids.length === 0) return [];

  const results: MetaData[] = [];
  // Preserve input order so the response matches the caller's pagination expectation.
  const indexById = new Map(ids.map((id, i) => [id, i]));
  const unordered: MetaData[] = [];

  for (let i = 0; i < ids.length; i += BATCH_GET_LIMIT) {
    const slice = ids.slice(i, i + BATCH_GET_LIMIT);
    let unprocessed: string[] = slice;
    let attempts = 0;
    while (unprocessed.length > 0 && attempts < 5) {
      const { Responses, UnprocessedKeys } = await dynamoDBService.batchGetCommand({
        RequestItems: {
          [metaTableName]: {
            Keys: unprocessed.map((id) => ({ id })),
            ProjectionExpression: "id, tags",
          },
        },
      });

      for (const item of (Responses?.[metaTableName] ?? []) as Array<{
        id: string;
        tags?: Array<{ key: string; value: string }>;
      }>) {
        unordered.push({ id: item.id, tags: item.tags ?? [] });
      }

      const next = (UnprocessedKeys?.[metaTableName]?.Keys ?? []) as Array<{ id: string }>;
      unprocessed = next.map((k) => k.id);
      attempts++;
      // Light backoff between retries on UnprocessedKeys.
      if (unprocessed.length > 0) await new Promise((r) => setTimeout(r, 50 * attempts));
    }
  }

  // Restore caller's order.
  unordered.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
  results.push(...unordered);
  return results;
};

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const dynamoDBService = acServices.dynamoDBService as BatchGetCapableDynamoDB | undefined;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    let parsedBody: { searchInput: SearchInput; pageSize: number; nextToken?: string };
    try {
      parsedBody = JSON.parse(event.body ?? "{}");
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }

    const { searchInput, pageSize, nextToken } = parsedBody;
    if (!searchInput || !searchInput.filter || !Array.isArray(searchInput.filter.tags)) {
      return json(400, { message: "searchInput.filter.tags is required" });
    }
    const safePageSize = Math.max(1, Math.min(pageSize ?? 20, 1000));
    const tags = searchInput.filter.tags;

    // ── 1. Query each tag → get candidate IDs as Sets ─────────────────
    // Run all per-tag Queries in parallel. Each returns the full set
    // because subsequent intersection requires complete sets, not pages.
    const candidateSets = tags.length === 0
      ? []
      : await Promise.all(tags.map(({ key, value }) => queryIdsForTag(dynamoDBService, key, value)));

    // ── 2. Sort by selectivity (smallest first) and intersect ────────
    // Smallest set first means the intersection runs through the fewest
    // candidates and short-circuits quickly when any pair is disjoint.
    candidateSets.sort((a, b) => a.size - b.size);

    let merged: Set<string> | null = null;
    for (const set of candidateSets) {
      if (merged === null) {
        merged = set;
      } else {
        merged = intersect(merged, set);
        if (merged.size === 0) break; // short-circuit on empty intersection
      }
    }

    // No filters → empty result (defensive — UI should always send at least one).
    if (merged === null || merged.size === 0) {
      return json(200, { entries: [] } as FolderConnection);
    }

    // ── 3. Filter out hidden via a single search-table Query ──────────
    const hiddenIds = await queryIdsForTag(dynamoDBService, TAG_HIDDEN);
    const visible: string[] = [];
    for (const id of merged) {
      if (!hiddenIds.has(id)) visible.push(id);
    }
    if (visible.length === 0) {
      return json(200, { entries: [] } as FolderConnection);
    }

    // ── 4. Paginate the ID list, then BatchGetItem only the page ──────
    // Stable order matters for nextToken correctness: sort lexicographically.
    visible.sort();
    const idEntries = visible.map((id) => ({ id }));
    const { startingIndex, newNextToken } = findTokenIndex({
      entries: idEntries,
      pageSize: safePageSize,
      token: nextToken,
    });
    logger.debug("FindTokenIndexResult", { startingIndex, newNextToken });

    const pageIds = visible.slice(startingIndex, startingIndex + safePageSize);
    const finalResult = await batchGetMeta(dynamoDBService, pageIds);

    return json(200, {
      entries: finalResult,
      ...(newNextToken ? { nextToken: newNextToken } : {}),
    } as FolderConnection);
  };
