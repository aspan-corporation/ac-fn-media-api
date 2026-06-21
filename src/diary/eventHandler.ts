import {
  AcContext,
  assertEnvVar,
  deriveFolder,
  DIARY_PREFIX,
  diaryPreview,
  extractEmbeddedPhotoKeys,
  isAllowedExtension,
  isDiaryKey,
  parseDiaryKeyDate,
  TAG_DIARY_ENTRY,
  TAG_DIARY_PHOTO,
  TAG_DIARY_PREVIEW,
  TAG_DIARY_TITLE,
  TEXT_TOKEN_PREFIX,
  tokenizeText,
} from "@aspan-corporation/ac-shared";
import type { S3Service, SQSService, DynamoDBService } from "@aspan-corporation/ac-shared";
import { Logger } from "@aws-lambda-powertools/logger";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const diaryBucketName = assertEnvVar("AC_DIARY_BUCKET_NAME");
// SQS queues of the shared processing Lambdas. Diary-uploaded images are pushed
// here on save (the same SQS-driven model ac-commander uses) so they get
// thumbnails + search indexing like media-bucket photos. There is no media
// state-machine in this account, so we dispatch the queues directly.
const metaQueueUrl = assertEnvVar("AC_META_QUEUE_URL");
const resizerQueueUrl = assertEnvVar("AC_RESIZER_QUEUE_URL");

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

type Tag = { key: string; value: string };

// Date tag keys this handler owns — re-derived from the diary key on each write.
// (Other ac:tau:* tags, e.g. ac:tau:virtualAlbum, are preserved.)
const MANAGED_DATE_KEYS = new Set([
  "ac:tau:yearCreated",
  "ac:tau:monthCreated",
  "ac:tau:dayCreated",
  "ac:tau:dateCreated",
  "ac:tau:hasDate",
]);

// Tags the diary API fully owns and recomputes from the body on every write.
// Everything else on the item (favorite, album membership, hidden, user tags)
// is preserved across edits.
const isManagedTag = (key: string): boolean =>
  key.startsWith(TEXT_TOKEN_PREFIX) ||
  key.startsWith("ac:diary:") ||
  MANAGED_DATE_KEYS.has(key);

// Reduce a browser-supplied filename to a safe S3 leaf name: strip any path
// components, collapse anything outside a conservative allowlist to "_", and
// cap the length. Returns "" for empty / all-dot names.
const sanitizeFilename = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return /^\.*$/.test(cleaned) ? "" : cleaned;
};

const splitExt = (name: string): [string, string] => {
  const i = name.lastIndexOf(".");
  return i <= 0 ? [name, ""] : [name.slice(0, i), name.slice(i)];
};

const objectExists = async (
  s3: S3Service,
  Bucket: string,
  Key: string,
): Promise<boolean> => {
  try {
    await s3.headObject({ Bucket, Key });
    return true;
  } catch {
    // Missing object → HeadObject 404 (the Lambda role has GetObject on the
    // bucket, so a miss is NotFound, not AccessDenied). Treat any failure as
    // "free to use" — at worst we pick a fresh name.
    return false;
  }
};

// Find a key under `prefix` that doesn't already exist, auto-suffixing the
// stem (`name`, `name-2`, `name-3`, …) so an upload never overwrites a prior
// photo. Falls back to a timestamped name in the pathological case.
const resolveUniqueKey = async (
  s3: S3Service,
  bucket: string,
  prefix: string,
  filename: string,
): Promise<string> => {
  const [stem, ext] = splitExt(filename);
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? `${prefix}${filename}` : `${prefix}${stem}-${n}${ext}`;
    if (!(await objectExists(s3, bucket, candidate))) return candidate;
  }
  return `${prefix}${stem}-${Date.now()}${ext}`;
};

// Ancestor folder paths of a key, from its own folder up to (and including)
// the diary root. e.g. "diary/2026/06/x.jpg" → ["diary/2026/06/",
// "diary/2026/", "diary/"].
const ancestorFolders = (key: string): string[] => {
  const folders: string[] = [];
  let f = deriveFolder(key);
  while (f && f !== "/" && f.startsWith(DIARY_PREFIX)) {
    folders.push(f);
    f = deriveFolder(f);
  }
  return folders;
};

/**
 * Ensure folder-marker meta items exist for a diary photo's ancestor folders so
 * the diary subtree is navigable in the Folders browser (ListFolder queries the
 * `by-folder` GSI, which needs a marker item per folder level). Diary images are
 * object keys, not folder keys, so nothing else creates these markers. Each
 * marker is written only if absent (so we never clobber a real item).
 */
