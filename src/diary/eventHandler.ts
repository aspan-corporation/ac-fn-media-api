import {
  AcContext,
  assertEnvVar,
  deriveFolder,
  diaryPreview,
  extractEmbeddedPhotoKeys,
  isDiaryKey,
  parseDiaryKeyDate,
  TAG_DIARY_ENTRY,
  TAG_DIARY_PHOTO,
  TAG_DIARY_PREVIEW,
  TAG_DIARY_TITLE,
  TEXT_TOKEN_PREFIX,
  tokenizeText,
} from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const diaryBucketName = assertEnvVar("AC_DIARY_BUCKET_NAME");

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
    const { dynamoDBService, sourceS3Service } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");
    assert(sourceS3Service, "sourceS3Service is required in context.acServices");

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

      logger.info("diary saved", { id, tokenCount: tokenTags.length });
      return json(200, { id, tags: finalTags });
    }

    return json(405, { message: `Method ${method} not allowed` });
  };
