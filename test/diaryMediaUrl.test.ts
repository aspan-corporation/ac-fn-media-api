import { jest } from "@jest/globals";
/**
 * Tests for the diary handler's audio support:
 *  - POST /api/diary/media-url → presigned GET for an embedded audio key
 *  - POST /api/diary/upload-url now accepts audio extensions
 *  - PUT save tags embedded audio as ac:diary:audio (not ac:diary:photo) and
 *    never dispatches audio to the processing queues.
 */

process.env.AC_TAU_MEDIA_META_TABLE_NAME = "test-meta";
process.env.AC_DIARY_BUCKET_NAME = "test-diary-bucket";
process.env.AC_META_QUEUE_URL = "https://sqs/test-meta-queue";
process.env.AC_RESIZER_QUEUE_URL = "https://sqs/test-resizer-queue";

import { Logger } from "@aws-lambda-powertools/logger";
import { TAG_DIARY_AUDIO, TAG_DIARY_PHOTO } from "@aspan-corporation/ac-shared";
import { lambdaHandler } from "../src/diary/eventHandler";

type Tag = { key: string; value: string };

const makeFakeServices = ({ existingObjects = new Set<string>() } = {}) => {
  const dbStore = new Map<string, { id: string; tags: Tag[] }>();
  const sourceS3Service = {
    getSignedUrl: jest.fn(async ({ Key }: any) => `https://signed.example/${Key}`),
    getSignedUploadUrl: jest.fn(async ({ Key }: any) => `https://upload.example/${Key}`),
    // resolveUniqueKey probes with headObject; a throw means "free to use".
    headObject: jest.fn(async ({ Key }: any) => {
      if (!existingObjects.has(Key)) throw new Error("NotFound");
      return { ContentLength: 123 };
    }),
    putObject: jest.fn(async () => ({})),
    getObject: jest.fn(async () => Buffer.from("")),
    deleteObject: jest.fn(async () => ({})),
  };
  const dynamoDBService = {
    getCommand: jest.fn(async ({ Key }: any) => ({ Item: dbStore.get(Key.id) })),
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
  return {
    status: result.statusCode,
    headers: result.headers as Record<string, string>,
    body: JSON.parse(result.body),
  };
};

describe("POST /api/diary/media-url", () => {
  const mediaUrlEvent = (body: unknown, httpMethod = "POST") => ({
    resource: "/api/diary/media-url",
    httpMethod,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("returns a presigned GET with the right bucket, key and playback MIME", async () => {
    const services = makeFakeServices();
    const key = "diary/2026/07/recording-20260704-101500.m4a";
    const { status, headers, body } = await invoke(services, mediaUrlEvent({ key }));

    expect(status).toBe(200);
    expect(body.url).toBe(`https://signed.example/${key}`);
    expect(services.sourceS3Service.getSignedUrl).toHaveBeenCalledWith({
      Bucket: "test-diary-bucket",
      Key: key,
      ResponseContentType: "audio/mp4",
    });
    // Signed URLs expire — the browser HTTP cache must stay out of the loop.
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it.each([
    ["webm", "audio/webm"],
    ["ogg", "audio/ogg"],
  ])("maps .%s to ResponseContentType %s", async (ext, mime) => {
    const services = makeFakeServices();
    const key = `diary/2026/07/recording.${ext}`;
    await invoke(services, mediaUrlEvent({ key }));
    expect(services.sourceS3Service.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ ResponseContentType: mime }),
    );
  });

  it.each([
    ["non-diary key", "media/2026/x.m4a"],
    ["image key", "diary/2026/07/photo.jpg"],
    ["markdown key", "diary/2026/07/20260704.md"],
    ["path traversal", "diary/2026/07/../../secret.m4a"],
    ["wrong depth", "diary/recording.m4a"],
    ["empty", ""],
  ])("rejects %s with 400", async (_label, key) => {
    const services = makeFakeServices();
    const { status } = await invoke(services, mediaUrlEvent({ key }));
    expect(status).toBe(400);
    expect(services.sourceS3Service.getSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400 and non-POST with 405", async () => {
    const services = makeFakeServices();
    expect((await invoke(services, mediaUrlEvent("{nope"))).status).toBe(400);
    expect(
      (await invoke(services, mediaUrlEvent({ key: "diary/2026/07/a.m4a" }, "GET")))
        .status,
    ).toBe(405);
  });
});

describe("POST /api/diary/upload-url with audio filenames", () => {
  const uploadEvent = (filename: string) => ({
    resource: "/api/diary/upload-url",
    httpMethod: "POST",
    body: JSON.stringify({ id: "diary/2026/07/20260704.md", filename }),
  });

  it("accepts a MediaRecorder audio filename", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(
      services,
      uploadEvent("recording-20260704-101500.m4a"),
    );
    expect(status).toBe(200);
    expect(body.key).toBe("diary/2026/07/recording-20260704-101500.m4a");
    expect(body.url).toBeDefined();
  });

  it("still accepts images and still rejects unsupported extensions", async () => {
    const services = makeFakeServices();
    expect((await invoke(services, uploadEvent("photo.jpg"))).status).toBe(200);
    expect((await invoke(services, uploadEvent("song.mp3"))).status).toBe(400);
    expect((await invoke(services, uploadEvent("evil.exe"))).status).toBe(400);
  });
});

describe("PUT /api/diary/{id} with embedded audio", () => {
  it("tags audio as ac:diary:audio, photos as ac:diary:photo, and dispatches only the photo", async () => {
    const photoKey = "diary/2026/07/photo.jpg";
    const audioKey = "diary/2026/07/recording-20260704-101500.m4a";
    // Both objects exist in the bucket (headObject succeeds → dispatch can size them).
    const services = makeFakeServices({
      existingObjects: new Set([photoKey, audioKey]),
    });
    const markdown = `Walked the dog.\n![](<${photoKey}>)\n![audio](<${audioKey}>)\n`;

    const { status, body } = await invoke(services, {
      resource: "/api/diary/{id}",
      httpMethod: "PUT",
      pathParameters: { id: encodeURIComponent("diary/2026/07/20260704.md") },
      body: JSON.stringify({ title: "Walk", markdown }),
    });

    expect(status).toBe(200);
    const tags = body.tags as Tag[];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: TAG_DIARY_PHOTO, value: photoKey },
        { key: TAG_DIARY_AUDIO, value: audioKey },
      ]),
    );
    expect(tags.filter((t) => t.key === TAG_DIARY_PHOTO)).toHaveLength(1);
    expect(tags.filter((t) => t.key === TAG_DIARY_AUDIO)).toHaveLength(1);

    // Only the image goes to the meta + resizer queues; audio never enters
    // the processing pipeline (entry-only by design).
    const sent = services.sqsService.sendMessage.mock.calls.map(
      ([arg]: any) => JSON.parse(arg.MessageBody).detail.object.key,
    );
    expect(sent).toEqual([photoKey, photoKey]);
  });
});
