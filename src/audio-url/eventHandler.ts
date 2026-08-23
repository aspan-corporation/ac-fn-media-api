import {
  AcContext,
  assertEnvVar,
  getKeyExtension,
  isAllowedAudioExtension,
} from "@aspan-corporation/ac-shared";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import assert from "node:assert";

const mediaBucketName = assertEnvVar("AC_TAU_MEDIA_MEDIA_BUCKET_NAME");

// Playback MIME by audio extension (see AUDIO_EXTENSIONS in ac-shared).
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

export const lambdaHandler: Handler<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> = async (event, ctx) => {
  const { logger, acServices = {} } = ctx as unknown as AcContext;
  const { sourceS3Service } = acServices;
  assert(sourceS3Service, "sourceS3Service is required in context.acServices");

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  const id = decodeURIComponent(event.pathParameters?.id ?? "");
  logger.debug("getAudioUrl", { id });

  if (!id || !isAllowedAudioExtension(id)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: "id must be an audio file" }),
    };
  }

  const url = await sourceS3Service.getSignedUrl({
    Bucket: mediaBucketName,
    Key: id,
    // Force the right playback MIME even if the stored Content-Type is
    // wrong or missing — files uploaded straight to S3 outside the app
    // commonly don't carry one.
    ResponseContentType: AUDIO_CONTENT_TYPES[getKeyExtension(id)],
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ url }),
  };
};