const ensureDiaryFolderMarkers = async (
  dynamoDBService: NonNullable<AcContext["acServices"]>["dynamoDBService"],
  key: string,
): Promise<void> => {
  assert(dynamoDBService);
  for (const id of ancestorFolders(key)) {
    try {
      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id },
        UpdateExpression: "SET #folder = :folder, tags = :tags",
        ConditionExpression: "attribute_not_exists(id)",
        ExpressionAttributeNames: { "#folder": "folder" },
        ExpressionAttributeValues: { ":folder": deriveFolder(id), ":tags": [] },
      });
    } catch (err) {
      // ConditionalCheckFailed → marker already exists; anything else is
      // non-fatal for issuing the upload URL.
      const name = err instanceof Error ? err.name : String(err);
      if (name !== "ConditionalCheckFailedException") {
        // best-effort; surfaced by the caller's logger
        throw err;
      }
    }
  }
};

// SQS body the resizer/meta-extractor recordHandlers expect: an EventBridge-
// shaped event with detail.bucket.name + detail.object.{key,size} and NO
// taskToken (so each Lambda processes standalone). Mirrors ac-commander's
// MessageDispatchProcessor envelope.
const processingMessageBody = (key: string, size: number): string =>
  JSON.stringify({
    "detail-type": "FileUploaded",
    source: "ac.diary",
    detail: {
      bucket: { name: diaryBucketName },
      object: { key, size },
    },
  });

/**
 * Push newly-embedded diary-bucket images to the meta-extractor + resizer queues
 * so they get indexed + thumbnailed like media-bucket photos. Skips images that
 * already have a meta item (already processed) so re-saving doesn't reprocess.
 * Best-effort: never fails the save.
 */
const dispatchDiaryImageProcessing = async (
  sqsService: SQSService,
  s3: S3Service,
  dynamoDBService: DynamoDBService,
  markdown: string,
  logger: Logger,
): Promise<void> => {
  const keys = [
    ...new Set(
      extractEmbeddedPhotoKeys(markdown).filter(
        (k) => k.startsWith(DIARY_PREFIX) && isAllowedExtension(k),
      ),
    ),
  ];
  for (const key of keys) {
    try {
      const { Item } = await dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id: key },
      });
      if (Item) continue; // already processed
      const head = await s3.headObject({ Bucket: diaryBucketName, Key: key });
      const body = processingMessageBody(key, head.ContentLength ?? 0);
      await Promise.all([
        sqsService.sendMessage({ QueueUrl: metaQueueUrl, MessageBody: body }),
        sqsService.sendMessage({ QueueUrl: resizerQueueUrl, MessageBody: body }),
      ]);
      logger.info("dispatched diary image for processing", { key });
    } catch (err) {
      logger.warn("diary image dispatch failed", { key, err: String(err) });
    }
  }
};

/**
 * /api/diary/{id} — one lambda, dispatched by HTTP method. `id` is the
 * URL-encoded diary key `diary/YYYY/MM/YYYYMMDD.md`; the entry date is derived
 * from the key, so the body only carries `{ title, markdown }`.
 *
 * - GET    → { id, markdown, tags }
 * - PUT    → write markdown to the diary bucket + (re)index the meta item
 * - DELETE → remove the object and its meta item
 */
