import cf from 'cloudfront';

// CloudFront Function (cloudfront-js-2.0), viewer-request on every behaviour except /_app/*.
// Runs before the cache, so a revoked or expired link stops working at once, even for cached files.
//   /                   -> landing page            /admin -> owner page (the API checks the sign-in)
//   /s/<id>[/<path>]    -> viewer page             /f/<id>/<path> -> file bytes (Lambda@Edge fetches from SharePoint)
//   /api/s/<id>/info    -> public listing API      /api/*, /auth/* -> owner API and sign-in
//   /docs, /docs/health.md -> docs pages; /docs/health -> 301 to /docs#health (the Testing tab) (/health itself has its own behaviour, without this function)
// For share URLs it looks the id up in the KeyValueStore and passes the OneDrive link to the origin in x-share-*
// headers. Incoming x-share-* headers are always removed, so visitors cannot forge them.

const kvs = cf.kvs('__KVS_ID__');
const ID = /^[0-9A-Za-z]{10}$/;

const ICON = '/_app/logo.svg';
const NOT_FOUND = '<!doctype html><html lang="en" data-i18n-title="linkNotFound"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
  + '<title>Link not found · DL Share</title><link rel="icon" type="image/svg+xml" href="' + ICON + '">'
  + '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css"><link rel="stylesheet" href="/_app/style.css">'
  + '<script type="module" src="/_app/i18n.js"></script></head>'
  + '<body class="dl-page"><header class="dl-header"><a class="dl-brand" href="/">'
  + '<img class="dl-logo" src="' + ICON + '" alt="" width="32" height="32">DL Share</a>'
  + '<nav class="dl-nav" aria-label="Site"></nav></header><main class="dl-main dl-narrow message">'
  + '<h1 data-i18n="linkNotFound">Link not found</h1>'
  + '<p data-i18n="linkNotFoundText">This link does not exist, has expired or was removed.</p>'
  + '</main><footer class="dl-footer"><a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com">'
  + '<img src="https://files.dliu.com/dliu.com/favicon.png" alt="" width="24" height="24"></a><a href="https://dliu.com">dliu.com</a> · <a href="/docs" data-i18n="docs">Docs</a></footer>'
  + '</body></html>';

function notFound() {
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: {
      'content-type': { value: 'text/html; charset=utf-8' },
      'cache-control': { value: 'no-store' },
    },
    body: NOT_FOUND,
  };
}

// "" or "/a/b" or "/a/b/". Every segment must decode and must not be ".", ".." or contain "\" or control characters.
function validPath(rest, allowTrailingSlash) {
  if (!rest) return true;
  const parts = rest.slice(1).split('/');
  for (let i = 0; i < parts.length; i++) {
    let part;
    try {
      part = decodeURIComponent(parts[i]);
    } catch (e) {
      return false;
    }
    if (part === '') {
      if (allowTrailingSlash && i === parts.length - 1) continue;
      return false;
    }
    if (part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part)) return false;
  }
  return true;
}

async function lookup(id) {
  if (!ID.test(id)) return null;
  let record;
  try {
    record = await kvs.get(id, { format: 'json' });
  } catch (e) {
    return null;
  }
  if (!record || typeof record.src !== 'string') return null;
  if (record.exp && Date.now() >= record.exp) return null;
  return record;
}

function pass(request, id, record) {
  request.headers['x-share-id'] = { value: id };
  request.headers['x-share-src'] = { value: record.src };
  request.headers['x-share-name'] = { value: encodeURIComponent(record.name || '') };
  return request;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  for (const name in headers) {
    if (name.indexOf('x-share-') === 0) delete headers[name];
  }
  const uri = request.uri;

  if (uri === '/') {
    request.uri = '/_app/index.html';
    return request;
  }
  if (uri === '/admin' || uri === '/admin/') {
    request.uri = '/_app/admin.html';
    return request;
  }
  if (uri === '/docs' || uri === '/docs/') {
    request.uri = '/_app/docs.html';
    return request;
  }
  if (uri === '/docs/health' || uri === '/docs/health/') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: '/docs#health' }, 'cache-control': { value: 'public, max-age=3600' } },
    };
  }
  if (uri === '/docs/health.md') {
    request.uri = '/_app/health.md';
    return request;
  }
  if (uri === '/robots.txt' || uri === '/favicon.ico') {
    request.uri = uri === '/robots.txt' ? '/_app/robots.txt' : ICON;
    return request;
  }

  let match = /^\/api\/s\/([^/]+)\/info$/.exec(uri);
  if (match) {
    const record = await lookup(match[1]);
    return record ? pass(request, match[1], record) : notFound();
  }
  if (uri.indexOf('/api/') === 0 || uri.indexOf('/auth/') === 0) return request;

  match = /^\/(s|f)\/([^/]+)(\/.*)?$/.exec(uri);
  if (!match) return notFound();
  const viewer = match[1] === 's';
  if (!validPath(match[3] || '', viewer)) return notFound();
  const record = await lookup(match[2]);
  if (!record) return notFound();

  if (viewer) {
    request.uri = '/_app/view.html';
    request.querystring = {};
    return request;
  }
  // Only ?dl=1 (download instead of show) reaches the cache key; anything else would just split the cache.
  const dl = request.querystring.dl;
  request.querystring = dl && dl.value === '1' ? { dl: { value: '1' } } : {};
  return pass(request, match[2], record);
}
