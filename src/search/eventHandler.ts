import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { GetCommandOutput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { FindTokenIndexResult, findTokenIndex } from "./findTokenIndex.js";
import { FolderConnection, MetaData, SearchInput } from "../shared/types.js";
import { Logger } from "@aws-lambda-powertools/logger";

const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");
const TAG_HIDDEN = "ac:ediacara:hidden";

type IdRecord = { id: string };
type SearchResult = IdRecord[];

const mergeSearchResults = (
  existingResults: SearchResult,
  newSearchResults: SearchResult = [],
  logger: Logger,
): SearchResult => {
  logger.debug("mergeSearchResults", { existingResults, newSearchResults });

  if (!existingResults.length) return newSearchResults;

  return existingResults.filter(({ id: existingId }) =>
    newSearchResults.some(({ id }) => existingId === id),
  );
};

// TODO: implement caching
export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
  const { logger, acServices = {} } = ctx as unknown as AcContext;
  const { dynamoDBService } = acServices;
  assert(dynamoDBService, "dynamoDBService is required in context.acServices");

  let parsedBody: { searchInput: SearchInput; pageSize: number; nextToken?: string };
  try {
    parsedBody = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Invalid JSON body" }),
    };
  }

  const { searchInput, pageSize, nextToken } = parsedBody;

  let foundEntries: SearchResult = [];

  assert(searchInput, "searchInput");
  const {
    filter: { tags },
  } = searchInput;
  assert(tags, "tags");

  for (const { key, value } of tags) {
    logger.debug("trying to read existing metadata");

    // DynamoDB Query returns at most 1MB per page, so walk LastEvaluatedKey
    // until the full match set for this tag is collected.
    const newSearchResults: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined = undefined;
    do {
      const { Items, LastEvaluatedKey } = await dynamoDBService.queryCommand({
        TableName: searchTableName,
        KeyConditionExpression: "#key = :key",
        ...(value
          ? {
              FilterExpression: "#value = :value",
            }
          : {}),
        ExpressionAttributeValues: {
          ":key": key,
          ...(value
            ? {
                ":value": value,
              }
            : {}),
        },
        ExpressionAttributeNames: {
          "#key": "key",
          ...(value
            ? {
                "#value": "value",
              }
            : {}),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      });
      if (Items?.length) newSearchResults.push(...Items);
      exclusiveStartKey = LastEvaluatedKey;
    } while (exclusiveStartKey);

    foundEntries = mergeSearchResults(
      foundEntries,
      newSearchResults.map((item) => ({ id: item.id as string })),
      logger,
    );
  }

  logger.debug("found key/value items from relationships table", {
    foundEntries,
  });

  if (!foundEntries.length) {
    const emptyResult: FolderConnection = { entries: [] };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emptyResult),
    };
  }

  // Paginate ID list BEFORE the metadata fetch, so we only do N=pageSize GetItem
  // calls instead of one per every match.
  const { startingIndex, newNextToken }: FindTokenIndexResult = findTokenIndex({
    entries: foundEntries,
    pageSize,
    token: nextToken,
  });

  logger.debug("FindTokenIndexResult", { startingIndex, newNextToken });

  const pageIds = foundEntries.slice(startingIndex, startingIndex + pageSize);

  // TODO: replace with a single batchGetCommand call once DynamoDBService exposes it
  //       (currently only batchWriteCommand is available), to eliminate the N+1 GetItem pattern.
  const getCommandOutputs: GetCommandOutput[] = await Promise.all(
    pageIds.map(({ id }) =>
      dynamoDBService.getCommand({
        TableName: metaTableName,
        Key: { id },
      }),
    ),
  );

  assert(
    getCommandOutputs.every(({ Item: item }) => item !== undefined),
    "could not find meta for some id",
  );

  const finalResult: MetaData[] = getCommandOutputs
    .map(({ Item: item }) => ({
      id: item!.id,
      tags: item!.tags,
    }))
    .filter(({ tags }) => !tags.some((t: { key: string }) => t.key === TAG_HIDDEN));

  logger.debug("finalResult", { finalResult });
  logger.debug("all done");

  const result: FolderConnection = {
    entries: finalResult,
    nextToken: newNextToken,
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  };
};
