import { AcContext, assertEnvVar } from "@aspan-corporation/ac-shared";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from "aws-lambda";
import assert from "node:assert";

const tagsTableName = assertEnvVar("AC_TAGS_TABLE_NAME");

export const lambdaHandler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, ctx) => {
    const { logger, acServices = {} } = ctx as unknown as AcContext;
    const { dynamoDBService } = acServices;
    assert(dynamoDBService, "dynamoDBService is required in context.acServices");

    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
    };

    const pageSize = parseInt(event.queryStringParameters?.pageSize ?? "20", 10);
    const safePage = Math.max(1, Math.min(isNaN(pageSize) ? 20 : pageSize, 1000));
    const nextTokenRaw = event.queryStringParameters?.nextToken;

    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (nextTokenRaw) {
      try {
        exclusiveStartKey = JSON.parse(nextTokenRaw);
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: "Invalid nextToken" }),
        };
      }
    }

    const keyPrefix = event.queryStringParameters?.keyPrefix;
    const keysOnly = event.queryStringParameters?.keysOnly === "true";

    logger.debug("getTags", { pageSize: safePage, keyPrefix, keysOnly, exclusiveStartKey });

    if (keysOnly) {
      // Full table scan, extracting only distinct key names.
      // No Limit — DynamoDB Limit caps *scanned* rows, not returned rows, so
      // a filtered scan with Limit would miss most keys.
      // Response is small (just key names, deduplicated).
      const distinctKeys = new Set<string>();
      let scanKey: Record<string, unknown> | undefined = exclusiveStartKey;
      do {
        const page = await dynamoDBService.scanCommand({
          TableName: tagsTableName,
          ProjectionExpression: "#kv",
          ExpressionAttributeNames: { "#kv": "key#value" },
          ...(scanKey ? { ExclusiveStartKey: scanKey } : {}),
        });
        for (const item of page.Items ?? []) {
          const composite = (item["key#value"] as string) ?? "";
          const sep = composite.indexOf("#");
          if (sep >= 0) distinctKeys.add(composite.substring(0, sep));
        }
        scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (scanKey);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          tags: [...distinctKeys].map((key) => ({ key, value: "" })),
        }),
      };
    }

    if (keyPrefix) {
      // Paginate through ALL scan pages so no matching tag is dropped.
      // A single-page scan silently misses items beyond the first 1 MB —
      // the root cause of year/month tags not appearing in dropdowns.
      const allItems: Record<string, unknown>[] = [];
      let scanKey: Record<string, unknown> | undefined = exclusiveStartKey;
      do {
        const page = await dynamoDBService.scanCommand({
          TableName: tagsTableName,
          FilterExpression: "begins_with(#kv, :prefix)",
          ExpressionAttributeNames: { "#kv": "key#value" },
          ExpressionAttributeValues: { ":prefix": `${keyPrefix}#` },
          ...(scanKey ? { ExclusiveStartKey: scanKey } : {}),
        });
        for (const item of page.Items ?? []) {
          allItems.push(item as Record<string, unknown>);
        }
        scanKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (scanKey);

      const tags = allItems.map((item) => {
        const composite = (item["key#value"] as string) ?? "";
        const sep = composite.indexOf("#");
        return sep >= 0
          ? { key: composite.substring(0, sep), value: composite.substring(sep + 1) }
          : { key: composite, value: "" };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ tags }),
      };
    }

    // No prefix filter — return a single page (used for generic tag browsing).
    const result = await dynamoDBService.scanCommand({
      TableName: tagsTableName,
      Limit: safePage,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });

    const tags = (result.Items ?? []).map((item: Record<string, unknown>) => {
      const composite = (item["key#value"] as string) ?? "";
      const separatorIndex = composite.indexOf("#");
      if (separatorIndex >= 0) {
        return {
          key: composite.substring(0, separatorIndex),
          value: composite.substring(separatorIndex + 1),
        };
      }
      return { key: composite, value: "" };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        tags,
        ...(result.LastEvaluatedKey
          ? { nextToken: JSON.stringify(result.LastEvaluatedKey) }
          : {}),
      }),
    };
  };
