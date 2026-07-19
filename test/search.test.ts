import { jest } from "@jest/globals";
/**
 * Tests for the reshaped search Lambda (SearchTableV2, date-ordered).
 *
 * The V2 table is keyed pk=`key#value`, sk=`sortDate#id`. A search Query hits
 * one partition, descending by sk (newest-first), with native ExclusiveStartKey
 * pagination. The handler merges the per-tag partition streams:
 *   - intersect (AND) for filter tags,
 *   - union for whole-library browse (no tags),
 * excludes the hidden partition, and returns a `nextToken` = the last emitted
 * `sk` (base64) so scrolling resumes exactly where it left off.
 */

process.env.AC_TAU_MEDIA_SEARCH_TABLE_NAME = "test-search-v2";
process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/search/eventHandler";

const TAG_HIDDEN = "ac:ediacara:hidden";
const sep = "#";

type V2Row = { pk: string; sk: string; id: string };

/** Build a V2 row for (key,value) with a given item id + ISO date. */
const row = (key: string, value: string, id: string, date: string): V2Row => ({
  pk: `${key}${sep}${value}`,
  sk: `${date}${sep}${id}`,
  id,
});

/**
 * In-memory fake of SearchTableV2's Query: returns rows for one `pk`,
 * descending by `sk`, honoring Limit + ExclusiveStartKey (exclusive, desc).
 */
const makeFakeSearchTable = (rows: V2Row[]) => {
  const queryCommand = jest.fn(async (params: any) => {
    const pk = params.ExpressionAttributeValues[":pk"];
    let matched = rows
      .filter((r) => r.pk === pk)
      .sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0)); // desc
    const esk = params.ExclusiveStartKey;
    if (esk) matched = matched.filter((r) => r.sk < esk.sk);
    const limit = params.Limit ?? matched.length;
    const page = matched.slice(0, limit);
    const last = page[page.length - 1];
    const more = matched.length > limit;
    return {
      Items: page.map((r) => ({ id: r.id, sk: r.sk })),
      ...(more && last ? { LastEvaluatedKey: { pk, sk: last.sk } } : {}),
    };
  });
  return queryCommand;
};

