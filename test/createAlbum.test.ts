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
      mediaType: "photo",
    };
    const { status, body, put } = await invoke({ name: "Faves in France", search });
    expect(status).toBe(201);
    expect(body.search).toEqual(search);
    expect(put.mock.calls[0][0].Item).toMatchObject({ name: "Faves in France", search });
  });

  // Regression: MEDIA_TYPES used to be `["both", "pictures", "videos"]`, so a
  // smart album saved with "diary" or "audio" failed validation and silently
  // fell back to "both" — dropping the type filter entirely. The full set of
  // real media types must round-trip unchanged.
  it.each(["photo", "video", "audio", "diary", "all"] as const)(
    "accepts mediaType %s unchanged",
    async (mediaType) => {
      const { body } = await invoke({
        name: "x",
        search: { tags: [{ key: "k", value: "v" }], mediaType },
      });
      expect(body.search.mediaType).toBe(mediaType);
    },
  );

  it("maps the legacy 'both' sentinel forward to 'all'", async () => {
    const { body } = await invoke({
      name: "legacy",
      search: { tags: [{ key: "k", value: "v" }], mediaType: "both" },
    });
    expect(body.search.mediaType).toBe("all");
  });

  it("defaults an unknown mediaType to 'all'", async () => {
    const { body } = await invoke({
      name: "x",
      search: { tags: [{ key: "k", value: "v" }], mediaType: "nope" },
    });
    expect(body.search.mediaType).toBe("all");
  });

  // Every album is now a saved search — an invalid/absent search doesn't mean
  // "no search", it means "manual album", whose search is SYNTHESIZED as its
  // own single membership-tag filter (value = the freshly generated album id).
  it("synthesizes a membership-tag search for an invalid/empty search (manual album)", async () => {
    const { body: a, put: putA } = await invoke({ name: "plain", search: { tags: [] } });
    expect(a.kind).toBe("manual");
    expect(a.search).toEqual({
      tags: [{ key: "ac:ediacara:va", value: a.id }],
      mediaType: "all",
    });
    expect(putA.mock.calls[0][0].Item.search).toEqual(a.search);

    const { body: b } = await invoke({ name: "plain2", search: { tags: [{ key: 1 }] } });
    expect(b.kind).toBe("manual");
    expect(b.search.tags).toEqual([{ key: "ac:ediacara:va", value: b.id }]);
  });

  it("creates a manual album (synthesized membership search) when no search is given", async () => {
    const { status, body } = await invoke({ name: "Holidays" });
    expect(status).toBe(201);
    expect(body).toEqual({
      id: expect.any(String),
      name: "Holidays",
      kind: "manual",
      search: {
        tags: [{ key: "ac:ediacara:va", value: body.id }],
        mediaType: "all",
      },
    });
  });

  it("rejects a missing name", async () => {
    const { status } = await invoke({ search: { tags: [{ key: "k", value: "v" }] } });
    expect(status).toBe(400);
  });
});