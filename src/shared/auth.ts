import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const ADMIN_GROUP = "admin";

/**
 * The app-level "hidden" tag. Must match
 * ac-cocobolo/src/common/constants.ts:TAG_HIDDEN (and the copy in
 * hide-folder/eventHandler.ts). Adding or removing this tag is an
 * admin-only operation — see requireAdmin below.
 */
export const TAG_HIDDEN = "ac:ediacara:hidden";

type Claims = { [name: string]: string | undefined };

/**
 * Parse the `cognito:groups` claim that API Gateway attaches to the request
 * from the verified Cognito ID token. API Gateway surfaces it in a few shapes
 * depending on how many groups the user belongs to:
 *   - undefined        — user is in no groups
 *   - "admin"          — single group
 *   - "admin,user"     — comma-joined
 *   - "[admin user]"   — REST-API array stringification (space-separated)
 */
export const groupsFromEvent = (event: APIGatewayProxyEvent): string[] => {
  const claims = (event.requestContext.authorizer as { claims?: Claims } | null | undefined)
    ?.claims;
  const raw = claims?.["cognito:groups"];
  if (!raw) return [];
  if (Array.isArray(raw)) return (raw as unknown[]).map(String);
  return String(raw)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter(Boolean);
};

export const isAdmin = (event: APIGatewayProxyEvent): boolean =>
  groupsFromEvent(event).includes(ADMIN_GROUP);

const forbidden: APIGatewayProxyResult = {
  statusCode: 403,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Forbidden: admin role required" }),
};

/**
 * Guard for admin-only operations. Returns a 403 result to early-return when
 * the caller is not an admin, or null when the caller is allowed:
 *
 *   const denied = requireAdmin(event);
 *   if (denied) return denied;
 */
export const requireAdmin = (
  event: APIGatewayProxyEvent,
): APIGatewayProxyResult | null => (isAdmin(event) ? null : forbidden);

/** Whether a tag list contains the hidden tag. */
export const hasHiddenTag = (
  tags: Array<{ key: string; value: string }>,
): boolean => tags.some((t) => t.key === TAG_HIDDEN);
