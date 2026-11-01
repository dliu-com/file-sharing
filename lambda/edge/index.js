'use strict';

// Lambda@Edge for /f/<id>/<path>: raw file bytes, fetched from SharePoint by CloudFront on a cache miss.
// origin-request: the viewer function has checked the link and passed the OneDrive link in x-share-src; this swaps
//   the origin to SharePoint's download.aspx with the guest session cookie (it answers range requests).
// origin-response: keeps only safe headers, sets the content type and Content-Disposition, and sets caching.
// No environment variables (Lambda@Edge has none); the in-memory session cache lives as long as the instance.

const { createSharePoint, ShareError } = require('./sharepoint');
const { contentTypeFor, isInline } = require('./mime');

let sharepoint = createSharePoint();
const ID = /^\/f\/([0-9A-Za-z]{10})(?:\/(.*))?$/;
const KEEP_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'date', 'via', 'transfer-encoding'];
const FILE_CACHE = 'public, max-age=3600, s-maxage=86400';

const value = (headers, name) => (headers[name] && headers[name][0] ? headers[name][0].value : undefined);
const set = (headers, key, text) => { headers[key.toLowerCase()] = [{ key, value: text }]; };

const MESSAGES = {
  404: 'Not found. 未找到该文件。',
  410: 'This link no longer works. 此链接已失效。',
  502: 'The file could not be fetched from OneDrive. Please try again later. 暂时无法获取文件，请稍后再试。',
  503: 'The file could not be fetched from OneDrive. Please reload the page. 暂时无法获取文件，请刷新页面。',
};

function plain(status, extra = {}) {
  const headers = {};
  set(headers, 'Content-Type', 'text/plain; charset=utf-8');
  set(headers, 'Cache-Control', status === 404 ? 'public, max-age=60' : 'no-store');
  for (const [key, text] of Object.entries(extra)) set(headers, key, text);
  return { status: String(status), statusDescription: { 404: 'Not Found', 410: 'Gone', 502: 'Bad Gateway', 503: 'Service Unavailable' }[status], headers, body: MESSAGES[status] };
}

function relativePath(uri) {
  const match = ID.exec(uri);
  if (!match) return null;
  try {
    return match[2] ? match[2].split('/').map(decodeURIComponent).join('/') : '';
  } catch {
    return null;
  }
}

async function originRequest(request) {
  const src = value(request.headers, 'x-share-src');
  const id = value(request.headers, 'x-share-id');
  for (const name of Object.keys(request.headers)) if (name.startsWith('x-share-')) delete request.headers[name];
  const rel = relativePath(request.uri);
  if (!src || rel === null || !request.uri.startsWith(`/f/${id}`)) return plain(404);
  const download = request.querystring === 'dl=1';

  let target;
  try {
    target = await sharepoint.origin(src, rel);
  } catch (error) {
    const status = error instanceof ShareError && [404, 410].includes(error.status) ? error.status : 502;
    console.log(JSON.stringify({ message: 'Origin lookup failed', id, status, error: error.message }));
    return plain(status);
  }

  request.origin = {
    custom: {
      domainName: target.host,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 30,
      keepaliveTimeout: 5,
      customHeaders: {},
    },
  };
  request.uri = target.path;
  request.querystring = target.querystring;
  set(request.headers, 'Host', target.host);
  set(request.headers, 'Cookie', target.cookie);
  set(request.headers, 'User-Agent', target.userAgent);
  // Read back by originResponse (it sees the request as sent); SharePoint ignores it.
  set(request.headers, 'X-Share-File', `${download ? 'dl' : 'view'}:${encodeURIComponent(target.name)}`);
  return request;
}

function disposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function originResponse(request, response) {
  const status = Number(response.status);
  if (status === 404) return plain(404);
  if ((status >= 300 && status < 400 && status !== 304) || status === 401 || status === 403) {
    // The guest cookie stopped working. Open the link again next time (in this instance at least).
    sharepoint = createSharePoint();
    console.log(JSON.stringify({ message: 'SharePoint refused the guest session', status }));
    return plain(503, { 'Retry-After': '5' });
  }
  if (![200, 206, 304, 416].includes(status)) {
    console.log(JSON.stringify({ message: 'Unexpected SharePoint status', status }));
    return plain(502);
  }

  const [mode, encodedName = ''] = (value(request.headers, 'x-share-file') || '').split(/:(.*)/s);
  let name = 'download';
  try {
    name = decodeURIComponent(encodedName) || name;
  } catch { /* keep the default */ }

  const headers = {};
  for (const key of KEEP_HEADERS) if (response.headers[key]) headers[key] = response.headers[key];
  const type = contentTypeFor(name);
  set(headers, 'Content-Type', type);
  set(headers, 'Content-Disposition', disposition(name, mode !== 'dl' && isInline(type)));
  set(headers, 'Cache-Control', status === 416 ? 'no-store' : FILE_CACHE);
  response.headers = headers;
  return response;
}

exports.handler = async (event) => {
  const { config, request, response } = event.Records[0].cf;
  if (config.eventType === 'origin-request') return originRequest(request);
  if (config.eventType === 'origin-response') return originResponse(request, response);
  return response || request;
};

// For tests.
exports.setSharePoint = (instance) => { sharepoint = instance; };
exports.disposition = disposition;
