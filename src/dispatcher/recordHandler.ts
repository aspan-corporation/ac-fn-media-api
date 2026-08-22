import {
  AcContext,
  assertEnvVar,
  buildProcessingMessageBody,
  ensureFolderMarkers,
  isIgnorableKey,
  MetricUnit,
  queueRolesForKey,
  type MediaQueueRole,
} from "@aspan-corporation/ac-shared";
import type { S3ObjectCreatedNotificationEvent, SQSRecord } from "aws-lambda";
import assert from "node:assert/strict";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

// Every upload lands under media/ — the EventBridge rule that feeds this
// queue is itself filtered to that prefix, so this is a second, cheap
// confirmation rather than the only gate.
const MEDIA_ROOT_PREFIX = "media/";

const queueUrlForRole: Record<MediaQueueRole, string> = {
  meta: assertEnvVar("AC_META_QUEUE_URL"),
  resizer: assertEnvVar("AC_RESIZER_QUEUE_URL"),
  videoMeta: assertEnvVar("AC_VIDEO_META_QUEUE_URL"),
  videoEncoder: assertEnvVar("AC_VIDEO_ENCODER_QUEUE_URL"),
  videoThumbs: assertEnvVar("AC_VIDEO_THUMBS_QUEUE_URL"),
};

/**
 * Automatic replacement for the manual `ac-commander dispatch-s3-event` CLI:
 * an EventBridge rule on MediaBucket's native S3 notifications (filtered to
 * media/) feeds this queue directly, so a browser or CLI upload gets
 * thumbnailed/indexed with no operator step.
 *
 * Per key: skip junk (isIgnorableKey — macOS Finder debris, folder markers,
 * unrecognized extensions) as a metric, not an error; skip anything that
 * already has a meta item (a re-sync or storage-class copy shouldn't re-run
 * a video encode); otherwise ensure the key's ancestor folders are
 * browsable and fan out to every queue its type needs — all in parallel,
 * since nothing in the pipeline enforces ordering between them (the
 * resizer's blurhash write upserts via if_not_exists specifically so this
 * is safe regardless of which queue's consumer finishes first).
 */
export const recordHandler = async (
  record: SQSRecord,
  context: AcContext,
): Promise<void> => {
  const { logger, metrics, acServices = {} } = context;
  const { sqsService, dynamoDBService } = acServices;
  assert(sqsService, "sqsService is required in context.acServices");
  assert(dynamoDBService, "dynamoDBService is required in context.acServices");

  const payload = record.body;
  assert(payload, "SQS record has no body");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch (e) {
    logger.error("Failed to parse SQS record payload", { error: e });
    throw new Error(
      `Failed to parse SQS record payload: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const item = parsed as unknown as S3ObjectCreatedNotificationEvent;

  const {
    detail: {
      object: { key, size },
      bucket: { name: bucket },
    },
  } = item;

  assert(key, "detail.object.key is missing from event payload");
  assert(
    size !== undefined && size !== null,
    "detail.object.size is missing from event payload",
  );
  assert(bucket, "detail.bucket.name is missing from event payload");

  if (!key.startsWith(MEDIA_ROOT_PREFIX) || isIgnorableKey(key)) {
    logger.debug("skipping ignorable or out-of-scope key", { key });
    metrics.addMetric("DispatchSkippedIgnorable", MetricUnit.Count, 1);
    return;
  }

  const roles = queueRolesForKey(key);
  if (roles.length === 0) {
    // isIgnorableKey already covers "no recognized role" — reaching here
    // would mean the two fell out of sync. Stay defensive rather than
    // silently doing nothing with no signal at all.
    logger.warn("key has a role-less extension isIgnorableKey didn't catch", {
      key,
    });
    metrics.addMetric("DispatchSkippedNoRole", MetricUnit.Count, 1);
    return;
  }

  const { Item: existing } = await dynamoDBService.getCommand({
    TableName: metaTableName,
    Key: { id: key },
  });
  if (existing) {
    logger.debug("skipping already-processed key", { key });
    metrics.addMetric("DispatchSkippedAlreadyProcessed", MetricUnit.Count, 1);
    return;
  }

  // Best-effort: make the new item's ancestor folders browsable. A failure
  // here must not block dispatching the actual processing.
  try {
    await ensureFolderMarkers(
      dynamoDBService,
      metaTableName,
      key,
      MEDIA_ROOT_PREFIX,
    );
  } catch (err) {
    logger.warn("folder marker creation failed", { key, err: String(err) });
  }

  const body = buildProcessingMessageBody({
    bucket,
    key,
    size,
    source: "ac.dispatcher",
  });
  await Promise.all(
    roles.map((role) =>
      sqsService.sendMessage({
        QueueUrl: queueUrlForRole[role],
        MessageBody: body,
      }),
    ),
  );

  logger.info("dispatched media for processing", { key, roles });
  metrics.addMetric("DispatchedForProcessing", MetricUnit.Count, 1);
};
