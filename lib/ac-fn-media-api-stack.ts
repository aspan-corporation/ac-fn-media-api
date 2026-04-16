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
    // Bucket name is a well-known constant — no SSM needed
    const mediaBucketName = "nurtai-media";

    // Concrete values for IAM policy resource ARNs.
    // IAM does not support CloudFormation SSM dynamic references, so we cannot
    // use valueForStringParameter here. The table names follow a known naming
    // convention (stackName-suffix) and the bucket name is a fixed constant.
    const dataStackName = "AcDataStack";
    const metaTableNameResolved = `${dataStackName}-metadata`;
    const searchTableNameResolved = `${dataStackName}-search`;
    const tagsTableNameResolved = `${dataStackName}-tags`;

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

    const commonEnv = {
      LOG_LEVEL: "INFO",
      POWERTOOLS_SERVICE_NAME: "ac-fn-media-api",
    };

    // 1. ListFolder Lambda
    const listFolderFunction = new lambdaNodejs.NodejsFunction(
      this,
      "ListFolderProcessor",
      {
        functionName: "MediaApiListFolderProcessor",
        entry: path.join(currentDirPath, "../src/list-folder/app.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 128,
        timeout: cdk.Duration.seconds(120),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_MEDIA_BUCKET_NAME: mediaBucketName,
        },
      },
    );

    listFolderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${mediaBucketName}`],
      }),
    );
    listFolderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${mediaBucketName}/*`],
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
        memorySize: 128,
        timeout: cdk.Duration.seconds(120),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    getMetadataFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:DescribeTable"],
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
        memorySize: 128,
        timeout: cdk.Duration.seconds(120),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
        },
      },
    );

    updateMetadataFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
        ],
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
        memorySize: 128,
        timeout: cdk.Duration.seconds(120),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAGS_TABLE_NAME: tagsTableName,
        },
      },
    );

    getTagsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:DescribeTable"],
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
        memorySize: 128,
        timeout: cdk.Duration.seconds(120),
        logGroup: centralLogGroup,
        environment: {
          ...commonEnv,
          AC_TAU_MEDIA_META_TABLE_NAME: metaTableName,
          AC_TAU_MEDIA_SEARCH_TABLE_NAME: searchTableName,
        },
      },
    );

    searchFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:GetItem",
          "dynamodb:DescribeTable",
        ],
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
  }
}
