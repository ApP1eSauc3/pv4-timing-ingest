import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * PV4 timing ingest.
 *
 *   POST /timing -> ingest Lambda -> DynamoDB -> AppSync -> CloudFront page
 *
 * Everything is prefixed `pv4-` and the app is tagged `project=pv4`, because
 * this account runs other workloads. Teardown is always
 * `cdk destroy Pv4TimingStack`, never a bare `cdk destroy`.
 */
export class Pv4TimingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Storage ────────────────────────────────────────────────────────────
    // One table. The stats item shares a partition with the athletes so that
    // `eventStats` is a single Query. See src/db.ts for the full key layout.
    const table = new dynamodb.Table(this, 'TimingTable', {
      tableName: 'pv4-timing',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Stored corrupt payloads are evidence, not records — they age out.
      timeToLiveAttribute: 'expiresAt',

      // Explicit: the CDK default is RETAIN, which would leave this table behind
      // in a shared account after teardown. This is assessment data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Ingest ─────────────────────────────────────────────────────────────
    // An explicit log group, not `logRetention`: that property is deprecated and
    // implements retention with a custom-resource Lambda, which would add a
    // second function competing for this account's concurrency.
    const logGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: '/aws/lambda/pv4-ingest',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingestFn = new NodejsFunction(this, 'IngestFunction', {
      functionName: 'pv4-ingest',
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      // Node 20 was deprecated on 2026-04-30 (CDK warns at synth, creation is
      // disabled from 2027-02-01). esbuild's output target is independent of the
      // local Node version, so bundling on Node 20 for a Node 22 runtime is fine.
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        POWERTOOLS_SERVICE_NAME: 'pv4-ingest',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      logGroup,
      bundling: {
        // Bundle the SDK rather than relying on the version the runtime ships,
        // so what is deployed is the version that was tested.
        externalModules: [],
        minify: false,
        sourceMap: true,
      },

      // NOTE: no `reservedConcurrentExecutions`. This account's Lambda
      // concurrency quota is 10 and AWS requires at least 100 unreserved, so no
      // reservation can be set at all. Recorded as a concession in DECISIONS.md.
    });

    table.grantReadWriteData(ingestFn);

    // ── HTTP API ───────────────────────────────────────────────────────────
    // One route. Anything else returns 404 without reaching the processor.
    const httpApi = new apigwv2.HttpApi(this, 'IngestApi', {
      apiName: 'pv4-ingest-api',
      description: 'PV4 timing ingest — POST /timing',
    });

    httpApi.addRoutes({
      path: '/timing',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('IngestIntegration', ingestFn),
    });

    // ── Read API ───────────────────────────────────────────────────────────
    // One Lambda behind all four queries, rather than AppSync's JavaScript
    // resolvers. See the note at the top of src/queryHandler.ts.
    const queryLogGroup = new logs.LogGroup(this, 'QueryLogGroup', {
      logGroupName: '/aws/lambda/pv4-query',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryFn = new NodejsFunction(this, 'QueryFunction', {
      functionName: 'pv4-query',
      entry: path.join(__dirname, '..', 'src', 'queryHandler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
      logGroup: queryLogGroup,
      bundling: { externalModules: [], minify: false, sourceMap: true },
    });

    // Read-only, deliberately. The read API can never change a result, however
    // wrong its code might be.
    table.grantReadData(queryFn);

    const api = new appsync.GraphqlApi(this, 'ResultsApi', {
      name: 'pv4-results-api',
      definition: appsync.Definition.fromFile(path.join(__dirname, 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            // The default is SEVEN DAYS, which would expire before this is
            // graded. The key is meant to be shared; it is not a secret.
            expires: cdk.Expiration.after(cdk.Duration.days(365)),
            description: 'pv4 results — read only',
          },
        },
      },
    });

    const queryDataSource = api.addLambdaDataSource('QueryDataSource', queryFn);

    for (const fieldName of ['events', 'results', 'eventStats', 'updatesRejected']) {
      queryDataSource.createResolver(`${fieldName}Resolver`, {
        typeName: 'Query',
        fieldName,
      });
    }

    // ── Outputs ────────────────────────────────────────────────────────────
    // Printed by the stack so they don't have to be hunted in the console weeks
    // from now, when the submission asks for them.
    new cdk.CfnOutput(this, 'IngestUrl', {
      value: `${httpApi.apiEndpoint}/timing`,
      description: 'POST timing updates here',
    });

    new cdk.CfnOutput(this, 'GraphqlUrl', {
      value: api.graphqlUrl,
      description: 'AppSync GraphQL endpoint',
    });

    new cdk.CfnOutput(this, 'GraphqlApiKey', {
      value: api.apiKey ?? 'none',
      description: 'AppSync API key — meant to be shared, expires in 365 days',
    });

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
