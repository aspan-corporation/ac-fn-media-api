import { jest } from "@jest/globals";
/**
 * Tests for delete-album:
 *   - manual albums cascade-remove the membership tag from every member,
 *     found via a single V2 `va#<id>` partition Query (id-keyed, not name);
 *   - smart albums have no per-item membership, so deletion skips the cascade
 *     entirely and just removes the album row.
 */

process.env.AC_ALBUMS_TABLE_NAME = "test-albums";
process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_TAU_MEDIA_SEARCH_TABLE_NAME = "test-search-v2";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/delete-album/eventHandler";

const adminEvent = (id: string, overrides: Record<string, unknown> = {}) => ({
  pathParameters: { id },
  requestContext: { authorizer: { claims: { "cognito:groups": "admin" } } },
  ...overrides,
});

const invoke = async (
  event: any,
  {
    album,
    searchRows = [],
    metaTags = new Map<string, Array<{ key: string; value: string }>>(),
  }: {
    album: Record<string, unknown> | undefined;
    searchRows?: Array<{ id: string }>;
    metaTags?: Map<string, Array<{ key: string; value: string }>>;
  },
) => {
  const getCommand = jest.fn(async (input: any) => {
    if (input.TableName === "test-albums") return { Item: album };
    if (input.TableName === "test-meta") {
      const id = input.Key.id as string;
      return metaTags.has(id) ? { Item: { id, tags: metaTags.get(id) } } : {};
    }
    return {};
  });
  const queryCommand = jest.fn(async (_input: any) => ({ Items: searchRows }));
  const updateCommand = jest.fn(async (_input: any) => ({}));
  const send = jest.fn(async (_cmd: any) => ({}));

  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: {
      dynamoDBService: {
        getCommand,
        queryCommand,
        updateCommand,
        documentClient: { send },
      },
    },
  } as any;

  const result = await (lambdaHandler as any)(event, ctx);
  return {
    status: result.statusCode,
    body: JSON.parse(result.body),
    getCommand,
    queryCommand,
    updateCommand,
    send,
  };
};

describe("delete-album", () => {
  it("rejects a non-admin caller", async () => {
    const { status } = await invoke(
      { pathParameters: { id: "1" }, requestContext: { authorizer: { claims: {} } } },
      { album: { id: "1", name: "x", kind: "manual" } },
    );
    expect(status).toBe(403);
  });

  it("404s when the album doesn't exist", async () => {
    const { status } = await invoke(adminEvent("missing"), { album: undefined });
    expect(status).toBe(404);
  });

  it("cascades a manual album's membership tag via a single va#<id> partition query", async () => {
    const { status, body, queryCommand, updateCommand, send } = await invoke(
      adminEvent("album-1"),
      {
        album: { id: "album-1", name: "Holidays", kind: "manual" },
        searchRows: [{ id: "media/a.jpg" }, { id: "media/b.jpg" }],
        metaTags: new Map([
          [
            "media/a.jpg",
            [{ key: "ac:ediacara:va", value: "album-1" }, { key: "ac:tau:favorite", value: "" }],
          ],
          ["media/b.jpg", [{ key: "ac:ediacara:va", value: "album-1" }]],
        ]),
      },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ id: "album-1", name: "Holidays", removedFromCount: 2 });

    // Queried by album ID, not name — a single pk partition.
    expect(queryCommand.mock.calls[0][0].ExpressionAttributeValues[":pk"]).toBe(
      "ac:ediacara:va#album-1",
    );

    // media/a.jpg keeps its other tag; media/b.jpg's tags empty out.
    const updatedA = updateCommand.mock.calls.find(
      (c: any) => c[0].Key.id === "media/a.jpg",
    )?.[0];
    expect(updatedA.ExpressionAttributeValues[":tags"]).toEqual([
      { key: "ac:tau:favorite", value: "" },
    ]);

    expect(send).toHaveBeenCalledTimes(1); // the album row DeleteCommand
  });

  it("skips the cascade entirely for a smart album — no query, no update, just the row delete", async () => {
    const { status, body, queryCommand, updateCommand, send } = await invoke(
      adminEvent("album-2"),
      {
        album: {
          id: "album-2",
          name: "France",
          kind: "smart",
          search: { tags: [{ key: "ac:tau:country", value: "France" }], mediaType: "all" },
        },
      },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ id: "album-2", name: "France", removedFromCount: 0 });
    expect(queryCommand).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a member whose tag is already gone is skipped without an update call", async () => {
    const { updateCommand } = await invoke(adminEvent("album-1"), {
      album: { id: "album-1", name: "Holidays", kind: "manual" },
      searchRows: [{ id: "media/a.jpg" }],
      metaTags: new Map([["media/a.jpg", [{ key: "ac:tau:favorite", value: "" }]]]), // va tag already absent
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });
});
