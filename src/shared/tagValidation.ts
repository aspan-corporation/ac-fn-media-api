// Tag-namespace conventions:
//   ac:tau:*       — system tags written by the metadata-extractor pipeline.
//                     Clients must NOT write these via update-metadata.
//   ac:ediacara:*  — app-level tags written by the UI (favorite, hidden,
//                     virtual album). Clients ARE allowed to write these.
//   anything else  — user-defined tags. Allowed.

import type { Tag } from "./types.js";

const SYSTEM_TAU_PREFIX = "ac:tau:";

const MAX_TAGS = 100;
const MAX_KEY_LEN = 200;
const MAX_VALUE_LEN = 1000;

export type TagValidationResult =
  | { ok: true; tags: Tag[]; strippedSystemTagCount: number }
  | { ok: false; message: string };

/**
 * Validates incoming tags from the API, returning a clean list of user/app
 * tags ready to merge with server-managed system tags.
 *
 * Policy:
 *   - shape, length caps, and array-size cap are enforced strictly (400)
 *   - any `ac:tau:*` system tag in the input is *silently dropped*; the
 *     final write reattaches the authoritative system tags from the DB.
 *     This makes the API forgiving for legacy clients that resend the
 *     full tag list, while keeping system tags server-authoritative.
 */
export const validateTagsInput = (raw: unknown): TagValidationResult => {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "tags must be an array" };
  }
  if (raw.length > MAX_TAGS) {
    return { ok: false, message: `at most ${MAX_TAGS} tags are allowed` };
  }

  const tags: Tag[] = [];
  let stripped = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as unknown;
    if (
      typeof t !== "object" ||
      t === null ||
      typeof (t as Tag).key !== "string" ||
      typeof (t as Tag).value !== "string"
    ) {
      return {
        ok: false,
        message: `tags[${i}] must be { key: string, value: string }`,
      };
    }

    const key = (t as Tag).key;
    const value = (t as Tag).value;

    if (key.length === 0) {
      return { ok: false, message: `tags[${i}].key must be non-empty` };
    }
    if (key.length > MAX_KEY_LEN) {
      return {
        ok: false,
        message: `tags[${i}].key exceeds ${MAX_KEY_LEN} chars`,
      };
    }
    if (value.length > MAX_VALUE_LEN) {
      return {
        ok: false,
        message: `tags[${i}].value exceeds ${MAX_VALUE_LEN} chars`,
      };
    }
    if (key.startsWith(SYSTEM_TAU_PREFIX)) {
      // Silently drop — server reads authoritative system tags from DB.
      stripped++;
      continue;
    }

    tags.push({ key, value });
  }

  return { ok: true, tags, strippedSystemTagCount: stripped };
};
