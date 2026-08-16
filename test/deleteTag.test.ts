import { jest } from "@jest/globals";
/**
 * Tests for delete-tag:
 *   - admin-only;
 *   - enumerates every item carrying the (key, value) tag via a single
 *     SearchTableV2 `key#value` partition Query (the same partition `search`
 *     itself reads), removes just that tag from each item's tags array, and
 *     deletes the tag's own row from the tags catalog;
 *   - idempotent (an item whose tag is already gone is skipped without a
 *     write; deleting an already-absent catalog row is a no-op).
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_TAU_MEDIA_SEARCH_TABLE_NAME = "test-search-v2";
process.env.AC_TAGS_TABLE_NAME = "test-tags";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/delete-tag/eventHandler";

const adminEvent = (
  body: unknown,
  overrides: Record<string, unknown> = {},
) => ({
  body: JSON.stringify(body),
  requestContext: { authorizer: { claims: { "cognito:groups": "admin" } } },
  ...overrides,
});

const invoke = async (
  event: any,
  {
    searchRows = [],
    metaTags = new Map<string, Array<{ key: string; value: string }>>(),
  }: {
    searchRows?: Array<{ id: string }>;
    metaTags?: Map<string, Array<{ key: string; value: string }>>;
  } = {},
) => {
  const getCommand = jest.fn(async (input: any) => {
    const id = input.Key.id as string;
    return metaTags.has(id) ? { Item: { id, tags: metaTags.get(id) } } : {};
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

describe("delete-tag", () => {
  it("rejects a non-admin caller", async () => {
    const { status } = await invoke({
      body: JSON.stringify({ key: "Location", value: "Paris" }),
      requestContext: { authorizer: { claims: {} } },
    });
    expect(status).toBe(403);
  });

  it("400s on a missing key", async () => {
    const { status, body } = await invoke(adminEvent({ value: "Paris" }));
    expect(status).toBe(400);
    expect(body.message).toMatch(/key/i);
  });

  it("400s on invalid JSON", async () => {
    const { status } = await invoke({
      body: "not json",
      requestContext: { authorizer: { claims: { "cognito:groups": "admin" } } },
    });
    expect(status).toBe(400);
  });

  it("removes the tag from every matching item and deletes the catalog row", async () => {
    const { status, body, queryCommand, updateCommand, send } = await invoke(
      adminEvent({ key: "Location", value: "Paris" }),
      {
        searchRows: [{ id: "media/a.jpg" }, { id: "media/b.jpg" }],
        metaTags: new Map([
          [
            "media/a.jpg",
            [
              { key: "Location", value: "Paris" },
              { key: "ac:tau:country", value: "France" },
            ],
          ],
          ["media/b.jpg", [{ key: "Location", value: "Paris" }]],
        ]),
      },
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      key: "Location",
      value: "Paris",
      removedFromCount: 2,
    });

    // Queried by the exact key#value partition — same shape `search` reads.
    expect(queryCommand.mock.calls[0][0].ExpressionAttributeValues[":pk"]).toBe(
      "Location#Paris",
    );

    // media/a.jpg keeps its other tag; media/b.jpg's tags empty out.
    const updatedA = updateCommand.mock.calls.find(
      (c: any) => c[0].Key.id === "media/a.jpg",
    )?.[0];
    expect(updatedA.ExpressionAttributeValues[":tags"]).toEqual([
      { key: "ac:tau:country", value: "France" },
    ]);

    // The catalog row delete, keyed the same way.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: "test-tags",
      Key: { "key#value": "Location#Paris" },
    });
  });

  it("still deletes the catalog row when no items carry the tag anymore", async () => {
    const { status, body, updateCommand, send } = await invoke(
      adminEvent({ key: "Event", value: "Reunion" }),
      { searchRows: [] },
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      key: "Event",
      value: "Reunion",
      removedFromCount: 0,
    });
    expect(updateCommand).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — an item whose tag is already gone is skipped without an update call", async () => {
    const { updateCommand } = await invoke(
      adminEvent({ key: "Location", value: "Paris" }),
      {
        searchRows: [{ id: "media/a.jpg" }],
        metaTags: new Map([
          ["media/a.jpg", [{ key: "ac:tau:favorite", value: "" }]],
        ]),
      },
    );
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it("deletes only the exact (key, value) pair, leaving other values of the same key untouched", async () => {
    const { updateCommand } = await invoke(
      adminEvent({ key: "Location", value: "Paris" }),
      {
        searchRows: [{ id: "media/a.jpg" }],
        metaTags: new Map([
          [
            "media/a.jpg",
            [
              { key: "Location", value: "Paris" },
              { key: "Location", value: "Tokyo" },
            ],
          ],
        ]),
      },
    );
    expect(
      updateCommand.mock.calls[0][0].ExpressionAttributeValues[":tags"],
    ).toEqual([{ key: "Location", value: "Tokyo" }]);
  });
});
