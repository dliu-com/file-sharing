import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FileSharingStack } from '../lib/file-sharing-stack';

// Bundling the API with esbuild takes a few seconds; build the stack once.
const app = new App();
const stack = new FileSharingStack(app, 'TestFileSharing', {
  subdomain: 'share',
  env: { account: '123456789012', region: 'eu-west-1' },
});
const template = Template.fromStack(stack);
const config = () => Object.values(template.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig;
const behavior = (pattern: string) => config().CacheBehaviors.find((b: any) => b.PathPattern === pattern);

test('one KeyValueStore, used by the viewer function', () => {
  template.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
  const fn = Object.values(template.findResources('AWS::CloudFront::Function'))[0] as any;
  expect(fn.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
  expect(fn.Properties.FunctionConfig.KeyValueStoreAssociations).toHaveLength(1);
  const code = JSON.stringify(fn.Properties.FunctionCode);
  expect(code).not.toContain('__KVS_ID__');
  expect(code).toContain('Fn::GetAtt');
});

test('behaviours', () => {
  expect(config().CacheBehaviors.map((b: any) => b.PathPattern).sort()).toEqual(['_app/*', 'api/*', 'auth/*', 'f/*', 's/*']);
  // Every behaviour except _app/* checks links with the viewer function.
  const viewerRequest = (b: any) => (b.FunctionAssociations || []).some((f: any) => f.EventType === 'viewer-request');
  expect(viewerRequest(config().DefaultCacheBehavior)).toBe(true);
  for (const pattern of ['s/*', 'f/*', 'api/*', 'auth/*']) expect(viewerRequest(behavior(pattern))).toBe(true);
  expect(viewerRequest(behavior('_app/*'))).toBe(false);

  const files = behavior('f/*');
  expect(files.LambdaFunctionAssociations.map((l: any) => l.EventType).sort()).toEqual(['origin-request', 'origin-response']);
  expect(files.AllowedMethods).toEqual(['GET', 'HEAD']);
  expect(files.Compress).toBe(false);
  expect(behavior('api/*').AllowedMethods).toContain('POST');
  expect(behavior('auth/*').AllowedMethods).toEqual(['GET', 'HEAD']);
  expect(config().PriceClass).toBe('PriceClass_All');
});

test('file cache key is the URL plus ?dl, and only the edge function gets the share link', () => {
  template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: Match.objectLike({
      ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
        QueryStringsConfig: { QueryStringBehavior: 'whitelist', QueryStrings: ['dl'] },
        HeadersConfig: { HeaderBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
      }),
    }),
  });
  template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
    OriginRequestPolicyConfig: Match.objectLike({
      HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['x-share-src', 'x-share-id'] },
    }),
  });
});

test('Lambda@Edge goes to a us-east-1 stack', () => {
  const edgeStacks = app.node.children.filter((c) => c.node.id.startsWith('edge-lambda-stack'));
  expect(edgeStacks).toHaveLength(1);
  const edge = Template.fromStack(edgeStacks[0] as any);
  edge.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 30 });
  expect((edgeStacks[0] as any).region).toBe('us-east-1');
});

test('every log group CDK manages keeps logs for 90 days', () => {
  const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
  expect(groups.length).toBeGreaterThan(0);
  for (const g of groups) expect((g as any).Properties.RetentionInDays).toBe(90);
  template.resourceCountIs('Custom::LogRetention', 0);
});

test('API can read and write the KeyValueStore, read its secrets and invalidate', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    ReservedConcurrentExecutions: 10,
    Environment: { Variables: Match.objectLike({ PARAMETER_PREFIX: '/share', TENANT_PARAMETER: '/dliu/entra-tenant-id', KVS_ARN: Match.anyValue() }) },
  });
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const ssmRead = statements.find((s: any) => s.Action === 'ssm:GetParameters');
  const resources = JSON.stringify(ssmRead.Resource);
  expect(resources).toContain(':parameter/share/*');
  expect(resources).toContain(':parameter/dliu/entra-tenant-id"');
  expect(resources).not.toContain(':parameter/dliu/*');
  const actions = statements.flatMap((s: any) => [].concat(s.Action));
  expect(actions).toEqual(expect.arrayContaining([
    'cloudfront-keyvaluestore:PutKey', 'cloudfront-keyvaluestore:DeleteKey', 'cloudfront-keyvaluestore:GetKey',
    'ssm:GetParameters', 'cloudfront:CreateInvalidation',
  ]));
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/share/distribution-id' });
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
});

test('security headers', () => {
  const policy = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0] as any;
  const config = policy.Properties.ResponseHeadersPolicyConfig;
  const csp = JSON.stringify(config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);
  expect(csp).toContain('/_app/');
  expect(csp).toContain("frame-ancestors 'self'");
  expect(config.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer');
  expect(config.CustomHeadersConfig.Items.map((i: any) => i.Header)).toContain('X-Robots-Tag');
});

test('DNS records', () => {
  template.resourceCountIs('AWS::Route53::RecordSet', 2);
});
