import { jest } from "@jest/globals";
/**
 * Tests for user-tag editing on diary entries (PUT /api/diary/{id}):
 *  - a supplied `tags` array becomes the entry's user tags (adds + removes)
 *  - system/app tags the diary API doesn't own (favorite, hidden, album,
 *    country) are preserved across the write; managed tags (date/diary/text)
 *    are recomputed
 *  - client-supplied `ac:*` keys are rejected (can't smuggle in system tags)
 *  - omitting `tags` leaves the item's existing user tags untouched
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_DIARY_BUCKET_NAME = "test-diary-bucket";
process.env.AC_META_QUEUE_URL = "https://sqs/test-meta-queue";
process.env.AC_RESIZER_QUEUE_URL = "https://sqs/test-resizer-queue";
process.env.AC_VIDEO_META_QUEUE_URL = "https://sqs/test-video-meta-queue";
process.env.AC_VIDEO_ENCODER_QUEUE_URL = "https://sqs/test-video-encoder-queue";
process.env.AC_VIDEO_THUMBS_QUEUE_URL = "https://sqs/test-video-thumbs-queue";

import { Logger } from "@aws-lambda-powertools/logger";
import { TAG_DIARY_ENTRY } from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "../src/diary/eventHandler";

type Tag = { key: string; value: string };

const makeFakeServices = ({ seedTags = [] as Tag[] } = {}) => {
  const dbStore = new Map<string, { id: string; tags: Tag[] }>();
  if (seedTags.length) {
    dbStore.set("diary/2026/07/20260704.md", {
      id: "diary/2026/07/20260704.md",
      tags: seedTags,
    });
  }
  const sourceS3Service = {
    getSignedUrl: jest.fn(
      async ({ Key }: any) => `https://signed.example/${Key}`,
    ),
    getSignedUploadUrl: jest.fn(
      async ({ Key }: any) => `https://upload.example/${Key}`,
    ),
    headObject: jest.fn(async () => {
      throw new Error("NotFound");
    }),
    putObject: jest.fn(async () => ({})),
    getObject: jest.fn(async () => Buffer.from("")),
    deleteObject: jest.fn(async () => ({})),
  };
  const dynamoDBService = {
    getCommand: jest.fn(async ({ Key }: any) => ({
      Item: dbStore.get(Key.id),
    })),
    updateCommand: jest.fn(async ({ Key, ExpressionAttributeValues }: any) => {
      const tags = (ExpressionAttributeValues?.[":tags"] ?? []) as Tag[];
      dbStore.set(Key.id, { id: Key.id, tags });
      return {};
    }),
    batchWriteCommand: jest.fn(async () => ({})),
  };
  const sqsService = { sendMessage: jest.fn(async () => ({})) };
  return { sourceS3Service, dynamoDBService, sqsService, dbStore };
};

const putEvent = (body: unknown) => ({
  resource: "/api/diary/{id}",
  httpMethod: "PUT",
  pathParameters: { id: encodeURIComponent("diary/2026/07/20260704.md") },
  body: JSON.stringify(body),
});

const invoke = async (
  services: ReturnType<typeof makeFakeServices>,
  event: Record<string, unknown>,
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: services,
  } as any;
  const result = await (lambdaHandler as any)(event, ctx);
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

const tagKeys = (tags: Tag[]) => tags.map((t) => t.key);

describe("PUT /api/diary/{id} user tags", () => {
  it("writes the supplied user tags onto the entry", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(
      services,
      putEvent({
        title: "Trip",
        markdown: "Hello",
        tags: [
          { key: "trip", value: "iceland" },
          { key: "mood", value: "happy" },
        ],
      }),
    );

    expect(status).toBe(200);
    const tags = body.tags as Tag[];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: "trip", value: "iceland" },
        { key: "mood", value: "happy" },
        { key: TAG_DIARY_ENTRY, value: "true" },
      ]),
    );
  });

  it("preserves non-managed system/app tags and recomputes managed ones", async () => {
    const services = makeFakeServices({
      seedTags: [
        { key: "ac:app:favorite", value: "true" },
        { key: "ac:tau:virtualAlbum", value: "trips" },
        { key: "ac:tau:country", value: "Iceland" },
        { key: "ac:tau:yearCreated", value: "1999" }, // managed → recomputed
        { key: "ac:diary:preview", value: "stale" }, // managed → recomputed
        { key: "ac:text:oldword", value: "" }, // managed → recomputed
        { key: "trip", value: "old" }, // user tag → replaced by supplied set
      ],
    });

    const { body } = await invoke(
      services,
      putEvent({
        title: "Trip",
        markdown: "Fresh words here",
        tags: [{ key: "trip", value: "iceland" }],
      }),
    );
    const tags = body.tags as Tag[];

    // Preserved app/system tags survive verbatim.
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: "ac:app:favorite", value: "true" },
        { key: "ac:tau:virtualAlbum", value: "trips" },
        { key: "ac:tau:country", value: "Iceland" },
      ]),
    );
    // Managed date tag re-derived from the key (2026, not the stale 1999).
    expect(tags).toContainEqual({ key: "ac:tau:yearCreated", value: "2026" });
    // Stale managed tags dropped.
    expect(tagKeys(tags)).not.toContain("ac:text:oldword");
    // Old user tag value gone; supplied one present.
    expect(tags.filter((t) => t.key === "trip")).toEqual([
      { key: "trip", value: "iceland" },
    ]);
  });

  it("rejects client-supplied ac:* keys (no smuggling system tags)", async () => {
    const services = makeFakeServices();
    const { body } = await invoke(
      services,
      putEvent({
        title: "T",
        markdown: "x",
        tags: [
          { key: "ac:app:hidden", value: "true" },
          { key: "ac:tau:country", value: "Nope" },
          { key: "legit", value: "1" },
        ],
      }),
    );
    const tags = body.tags as Tag[];
    expect(tags).toContainEqual({ key: "legit", value: "1" });
    // The forged system tags were never written.
    expect(tags).not.toContainEqual({ key: "ac:app:hidden", value: "true" });
    expect(tags).not.toContainEqual({ key: "ac:tau:country", value: "Nope" });
  });

  it("leaves existing user tags untouched when tags is omitted", async () => {
    const services = makeFakeServices({
      seedTags: [{ key: "trip", value: "keep-me" }],
    });
    const { body } = await invoke(
      services,
      putEvent({ title: "T", markdown: "x" }),
    );
    expect(body.tags as Tag[]).toContainEqual({
      key: "trip",
      value: "keep-me",
    });
  });

  it("replaces all user tags with an empty supplied array (removal)", async () => {
    const services = makeFakeServices({
      seedTags: [{ key: "trip", value: "gone" }],
    });
    const { body } = await invoke(
      services,
      putEvent({ title: "T", markdown: "x", tags: [] }),
    );
    expect(tagKeys(body.tags as Tag[])).not.toContain("trip");
  });
});
