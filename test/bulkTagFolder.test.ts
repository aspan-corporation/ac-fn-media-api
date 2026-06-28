/**
 * Tests for bulk-tag folder mode: a `folder` prefix cascades the merge to every
 * media item inside it (recursively), skipping folder-marker rows.
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/bulk-tag/eventHandler";

type Tag = { key: string; value: string };

const makeDb = (items: Array<{ id: string; tags: Tag[] }>) => {
  const store = new Map(items.map((i) => [i.id, { id: i.id, tags: [...i.tags] }]));
  return {
    store,
    scanCommand: jest.fn(async ({ ExpressionAttributeValues }: any) => {
      const prefix = ExpressionAttributeValues[":prefix"] as string;
      return {
        Items: [...store.values()].filter((i) => i.id.startsWith(prefix)).map((i) => ({ id: i.id })),
        LastEvaluatedKey: undefined,
      };
    }),
    getCommand: jest.fn(async ({ Key }: any) => ({ Item: store.get(Key.id) })),
    updateCommand: jest.fn(async ({ Key, ExpressionAttributeValues }: any) => {
      store.get(Key.id)!.tags = ExpressionAttributeValues[":tags"];
      return {};
    }),
  };
};

const invoke = async (db: ReturnType<typeof makeDb>, body: unknown) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: db },
  } as any;
  const result = await (lambdaHandler as any)({ body: JSON.stringify(body) }, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

const has = (db: ReturnType<typeof makeDb>, id: string, key: string, value: string) =>
  db.store.get(id)!.tags.some((t) => t.key === key && t.value === value);

describe("bulk-tag folder mode", () => {
  it("cascades the merge to media items in the folder + subfolders, skipping markers", async () => {
    const db = makeDb([
      { id: "media/trip/", tags: [] },
      { id: "media/trip/a.jpg", tags: [{ key: "x", value: "1" }] },
      { id: "media/trip/sub/", tags: [] },
      { id: "media/trip/sub/b.jpg", tags: [] },
      { id: "media/other/c.jpg", tags: [] },
    ]);

    const { status, body } = await invoke(db, {
      folder: "media/trip/",
      merge: [
        { key: "ac:tau:yearCreated", value: "2003" },
        { key: "ac:tau:country", value: "France" },
      ],
    });

    expect(status).toBe(200);
    expect(body.updatedCount).toBe(2); // a.jpg + sub/b.jpg
    expect(has(db, "media/trip/a.jpg", "ac:tau:yearCreated", "2003")).toBe(true);
    expect(has(db, "media/trip/a.jpg", "ac:tau:country", "France")).toBe(true);
    expect(has(db, "media/trip/a.jpg", "x", "1")).toBe(true); // existing preserved
    expect(has(db, "media/trip/a.jpg", "ac:tau:hasDate", "true")).toBe(true); // sentinel
    expect(has(db, "media/trip/sub/b.jpg", "ac:tau:yearCreated", "2003")).toBe(true);
    // Folder markers and items outside the folder are untouched.
    expect(has(db, "media/trip/", "ac:tau:yearCreated", "2003")).toBe(false);
    expect(has(db, "media/trip/sub/", "ac:tau:yearCreated", "2003")).toBe(false);
    expect(has(db, "media/other/c.jpg", "ac:tau:yearCreated", "2003")).toBe(false);
  });

  it("normalizes a folder id without a trailing slash", async () => {
    const db = makeDb([
      { id: "media/trip/", tags: [] },
      { id: "media/trip/a.jpg", tags: [] },
    ]);
    const { body } = await invoke(db, {
      folder: "media/trip",
      merge: [{ key: "ac:tau:country", value: "Spain" }],
    });
    expect(body.updatedCount).toBe(1);
    expect(has(db, "media/trip/a.jpg", "ac:tau:country", "Spain")).toBe(true);
  });

  it("requires ids or folder", async () => {
    const db = makeDb([]);
    const { status } = await invoke(db, { merge: [{ key: "k", value: "v" }] });
    expect(status).toBe(400);
  });
});
