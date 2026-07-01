import { jest } from "@jest/globals";
/**
 * Tests for hide-folder: recursively sets/clears the hidden tag on a folder's
 * own marker plus every item inside it, walking the by-folder GSI.
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/hide-folder/eventHandler";

type Tag = { key: string; value: string };
const TAG_HIDDEN = "ac:ediacara:hidden";

const parentFolder = (id: string): string => {
  const s = id.endsWith("/") ? id.slice(0, -1) : id;
  const i = s.lastIndexOf("/");
  return i < 0 ? "/" : s.slice(0, i + 1);
};

const makeDb = (items: Array<{ id: string; tags: Tag[] }>) => {
  const store = new Map(items.map((i) => [i.id, { id: i.id, tags: [...i.tags] }]));
  return {
    store,
    queryCommand: jest.fn(async ({ ExpressionAttributeValues }: any) => {
      const folder = ExpressionAttributeValues[":folder"] as string;
      return {
        Items: [...store.values()]
          .filter((i) => parentFolder(i.id) === folder)
          .map((i) => ({ id: i.id, tags: i.tags })),
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

const invoke = async (
  db: ReturnType<typeof makeDb>,
  id: string,
  body: unknown,
  { admin = true }: { admin?: boolean } = {},
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: { dynamoDBService: db },
  } as any;
  const event: any = {
    pathParameters: { id: encodeURIComponent(id) },
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { claims: { "cognito:groups": admin ? "admin" : "user" } },
    },
  };
  const result = await (lambdaHandler as any)(event, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

const isHidden = (db: ReturnType<typeof makeDb>, id: string) =>
  db.store.get(id)!.tags.some((t) => t.key === TAG_HIDDEN);

const baseTree = (): Array<{ id: string; tags: Tag[] }> => [
  { id: "media/trip/", tags: [] },
  { id: "media/trip/a.jpg", tags: [] },
  { id: "media/trip/sub/", tags: [] },
  { id: "media/trip/sub/b.jpg", tags: [] },
  { id: "media/other/c.jpg", tags: [] },
];

describe("hide-folder", () => {
  it("hides the folder marker and every descendant, leaving outsiders alone", async () => {
    const db = makeDb(baseTree());
    const { status, body } = await invoke(db, "media/trip/", { hidden: true });

    expect(status).toBe(200);
    // folder marker + a.jpg + sub/ + sub/b.jpg = 4
    expect(body.updatedCount).toBe(4);
    expect(isHidden(db, "media/trip/")).toBe(true);
    expect(isHidden(db, "media/trip/a.jpg")).toBe(true);
    expect(isHidden(db, "media/trip/sub/")).toBe(true);
    expect(isHidden(db, "media/trip/sub/b.jpg")).toBe(true);
    expect(isHidden(db, "media/other/c.jpg")).toBe(false);
  });

  it("unhides recursively (idempotent no-op on already-visible items)", async () => {
    const db = makeDb(
      baseTree().map((i) =>
        i.id.startsWith("media/trip")
          ? { ...i, tags: [{ key: TAG_HIDDEN, value: "true" }] }
          : i,
      ),
    );
    const { body } = await invoke(db, "media/trip/", { hidden: false });
    expect(body.updatedCount).toBe(4);
    expect(isHidden(db, "media/trip/a.jpg")).toBe(false);
    expect(isHidden(db, "media/trip/sub/b.jpg")).toBe(false);
  });

  it("normalizes an id without a trailing slash", async () => {
    const db = makeDb(baseTree());
    const { body } = await invoke(db, "media/trip", { hidden: true });
    expect(body.updatedCount).toBe(4);
  });

  it("rejects non-admins", async () => {
    const db = makeDb(baseTree());
    const { status } = await invoke(db, "media/trip/", { hidden: true }, { admin: false });
    expect(status).toBe(403);
  });
});