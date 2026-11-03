const fs = require('fs');
const path = require('path');

// Runs functions/viewer.js (CloudFront Functions JS 2.0) in Node with a fake KeyValueStore.
function load(records) {
  const source = fs.readFileSync(path.join(__dirname, '../functions/viewer.js'), 'utf8');
  expect(source).toMatch(/^import cf from 'cloudfront';/);
  expect(source).toContain("cf.kvs('__KVS_ID__')");
  const cf = {
    kvs: () => ({
      get: async (key, options) => {
        expect(options).toEqual({ format: 'json' });
        if (!(key in records)) throw new Error('Key not found');
        return records[key];
      },
    }),
  };
  // eslint-disable-next-line no-new-func
  return new Function('cf', `${source.replace(/^import cf from 'cloudfront';/, '')}\nreturn handler;`)(cf);
}

const LINK = 'https://contoso-my.sharepoint.com/:f:/g/personal/user_example_com/AbCdEf?e=x';
const records = {
  Abc1234567: { src: LINK, kind: 'folder', name: 'Holiday 照片', created: 1, exp: 0 },
  Old1234567: { src: LINK, kind: 'folder', name: 'Old', created: 1, exp: Date.now() - 1000 },
  Fut1234567: { src: LINK, kind: 'file', name: '', created: 1, exp: Date.now() + 60_000 },
  Bad1234567: { kind: 'folder' },
};
const handler = load(records);

const request = (uri, extra = {}) => ({
  request: { method: 'GET', uri, querystring: {}, headers: {}, cookies: {}, ...extra },
});
const header = (result, name) => result.headers[name] && result.headers[name].value;

describe('viewer function', () => {
  test('site pages', async () => {
    expect((await handler(request('/'))).uri).toBe('/_app/index.html');
    expect((await handler(request('/admin'))).uri).toBe('/_app/admin.html');
    expect((await handler(request('/admin/'))).uri).toBe('/_app/admin.html');
    expect((await handler(request('/docs'))).uri).toBe('/_app/docs.html');
    expect((await handler(request('/docs/health'))).uri).toBe('/_app/health.html');
    expect((await handler(request('/docs/health/'))).uri).toBe('/_app/health.html');
    expect((await handler(request('/docs/health.md'))).uri).toBe('/_app/health.md');
    expect((await handler(request('/robots.txt'))).uri).toBe('/_app/robots.txt');
    expect((await handler(request('/favicon.ico'))).uri).toBe('/_app/logo.svg');
  });

  test('anything else is the link-not-found page', async () => {
    for (const uri of ['/index.html', '/_data/x', '/s', '/s/', '/x/Abc1234567/', '/admin.html']) {
      const result = await handler(request(uri));
      expect(result.statusCode).toBe(404);
      expect(header(result, 'content-type')).toMatch(/text\/html/);
      expect(result.body).toContain('data-i18n="linkNotFound"');
      expect(result.body).toContain('src="/_app/i18n.js"');
    }
  });

  test('viewer page for a valid link, with or without a path', async () => {
    for (const uri of ['/s/Abc1234567', '/s/Abc1234567/', '/s/Abc1234567/a%20b/', '/s/Abc1234567/a/c.pdf']) {
      const result = await handler(request(uri, { querystring: { utm: { value: 'x' } } }));
      expect(result.uri).toBe('/_app/view.html');
      expect(result.querystring).toEqual({});
      // Pages never get the OneDrive link.
      expect(result.headers['x-share-src']).toBeUndefined();
    }
  });

  test('unknown, expired, broken and malformed ids are 404', async () => {
    for (const uri of ['/s/Zzz1234567/', '/s/Old1234567/', '/s/Bad1234567/', '/s/short/', '/s/Abc1234567x/', '/f/Old1234567/a.pdf', '/api/s/Old1234567/info']) {
      expect((await handler(request(uri))).statusCode).toBe(404);
    }
    expect((await handler(request('/s/Fut1234567'))).uri).toBe('/_app/view.html');
  });

  test('bad paths are 404', async () => {
    for (const uri of ['/s/Abc1234567/a//b', '/s/Abc1234567/%2E%2E/x', '/s/Abc1234567/./x', '/f/Abc1234567/a/', '/f/Abc1234567/%zz', '/f/Abc1234567/a%5Cb', '/f/Abc1234567/a%00b']) {
      expect((await handler(request(uri))).statusCode).toBe(404);
    }
  });

  test('files get the share link in headers and keep only ?dl=1', async () => {
    const result = await handler(request('/f/Abc1234567/a/c.pdf', { querystring: { dl: { value: '1' }, x: { value: 'y' } } }));
    expect(result.uri).toBe('/f/Abc1234567/a/c.pdf');
    expect(result.querystring).toEqual({ dl: { value: '1' } });
    expect(header(result, 'x-share-src')).toBe(LINK);
    expect(header(result, 'x-share-id')).toBe('Abc1234567');
    expect(decodeURIComponent(header(result, 'x-share-name'))).toBe('Holiday 照片');
    const plain = await handler(request('/f/Abc1234567/c.pdf', { querystring: { dl: { value: '0' } } }));
    expect(plain.querystring).toEqual({});
  });

  test('the public listing API gets the share link; other API calls pass through', async () => {
    const info = await handler(request('/api/s/Abc1234567/info', { querystring: { path: { value: 'a/' } } }));
    expect(header(info, 'x-share-src')).toBe(LINK);
    expect(info.querystring).toEqual({ path: { value: 'a/' } });
    const api = await handler(request('/api/shares', { headers: { 'x-share-src': { value: 'https://evil.sharepoint.com/x' } } }));
    expect(api.uri).toBe('/api/shares');
    expect(api.headers['x-share-src']).toBeUndefined();
    expect((await handler(request('/auth/login'))).uri).toBe('/auth/login');
  });

  test('visitors cannot forge the x-share headers', async () => {
    const forged = { 'x-share-src': { value: 'https://evil.sharepoint.com/x' }, 'x-share-id': { value: 'Abc1234567' }, 'x-share-anything': { value: '1' } };
    const page = await handler(request('/', { headers: { ...forged } }));
    expect(Object.keys(page.headers)).toEqual([]);
    const file = await handler(request('/f/Abc1234567/c.pdf', { headers: { ...forged } }));
    expect(header(file, 'x-share-src')).toBe(LINK);
    expect(file.headers['x-share-anything']).toBeUndefined();
  });
});