const makeFakeMetaTable = (
  meta: Map<string, Array<{ key: string; value: string }>>,
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
  body: any,
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

const metaFor = (ids: string[]) =>
  makeFakeMetaTable(new Map(ids.map((id) => [id, []])));

describe("search (V2 date-ordered)", () => {
  it("returns 400 when searchInput.filter.tags is missing", async () => {
    const { result } = await invoke(makeFakeSearchTable([]), null, {});
    expect(result.statusCode).toBe(400);
  });

  it("returns a single tag's matches newest-first", async () => {
    const rows = [
      row("ac:tau:favorite", "", "a", "2008-01-01T00:00:00.000Z"),
      row("ac:tau:favorite", "", "b", "2020-01-01T00:00:00.000Z"),
      row("ac:tau:favorite", "", "c", "2014-01-01T00:00:00.000Z"),
    ];
    const { parsed } = await invoke(makeFakeSearchTable(rows), metaFor(["a", "b", "c"]), {
      searchInput: { filter: { tags: [{ key: "ac:tau:favorite", value: "" }] } },
      pageSize: 10,
    });
    // Newest → oldest, regardless of id order.
    expect(parsed.entries.map((e: any) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("intersects multiple tag filters (AND) keeping date order", async () => {
    // Same item has the SAME sk in every partition it belongs to.
    const d1 = "2010-03-05T00:00:00.000Z";
    const d3 = "2010-03-20T00:00:00.000Z";
    const rows = [
      row("ac:tau:yearCreated", "2010", "p1", d1),
      row("ac:tau:yearCreated", "2010", "p2", "2010-06-01T00:00:00.000Z"),
      row("ac:tau:yearCreated", "2010", "p3", d3),
      row("ac:tau:monthCreated", "3", "p1", d1),
      row("ac:tau:monthCreated", "3", "p3", d3),
    ];
    const { parsed } = await invoke(makeFakeSearchTable(rows), metaFor(["p1", "p3"]), {
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
    // p3 (Mar 20) before p1 (Mar 05); p2 excluded (not in March).
    expect(parsed.entries.map((e: any) => e.id)).toEqual(["p3", "p1"]);
  });

  it("excludes items in the hidden partition", async () => {
    const rows = [
      row("ac:tau:favorite", "", "p1", "2021-01-01T00:00:00.000Z"),
      row("ac:tau:favorite", "", "p2", "2022-01-01T00:00:00.000Z"),
      row(TAG_HIDDEN, "true", "p2", "2022-01-01T00:00:00.000Z"),
    ];
    const { parsed } = await invoke(makeFakeSearchTable(rows), metaFor(["p1"]), {
      searchInput: { filter: { tags: [{ key: "ac:tau:favorite", value: "" }] } },
      pageSize: 10,
    });
    expect(parsed.entries.map((e: any) => e.id)).toEqual(["p1"]);
  });

  it("returns empty for a disjoint intersection", async () => {
    const rows = [
      row("ac:tau:yearCreated", "2010", "p1", "2010-01-01T00:00:00.000Z"),
      row("ac:tau:yearCreated", "2024", "p9", "2024-01-01T00:00:00.000Z"),
    ];
    const { parsed } = await invoke(makeFakeSearchTable(rows), metaFor([]), {
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
  });

  it("browses the whole library (no tags) as a union of media-type partitions, newest-first", async () => {
    const rows = [
      row("ac:tau:type", "photo", "ph", "2019-01-01T00:00:00.000Z"),
      row("ac:tau:type", "video", "vi", "2023-01-01T00:00:00.000Z"),
      row("ac:tau:type", "audio", "au", "2010-01-01T00:00:00.000Z"),
      row("ac:diary:entry", "true", "di", "2025-01-01T00:00:00.000Z"),
    ];
    const { parsed } = await invoke(
      makeFakeSearchTable(rows),
      metaFor(["di", "vi", "ph", "au"]),
      { searchInput: { filter: { tags: [] } }, pageSize: 10 },
    );
    expect(parsed.entries.map((e: any) => e.id)).toEqual(["di", "vi", "ph", "au"]);
  });

  it("paginates via nextToken cursor without gaps or duplicates", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row(
        "ac:tau:favorite",
        "",
        `p${i}`,
        `20${10 + i}-01-01T00:00:00.000Z`, // 2010..2014
      ),
    );
    const search = makeFakeSearchTable(rows);
    const body = (nextToken?: string) => ({
      searchInput: { filter: { tags: [{ key: "ac:tau:favorite", value: "" }] } },
      pageSize: 2,
      ...(nextToken ? { nextToken } : {}),
    });

    const seen: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 5; i++) {
      const { parsed } = await invoke(search, metaFor(rows.map((r) => r.id)), body(token));
      seen.push(...parsed.entries.map((e: any) => e.id));
      token = parsed.nextToken;
      if (!token) break;
    }
    // 2014..2010 newest-first, each seen exactly once across pages.
    expect(seen).toEqual(["p4", "p3", "p2", "p1", "p0"]);
  });

  it("BatchGets only the page-sized slice of meta", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row("ac:tau:favorite", "", `p${String(i).padStart(3, "0")}`, `2000-01-01T00:00:0${i % 10}.000Z`),
    );
    const meta = metaFor(rows.map((r) => r.id));
    const { parsed } = await invoke(makeFakeSearchTable(rows), meta, {
      searchInput: { filter: { tags: [{ key: "ac:tau:favorite", value: "" }] } },
      pageSize: 5,
    });
    expect(parsed.entries).toHaveLength(5);
    expect(meta.mock.calls).toHaveLength(1);
    expect(meta.mock.calls[0][0].RequestItems["test-meta"].Keys).toHaveLength(5);
  });
});
