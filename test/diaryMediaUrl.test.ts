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
process.env.AC_VIDEO_META_QUEUE_URL = "https://sqs/test-video-meta-queue";
process.env.AC_VIDEO_ENCODER_QUEUE_URL = "https://sqs/test-video-encoder-queue";
process.env.AC_VIDEO_THUMBS_QUEUE_URL = "https://sqs/test-video-thumbs-queue";

import { Logger } from "@aws-lambda-powertools/logger";
import { TAG_DIARY_AUDIO, TAG_DIARY_PHOTO } from "@aspan-corporation/ac-shared";
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
    // Upload keys are now UUIDs (no HeadObject probing); headObject is still
    // used on PUT save to size an embedded object before dispatch — a throw
    // means the object isn't present.
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
    const { status, headers, body } = await invoke(
      services,
      mediaUrlEvent({ key }),
    );

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

  it("accepts a UUID-shaped audio key (the new upload-url key format)", async () => {
    const services = makeFakeServices();
    const key = "diary/2026/07/1f0b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.m4a";
    const { status, body } = await invoke(services, mediaUrlEvent({ key }));
    expect(status).toBe(200);
    expect(body.url).toBe(`https://signed.example/${key}`);
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
      (
        await invoke(
          services,
          mediaUrlEvent({ key: "diary/2026/07/a.m4a" }, "GET"),
        )
      ).status,
    ).toBe(405);
  });
});

describe("POST /api/diary/upload-url with audio filenames", () => {
  const uploadEvent = (filename: string) => ({
    resource: "/api/diary/upload-url",
    httpMethod: "POST",
    body: JSON.stringify({ id: "diary/2026/07/20260704.md", filename }),
  });

  const UUID_KEY = (ext: string) =>
    new RegExp(
      `^diary/2026/07/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`,
    );

  it("mints a UUID key with the file's extension (no HeadObject probing)", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(
      services,
      uploadEvent("recording-20260704-101500.m4a"),
    );
    expect(status).toBe(200);
    expect(body.key).toMatch(UUID_KEY("m4a"));
    expect(body.url).toBeDefined();
    // The key is unique by construction — we never probe S3 to pick a name.
    expect(services.sourceS3Service.headObject).not.toHaveBeenCalled();
  });

  it("gives every upload a distinct key even for the same filename", async () => {
    const services = makeFakeServices();
    const a = (await invoke(services, uploadEvent("photo.jpg"))).body.key;
    const b = (await invoke(services, uploadEvent("photo.jpg"))).body.key;
    expect(a).toMatch(UUID_KEY("jpg"));
    expect(b).toMatch(UUID_KEY("jpg"));
    expect(a).not.toBe(b);
  });

  it("still accepts images and still rejects unsupported extensions", async () => {
    const services = makeFakeServices();
    expect((await invoke(services, uploadEvent("photo.jpg"))).status).toBe(200);
    expect((await invoke(services, uploadEvent("song.mp3"))).status).toBe(400);
    expect((await invoke(services, uploadEvent("evil.exe"))).status).toBe(400);
  });
});

describe("POST /api/diary/upload-url device hints", () => {
  const uploadEvent = (hints?: unknown) => ({
    resource: "/api/diary/upload-url",
    httpMethod: "POST",
    body: JSON.stringify({
      id: "diary/2026/07/20260704.md",
      filename: "photo.jpg",
      ...(hints !== undefined ? { hints } : {}),
    }),
  });

  const signedMetadata = (services: ReturnType<typeof makeFakeServices>) =>
    (services.sourceS3Service.getSignedUploadUrl.mock.calls[0] as any[])[0]
      .Metadata;

  it("embeds valid date and location hints as S3 user metadata", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(
      services,
      uploadEvent({
        date: "2026-07-06T10:30:00.000Z",
        latitude: 48.8584,
        longitude: 2.2945,
      }),
    );
    expect(status).toBe(200);
    expect(signedMetadata(services)).toEqual({
      "hint-date": "2026-07-06T10:30:00.000Z",
      "hint-latitude": "48.8584",
      "hint-longitude": "2.2945",
    });
  });

  it("omits Metadata entirely when no hints are sent", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(services, uploadEvent());
    expect(status).toBe(200);
    expect(signedMetadata(services)).toBeUndefined();
  });

  it("keeps the date hint when coordinates are invalid", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(
      services,
      uploadEvent({
        date: "2026-07-06T10:30:00.000Z",
        latitude: 91, // out of range
        longitude: 2.2945,
      }),
    );
    expect(status).toBe(200);
    expect(signedMetadata(services)).toEqual({
      "hint-date": "2026-07-06T10:30:00.000Z",
    });
  });

  it("drops a lone coordinate — they only make sense as a pair", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(
      services,
      uploadEvent({ latitude: 48.8584 }),
    );
    expect(status).toBe(200);
    expect(signedMetadata(services)).toBeUndefined();
  });

  it("accepts (0, 0) as valid coordinates", async () => {
    const services = makeFakeServices();
    await invoke(services, uploadEvent({ latitude: 0, longitude: 0 }));
    expect(signedMetadata(services)).toEqual({
      "hint-latitude": "0",
      "hint-longitude": "0",
    });
  });

  it.each([
    ["junk hints object", "nonsense"],
    ["null hints", null],
    ["array hints", [1, 2]],
    ["unparseable date", { date: "not-a-date" }],
    ["far-future date", { date: "2999-01-01T00:00:00.000Z" }],
    ["pre-epoch date", { date: "1899-01-01T00:00:00.000Z" }],
    ["string coordinates", { latitude: "48.8", longitude: "2.29" }],
    ["NaN coordinates", { latitude: NaN, longitude: NaN }],
  ])(
    "never 400s on bad hints (%s) — upload proceeds without them",
    async (_l, hints) => {
      const services = makeFakeServices();
      const { status } = await invoke(services, uploadEvent(hints));
      expect(status).toBe(200);
      expect(signedMetadata(services)).toBeUndefined();
    },
  );
});

describe("PUT /api/diary/{id} with embedded audio", () => {
  it("tags audio as ac:diary:audio, photos as ac:diary:photo, and dispatches the photo to meta+resizer and the audio to meta only", async () => {
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

    // The photo goes to meta + resizer (thumbnail); the audio goes to the
    // meta queue ONLY — it gets a searchable meta item but no thumbnail.
    const sends = services.sqsService.sendMessage.mock.calls.map(
      ([arg]: any) => ({
        queue: arg.QueueUrl,
        key: JSON.parse(arg.MessageBody).detail.object.key,
      }),
    );
    // photo → both queues
    expect(sends).toContainEqual({
      queue: "https://sqs.test/meta",
      key: photoKey,
    });
    expect(sends).toContainEqual({
      queue: "https://sqs.test/resizer",
      key: photoKey,
    });
    // audio → meta only
    expect(sends).toContainEqual({
      queue: "https://sqs.test/meta",
      key: audioKey,
    });
    expect(
      sends.filter((s: { key: string }) => s.key === audioKey),
    ).toHaveLength(1);
    // audio never hits the resizer or any video queue
    expect(
      sends.filter(
        (s: { key: string; queue: string }) =>
          s.key === audioKey && s.queue !== "https://sqs.test/meta",
      ),
    ).toHaveLength(0);
  });
});
