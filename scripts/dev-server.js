#!/usr/bin/env node
// Local preview of share.dliu.com that runs the real code: the viewer function (with an in-memory KeyValueStore),
// the API handler (signed in as a dev owner) and the Lambda@Edge handler (fetching real files from SharePoint).
// Nothing touches AWS. Links created here live until the server stops.
//   make dev            then open http://localhost:8787/admin and paste a OneDrive "Anyone" link
//   SHARE_PROBE_LINK=… make dev   also creates the link Dev0000001 for it at startup
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const SITE = `http://localhost:${PORT}`;
process.env.SITE_URL = SITE;
process.env.PARAMETER_PREFIX = '/share';

const auth = require('../lambda/api/auth');
const { createHandler } = require('../lambda/api/index');
const edge = require('../lambda/edge/index');

const WEB = path.join(__dirname, '../web');
const config = { tenantId: 'dev', clientId: 'dev', clientSecret: 'dev', allowedDomain: 'example.com' };
const sessionCookie = `${auth.SESSION_COOKIE}=${auth.sign({ user: 'dev@example.com', name: 'Dev owner', exp: 4102444800 }, auth.sessionKey(config))}`;

const records = new Map();
const store = {
  get: async (id) => (records.has(id) ? JSON.parse(records.get(id)) : null),
  list: async () => [...records].map(([id, value]) => ({ id, ...JSON.parse(value) })),
  put: async (id, record) => { records.set(id, JSON.stringify(record)); },
  remove: async (id) => { records.delete(id); },
};
const api = createHandler({ loadConfig: async () => config, store, invalidate: async (paths) => console.log('invalidate', paths) });

const viewerSource = fs.readFileSync(path.join(__dirname, '../functions/viewer.js'), 'utf8').replace(/^import cf from 'cloudfront';/, '');
const kvs = { get: async (key) => { if (!records.has(key)) throw new Error('not found'); return JSON.parse(records.get(key)); } };
// eslint-disable-next-line no-new-func
const viewer = new Function('cf', `${viewerSource}\nreturn handler;`)({ kvs: () => kvs });

const CSP = ["default-src 'self'", `script-src ${SITE}/_app/`, "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
  "frame-src 'self'", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'"].join('; ');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

function send(res, status, headers, body) {
  res.writeHead(status, { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}

function serveStatic(res, uri) {
  const file = path.join(WEB, uri.replace(/^\/_app\//, ''));
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file)) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
  send(res, 200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }, fs.readFileSync(file));
}

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

async function callApi(req, res, request) {
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, v.value]));
  const query = Object.fromEntries(Object.entries(request.querystring).map(([k, v]) => [k, v.value]));
  const body = await readBody(req);
  const result = await api({
    rawPath: request.uri,
    requestContext: { http: { method: req.method } },
    headers,
    cookies: [sessionCookie],
    queryStringParameters: query,
    ...(body ? { body } : {}),
  });
  const out = { ...result.headers };
  if (result.cookies) out['set-cookie'] = result.cookies;
  send(res, result.statusCode, out, result.body);
}

async function callEdge(req, res, request) {
  const lambdaHeaders = {};
  for (const [name, { value }] of Object.entries(request.headers)) lambdaHeaders[name] = [{ key: name, value }];
  const querystring = Object.entries(request.querystring).map(([k, v]) => `${k}=${v.value}`).join('&');
  const cfRequest = { uri: request.uri, querystring, method: req.method, headers: lambdaHeaders };
  const sent = await edge.handler({ Records: [{ cf: { config: { eventType: 'origin-request' }, request: cfRequest } }] });
  const sendLambda = (result, body) => {
    const headers = {};
    for (const [name, list] of Object.entries(result.headers)) headers[name] = list[0].value;
    res.writeHead(Number(result.status), { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', ...headers });
    if (body) return body;
    res.end(result.body || '');
    return null;
  };
  if (sent.status) return sendLambda(sent);

  const origin = await fetch(`https://${sent.origin.custom.domainName}${sent.uri}?${sent.querystring}`, {
    redirect: 'manual',
    headers: {
      cookie: sent.headers.cookie[0].value,
      'user-agent': sent.headers['user-agent'][0].value,
      'accept-encoding': 'identity',
      ...(req.headers.range ? { range: req.headers.range } : {}),
    },
  });
  const originHeaders = {};
  origin.headers.forEach((value, name) => { originHeaders[name] = [{ key: name, value }]; });
  const result = await edge.handler({ Records: [{ cf: { config: { eventType: 'origin-response' }, request: sent, response: { status: String(origin.status), headers: originHeaders } } }] });
  if (result.body !== undefined || !origin.body) {
    await origin.body?.cancel();
    return sendLambda(result);
  }
  sendLambda(result, true);
  for await (const chunk of origin.body) res.write(chunk);
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, SITE);
    if (url.pathname.startsWith('/_app/')) return serveStatic(res, url.pathname);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name] = { value: String(value) };
    const querystring = {};
    for (const [k, v] of url.searchParams) querystring[k] = { value: v };
    const result = await viewer({ request: { method: req.method, uri: url.pathname, querystring, headers, cookies: {} } });
    if (result.statusCode) {
      const out = {};
      for (const [name, { value }] of Object.entries(result.headers || {})) out[name] = value;
      return send(res, result.statusCode, out, result.body);
    }
    if (result.uri.startsWith('/_app/')) return serveStatic(res, result.uri);
    if (result.uri.startsWith('/api/') || result.uri.startsWith('/auth/')) return await callApi(req, res, result);
    return await callEdge(req, res, result);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain' }, 'Dev server error');
    else res.end();
  }
});

server.listen(PORT, async () => {
  console.log(`share.dliu.com dev server: ${SITE}/admin`);
  if (process.env.SHARE_PROBE_LINK) {
    const { createSharePoint } = require('../lambda/edge/sharepoint');
    const info = await createSharePoint().describe(process.env.SHARE_PROBE_LINK.trim());
    records.set('Dev0000001', JSON.stringify({ src: process.env.SHARE_PROBE_LINK.trim(), kind: info.kind, name: 'Dev test', created: Date.now(), exp: 0 }));
    console.log(`Test link: ${SITE}/s/Dev0000001/`);
  }
});
