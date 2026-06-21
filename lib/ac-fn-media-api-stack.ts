import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import * as path from "path";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

export class AcFnMediaApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get centralized log group from monitoring stack
    const centralLogGroupArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/monitoring/central-log-group-arn",
    );
    const centralLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "CentralLogGroup",
      centralLogGroupArn,
    );

    // valueForStringParameter → CloudFormation {{resolve:ssm:...}} token, fine for env vars
    // valueFromLookup       → concrete string resolved at synth time, required for IAM policy resources
    //                         (IAM does not support CloudFormation SSM dynamic references)
    const metaTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/meta-table-name",
    );
    const searchTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/search-table-name",
    );
    const tagsTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/tags-table-name",
    );
    const albumsTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/albums-table-name",
    );

    // Concrete values for IAM policy resource ARNs.
    // IAM does not support CloudFormation SSM dynamic references, so we cannot
    // use valueForStringParameter here. The table names follow a known naming
    // convention (stackName-suffix) and the bucket name is a fixed constant.
    const dataStackName = "AcDataStack";
    const metaTableNameResolved = `${dataStackName}-metadata`;
    const searchTableNameResolved = `${dataStackName}-search`;
    const tagsTableNameResolved = `${dataStackName}-tags`;
    const albumsTableNameResolved = `${dataStackName}-albums`;

    // Build ARNs using synth-time resolved names (IAM does not support SSM dynamic refs)
    const metaTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${metaTableNameResolved}`,
      },
      this,
    );

    const searchTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${searchTableNameResolved}`,
      },
      this,
    );

    const tagsTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${tagsTableNameResolved}`,
      },
      this,
    );

    const albumsTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${albumsTableNameResolved}`,
      },
      this,
    );

    const commonEnv = {
      LOG_LEVEL: "INFO",
      POWERTOOLS_SERVICE_NAME: "ac-fn-media-api",
    };

    // Memory / timeout sizing for a single-tenant family app
    // ----------------------------------------------------------------
    // Reads (interactive, latency-sensitive)         : 512 MB / 10 s
    // Search (multi-Query + intersect, hot path)     : 1024 MB / 30 s
    // Writes (rare, dwell-tolerant)                  : 256 MB / 15 s
    //
    // Lambda billing is ms × MB; doubling memory often halves wall time
    // for interactive paths so net cost is flat or lower while UX wins.

    // 1. ListFolder Lambda — queries the meta table's `by-folder` GSI.
    const listFolderFunction = new lambdaNodejs.NodejsFunction(
      this,
      "ListFolderProcessor",
      {
        functionName: "MediaApiListFolderProcessor",
        entry: path.join(currentDirPath, "../src/list-folder/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    listFolderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [metaTableArn, `${metaTableArn}/index/*`],
      }),
    );

    // 2. GetMetadata Lambda
    const getMetadataFunction = new lambdaNodejs.NodejsFunction(
      this,
      "GetMetadataProcessor",
      {
        functionName: "MediaApiGetMetadataProcessor",
        entry: path.join(currentDirPath, "../src/get-metadata/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    getMetadataFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [metaTableArn],
      }),
    );

    // 3. UpdateMetadata Lambda
    const updateMetadataFunction = new lambdaNodejs.NodejsFunction(
      this,
      "UpdateMetadataProcessor",
      {
        functionName: "MediaApiUpdateMetadataProcessor",
        entry: path.join(currentDirPath, "../src/update-metadata/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    // GetItem to read existing system tags, UpdateItem to write merged tags.
    updateMetadataFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [metaTableArn],
      }),
    );

    // 4. GetTags Lambda
    const getTagsFunction = new lambdaNodejs.NodejsFunction(
      this,
      "GetTagsProcessor",
      {
        functionName: "MediaApiGetTagsProcessor",
        entry: path.join(currentDirPath, "../src/get-tags/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(15),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAGS_TABLE_NAME: tagsTableName,
        },
      },
    );

    getTagsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Scan"],
        resources: [tagsTableArn],
      }),
    );

    // 5. Search Lambda
    const searchFunction = new lambdaNodejs.NodejsFunction(
      this,
      "SearchProcessor",
      {
        functionName: "MediaApiSearchProcessor",
        entry: path.join(currentDirPath, "../src/search/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 1024,
        timeout: cdk.Duration.seconds(30),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
          AC_TAU_MEDIA_SEARCH_TABLE_NAME: searchTableName,
        },
      },
    );

    // BatchGetItem is implicitly granted by GetItem on the same resource.
    searchFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
        resources: [metaTableArn, searchTableArn],
      }),
    );

    // SSM outputs for Lambda ARNs
    new ssm.StringParameter(this, "ListFolderFunctionArnParameter", {
      parameterName: "/ac/api/list-folder-fn-arn",
      stringValue: listFolderFunction.functionArn,
    });

    new ssm.StringParameter(this, "GetMetadataFunctionArnParameter", {
      parameterName: "/ac/api/get-metadata-fn-arn",
      stringValue: getMetadataFunction.functionArn,
    });

    new ssm.StringParameter(this, "UpdateMetadataFunctionArnParameter", {
      parameterName: "/ac/api/update-metadata-fn-arn",
      stringValue: updateMetadataFunction.functionArn,
    });

    new ssm.StringParameter(this, "GetTagsFunctionArnParameter", {
      parameterName: "/ac/api/get-tags-fn-arn",
      stringValue: getTagsFunction.functionArn,
    });

    new ssm.StringParameter(this, "SearchFunctionArnParameter", {
      parameterName: "/ac/api/search-fn-arn",
      stringValue: searchFunction.functionArn,
    });

    // 6. GetAlbums Lambda
    const getAlbumsFunction = new lambdaNodejs.NodejsFunction(
      this,
      "GetAlbumsProcessor",
      {
        functionName: "MediaApiGetAlbumsProcessor",
        entry: path.join(currentDirPath, "../src/get-albums/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_ALBUMS_TABLE_NAME: albumsTableName,
        },
      },
    );

    getAlbumsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Scan"],
        resources: [albumsTableArn],
      }),
    );

    // 7. CreateAlbum Lambda
    const createAlbumFunction = new lambdaNodejs.NodejsFunction(
      this,
      "CreateAlbumProcessor",
      {
        functionName: "MediaApiCreateAlbumProcessor",
        entry: path.join(currentDirPath, "../src/create-album/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_ALBUMS_TABLE_NAME: albumsTableName,
        },
      },
    );

    createAlbumFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [albumsTableArn],
      }),
    );

    new ssm.StringParameter(this, "GetAlbumsFunctionArnParameter", {
      parameterName: "/ac/api/get-albums-fn-arn",
      stringValue: getAlbumsFunction.functionArn,
    });

    new ssm.StringParameter(this, "CreateAlbumFunctionArnParameter", {
      parameterName: "/ac/api/create-album-fn-arn",
      stringValue: createAlbumFunction.functionArn,
    });

    // 7b. DeleteAlbum Lambda — removes the album row AND cascades the
    // membership-tag removal across every meta entry that was in the album.
    // Timeout is generous (30 s) because the cascade does N read-modify-write
    // round-trips on the meta table for an N-member album; CASCADE_CONCURRENCY
    // in the handler caps DynamoDB pressure but doesn't bound wall-clock for
    // very large albums. Memory is bumped for the same reason.
    const deleteAlbumFunction = new lambdaNodejs.NodejsFunction(
      this,
      "DeleteAlbumProcessor",
      {
        functionName: "MediaApiDeleteAlbumProcessor",
        entry: path.join(currentDirPath, "../src/delete-album/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(30),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_ALBUMS_TABLE_NAME: albumsTableName,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
          AC_TAU_MEDIA_SEARCH_TABLE_NAME: searchTableName,
        },
      },
    );

    // Read+delete on albums; read+write on meta (for the tag-cascade); read
    // on search (to enumerate members without scanning meta). The
    // ac-fn-calculate-relationship-updates stream-handler is responsible for
    // cleaning search-table rows after meta updates, so we don't write the
    // search table here.
    deleteAlbumFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
        resources: [albumsTableArn],
      }),
    );
    deleteAlbumFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [metaTableArn],
      }),
    );
    deleteAlbumFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [searchTableArn, `${searchTableArn}/index/*`],
      }),
    );

    new ssm.StringParameter(this, "DeleteAlbumFunctionArnParameter", {
      parameterName: "/ac/api/delete-album-fn-arn",
      stringValue: deleteAlbumFunction.functionArn,
    });

    // 8. BulkTag Lambda — sets/overwrites specified tags (including ac:tau:*)
    // on a list of items in one call. Intended for manually correcting old
    // files missing EXIF. GetItem + UpdateItem per item, throttled by
    // CASCADE_CONCURRENCY. 512 MB / 29 s for up to 500 items.
    const bulkTagFunction = new lambdaNodejs.NodejsFunction(
      this,
      "BulkTagProcessor",
      {
        functionName: "MediaApiBulkTagProcessor",
        entry: path.join(currentDirPath, "../src/bulk-tag/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(29),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    bulkTagFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [metaTableArn],
      }),
    );

    new ssm.StringParameter(this, "BulkTagFunctionArnParameter", {
      parameterName: "/ac/api/bulk-tag-fn-arn",
      stringValue: bulkTagFunction.functionArn,
    });

    // 10. HideFolder Lambda — recursively hides/unhides all items under a folder
    // prefix. Needs Scan (to enumerate all items with begins_with) plus
    // GetItem + UpdateItem for the read-modify-write tag merge. Timeout is
    // generous (29 s = API GW max) because large folders can touch thousands
    // of items; memory is 512 MB to keep the scan fast.
    const hideFolderFunction = new lambdaNodejs.NodejsFunction(
      this,
      "HideFolderProcessor",
      {
        functionName: "MediaApiHideFolderProcessor",
        entry: path.join(currentDirPath, "../src/hide-folder/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(29),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    hideFolderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [metaTableArn],
      }),
    );

    new ssm.StringParameter(this, "HideFolderFunctionArnParameter", {
      parameterName: "/ac/api/hide-folder-fn-arn",
      stringValue: hideFolderFunction.functionArn,
    });

    // 11. DownloadUrl Lambda — generates a presigned S3 URL for the original file
    const downloadUrlFunction = new lambdaNodejs.NodejsFunction(
      this,
      "DownloadUrlProcessor",
      {
        functionName: "MediaApiDownloadUrlProcessor",
        entry: path.join(currentDirPath, "../src/download-url/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_MEDIA_BUCKET_NAME: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/storage/media-bucket-name",
          ),
          AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/iam/media-bucket-access-role-arn",
          ),
        },
      },
    );

    // Allow Lambda to assume the S3 media read access role (for presigned URL generation)
    downloadUrlFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/aspan-corporation/ac-s3-media-read-access`,
        ],
      }),
    );

    new ssm.StringParameter(this, "DownloadUrlFunctionArnParameter", {
      parameterName: "/ac/api/download-url-fn-arn",
      stringValue: downloadUrlFunction.functionArn,
    });

    // GetMediaCookie Lambda — mints short-lived CloudFront signed cookies for
    // /thumbs/*, replacing the per-request Lambda@Edge auth on media loads.
    // All signing config (private key, key id, distribution domain) is read
    // from SSM at runtime, so this Lambda has no deploy-time dependency on the
    // ac-infra-managed parameters and can deploy before them.
    const getMediaCookieFunction = new lambdaNodejs.NodejsFunction(
      this,
      "GetMediaCookieProcessor",
      {
        functionName: "MediaApiGetMediaCookieProcessor",
        entry: path.join(currentDirPath, "../src/get-media-cookie/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
        },
        bundling: {
          // @aws-sdk/client-ssm ships in the Node 22 Lambda runtime; keep it
          // external. @aws-sdk/cloudfront-signer is NOT in the runtime, so it
          // must be bundled — replacing the default "@aws-sdk/*" external list
          // with just client-ssm lets esbuild bundle the signer.
          externalModules: ["@aws-sdk/client-ssm"],
        },
      },
    );

    // Read the three signing parameters at runtime (private key is a
    // SecureString → needs kms:Decrypt on the default SSM key).
    getMediaCookieFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: [
          cdk.Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: "ac/cloudfront/media-signing-private-key",
            },
            this,
          ),
          cdk.Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: "ac/cloudfront/media-signing-key-id",
            },
            this,
          ),
          cdk.Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: "ac/cloudfront/distribution-domain-name",
            },
            this,
          ),
        ],
      }),
    );
    getMediaCookieFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
        },
      }),
    );

    new ssm.StringParameter(this, "GetMediaCookieFunctionArnParameter", {
      parameterName: "/ac/api/media-cookie-fn-arn",
      stringValue: getMediaCookieFunction.functionArn,
    });

    // Diary Lambda — GET/PUT/DELETE /api/diary/{id}. Writes Markdown entries to
    // the dedicated diary bucket (created in AcAppStack) and indexes them in the
    // shared meta table. The originals/media bucket gets NO grant here — diary
    // writes are isolated to the diary bucket. Bucket name follows the
    // AcAppStack naming convention (IAM can't use SSM dynamic refs, same as the
    // table ARNs above).
    const diaryBucketName = `acappstack-diary-${this.region}-${this.account}`;
    const diaryBucketArn = `arn:aws:s3:::${diaryBucketName}`;

    const diaryFunction = new lambdaNodejs.NodejsFunction(
      this,
      "DiaryProcessor",
      {
        functionName: "MediaApiDiaryProcessor",
        entry: path.join(currentDirPath, "../src/diary/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 512,
        timeout: cdk.Duration.seconds(15),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
          AC_DIARY_BUCKET_NAME: diaryBucketName,
          // Processing queues — diary-uploaded images are dispatched here on
          // save so they get thumbnails + search indexing (no media state
          // machine exists in this account; we drive the queues directly).
          AC_META_QUEUE_URL: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/meta-extractor/queue-url",
          ),
          AC_RESIZER_QUEUE_URL: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/resizer/queue-url",
          ),
        },
      },
    );

    diaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:BatchWriteItem",
        ],
        resources: [metaTableArn],
      }),
    );
    diaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`${diaryBucketArn}/*`],
      }),
    );
    // Dispatch diary images to the meta-extractor + resizer queues on save.
    diaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [
          ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/meta-extractor/queue-arn",
          ),
          ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/resizer/queue-arn",
          ),
        ],
      }),
    );

    new ssm.StringParameter(this, "DiaryFunctionArnParameter", {
      parameterName: "/ac/api/diary-fn-arn",
      stringValue: diaryFunction.functionArn,
    });
  }
}
