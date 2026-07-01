import { jest } from "@jest/globals";
/**
 * Tests for the folder→items tag cascade in the update-metadata handler.
 *
 * Editing a FOLDER's tags propagates the change to every item inside it
 * (recursively, via begins_with on the id prefix): added tags are added to
 * each descendant, removed tags are removed from each. Non-folder edits never
 * cascade.
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/update-metadata/eventHandler";

type Tag = { key: string; value: string };
type Item = { id: string; tags: Tag[] };

const sameTag = (a: Tag, b: Tag) => a.key === b.key && a.value === b.value;

const parentFolder = (id: string): string => {
  const s = id.endsWith("/") ? id.slice(0, -1) : id;
  const i = s.lastIndexOf("/");
  return i < 0 ? "/" : s.slice(0, i + 1);
};

/**
 * In-memory fake of the bits of dynamoDBService the handler uses:
 * getCommand (read folder item), updateCommand (write any item), queryCommand
 * (by-folder GSI subtree walk). Backed by a single map keyed on id.
 */
const makeFakeDb = (items: Item[]) => {
  const store = new Map(items.map((i) => [i.id, { ...i, tags: [...i.tags] }]));
  const updates: Array<{ id: string; tags: Tag[] }> = [];
  return {
    updates,
    store,
    getCommand: jest.fn(async ({ Key }: any) => {
      const item = store.get(Key.id);
      return { Item: item ? { ...item, tags: [...item.tags] } : undefined };
    }),
    updateCommand: jest.fn(async ({ Key, ExpressionAttributeValues }: any) => {
      const tags = ExpressionAttributeValues[":tags"] as Tag[];
      store.set(Key.id, { id: Key.id, tags });
      updates.push({ id: Key.id, tags });
      return { Attributes: { id: Key.id, tags } };
    }),
    queryCommand: jest.fn(async ({ ExpressionAttributeValues }: any) => {
      const folder = ExpressionAttributeValues[":folder"] as string;
      const Items = [...store.values()].filter((i) => parentFolder(i.id) === folder);
      return { Items, LastEvaluatedKey: undefined };
    }),
  };
};

const invoke = async (db: ReturnType<typeof makeFakeDb>, id: string, tags: Tag[]) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: db },
  } as any;
  const event: any = {
    pathParameters: { id: encodeURIComponent(id) },
    body: JSON.stringify({ tags }),
  };
  const result = await (lambdaHandler as any)(event, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

const SYS = { key: "ac:tau:label", value: "Paris" };

describe("update-metadata folder tag cascade", () => {
  it("adds a new folder tag to every descendant (incl. subfolders), preserving their other tags", async () => {
    const db = makeFakeDb([
      { id: "media/trip/", tags: [] },
      { id: "media/trip/a.jpg", tags: [{ key: "rating", value: "5" }, SYS] },
      { id: "media/trip/sub/", tags: [] },
      { id: "media/trip/sub/b.jpg", tags: [] },
      { id: "media/other/c.jpg", tags: [] }, // outside the folder — untouched
    ]);

    const { status, body } = await invoke(db, "media/trip/", [{ key: "trip", value: "italy" }]);

    expect(status).toBe(200);
    expect(body.cascadedCount).toBe(3); // a.jpg, sub/, sub/b.jpg

    const tagsOf = (id: string) => db.store.get(id)!.tags;
    const hasTrip = (id: string) => tagsOf(id).some((t) => sameTag(t, { key: "trip", value: "italy" }));
    expect(hasTrip("media/trip/a.jpg")).toBe(true);
    expect(hasTrip("media/trip/sub/")).toBe(true);
    expect(hasTrip("media/trip/sub/b.jpg")).toBe(true);
    // Untouched outside the folder.
    expect(hasTrip("media/other/c.jpg")).toBe(false);
    // Existing tags on a descendant are preserved.
    expect(tagsOf("media/trip/a.jpg")).toEqual(
      expect.arrayContaining([{ key: "rating", value: "5" }, SYS]),
    );
  });

  it("removes a folder tag from every descendant that has it", async () => {
    const db = makeFakeDb([
      { id: "media/trip/", tags: [{ key: "trip", value: "italy" }] },
      { id: "media/trip/a.jpg", tags: [{ key: "trip", value: "italy" }, { key: "rating", value: "5" }] },
      // Sub-folder marker (present in real data — makes the GSI walk reachable);
      // it has no `trip` tag, so it is a no-op for the removal.
      { id: "media/trip/sub/", tags: [] },
      { id: "media/trip/sub/b.jpg", tags: [{ key: "trip", value: "italy" }] },
    ]);

    // Save the folder with no tags → removes "trip:italy".
    const { body } = await invoke(db, "media/trip/", []);

    expect(body.cascadedCount).toBe(2);
    const tagsOf = (id: string) => db.store.get(id)!.tags;
    expect(tagsOf("media/trip/a.jpg")).toEqual([{ key: "rating", value: "5" }]);
    expect(tagsOf("media/trip/sub/b.jpg")).toEqual([]);
  });

  it("does not write descendants that already match", async () => {
    const db = makeFakeDb([
      { id: "media/trip/", tags: [] },
      { id: "media/trip/a.jpg", tags: [{ key: "trip", value: "italy" }] }, // already tagged
      { id: "media/trip/b.jpg", tags: [] },
    ]);

    const { body } = await invoke(db, "media/trip/", [{ key: "trip", value: "italy" }]);

    expect(body.cascadedCount).toBe(1); // only b.jpg
    // a.jpg was not rewritten (no duplicate tag, single write was the folder itself + b.jpg)
    const writtenIds = db.updates.map((u) => u.id);
    expect(writtenIds).toContain("media/trip/"); // folder's own write
    expect(writtenIds).toContain("media/trip/b.jpg");
    expect(writtenIds.filter((x) => x === "media/trip/a.jpg")).toHaveLength(0);
  });

  it("does not cascade or scan for a non-folder id", async () => {
    const db = makeFakeDb([
      { id: "media/trip/a.jpg", tags: [] },
      { id: "media/trip/b.jpg", tags: [] },
    ]);

    const { body } = await invoke(db, "media/trip/a.jpg", [{ key: "trip", value: "italy" }]);

    expect(body.cascadedCount).toBeUndefined();
    expect(db.queryCommand).not.toHaveBeenCalled();
    // b.jpg untouched.
    expect(db.store.get("media/trip/b.jpg")!.tags).toEqual([]);
  });
});