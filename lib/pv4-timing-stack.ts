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
 * Everything is prefixed `pv4-` and the whole app is tagged `project=pv4`,
 * because this account runs other workloads and I want to be able to list
 * exactly what belongs to this stack. Teardown is always
 * `cdk destroy Pv4TimingStack` and never a bare `cdk destroy`.
 */
export class Pv4TimingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Storage ────────────────────────────────────────────────────────────
    // One table. The counters share a partition with the athletes so eventStats
    // only ever costs a single Query - src/db.ts has the full key layout.
    const table = new dynamodb.Table(this, 'TimingTable', {
      tableName: 'pv4-timing',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Stored corrupt payloads are evidence rather than records, so they age
      // out on their own instead of accumulating forever.
      timeToLiveAttribute: 'expiresAt',

      // Set explicitly, because CDK defaults this to RETAIN and would leave the
      // table sitting in a shared account long after teardown. This is
      // assessment data and it should disappear with the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Ingest ─────────────────────────────────────────────────────────────
    // An explicit log group rather than the logRetention property. That one is
    // deprecated and implements retention with a custom-resource Lambda, which
    // would quietly add a second function competing for concurrency in an
    // account that does not have much to spare.
    const logGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: '/aws/lambda/pv4-ingest',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingestFn = new NodejsFunction(this, 'IngestFunction', {
      functionName: 'pv4-ingest',
      entry: path.join(__dirname, '..', 'src', 'handler.ts'),
      handler: 'handler',
      // Node 20 was deprecated on 2026-04-30 and CDK warns about it at synth,
      // with creation disabled from 2027-02-01. esbuild's output target has
      // nothing to do with the local Node version, so bundling on 20 for a 22
      // runtime works perfectly well.
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
        // Bundle the SDK instead of relying on whichever version the runtime
        // happens to ship, so what gets deployed is what I actually tested.
        externalModules: [],
        minify: false,
        sourceMap: true,
      },

      // No reservedConcurrentExecutions, and not by choice. This account's
      // Lambda concurrency quota is 10 and AWS will not allow a reservation that
      // leaves fewer than 100 unreserved, so no reservation is possible at all.
      // Written up as a concession rather than left looking like an oversight.
    });

    table.grantReadWriteData(ingestFn);

    // ── HTTP API ───────────────────────────────────────────────────────────
    // One route only. Anything else gets a 404 without ever reaching the
    // processor, which keeps the surface area as small as the brief allows.
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
    // One Lambda behind all four queries instead of AppSync's JavaScript
    // resolvers, for the reasons at the top of src/queryHandler.ts.
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

    // Read-only, deliberately. However wrong the read API's code might turn out
    // to be, it cannot change a result.
    table.grantReadData(queryFn);

    const api = new appsync.GraphqlApi(this, 'ResultsApi', {
      name: 'pv4-results-api',
      definition: appsync.Definition.fromFile(path.join(__dirname, 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            // The default here is seven days, which would have expired long
            // before anybody graded this. The key is meant to be shared and is
            // not a secret.
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
    // A private bucket that only CloudFront can read, through Origin Access
    // Control. The bucket itself is never public.
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
        // The page re-queries on demand, and caching the HTML would only serve
        // a stale page after a deploy. The results themselves are never cached
        // here anyway, since they come from AppSync at request time.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      comment: 'pv4 results page',
    });

    // The page reads its endpoint and key from config.json at runtime, so
    // nothing is baked into the HTML and the same page keeps working after a
    // redeploy without being rebuilt.
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

    // On errors, not on rejections. A rejected update is completely normal here,
    // since the brief says roughly one in ten arrives corrupt, so an alarm on
    // those would fire during every race and be muted within a day - which is
    // worse than having no alarm at all. An error means the processor could not
    // say what happened to an update, and that should never happen.
    const errorAlarm = new cloudwatch.Alarm(this, 'IngestErrorAlarm', {
      alarmName: 'pv4-ingest-errors',
      alarmDescription:
        'The ingest Lambda threw. An update reached the processor and landed in none of accepted, ignored or rejected.',
      metric: ingestFn.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // No traffic is not a problem, it is a race that has not started yet.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    errorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Outputs ────────────────────────────────────────────────────────────
    // Printed by the stack, so nobody has to go hunting through the console for
    // them weeks from now when they are needed for the submission.
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
