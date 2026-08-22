import {
  AcContext,
  assertEnvVar,
  isAllowedAudioExtension,
  isAllowedExtension,
  isAllowedVideoExtension,
} from "@aspan-corporation/ac-shared";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import assert from "node:assert";
import { parseUploadHints, sanitizeFilename } from "../shared/uploadHints.js";

const mediaBucketName = assertEnvVar("AC_TAU_MEDIA_MEDIA_BUCKET_NAME");

const headers = { "Content-Type": "application/json" };
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * media/YYYY/MM/DD/<uuid>.<ext> — a UUID leaf so concurrent uploads (or two
 * cameras producing the same filename, e.g. IMG_0001.jpg) never collide,
 * same reasoning as diaryMediaKey. Dated from `hintDateIso` when the browser
 * supplied one (the device's own file timestamp), else from now — the key's
 * date is a filing convenience only; the item's *searchable* date comes from
 * real EXIF once the meta-extractor runs, which wins over this if the two
 * disagree (e.g. a re-downloaded file with a stale OS timestamp).
 */
export const buildMediaUploadKey = (
  hintDateIso: string | undefined,
  ext: string,
): string => {
  const d = hintDateIso ? new Date(hintDateIso) : new Date();
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const uuid = globalThis.crypto.randomUUID();
  return `media/${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${uuid}.${cleanExt}`;
};

/**
 * POST /api/media/upload-url — hand the browser a presigned PUT so it can
 * upload a photo, video, or audio recording straight to the media library
 * (bytes never pass through the API). Body: { filename, hints? }, where
 * `hints` carries the optional device date/location (see parseUploadHints).
 * No dispatch here and no folder-marker bookkeeping — unlike the diary
 * upload path, the media bucket auto-triggers the dispatcher (EventBridge)
 * on the real S3 PUT, which handles both once the object actually lands.
 */
export const lambdaHandler: Handler<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> = async (event, ctx) => {
  const { logger, acServices = {} } = ctx as unknown as AcContext;
  const { sourceS3Service } = acServices;
  assert(sourceS3Service, "sourceS3Service is required in context.acServices");

  if (event.httpMethod !== "POST") {
    return json(405, { message: `Method ${event.httpMethod} not allowed` });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const safe = sanitizeFilename(filename);
  if (
    !safe ||
    !(
      isAllowedExtension(safe) ||
      isAllowedAudioExtension(safe) ||
      isAllowedVideoExtension(safe)
    )
  ) {
    return json(400, {
      message:
        "filename must be an image, audio, or video file with a supported extension",
    });
  }

  const hintMetadata = parseUploadHints(body.hints);
  const ext = safe.slice(safe.lastIndexOf(".") + 1);
  const key = buildMediaUploadKey(hintMetadata["hint-date"], ext);

  const url = await sourceS3Service.getSignedUploadUrl({
    Bucket: mediaBucketName,
    Key: key,
    ...(Object.keys(hintMetadata).length > 0
      ? { Metadata: hintMetadata }
      : {}),
  });

  logger.info("media upload url issued", {
    key,
    hasDateHint: "hint-date" in hintMetadata,
    hasLocationHint: "hint-latitude" in hintMetadata,
  });
  return json(200, { url, key });
};
