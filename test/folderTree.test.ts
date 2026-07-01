/**
 * Unit tests for the by-folder GSI walk that replaced the full-table Scan in
 * hide-folder and bulk-tag folder mode.
 */
import {
  collectFolderTree,
  FolderQueryClient,
} from "../src/shared/folderTree";

type Row = { id: string; tags: Array<{ key: string; value: string }> };

const parentFolder = (id: string): string => {
  const s = id.endsWith("/") ? id.slice(0, -1) : id;
  const i = s.lastIndexOf("/");
  return i < 0 ? "/" : s.slice(0, i + 1);
};

/** In-memory by-folder GSI. `pageSize` forces pagination when > 0. */
const makeClient = (rows: Row[], pageSize = 0): FolderQueryClient & { calls: number } => {
  const byFolder = new Map<string, Row[]>();
  for (const r of rows) {
    const f = parentFolder(r.id);
    (byFolder.get(f) ?? byFolder.set(f, []).get(f)!).push(r);
  }
  const client: any = {
    calls: 0,
    queryCommand: async ({ ExpressionAttributeValues, ExclusiveStartKey }: any) => {
      client.calls++;
      const folder = ExpressionAttributeValues[":folder"] as string;
      const items = (byFolder.get(folder) ?? []).map((r) => ({ id: r.id, tags: r.tags }));
      if (pageSize > 0) {
        const start = (ExclusiveStartKey?.i as number) ?? 0;
        const slice = items.slice(start, start + pageSize);
        const next = start + pageSize;
        return { Items: slice, LastEvaluatedKey: next < items.length ? { i: next } : undefined };
      }
      return { Items: items, LastEvaluatedKey: undefined };
    },
  };
  return client;
};

const tree: Row[] = [
  { id: "media/trip/", tags: [] },
  { id: "media/trip/a.jpg", tags: [{ key: "x", value: "1" }] },
  { id: "media/trip/b.jpg", tags: [] },
  { id: "media/trip/sub/", tags: [] },
  { id: "media/trip/sub/c.jpg", tags: [] },
  { id: "media/trip/sub/deep/", tags: [] },
  { id: "media/trip/sub/deep/d.jpg", tags: [] },
  { id: "media/other/e.jpg", tags: [] },
];

describe("collectFolderTree", () => {
  it("excludes markers when includeMarkers=false (bulk-tag semantics)", async () => {
    const client = makeClient(tree);
    const items = await collectFolderTree(client, "meta", "media/trip/", {
      includeMarkers: false,
    });
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual([
      "media/trip/a.jpg",
      "media/trip/b.jpg",
      "media/trip/sub/c.jpg",
      "media/trip/sub/deep/d.jpg",
    ]);
  });

  it("includes markers when includeMarkers=true (hide-folder semantics)", async () => {
    const client = makeClient(tree);
    const items = await collectFolderTree(client, "meta", "media/trip/", {
      includeMarkers: true,
    });
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual([
      "media/trip/a.jpg",
      "media/trip/b.jpg",
      "media/trip/sub/",
      "media/trip/sub/c.jpg",
      "media/trip/sub/deep/",
      "media/trip/sub/deep/d.jpg",
    ]);
  });

  it("does not reach items outside the prefix", async () => {
    const client = makeClient(tree);
    const items = await collectFolderTree(client, "meta", "media/trip/", {
      includeMarkers: true,
    });
    expect(items.some((i) => i.id === "media/other/e.jpg")).toBe(false);
  });

  it("preserves tags on returned items", async () => {
    const client = makeClient(tree);
    const items = await collectFolderTree(client, "meta", "media/trip/", {
      includeMarkers: false,
    });
    const a = items.find((i) => i.id === "media/trip/a.jpg");
    expect(a?.tags).toEqual([{ key: "x", value: "1" }]);
  });

  it("paginates each folder query (ExclusiveStartKey loop)", async () => {
    const client = makeClient(tree, 1); // one item per page
    const items = await collectFolderTree(client, "meta", "media/trip/", {
      includeMarkers: false,
    });
    expect(items.map((i) => i.id).sort()).toEqual([
      "media/trip/a.jpg",
      "media/trip/b.jpg",
      "media/trip/sub/c.jpg",
      "media/trip/sub/deep/d.jpg",
    ]);
    expect(client.calls).toBeGreaterThan(4); // multiple pages were fetched
  });

  it("returns empty for an empty/leaf folder", async () => {
    const client = makeClient(tree);
    const items = await collectFolderTree(client, "meta", "media/empty/", {
      includeMarkers: true,
    });
    expect(items).toEqual([]);
  });
});
