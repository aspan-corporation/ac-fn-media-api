/**
 * Tests for the search Lambda handler.
 *
 * Focus:
 *   - intersection of multiple tag filters (AND semantics)
 *   - hidden filter excludes items at the end
 *   - sort-by-selectivity short-circuits on disjoint tag sets
 *   - BatchGetItem fetches only the page (not the whole match set)
 */

process.env.AC_TAU_MEDIA_SEARCH_TABLE_NAME = "test-search";
process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/search/eventHandler";

const TAG_HIDDEN = "ac:ediacara:hidden";

type SearchRow = { id: string; key: string; value: string };

/**
 * In-memory fake of the search table.
 * Each row is `{id, key, value}`. Query returns all rows for a given `key`,
 * optionally filtered by `value`.
 */
const makeFakeSearchTable = (rows: SearchRow[]) => {
  const queryCommand = jest.fn(async (params: any) => {
    const key = params.ExpressionAttributeValues[":key"];
    const value = params.ExpressionAttributeValues?.[":value"];
    const matched = rows.filter(
      (r) => r.key === key && (value === undefined || r.value === value)
    );
    return { Items: matched.map(({ id }) => ({ id })) };
  });
  return queryCommand;
};

/**
 * In-memory fake of the meta table for BatchGet.
 */
const makeFakeMetaTable = (
  meta: Map<string, Array<{ key: string; value: string }>>
) =>
  jest.fn(async (params: any) => {
    const tableName = Object.keys(params.RequestItems)[0];
    const keys: Array<{ id: string }> = params.RequestItems[tableName].Keys;
    return {
      Responses: {
        [tableName]: keys.map(({ id }) => ({ id, tags: meta.get(id) ?? [] })),
      },
    };
  });

const invoke = async (
  searchTable: ReturnType<typeof makeFakeSearchTable>,
  metaTable: ReturnType<typeof makeFakeMetaTable> | null,
  body: any
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: {
      dynamoDBService: {
        queryCommand: searchTable,
        batchGetCommand: metaTable ?? jest.fn(),
      },
    },
  } as any;
  const event: any = { body: JSON.stringify(body) };
  const result = await (lambdaHandler as any)(event, ctx);
  return { result, parsed: JSON.parse(result.body) };
};

describe("search", () => {
  it("returns 400 when searchInput.filter.tags is missing", async () => {
    const search = makeFakeSearchTable([]);
    const { result } = await invoke(search, null, {});
    expect(result.statusCode).toBe(400);
  });

  it("intersects multiple tag filters (AND)", async () => {
    const rows: SearchRow[] = [
      { id: "p1", key: "ac:tau:yearCreated", value: "2010" },
      { id: "p2", key: "ac:tau:yearCreated", value: "2010" },
      { id: "p3", key: "ac:tau:yearCreated", value: "2010" },
      { id: "p1", key: "ac:tau:monthCreated", value: "3" },
      { id: "p3", key: "ac:tau:monthCreated", value: "3" },
    ];
    const search = makeFakeSearchTable(rows);
    const meta = makeFakeMetaTable(new Map([
      ["p1", [{ key: "x", value: "y" }]],
      ["p3", []],
    ]));
    const { parsed } = await invoke(search, meta, {
      searchInput: {
        filter: {
          tags: [
            { key: "ac:tau:yearCreated", value: "2010" },
            { key: "ac:tau:monthCreated", value: "3" },
          ],
        },
      },
      pageSize: 10,
    });
    expect(parsed.entries.map((e: any) => e.id).sort()).toEqual(["p1", "p3"]);
  });

  it("excludes items tagged hidden", async () => {
    const rows: SearchRow[] = [
      { id: "p1", key: "ac:ediacara:favorite", value: "" },
      { id: "p2", key: "ac:ediacara:favorite", value: "" },
      { id: "p2", key: TAG_HIDDEN, value: "true" },
    ];
    const search = makeFakeSearchTable(rows);
    const meta = makeFakeMetaTable(new Map([["p1", []]]));
    const { parsed } = await invoke(search, meta, {
      searchInput: { filter: { tags: [{ key: "ac:ediacara:favorite", value: "" }] } },
      pageSize: 10,
    });
    expect(parsed.entries.map((e: any) => e.id)).toEqual(["p1"]);
  });

  it("short-circuits when tag sets are disjoint", async () => {
    const rows: SearchRow[] = [
      { id: "p1", key: "ac:tau:yearCreated", value: "2010" },
      { id: "p9", key: "ac:tau:yearCreated", value: "2024" },
    ];
    const search = makeFakeSearchTable(rows);
    const meta = makeFakeMetaTable(new Map());
    const { parsed } = await invoke(search, meta, {
      searchInput: {
        filter: {
          tags: [
            { key: "ac:tau:yearCreated", value: "2010" },
            { key: "ac:tau:yearCreated", value: "2024" },
          ],
        },
      },
      pageSize: 10,
    });
    expect(parsed.entries).toEqual([]);
    // Hidden Query NOT issued because we short-circuited before that step.
    expect(search.mock.calls.length).toBe(2); // two tag queries only
  });

  it("BatchGet only fetches page-sized slice of meta", async () => {
    // 50 matching photos; pageSize=5 should fetch only 5 from meta.
    const rows: SearchRow[] = Array.from({ length: 50 }, (_, i) => ({
      id: `p${String(i).padStart(3, "0")}`,
      key: "ac:ediacara:favorite",
      value: "",
    }));
    const search = makeFakeSearchTable(rows);
    const meta = makeFakeMetaTable(new Map(rows.map((r) => [r.id, []])));
    const { parsed } = await invoke(search, meta, {
      searchInput: { filter: { tags: [{ key: "ac:ediacara:favorite", value: "" }] } },
      pageSize: 5,
    });
    expect(parsed.entries).toHaveLength(5);
    // BatchGet was issued once with 5 keys.
    expect(meta.mock.calls).toHaveLength(1);
    const keys = meta.mock.calls[0][0].RequestItems["test-meta"].Keys;
    expect(keys).toHaveLength(5);
  });
});
