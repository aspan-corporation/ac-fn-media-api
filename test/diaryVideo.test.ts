import { jest } from "@jest/globals";
/**
 * Tests for the diary handler's video support:
 *  - POST /api/diary/upload-url accepts video extensions
 *  - PUT save tags embedded videos as ac:diary:video (not ac:diary:photo) and
 *    dispatches them to the video-meta-extractor, video-encoder, and
 *    video-thumbs queues — the same three steps the library state machine
 *    runs for a video — while images still go to meta + resizer only.
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_DIARY_BUCKET_NAME = "test-diary-bucket";
process.env.AC_META_QUEUE_URL = "https://sqs/test-meta-queue";
process.env.AC_RESIZER_QUEUE_URL = "https://sqs/test-resizer-queue";
process.env.AC_VIDEO_META_QUEUE_URL = "https://sqs/test-video-meta-queue";
process.env.AC_VIDEO_ENCODER_QUEUE_URL = "https://sqs/test-video-encoder-queue";
process.env.AC_VIDEO_THUMBS_QUEUE_URL = "https://sqs/test-video-thumbs-queue";

import { Logger } from "@aws-lambda-powertools/logger";
import { TAG_DIARY_PHOTO, TAG_DIARY_VIDEO } from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "../src/diary/eventHandler";

type Tag = { key: string; value: string };

const makeFakeServices = ({ existingObjects = new Set<string>() } = {}) => {
  const dbStore = new Map<string, { id: string; tags: Tag[] }>();
  const sourceS3Service = {
    getSignedUrl: jest.fn(
      async ({ Key }: any) => `https://signed.example/${Key}`,
    ),
    getSignedUploadUrl: jest.fn(
      async ({ Key }: any) => `https://upload.example/${Key}`,
    ),
    headObject: jest.fn(async ({ Key }: any) => {
      if (!existingObjects.has(Key)) throw new Error("NotFound");
      return { ContentLength: 123 };
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

describe("POST /api/diary/upload-url with video filenames", () => {
  const uploadEvent = (filename: string) => ({
    resource: "/api/diary/upload-url",
    httpMethod: "POST",
    body: JSON.stringify({ id: "diary/2026/07/20260704.md", filename }),
  });

  it.each([
    ["clip.mp4", "mp4"],
    ["clip.mov", "mov"],
  ])(
    "accepts %s and mints a UUID key with its extension",
    async (filename, ext) => {
      const services = makeFakeServices();
      const { status, body } = await invoke(services, uploadEvent(filename));
      expect(status).toBe(200);
      expect(body.key).toMatch(
        new RegExp(
          `^diary/2026/07/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`,
        ),
      );
      expect(body.url).toBeDefined();
    },
  );

  it("still rejects unsupported extensions", async () => {
    const services = makeFakeServices();
    expect((await invoke(services, uploadEvent("movie.avi"))).status).toBe(400);
  });
});

describe("PUT /api/diary/{id} with embedded video", () => {
  it("tags video as ac:diary:video, photos as ac:diary:photo, and dispatches each to its own pipeline", async () => {
    const photoKey = "diary/2026/07/photo.jpg";
    const videoKey = "diary/2026/07/clip.mp4";
    const services = makeFakeServices({
      existingObjects: new Set([photoKey, videoKey]),
    });
    const markdown = `Family trip.\n![](<${photoKey}>)\n![](<${videoKey}>)\n`;

    const { status, body } = await invoke(services, {
      resource: "/api/diary/{id}",
      httpMethod: "PUT",
      pathParameters: { id: encodeURIComponent("diary/2026/07/20260704.md") },
      body: JSON.stringify({ title: "Trip", markdown }),
    });

    expect(status).toBe(200);
    const tags = body.tags as Tag[];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: TAG_DIARY_PHOTO, value: photoKey },
        { key: TAG_DIARY_VIDEO, value: videoKey },
      ]),
    );
    expect(tags.filter((t) => t.key === TAG_DIARY_PHOTO)).toHaveLength(1);
    expect(tags.filter((t) => t.key === TAG_DIARY_VIDEO)).toHaveLength(1);

    // The photo goes to meta + resizer; the video goes to its own three
    // queues (video-meta, video-encoder, video-thumbs) — five sends total,
    // two of the same key (photo) and three of the same key (video).
    const sent = services.sqsService.sendMessage.mock.calls.map(
      ([arg]: any) => JSON.parse(arg.MessageBody).detail.object.key,
    );
    expect(sent.filter((k: string) => k === photoKey)).toHaveLength(2);
    expect(sent.filter((k: string) => k === videoKey)).toHaveLength(3);
    expect(sent).toHaveLength(5);
  });

  it("does not re-dispatch a video that already has a meta item", async () => {
    const videoKey = "diary/2026/07/clip.mp4";
    const services = makeFakeServices({ existingObjects: new Set([videoKey]) });
    // Pre-seed a meta item for the video (already processed).
    services.dbStore.set(videoKey, { id: videoKey, tags: [] });

    await invoke(services, {
      resource: "/api/diary/{id}",
      httpMethod: "PUT",
      pathParameters: { id: encodeURIComponent("diary/2026/07/20260704.md") },
      body: JSON.stringify({
        title: "Trip",
        markdown: `![](<${videoKey}>)\n`,
      }),
    });

    expect(services.sqsService.sendMessage).not.toHaveBeenCalled();
  });
});
