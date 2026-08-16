import { jest } from "@jest/globals";
/**
 * Tests for GET /api/metadata/{id}/audio-url — a presigned GET for a
 * standalone audio file living in the main media bucket (as opposed to
 * POST /api/diary/media-url, which is diary-bucket-only).
 */

process.env.AC_TAU_MEDIA_MEDIA_BUCKET_NAME = "test-media-bucket";

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/audio-url/eventHandler";

const makeFakeServices = () => ({
  sourceS3Service: {
    getSignedUrl: jest.fn(
      async ({ Key }: any) => `https://signed.example/${Key}`,
    ),
  },
});

const invoke = async (
  services: ReturnType<typeof makeFakeServices>,
  id: string,
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: services,
  } as any;
  const event = { pathParameters: { id: encodeURIComponent(id) } };
  const result = await (lambdaHandler as any)(event, ctx);
  return {
    status: result.statusCode,
    headers: result.headers as Record<string, string>,
    body: JSON.parse(result.body),
  };
};

describe("GET /api/metadata/{id}/audio-url", () => {
  it("returns a presigned GET against the media bucket with the right playback MIME", async () => {
    const services = makeFakeServices();
    const key = "media/2024/08/15/recording.m4a";
    const { status, headers, body } = await invoke(services, key);

    expect(status).toBe(200);
    expect(body.url).toBe(`https://signed.example/${key}`);
    expect(services.sourceS3Service.getSignedUrl).toHaveBeenCalledWith({
      Bucket: "test-media-bucket",
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
    const key = `media/2024/08/15/recording.${ext}`;
    await invoke(services, key);
    expect(services.sourceS3Service.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ ResponseContentType: mime }),
    );
  });

  it.each([
    ["image key", "media/2024/08/15/photo.jpg"],
    ["video key", "media/2024/08/15/clip.mp4"],
    ["unsupported audio ext", "media/2024/08/15/song.mp3"],
    ["empty", ""],
  ])("rejects %s with 400", async (_label, key) => {
    const services = makeFakeServices();
    const { status } = await invoke(services, key);
    expect(status).toBe(400);
    expect(services.sourceS3Service.getSignedUrl).not.toHaveBeenCalled();
  });

  it("works for a diary-bucket-shaped key too — the bucket is fixed server-side, not derived from the key", async () => {
    const services = makeFakeServices();
    const key = "diary/2026/07/recording.m4a";
    const { status, body } = await invoke(services, key);
    expect(status).toBe(200);
    expect(body.url).toBe(`https://signed.example/${key}`);
  });
});
