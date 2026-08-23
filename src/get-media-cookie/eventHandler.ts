import { AcContext } from "@aspan-corporation/ac-shared";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";

/**
 * GET /api/auth/media-cookie
 *
 * Mints short-lived CloudFront signed cookies scoped to `/thumbs/*` for the
 * authenticated caller (the API Gateway Cognito authorizer gates this route,
 * so only signed-in users reach here). The browser then loads thumbnails,
 * full-size images, and videos as native <img>/<video> against the same
 * CloudFront origin — CloudFront validates the signature at the edge, so no
 * per-request Lambda@Edge runs and responses are browser-cacheable.
 *
 * The signing key pair is read from SSM at runtime (cached for the life of
 * the execution environment) rather than via a deploy-time CloudFormation
 * dynamic reference. This deliberately removes any deploy-time dependency on
 * the ac-infra-managed key-id parameter, which lets this Lambda deploy
 * before ac-infra creates it.
 */

const region = process.env.AWS_REGION || "us-east-1";

const PRIVATE_KEY_PARAM =
  process.env.CF_PRIVATE_KEY_PARAM ||
  "/ac/cloudfront/media-signing-private-key";
const KEY_ID_PARAM =
  process.env.CF_KEY_ID_PARAM || "/ac/cloudfront/media-signing-key-id";

// Cookie lifetime. The client refreshes well before this elapses.
const COOKIE_TTL_SECONDS = 2 * 60 * 60;

const ssm = new SSMClient({ region });

type SigningConfig = { privateKey: string; keyPairId: string };

// Cached across invocations in the same execution environment. Failures are
// not cached so a transient SSM error doesn't poison the container.
let configPromise: Promise<SigningConfig> | undefined;

const getConfig = (): Promise<SigningConfig> => {
  if (!configPromise) {
    configPromise = ssm
      .send(
        new GetParametersCommand({
          Names: [PRIVATE_KEY_PARAM, KEY_ID_PARAM],
          WithDecryption: true,
        }),
      )
      .then((res) => {
        const byName = new Map(
          (res.Parameters ?? []).map((p) => [p.Name, p.Value]),
        );
        const privateKey = byName.get(PRIVATE_KEY_PARAM);
        const keyPairId = byName.get(KEY_ID_PARAM);
        if (!privateKey || !keyPairId) {
          throw new Error(
            `missing media-signing SSM params: ${(res.InvalidParameters ?? []).join(", ") || "(value empty)"}`,
          );
        }
        return { privateKey, keyPairId };
      })
      .catch((err) => {
        configPromise = undefined;
        throw err;
      });
  }
  return configPromise;
};

export const lambdaHandler: Handler<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> = async (_event, ctx) => {
  const { logger } = ctx as unknown as AcContext;

  const { privateKey, keyPairId } = await getConfig();

  const expires = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  const policy = JSON.stringify({
    Statement: [
      {
        // Domain wildcarded rather than pinned to one alias: this
        // distribution is reachable at more than one domain name
        // (*.cloudfront.net and cocobolo.aspan.dev, with more possible in
        // future), and CloudFront's signed-cookie validation checks the
        // Resource against the actual request host — a pinned domain here
        // 403s every /thumbs/* request made from any OTHER alias. Scheme
        // and path stay locked down.
        Resource: "https://*/thumbs/*",
        Condition: { DateLessThan: { "AWS:EpochTime": expires } },
      },
    ],
  });

  const cookies = getSignedCookies({ keyPairId, privateKey, policy });

  // Host-only cookies (no Domain attribute) scoped to the CloudFront origin.
  // SameSite=Lax is sufficient because the SPA, the API, and /thumbs/* are
  // all served from the same CloudFront origin — image sub-requests are
  // same-site, so the cookies are sent. HttpOnly keeps them out of JS.
  const attrs = `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_SECONDS}`;
  const setCookies = Object.entries(cookies).map(
    ([name, value]) => `${name}=${value}; ${attrs}`,
  );

  logger.debug("issued media cookies", { expires });

  return {
    statusCode: 204,
    headers: { "Cache-Control": "no-store" },
    multiValueHeaders: { "Set-Cookie": setCookies },
    body: "",
  };
};