export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService, sourceS3Service, sqsService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");
    assert(sourceS3Service, "sourceS3Service is required in context.acServices");

    // ── POST /api/diary/upload-url ─────────────────────────────────────
    // Hand the browser a presigned PUT so it can upload an image straight to
    // the diary bucket (bytes never pass through the API). Body: { id, filename }
    // where `id` is the entry's diary key. The object lands at
    // diary/YYYY/MM/<filename> — YYYY/MM from the entry date — auto-suffixed so
    // it never overwrites an existing photo. Once written, the diary-bucket
    // EventBridge rule runs it through the media pipeline (thumbnails + search),
    // making it render and search exactly like a media-bucket photo.
    if (event.resource?.endsWith("/upload-url")) {
      if (event.httpMethod !== "POST") {
        return json(405, { message: `Method ${event.httpMethod} not allowed` });
      }
      let upBody: Record<string, unknown>;
      try {
        upBody = JSON.parse(event.body ?? "{}");
      } catch {
        return json(400, { message: "Invalid JSON body" });
      }
      const entryId = typeof upBody.id === "string" ? upBody.id : "";
      const filename = typeof upBody.filename === "string" ? upBody.filename : "";
      const d = isDiaryKey(entryId) ? parseDiaryKeyDate(entryId) : null;
      if (!d) {
        return json(400, {
          message: "id must be a diary key (diary/YYYY/MM/YYYYMMDD.md)",
        });
      }
      const safe = sanitizeFilename(filename);
      if (!safe || !isAllowedExtension(safe)) {
        return json(400, {
          message: "filename must be an image with a supported extension",
        });
      }
      const mm = String(d.month).padStart(2, "0");
      const prefix = `${DIARY_PREFIX}${d.year}/${mm}/`;
      const key = await resolveUniqueKey(
        sourceS3Service,
        diaryBucketName,
        prefix,
        safe,
      );
      // Best-effort: make the diary folder tree browsable. A failure here must
      // not block the upload, so swallow and log.
      try {
        await ensureDiaryFolderMarkers(dynamoDBService, key);
      } catch (err) {
        logger.warn("diary folder marker creation failed", {
          key,
          err: String(err),
        });
      }
      const url = await sourceS3Service.getSignedUploadUrl({
        Bucket: diaryBucketName,
        Key: key,
      });
      logger.info("diary upload url issued", { key });
      return json(200, { url, key });
    }

    const id = decodeURIComponent(event.pathParameters?.id ?? "");
    if (!id) return json(400, { message: "id is required" });
    if (!isDiaryKey(id)) {
      return json(400, {
        message: "id must be a diary key (diary/YYYY/MM/YYYYMMDD.md)",
      });
    }

    const method = event.httpMethod;

    // ── GET ────────────────────────────────────────────────────────────
    if (method === "GET") {
      let markdown = "";
      try {
        const buf = await sourceS3Service.getObject({
          Bucket: diaryBucketName,
          Key: id,
        });
        markdown = buf.toString("utf8");
      } catch (err) {
        // Missing object → treat as an empty (not-yet-saved) entry.
        logger.debug("diary getObject miss", { id, err: String(err) });
      }
      const { Item } = await dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id },
      });
      return json(200, { id, markdown, tags: (Item?.tags ?? []) as Tag[] });
    }

    // ── DELETE ─────────────────────────────────────────────────────────
    if (method === "DELETE") {
      await sourceS3Service.deleteObject({ Bucket: diaryBucketName, Key: id });
      await dynamoDBService.batchWriteCommand({
        RequestItems: {
          [metaTableName]: [{ DeleteRequest: { Key: { id } } }],
        },
      });
      logger.info("diary deleted", { id });
      return json(200, { id, deleted: true });
    }

    // ── PUT (create / update) ──────────────────────────────────────────
    if (method === "PUT") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? "{}");
      } catch {
        return json(400, { message: "Invalid JSON body" });
      }
      const title = typeof body.title === "string" ? body.title.slice(0, 200) : "";
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      if (!markdown.trim() && !title.trim()) {
        return json(400, { message: "title or markdown is required" });
      }

      // 1. Write the markdown object to the diary bucket.
      await sourceS3Service.putObject({
        Bucket: diaryBucketName,
        Key: id,
        Body: markdown,
        ContentType: "text/markdown; charset=utf-8",
      });

      // 2. Read existing meta; preserve everything the diary API doesn't own.
      const { Item: existing } = await dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id },
      });
      const existingTags = (existing?.tags ?? []) as Tag[];
      const preserved = existingTags.filter((t) => !isManagedTag(t.key));

      // 3. Date tags derived from the key (same ac:tau:* keys photos use, so the
      //    entry surfaces in On This Day and date search alongside pictures).
      const d = parseDiaryKeyDate(id);
      assert(d, "diary key date parse failed");
      const iso = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      const dateTags: Tag[] = [
        { key: "ac:tau:yearCreated", value: String(d.year) },
        { key: "ac:tau:monthCreated", value: String(d.month) },
        { key: "ac:tau:dayCreated", value: String(d.day) },
        { key: "ac:tau:dateCreated", value: iso },
        { key: "ac:tau:hasDate", value: "true" },
      ];

      // 4. Diary metadata + searchable body tokens + embedded-photo links.
      const diaryTags: Tag[] = [
        { key: TAG_DIARY_ENTRY, value: "true" },
        ...(title ? [{ key: TAG_DIARY_TITLE, value: title }] : []),
        { key: TAG_DIARY_PREVIEW, value: diaryPreview(markdown) },
      ];
      const tokenTags: Tag[] = tokenizeText(markdown).map((tok) => ({
        key: TEXT_TOKEN_PREFIX + tok,
        value: "",
      }));
      const photoTags: Tag[] = extractEmbeddedPhotoKeys(markdown).map((k) => ({
        key: TAG_DIARY_PHOTO,
        value: k,
      }));

      const finalTags = [
        ...preserved,
        ...dateTags,
        ...diaryTags,
        ...tokenTags,
        ...photoTags,
      ];

      // 5. Write the meta item with the `folder` GSI attribute set.
      await dynamoDBService.updateCommand({
        TableName: metaTableName,
        Key: { id },
        UpdateExpression: "SET tags = :tags, #folder = :folder",
        ExpressionAttributeNames: { "#folder": "folder" },
        ExpressionAttributeValues: {
          ":tags": finalTags,
          ":folder": deriveFolder(id),
        },
      });

      // Dispatch any newly-embedded diary-bucket images for processing
      // (thumbnails + search). Best-effort; never fails the save.
      if (sqsService) {
        await dispatchDiaryImageProcessing(
          sqsService,
          sourceS3Service,
          dynamoDBService,
          markdown,
          logger,
        );
      }

      logger.info("diary saved", { id, tokenCount: tokenTags.length });
      return json(200, { id, tags: finalTags });
    }

    return json(405, { message: `Method ${method} not allowed` });
  };
