import { jest } from "@jest/globals";
/**
 * Tests for the diary handler's audio SEARCH support (as distinct from the
 * playback/upload support in diaryMediaUrl.test.ts):
 *  - PUT save dispatches an embedded audio recording to the meta-extractor
 *    queue ONLY (so it gets a searchable meta item), never the resizer or any
 *    video queue (a voice memo has no thumbnail).
 *  - Audio that already has a meta item is not re-dispatched.
 * Queue URLs come from test/jest.setup-env.cjs (the per-file process.env
 * assignments are dead — ESM hoists the handler import above them).
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { lambdaHandler } from "../src/diary/eventHandler";

const META_QUEUE = "https://sqs.test/meta";

type Tag = { key: string; value: string };

const makeFakeServices = ({
  existingObjects = new Set<string>(),
  seedMeta = new Set<string>(),
} = {}) => {
  const dbStore = new Map<string, { id: string; tags: Tag[] }>();
  for (const id of seedMeta) dbStore.set(id, { id, tags: [] });
  const sourceS3Service = {
    getSignedUploadUrl: jest.fn(
      async ({ Key }: any) => `https://upload.example/${Key}`,
    ),
    headObject: jest.fn(async ({ Key }: any) => {
      if (!existingObjects.has(Key)) throw new Error("NotFound");
      return { ContentLength: 4096 };
    }),
    putObject: jest.fn(async () => ({})),
    getObject: jest.fn(async () => Buffer.from("")),
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

const putAudio = async (
  services: ReturnType<typeof makeFakeServices>,
  audioKey: string,
) => {
  const ctx = {
    logger: new Logger({ serviceName: "test" }),
    acServices: services,
  } as any;
  const result = await (lambdaHandler as any)(
    {
      resource: "/api/diary/{id}",
      httpMethod: "PUT",
      pathParameters: { id: encodeURIComponent("diary/2026/07/20260704.md") },
      body: JSON.stringify({
        title: "Note",
        markdown: `A voice note.\n![audio](<${audioKey}>)\n`,
      }),
    },
    ctx,
  );
  return { status: result.statusCode };
};

const sends = (services: ReturnType<typeof makeFakeServices>) =>
  services.sqsService.sendMessage.mock.calls.map(([arg]: any) => ({
    queue: arg.QueueUrl,
    key: JSON.parse(arg.MessageBody).detail.object.key,
  }));

describe("PUT /api/diary/{id} embedded audio → search dispatch", () => {
  it("dispatches audio to the meta queue only (no resizer, no video queues)", async () => {
    const audioKey = "diary/2026/07/recording-20260704-101500.m4a";
    const services = makeFakeServices({
      existingObjects: new Set([audioKey]),
    });

    const { status } = await putAudio(services, audioKey);
    expect(status).toBe(200);

    const all = sends(services);
    expect(all).toEqual([{ queue: META_QUEUE, key: audioKey }]);
  });

  it("does not re-dispatch audio that already has a meta item", async () => {
    const audioKey = "diary/2026/07/recording-20260704-101500.webm";
    const services = makeFakeServices({
      existingObjects: new Set([audioKey]),
      seedMeta: new Set([audioKey]),
    });

    const { status } = await putAudio(services, audioKey);
    expect(status).toBe(200);
    expect(services.sqsService.sendMessage).not.toHaveBeenCalled();
  });
});
