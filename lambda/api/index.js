'use strict';

const auth = require('./auth');
const { loadConfig, NotConfigured } = require('./config');
const { BadRequest, NotFound, createShares } = require('./shares');
const { createSharePoint, ShareError } = require('../edge/sharepoint');
const { createHealth, checkLinks, checkSignin } = require('./health');

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const MAX_BODY = 16 * 1024;
const PUBLIC_INFO = /^\/api\/s\/([0-9A-Za-z]{10})\/info$/;

function json(statusCode, body, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

function redirect(location, cookies) {
  return { statusCode: 302, headers: { ...SECURITY_HEADERS, location }, ...(cookies ? { cookies } : {}), body: '' };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(statusCode, message, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: `<!doctype html><meta charset="utf-8"><title>DL Share</title><link rel="stylesheet" href="/_app/style.css">
<body><main class="narrow message"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p><a href="/auth/login?return=/admin">Try again</a> · <a href="/">Home</a></p></main></body>`,
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new BadRequest('Request too large');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new BadRequest('Body must be a JSON object');
  }
}

const header = (event, name) => (event.headers && event.headers[name]) || '';

let clients = {};
const client = (name, make) => clients[name] || (clients[name] = make());

// Changing or removing a link drops its files from the CDN. The distribution ID is in SSM: the stack cannot pass it
// to this function directly, because the distribution itself points at this function.
async function invalidateWithCloudFront(paths) {
  const prefix = process.env.PARAMETER_PREFIX || '/share';
  const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
  const ssm = client('ssm', () => new SSMClient({}));
  const result = await ssm.send(new GetParametersCommand({ Names: [`${prefix}/distribution-id`] }));
  const distributionId = result.Parameters && result.Parameters[0] && result.Parameters[0].Value;
  if (!distributionId) {
    console.warn(JSON.stringify({ message: 'No distribution ID; skipped CDN invalidation', paths }));
    return;
  }
  const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
  const cloudfront = client('cloudfront', () => new CloudFrontClient({}));
  await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: { CallerReference: `${Date.now()}-${Math.random()}`, Paths: { Quantity: paths.length, Items: paths } },
  }));
}

const ROUTES = {
  'GET /api/shares': 'list',
  'POST /api/shares': 'create',
  'POST /api/shares/update': 'update',
  'POST /api/shares/delete': 'remove',
  'POST /api/shares/refresh': 'refresh',
};

function createHandler(deps = {}) {
  const getConfig = deps.loadConfig || loadConfig;
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const clock = deps.now || Date.now;
  const sharepoint = deps.sharepoint || createSharePoint();
  let store = deps.store;
  const getStore = () => store || (store = require('./store').createStore({ arn: process.env.KVS_ARN }));
  const health = createHealth({
    checks: { links: () => checkLinks(getStore()), signin: () => checkSignin(getConfig) },
    now: clock,
  });

  // Visitors: what a share link shows. The viewer function has checked the link (exists, not expired) and passed
  // the OneDrive link in x-share-src. Only CloudFront can call this function, so the headers can be trusted.
  async function publicInfo(event, id) {
    const src = header(event, 'x-share-src');
    if (!src || header(event, 'x-share-id') !== id) return json(404, { error: 'Not found' });
    const path = (event.queryStringParameters && event.queryStringParameters.path) || '';
    let title = '';
    try {
      title = decodeURIComponent(header(event, 'x-share-name'));
    } catch { /* fall back to the OneDrive name */ }
    try {
      const result = await sharepoint.browse(src, path.replace(/^\/+/, ''), { folderFirst: path === '' || path.endsWith('/') });
      return json(200, { ...result, title: title || result.share });
    } catch (error) {
      if (error instanceof ShareError && error.status === 404) return json(404, { error: 'Not found. 未找到。' });
      if (error instanceof ShareError && error.status === 410) return json(410, { error: 'This link no longer works. 此链接已失效。' });
      console.error(JSON.stringify({ message: 'Listing failed', id, error: error.message }));
      return json(502, { error: 'Could not reach OneDrive. Please try again later. 暂时无法连接 OneDrive，请稍后再试。' });
    }
  }

  return async function handler(event) {
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    // status.dliu.com's guest check: decided on the method and path alone, before anything else is read.
    if (path === '/health') return method === 'GET' || method === 'HEAD' ? health() : json(405, { error: 'Method not allowed' });

    const params = event.queryStringParameters || {};
    const siteUrl = process.env.SITE_URL;

    const publicMatch = PUBLIC_INFO.exec(path);
    if (publicMatch) return method === 'GET' ? publicInfo(event, publicMatch[1]) : json(405, { error: 'Method not allowed' });

    const route = ROUTES[`${method} ${path}`];
    if (!route && method !== 'GET') return json(405, { error: 'Method not allowed' });

    try {
      const config = await getConfig();

      if (path === '/auth/login') {
        const login = auth.startLogin(config, siteUrl, clock(), params.return || '/admin');
        return redirect(login.location, login.cookies);
      }
      if (path === '/auth/callback') {
        const result = await auth.finishLogin(event, config, siteUrl, { fetchImpl, now: clock() });
        return result.location ? redirect(result.location, result.cookies) : errorPage(result.status, result.error, result.cookies);
      }
      if (path === '/auth/logout') return redirect('/', auth.logoutCookies());

      if (!path.startsWith('/api/')) return json(404, { error: 'Not found' });
      const session = auth.getSession(event, config, clock());
      // Clearing the hint cookie makes the pages show the sign-in button again.
      if (!session) return json(401, { error: 'Not signed in' }, auth.logoutCookies());
      if (path === '/api/me') return json(200, { user: session.user, name: session.name });
      if (!route) return json(404, { error: 'Not found' });

      // Cross-site requests carry no session (SameSite=Lax); the Origin check is a second guard for changes.
      if (method === 'POST' && header(event, 'origin') !== siteUrl) return json(403, { error: 'Forbidden' });

      const shares = createShares({
        store: getStore(),
        sharepoint,
        invalidate: deps.invalidate || invalidateWithCloudFront,
        now: clock,
      });
      const result = await shares[route](method === 'POST' ? parseBody(event) : {});
      if (route === 'create' || route === 'update' || route === 'remove') {
        console.log(JSON.stringify({ message: 'Share changed', action: route, id: result.id, user: session.user }));
      }
      return json(200, result);
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof ShareError) return json(502, { error: `OneDrive did not answer as expected: ${error.message}` });
      if (error instanceof NotConfigured) {
        console.error(JSON.stringify({ message: 'Sign-in not configured', path, error: error.message }));
        const text = 'Sign-in is not configured yet. Run "make set-secrets".';
        return path.startsWith('/auth/') ? errorPage(503, text) : json(503, { error: text });
      }
      console.error(JSON.stringify({ message: 'Request failed', path, error: error.message, stack: error.stack }));
      if (path.startsWith('/auth/')) return errorPage(500, 'Something went wrong while signing in.');
      return json(500, { error: 'Internal error' });
    }
  };
}

module.exports = { createHandler, handler: createHandler() };
