import { jest } from "@jest/globals";
/**
 * Tests for the automatic-upload dispatcher: an EventBridge rule on
 * MediaBucket's native S3 notifications feeds this queue, replacing the
 * manual `ac-commander dispatch-s3-event` CLI as the trigger for media
 * processing.
 *
 * Queue URLs and the meta table name come from test/jest.setup-env.cjs
 * (global defaults: test-meta, https://sqs.test/*) — the same env vars
 * every other handler's tests already rely on, so no extra env wiring is
 * needed here.
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { recordHandler } from "../src/dispatcher/recordHandler";

const s3Event = (key: string, size = 12345, bucket = "test-media-bucket") =>
  JSON.stringify({
    "detail-type": "Object Created",
    source: "aws.s3",
    detail: {
      bucket: { name: bucket },
      object: { key, size },
    },
  });

const makeFakeServices = (existingMetaItem: unknown = undefined) => ({
  sqsService: { sendMessage: jest.fn(async () => ({})) },
  dynamoDBService: {
    getCommand: jest.fn(async () => ({ Item: existingMetaItem })),
    updateCommand: jest.fn(async () => ({})),
  },
});

const invoke = async (
  services: ReturnType<typeof makeFakeServices>,
  body: string,
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    metrics: { addMetric: jest.fn() },
    acServices: services,
  } as any;
  const record = { body } as any;
  await (recordHandler as any)(record, ctx);
};

describe("dispatcher recordHandler", () => {
  it("dispatches a new image to meta + resizer", async () => {
    const services = makeFakeServices();
    await invoke(services, s3Event("media/2024/08/photo.jpg"));

    expect(services.dynamoDBService.getCommand).toHaveBeenCalledWith({
      TableName: "test-meta",
      Key: { id: "media/2024/08/photo.jpg" },
    });
    const urls = services.sqsService.sendMessage.mock.calls.map(
      (c: any) => c[0].QueueUrl,
    );
    expect(urls.sort()).toEqual(
      ["https://sqs.test/meta", "https://sqs.test/resizer"].sort(),
    );
  });

  it("dispatches a new video to all three video-pipeline queues", async () => {
    const services = makeFakeServices();
    await invoke(services, s3Event("media/2024/08/clip.mov"));

    const urls = services.sqsService.sendMessage.mock.calls.map(
      (c: any) => c[0].QueueUrl,
    );
    expect(urls.sort()).toEqual(
      [
        "https://sqs.test/video-meta",
        "https://sqs.test/video-encoder",
        "https://sqs.test/video-thumbs",
      ].sort(),
    );
  });

  it("dispatches a new audio file to meta only", async () => {
    const services = makeFakeServices();
    await invoke(services, s3Event("media/2024/08/recording.m4a"));

    expect(services.sqsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(services.sqsService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ QueueUrl: "https://sqs.test/meta" }),
    );
  });

  it("skips a key that already has a meta item, without touching any queue", async () => {
    const services = makeFakeServices({ id: "media/2024/08/photo.jpg" });
    await invoke(services, s3Event("media/2024/08/photo.jpg"));
    expect(services.sqsService.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["macOS Finder debris", "media/2024/08/.DS_Store"],
    ["a folder placeholder key", "media/2024/08/"],
    ["a macOS resource fork", "media/2024/08/._IMG_0001.jpg"],
    ["an unrecognized extension", "media/2024/08/notes.txt"],
  ])("skips %s without an error or a DynamoDB lookup", async (_label, key) => {
    const services = makeFakeServices();
    await invoke(services, s3Event(key));
    expect(services.dynamoDBService.getCommand).not.toHaveBeenCalled();
    expect(services.sqsService.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a key outside media/ (e.g. a diary key reaching this queue by mistake)", async () => {
    const services = makeFakeServices();
    await invoke(services, s3Event("diary/2024/08/photo.jpg"));
    expect(services.dynamoDBService.getCommand).not.toHaveBeenCalled();
    expect(services.sqsService.sendMessage).not.toHaveBeenCalled();
  });

  it("ensures ancestor folder markers for a genuinely new key", async () => {
    const services = makeFakeServices();
    await invoke(services, s3Event("media/2027/new-album/photo.jpg"));

    const markerIds = services.dynamoDBService.updateCommand.mock.calls.map(
      (c: any) => c[0].Key.id,
    );
    expect(markerIds).toEqual([
      "media/2027/new-album/",
      "media/2027/",
      "media/",
    ]);
  });

  it("still dispatches processing even if folder-marker creation fails", async () => {
    const services = makeFakeServices();
    services.dynamoDBService.updateCommand.mockRejectedValue(
      new Error("boom") as never,
    );
    await invoke(services, s3Event("media/2024/08/photo.jpg"));
    expect(services.sqsService.sendMessage).toHaveBeenCalled();
  });
});
