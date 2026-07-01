import { jest } from "@jest/globals";
/**
 * Tests for the list-folder Lambda handler.
 *
 * Focus: pagination correctness when hidden items are filtered out — this
 * was previously broken (the handler returned `pageSize` raw items minus
 * hidden ones, producing inconsistent page sizes at the viewer).
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/list-folder/eventHandler";

type Item = { id: string; tags?: Array<{ key: string; value: string }> };

const TAG_HIDDEN = "ac:ediacara:hidden";

/**
 * Minimal in-memory fake of dynamoDBService.queryCommand.
 * Treats `items` as the partition; respects Limit and ExclusiveStartKey via
 * an integer index encoded in the key.
 */
const makeFakeQuery = (items: Item[]) =>
  jest.fn(async (params: any) => {
    const start = params.ExclusiveStartKey?.idx ?? 0;
    const limit = params.Limit ?? items.length;
    const slice = items.slice(start, start + limit);
    const next = start + slice.length;
    return {
      Items: slice,
      LastEvaluatedKey: next < items.length ? { idx: next } : undefined,
    };
  });

const invoke = async (
  query: ReturnType<typeof makeFakeQuery>,
  pathParams: Record<string, string>,
  qs: Record<string, string> = {}
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: { queryCommand: query } },
  } as any;
  const event: any = { pathParameters: pathParams, queryStringParameters: qs };
  const result = await (lambdaHandler as any)(event, ctx);
  return JSON.parse(result.body);
};

describe("list-folder", () => {
  it("returns all items when none are hidden", async () => {
    const items: Item[] = [
      { id: "a", tags: [] },
      { id: "b", tags: [] },
      { id: "c", tags: [] },
    ];
    const query = makeFakeQuery(items);
    const body = await invoke(query, { id: "media%2F" }, { pageSize: "10" });
    expect(body.entries.map((e: Item) => e.id)).toEqual(["a", "b", "c"]);
    expect(body.nextToken).toBeUndefined();
  });

  it("filters out hidden items", async () => {
    const items: Item[] = [
      { id: "a", tags: [] },
      { id: "b", tags: [{ key: TAG_HIDDEN, value: "true" }] },
      { id: "c", tags: [] },
    ];
    const query = makeFakeQuery(items);
    const body = await invoke(query, { id: "media%2F" }, { pageSize: "10" });
    expect(body.entries.map((e: Item) => e.id)).toEqual(["a", "c"]);
  });

  it("loops to fill pageSize when leading items are hidden", async () => {
    // First Query (Limit=3) returns 2 hidden + 1 visible → continue.
    // Second Query (Limit=2 remaining) returns 2 visible → done.
    const items: Item[] = [
      { id: "h1", tags: [{ key: TAG_HIDDEN, value: "true" }] },
      { id: "h2", tags: [{ key: TAG_HIDDEN, value: "true" }] },
      { id: "v1", tags: [] },
      { id: "v2", tags: [] },
      { id: "v3", tags: [] },
    ];
    const query = makeFakeQuery(items);
    const body = await invoke(query, { id: "media%2F" }, { pageSize: "3" });
    // Returns exactly pageSize visible items even though several were hidden.
    expect(body.entries.map((e: Item) => e.id)).toEqual(["v1", "v2", "v3"]);
    // More than one DynamoDB Query was issued because the first one came back short.
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });

  it("encodes nextToken in base64 when more results exist", async () => {
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({
      id: String.fromCharCode(97 + i),
      tags: [],
    }));
    const query = makeFakeQuery(items);
    const body = await invoke(query, { id: "media%2F" }, { pageSize: "3" });
    expect(body.entries.map((e: Item) => e.id)).toEqual(["a", "b", "c"]);
    expect(typeof body.nextToken).toBe("string");
    const decoded = JSON.parse(Buffer.from(body.nextToken, "base64").toString());
    expect(decoded).toEqual({ idx: 3 });
  });

  it("clamps pageSize to [1, 1000]", async () => {
    const items: Item[] = [{ id: "a", tags: [] }];
    const query = makeFakeQuery(items);
    await invoke(query, { id: "x" }, { pageSize: "0" });
    expect(query.mock.calls[0][0].Limit).toBe(1);
    query.mockClear();
    await invoke(query, { id: "x" }, { pageSize: "9999" });
    expect(query.mock.calls[0][0].Limit).toBe(1000);
  });

  it("normalizes folder id by appending trailing slash", async () => {
    const query = makeFakeQuery([]);
    await invoke(query, { id: "media%2F2024%2F08" });
    expect(query.mock.calls[0][0].ExpressionAttributeValues).toMatchObject({
      ":folder": "media/2024/08/",
    });
  });
});