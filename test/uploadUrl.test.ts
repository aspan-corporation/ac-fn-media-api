import { jest } from "@jest/globals";
/**
 * Tests for POST /api/media/upload-url — a presigned PUT so the browser can
 * upload straight into the media library (no dispatch/folder-marker
 * bookkeeping here; the dispatcher's EventBridge trigger handles both once
 * the real S3 PUT lands).
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { buildMediaUploadKey, lambdaHandler } from "../src/upload-url/eventHandler";

const makeFakeServices = () => ({
  sourceS3Service: {
    getSignedUploadUrl: jest.fn(
      async ({ Key }: any) => `https://signed.example/${Key}`,
    ),
  },
});

const invoke = async (
  services: ReturnType<typeof makeFakeServices>,
  body: unknown,
  httpMethod = "POST",
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: services,
  } as any;
  const event = { httpMethod, body: JSON.stringify(body) };
  const result = await (lambdaHandler as any)(event, ctx);
  return {
    status: result.statusCode,
    body: JSON.parse(result.body),
  };
};

describe("buildMediaUploadKey", () => {
  it("builds media/YYYY/MM/DD/<uuid>.<ext> from a date hint", () => {
    const key = buildMediaUploadKey("2024-08-15T10:00:00.000Z", "jpg");
    expect(key).toMatch(
      /^media\/2024\/08\/15\/[0-9a-f-]{36}\.jpg$/,
    );
  });

  it("lowercases and strips a leading dot from the extension", () => {
    const key = buildMediaUploadKey("2024-08-15T00:00:00.000Z", ".JPG");
    expect(key.endsWith(".jpg")).toBe(true);
  });

  it("falls back to the current date when no hint is given", () => {
    const key = buildMediaUploadKey(undefined, "png");
    const now = new Date();
    const expectedPrefix = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/`;
    expect(key.startsWith(expectedPrefix)).toBe(true);
  });

  it("produces a different UUID leaf on each call (no collisions)", () => {
    const a = buildMediaUploadKey("2024-08-15T00:00:00.000Z", "jpg");
    const b = buildMediaUploadKey("2024-08-15T00:00:00.000Z", "jpg");
    expect(a).not.toBe(b);
  });
});

describe("POST /api/media/upload-url", () => {
  it("issues a presigned PUT for a valid image filename", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(services, { filename: "IMG_0001.jpg" });

    expect(status).toBe(200);
    expect(body.key).toMatch(/^media\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(body.url).toBe(`https://signed.example/${body.key}`);
    expect(services.sourceS3Service.getSignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: "test-media-bucket", Key: body.key }),
    );
  });

  it.each([
    ["video", "clip.mov"],
    ["audio", "recording.m4a"],
  ])("accepts a %s filename too", async (_label, filename) => {
    const services = makeFakeServices();
    const { status } = await invoke(services, { filename });
    expect(status).toBe(200);
  });

  it("rejects an unsupported extension", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(services, { filename: "notes.txt" });
    expect(status).toBe(400);
    expect(body.message).toMatch(/supported extension/);
    expect(services.sourceS3Service.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a missing filename", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(services, {});
    expect(status).toBe(400);
  });

  it("rejects a non-POST method", async () => {
    const services = makeFakeServices();
    const { status } = await invoke(services, { filename: "a.jpg" }, "GET");
    expect(status).toBe(405);
  });

  it("attaches a valid device date hint as S3 metadata", async () => {
    const services = makeFakeServices();
    await invoke(services, {
      filename: "a.jpg",
      hints: { date: "2024-08-15T10:00:00.000Z" },
    });
    expect(services.sourceS3Service.getSignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Metadata: expect.objectContaining({ "hint-date": "2024-08-15T10:00:00.000Z" }),
      }),
    );
  });

  it("omits Metadata entirely when no valid hints are given", async () => {
    const services = makeFakeServices();
    await invoke(services, { filename: "a.jpg" });
    const call = services.sourceS3Service.getSignedUploadUrl.mock.calls[0][0] as any;
    expect(call.Metadata).toBeUndefined();
  });

  it("never lets a path-traversal filename escape into the S3 key", async () => {
    const services = makeFakeServices();
    const { status, body } = await invoke(services, {
      filename: "../../etc/passwd.jpg",
    });
    // sanitizeFilename strips path separators, leaving a valid leaf
    // ("passwd.jpg") — accepted, not a 400. The key itself is a UUID leaf
    // regardless (the original filename is never used as the key), so the
    // traversal input never reaches the S3 key either way.
    expect(status).toBe(200);
    expect(body.key).toMatch(/^media\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
  });
});
