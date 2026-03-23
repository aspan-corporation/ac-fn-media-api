import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { GetCommandOutput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";
import { FindTokenIndexResult, findTokenIndex } from "./findTokenIndex.js";
import { FolderConnection, MetaData, SearchInput } from "../shared/types.js";
import { Logger } from "@aws-lambda-powertools/logger";

const searchTableName = assertEnvVar("AC_TAU_MEDIA_SEARCH_TABLE_NAME");
const metaTableName = assertEnvVar("AC_TAU_MEDIA_META_TABLE_NAME");

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

  const { searchInput, pageSize, nextToken } = JSON.parse(event.body ?? "{}") as {
    searchInput: SearchInput;
    pageSize: number;
    nextToken?: string;
  };

  let foundEntries: SearchResult = [];

  assert(searchInput, "searchInput");
  const {
    filter: { tags },
  } = searchInput;
  assert(tags, "tags");

  for (const { key, value } of tags) {
    logger.debug("trying to read existing metadata");
    const { Items: newSearchResults } = await dynamoDBService.queryCommand({
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
    });

    foundEntries = mergeSearchResults(
      foundEntries,
      newSearchResults?.map((item: Record<string, unknown>) => ({ id: item.id as string })),
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

  const getCommandOutputs: GetCommandOutput[] = await Promise.all(
    foundEntries.map(({ id }) =>
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

  // get attributes metadata
  const responses: MetaData[] = getCommandOutputs.map(({ Item: item }) => ({
    id: item!.id,
    tags: item!.tags,
  }));

  logger.debug("mapped metadata", {
    responses,
  });

  // calculate next token
  const { startingIndex, newNextToken }: FindTokenIndexResult = findTokenIndex({
    entries: responses,
    pageSize,
    token: nextToken,
  });

  logger.debug("FindTokenIndexResult", { startingIndex, newNextToken });

  // trim to pageSize
  const finalResult = responses.slice(startingIndex, startingIndex + pageSize);

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
