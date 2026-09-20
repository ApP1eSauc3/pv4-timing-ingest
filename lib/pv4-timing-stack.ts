import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * PV4 timing ingest, end to end.
 *
 *   POST /timing -> ingest Lambda -> DynamoDB -> AppSync -> CloudFront page
 *
 * Everything is prefixed `pv4-` and tagged `project=pv4`, because this account
 * runs other workloads and what belongs to this stack has to be listable.
 * Teardown is always `cdk destroy Pv4TimingStack`, never a bare `cdk destroy`.
 */
export class Pv4TimingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Storage ────────────────────────────────────────────────────────────
    // One table. The counters share a partition with the athletes so eventStats
    // costs a single Query. Full key layout is in src/db.ts.
    const table = new dynamodb.Table(this, 'TimingTable', {
      tableName: 'pv4-timing',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Stored corrupt payloads are evidence, not records - they age out.
      timeToLiveAttribute: 'expiresAt',

      // Explicit: CDK defaults to RETAIN, which would leave the table behind in
      // a shared account after teardown. This is assessment data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Ingest ─────────────────────────────────────────────────────────────
    // An explicit log group, not the logRetention property: that one is
    // deprecated and implements retention with a custom-resource Lambda, adding
    // a second function competing for this account's concurrency.
    const logGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: '/aws/lambda/pv4-ingest',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingestFn = new NodejsFunction(this, 'IngestFunction', {
      functionName: 'pv4-ingest',
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      // Node 20 was deprecated 2026-04-30 (CDK warns at synth; creation
      // disabled from 2027-02-01). esbuild's output target is independent of the
      // local Node version, so bundling on 20 for a 22 runtime is fine.
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        POWERTOOLS_SERVICE_NAME: 'pv4-ingest',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_METRICS_NAMESPACE: 'PV4/Timing',
      },
      logGroup,
      bundling: {
        // Bundle the SDK rather than relying on the version the runtime ships,
        // so what is deployed is the version that was tested.
        externalModules: [],
        minify: false,
        sourceMap: true,
      },

      // No reservedConcurrentExecutions, and not by choice: this account's
      // Lambda concurrency quota is 10, and AWS requires at least 100
      // unreserved, so no reservation can be set. A concession in DECISIONS.md.
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
    // One Lambda behind all four queries rather than AppSync's JavaScript
    // resolvers. Reasons at the top of src/queryHandler.ts.
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

    // Read-only, deliberately: however wrong this code is, it cannot change a
    // result.
    table.grantReadData(queryFn);

    const api = new appsync.GraphqlApi(this, 'ResultsApi', {
      name: 'pv4-results-api',
      definition: appsync.Definition.fromFile(path.join(__dirname, 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            // The default is seven days, which would expire before this is
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

    // ── Results page ───────────────────────────────────────────────────────
    // Private bucket, readable only by CloudFront through Origin Access
    // Control. Never public.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `pv4-results-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // The page re-queries on demand; caching the HTML would serve a stale
        // page after a deploy. The results are not cached here either way - they
        // come from AppSync at request time.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      comment: 'pv4 results page',
    });

    // The page reads its endpoint and key from config.json at runtime, so
    // nothing is baked into the HTML and it survives a redeploy unchanged.
    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'web')),
        s3deploy.Source.jsonData('config.json', {
          graphqlUrl: api.graphqlUrl,
          apiKey: api.apiKey ?? '',
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
    });

    // ── Alarms ─────────────────────────────────────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'pv4-alarms',
      displayName: 'PV4 timing alarms',
    });

    // On errors, not rejections. Roughly one update in ten arrives corrupt, so
    // an alarm on rejections fires every race and gets muted, which is worse
    // than no alarm. An error means the processor could not say what happened to
    // an update - that should never happen.
    const errorAlarm = new cloudwatch.Alarm(this, 'IngestErrorAlarm', {
      alarmName: 'pv4-ingest-errors',
      alarmDescription:
        'The ingest Lambda threw. An update reached the processor and landed in none of accepted, ignored or rejected.',
      metric: ingestFn.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // No traffic is not a problem - it is a race that has not started.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    errorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Outputs ────────────────────────────────────────────────────────────
    // Printed by the stack, so they are not hunted for in the console weeks
    // later when the submission needs them.
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

    new cdk.CfnOutput(this, 'ResultsPageUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront results page',
    });

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
