import type { MetaData } from "../shared/types.js";
import assert from "assert";

export type FindTokenIndexResult = {
  startingIndex: number;
  newNextToken: string | null;
};

export const findTokenIndex = ({
  entries,
  pageSize,
  token,
}: {
  entries: MetaData[];
  pageSize: number;
  token?: string | undefined | null;
}): FindTokenIndexResult => {
  assert(pageSize >= 0, "pageSize must be a number that is greater than zero");
  let newNextToken: FindTokenIndexResult["newNextToken"] = null;
  let startingIndex = 0;
  let foundIndex: number;

  if (token) {
    foundIndex = entries.findIndex(({ id }) => id === token);
    startingIndex = foundIndex >= 0 ? foundIndex : 0;
  } else {
    startingIndex = 0;
  }

  if (entries.length > startingIndex + pageSize) {
    newNextToken = entries[startingIndex + pageSize].id;
  }

  return { startingIndex, newNextToken };
};
