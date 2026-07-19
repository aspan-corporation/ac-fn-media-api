import { jest } from "@jest/globals";
/**
 * Tests for get-albums: every returned album always has {kind, search},
 * normalized via normalizeAlbum — including legacy rows written before the
 * manual/smart unification.
 */

process.env.AC_ALBUMS_TABLE_NAME = "test-albums";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/get-albums/eventHandler";

const invoke = async (items: Array<Record<string, unknown>>) => {
  const scan = jest.fn(async (_input: any) => ({ Items: items }));
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: { scanCommand: scan } },
  } as any;
  const event: any = { queryStringParameters: {} };
  const result = await (lambdaHandler as any)(event, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

describe("get-albums", () => {
  it("normalizes a legacy manual album row (no kind, no search)", async () => {
    const { body } = await invoke([{ id: "1", name: "Holidays" }]);
    expect(body.albums).toEqual([
      {
        id: "1",
        name: "Holidays",
        kind: "manual",
        search: {
          tags: [{ key: "ac:ediacara:va", value: "1" }],
          mediaType: "all",
        },
      },
    ]);
  });

  it("normalizes a legacy smart album row (search, no kind)", async () => {
    const { body } = await invoke([
      {
        id: "2",
        name: "France",
        search: { tags: [{ key: "ac:tau:country", value: "France" }], mediaType: "pictures" },
      },
    ]);
    expect(body.albums[0]).toEqual({
      id: "2",
      name: "France",
      kind: "smart",
      search: {
        tags: [{ key: "ac:tau:country", value: "France" }],
        mediaType: "all", // unrecognized legacy value falls back to "all"
      },
    });
  });

  it("passes through a current-shape row (kind + search already set) unchanged", async () => {
    const { body } = await invoke([
      {
        id: "3",
        name: "Audio diary",
        kind: "smart",
        search: { tags: [{ key: "ac:tau:type", value: "audio" }], mediaType: "audio" },
      },
    ]);
    expect(body.albums[0]).toEqual({
      id: "3",
      name: "Audio diary",
      kind: "smart",
      search: { tags: [{ key: "ac:tau:type", value: "audio" }], mediaType: "audio" },
    });
  });

  it("sorts albums by name", async () => {
    const { body } = await invoke([
      { id: "1", name: "Zoo" },
      { id: "2", name: "Apple" },
    ]);
    expect(body.albums.map((a: any) => a.name)).toEqual(["Apple", "Zoo"]);
  });
});
