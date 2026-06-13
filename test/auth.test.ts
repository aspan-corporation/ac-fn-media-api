/**
 * Tests for the admin-authorization helper used to gate hide/delete
 * operations. Verifies the cognito:groups claim is parsed across the shapes
 * API Gateway surfaces it in, and that requireAdmin returns 403 for
 * non-admins.
 */

import type { APIGatewayProxyEvent } from "aws-lambda";
import { groupsFromEvent, isAdmin, requireAdmin, hasHiddenTag } from "../src/shared/auth";

const eventWithGroups = (groups: unknown): APIGatewayProxyEvent =>
  ({
    requestContext: {
      authorizer: groups === undefined ? {} : { claims: { "cognito:groups": groups } },
    },
  } as unknown as APIGatewayProxyEvent);

describe("groupsFromEvent", () => {
  it("returns [] when no authorizer/claims/groups present", () => {
    expect(groupsFromEvent({ requestContext: {} } as any)).toEqual([]);
    expect(groupsFromEvent(eventWithGroups(undefined))).toEqual([]);
  });

  it("parses a single group", () => {
    expect(groupsFromEvent(eventWithGroups("admin"))).toEqual(["admin"]);
  });

  it("parses a comma-joined string", () => {
    expect(groupsFromEvent(eventWithGroups("admin,user"))).toEqual(["admin", "user"]);
  });

  it("parses the REST-API array-stringified, space-separated shape", () => {
    expect(groupsFromEvent(eventWithGroups("[admin user]"))).toEqual(["admin", "user"]);
  });

  it("parses an actual array", () => {
    expect(groupsFromEvent(eventWithGroups(["admin", "user"]))).toEqual(["admin", "user"]);
  });
});

describe("isAdmin / requireAdmin", () => {
  it("is true only when the admin group is present", () => {
    expect(isAdmin(eventWithGroups("admin"))).toBe(true);
    expect(isAdmin(eventWithGroups("[user admin]"))).toBe(true);
    expect(isAdmin(eventWithGroups("user"))).toBe(false);
    expect(isAdmin(eventWithGroups(undefined))).toBe(false);
  });

  it("requireAdmin returns null for admins and a 403 for everyone else", () => {
    expect(requireAdmin(eventWithGroups("admin"))).toBeNull();

    const denied = requireAdmin(eventWithGroups("user"));
    expect(denied).not.toBeNull();
    expect(denied!.statusCode).toBe(403);
  });
});

describe("hasHiddenTag", () => {
  it("detects the hidden tag regardless of value", () => {
    expect(hasHiddenTag([{ key: "ac:ediacara:hidden", value: "true" }])).toBe(true);
    expect(hasHiddenTag([{ key: "ac:ediacara:favorite", value: "" }])).toBe(false);
    expect(hasHiddenTag([])).toBe(false);
  });
});
