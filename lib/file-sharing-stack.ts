import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_ssm as ssm,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');
export const PARAMETER_PREFIX = '/share';

export interface FileSharingStackProps extends StackProps {
  /** Subdomain under the MainDomain export. */
  subdomain: string;
}

// share.dliu.com: short links to OneDrive "Anyone with the link" shares. No files are stored here: the shared
// files are fetched from SharePoint at the edge and cached by CloudFront. Everything is pay-per-use.
//
//   viewer ──► CloudFront ──► viewer-request function (checks the link id in the KeyValueStore)
//                ├─ pages (/, /admin, /s/<id>/...) ──► S3 _app/
//                ├─ /f/<id>/<path> ──► Lambda@Edge ──► SharePoint (anonymous guest session for the Anyone link)
//                └─ /api/*, /auth/* ──► API Lambda (public folder listing; owner sign-in and link management)
export class FileSharingStack extends Stack {
  constructor(scope: Construct, id: string, props: FileSharingStackProps) {
    super(scope, id, props);

    const rootDomain = Fn.importValue('MainDomain');
    const domainName = Fn.join('', [`${props.subdomain}.`, rootDomain]);
    const siteUrl = Fn.join('', ['https://', domainName]);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      zoneName: rootDomain,
      hostedZoneId: Fn.importValue('MainHostedZoneId'),
    });

    // ---------- Links ----------
    // id -> { src: OneDrive link, kind, name, created, exp }. Read by the viewer function at every edge location.
    const links = new cloudfront.KeyValueStore(this, 'Links', {
      comment: 'share.dliu.com link ids -> OneDrive sharing links',
    });

    // ---------- Site pages ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Only the deployed web/ folder lives here; the links are in the KeyValueStore.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'SiteContent', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: siteBucket,
      destinationKeyPrefix: '_app/',
      // Browsers and CloudFront revalidate on every load (a 304 when unchanged), so a deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    // ---------- API ----------
    // Bundled with esbuild: it shares lambda/edge/sharepoint.js and needs the KeyValueStore client and the SigV4A
    // signer, which the Lambda runtime does not include.
    const api = new nodejs.NodejsFunction(this, 'ApiHandler', {
      entry: path.join(ROOT, 'lambda/api/index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      memorySize: 256,
      description: 'share.dliu.com folder listing, sign-in (Microsoft Entra) and link management',
      environment: {
        SITE_URL: siteUrl,
        ROOT_DOMAIN: rootDomain,
        PARAMETER_PREFIX,
        KVS_ARN: links.keyValueStoreArn,
      },
      bundling: { externalModules: [], target: 'node22', minify: true, sourceMap: false },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:GetKey',
        'cloudfront-keyvaluestore:ListKeys',
        'cloudfront-keyvaluestore:PutKey',
        'cloudfront-keyvaluestore:DeleteKey',
      ],
      resources: [links.keyValueStoreArn],
    }));
    const functionUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- File proxy (Lambda@Edge) ----------
    // Lambda@Edge must live in us-east-1; CDK puts it in a small companion stack there. It has no environment
    // variables and no AWS permissions: it only talks to SharePoint.
    const edge = new cloudfront.experimental.EdgeFunction(this, 'FileProxy', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/edge')),
      // The origin-request limit. Opening a guest session takes about a second.
      timeout: Duration.seconds(30),
      memorySize: 512,
      description: 'share.dliu.com: fetches shared OneDrive files from SharePoint',
    });

    // ---------- CDN ----------
    const certificate = new acm.DnsValidatedCertificate(this, 'FileSharingCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1',
    });

    // Scripts may only come from the site's own _app/ folder, so a shared HTML or SVG file cannot run code here.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: Fn.join('; ', [
            "default-src 'self'",
            Fn.join('', ['script-src ', siteUrl, '/_app/']),
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "frame-src 'self'",
            "frame-ancestors 'self'",
            "base-uri 'none'",
            "form-action 'none'",
          ]),
          override: true,
        },
        contentTypeOptions: { override: true },
        // Share URLs are the only credential: never send them to another site.
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
        ],
      },
    });

    // Central traffic monitoring (dliu-com/traffic-monitor): shared visitor cookie and city logging.
    const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
      functionArn: Fn.importValue('TrafficVisitorFunctionArn'),
      functionName: 'dliu-visitor-id',
    });
    const trafficGeo = cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(
      this, 'TrafficGeo', Fn.importValue('TrafficGeoOriginRequestPolicyId'));

    const viewerSource = fs.readFileSync(path.join(ROOT, 'functions/viewer.js'), 'utf8');
    const viewerFunction = new cloudfront.Function(this, 'ViewerFunction', {
      comment: 'share.dliu.com: routes pages and checks share link ids',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(viewerSource.replace('__KVS_ID__', links.keyValueStoreId)),
      keyValueStore: links,
    });
    const viewerRequest = { function: viewerFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST };
    const viewerResponse = { function: visitorId, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE };

    const pageBehavior: cloudfront.BehaviorOptions = {
      origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: headers,
      compress: true,
    };
    const visitedPage: cloudfront.BehaviorOptions = {
      ...pageBehavior,
      originRequestPolicy: trafficGeo,
      functionAssociations: [viewerRequest, viewerResponse],
    };

    // Files: the cache key is the URL plus ?dl=1. The viewer function adds the OneDrive link in x-share-src; only
    // the origin request (Lambda@Edge) sees it. Changing or deleting a link invalidates /f/<id>*.
    const fileCache = new cloudfront.CachePolicy(this, 'FileCache', {
      comment: 'share.dliu.com shared files',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(7),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('dl'),
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
    });
    const fileRequest = new cloudfront.OriginRequestPolicy(this, 'FileRequest', {
      comment: 'share.dliu.com: pass the share link to Lambda@Edge',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('x-share-src', 'x-share-id'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });
    const fileBehavior: cloudfront.BehaviorOptions = {
      // Placeholder: Lambda@Edge points each request at the share's SharePoint host.
      origin: new origins.HttpOrigin('sharepoint.com', {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        readTimeout: Duration.seconds(30),
      }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: fileCache,
      originRequestPolicy: fileRequest,
      responseHeadersPolicy: headers,
      compress: false,
      functionAssociations: [viewerRequest, viewerResponse],
      edgeLambdas: [
        { functionVersion: edge.currentVersion, eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST },
        { functionVersion: edge.currentVersion, eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE },
      ],
    };

    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout: Duration.seconds(30) }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
      functionAssociations: [viewerRequest],
    };

    const distribution = new cloudfront.Distribution(this, 'FileSharingDistribution', {
      comment: 'share.dliu.com',
      defaultBehavior: visitedPage,
      additionalBehaviors: {
        '_app/*': pageBehavior,
        's/*': visitedPage,
        'f/*': fileBehavior,
        'api/*': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
        'auth/*': apiBehavior,
      },
      domainNames: [domainName],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // Includes the Asian edge locations closest to China.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    });
    // IncludeCookies is the only legacy logging setting v2 honours: it puts the dl_vid cookie in the logs.
    (distribution.node.defaultChild as cloudfront.CfnDistribution)
      .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });

    // New function URLs require both invoke permissions. CDK adds InvokeFunctionUrl.
    api.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    // Changing or deleting a link invalidates its cached files. A separate policy (not the role's default one)
    // and an SSM parameter keep the function from depending on the distribution, which depends on the function.
    new ssm.StringParameter(this, 'DistributionIdParameter', {
      parameterName: `${PARAMETER_PREFIX}/distribution-id`,
      stringValue: distribution.distributionId,
      description: 'share.dliu.com CloudFront distribution, for invalidating changed links',
    });
    new iam.Policy(this, 'InvalidatePolicy', {
      roles: [api.role!],
      statements: [new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [distribution.distributionArn] })],
    });

    new route53.ARecord(this, 'FileSharingAliasRecord', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'FileSharingAliasIpv6Record', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'AuthRedirectUri', { value: Fn.join('', [siteUrl, '/auth/callback']) });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'KeyValueStoreArn', { value: links.keyValueStoreArn });
    new CfnOutput(this, 'ApiFunctionName', { value: api.functionName });
  }
}
