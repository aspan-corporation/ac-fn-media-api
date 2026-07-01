import { jest } from "@jest/globals";
/**
 * Tests for create-album, focused on "synthetic" albums (saved searches):
 * a valid `search` payload is stored on the item; an absent/invalid one is
 * ignored so the album is a plain membership album.
 */

process.env.AC_ALBUMS_TABLE_NAME = "test-albums";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/create-album/eventHandler";

const invoke = async (body: unknown) => {
  const put = jest.fn(async (_input: any) => ({}));
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: { putCommand: put } },
  } as any;
  const event: any = { body: JSON.stringify(body) };
  const result = await (lambdaHandler as any)(event, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body), put };
};

describe("create-album", () => {
  it("stores a valid saved search as a synthetic album", async () => {
    const search = {
      tags: [{ key: "ac:tau:country", value: "France" }, { key: "ac:ediacara:favorite", value: "" }],
      mediaType: "pictures",
    };
    const { status, body, put } = await invoke({ name: "Faves in France", search });
    expect(status).toBe(201);
    expect(body.search).toEqual(search);
    expect(put.mock.calls[0][0].Item).toMatchObject({ name: "Faves in France", search });
  });

  it("defaults an unknown mediaType to 'both'", async () => {
    const { body } = await invoke({
      name: "x",
      search: { tags: [{ key: "k", value: "v" }], mediaType: "nope" },
    });
    expect(body.search.mediaType).toBe("both");
  });

  it("ignores an invalid/empty search (plain album)", async () => {
    const { body: a, put: putA } = await invoke({ name: "plain", search: { tags: [] } });
    expect(a.search).toBeUndefined();
    expect(putA.mock.calls[0][0].Item.search).toBeUndefined();

    const { body: b } = await invoke({ name: "plain2", search: { tags: [{ key: 1 }] } });
    expect(b.search).toBeUndefined();
  });

  it("creates a plain album when no search is given", async () => {
    const { status, body } = await invoke({ name: "Holidays" });
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), name: "Holidays" });
  });

  it("rejects a missing name", async () => {
    const { status } = await invoke({ search: { tags: [{ key: "k", value: "v" }] } });
    expect(status).toBe(400);
  });
});