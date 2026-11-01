const edge = require('../lambda/edge/index');
const { ShareError } = require('../lambda/edge/sharepoint');

const LINK = 'https://contoso-my.sharepoint.com/:f:/g/personal/user_example_com/AbCdEf?e=x';
const HOST = 'contoso-my.sharepoint.com';

const h = (key, value) => ({ [key.toLowerCase()]: [{ key, value }] });
const value = (headers, name) => headers[name] && headers[name][0].value;

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));

function fakeSharePoint(files = { 'a/c.pdf': 1000, '照片 1.JPG': 42, 'page.html': 3 }) {
  const calls = [];
  return {
    calls,
    async origin(link, rel) {
      calls.push([link, rel]);
      if (link !== LINK) throw new ShareError('The link was removed', 410);
      if (!(rel in files)) throw new ShareError('Not found', 404);
      return {
        host: HOST, path: '/personal/user_example_com/_layouts/15/download.aspx', querystring: 'UniqueId=u-1',
        cookie: 'FedAuth=guest; rtFa=x', userAgent: 'Mozilla/5.0 test', name: rel.split('/').pop(), size: files[rel],
      };
    },
  };
}

function originRequest(uri, { src = LINK, id = 'Abc1234567', querystring = '' } = {}) {
  const headers = { ...h('Host', 'share.dliu.com'), ...h('User-Agent', 'Amazon CloudFront') };
  if (src) Object.assign(headers, h('x-share-src', src));
  if (id) Object.assign(headers, h('x-share-id', id));
  return {
    Records: [{
      cf: {
        config: { eventType: 'origin-request', distributionId: 'E1' },
        request: { uri, querystring, method: 'GET', headers, origin: { custom: { domainName: 'sharepoint.com' } } },
      },
    }],
  };
}

function originResponse(request, status, headers = {}) {
  return {
    Records: [{
      cf: {
        config: { eventType: 'origin-response' },
        request,
        response: { status: String(status), statusDescription: 'x', headers },
      },
    }],
  };
}

describe('origin-request', () => {
  test('points the request at SharePoint download.aspx', async () => {
    edge.setSharePoint(fakeSharePoint());
    const result = await edge.handler(originRequest('/f/Abc1234567/a/c.pdf'));
    expect(result.origin.custom).toMatchObject({ domainName: HOST, protocol: 'https', port: 443, path: '' });
    expect(result.uri).toBe('/personal/user_example_com/_layouts/15/download.aspx');
    expect(result.querystring).toBe('UniqueId=u-1');
    expect(value(result.headers, 'host')).toBe(HOST);
    expect(value(result.headers, 'cookie')).toBe('FedAuth=guest; rtFa=x');
    expect(value(result.headers, 'user-agent')).toBe('Mozilla/5.0 test');
    expect(value(result.headers, 'x-share-file')).toBe('view:c.pdf');
    // The OneDrive link never goes to SharePoint as a header.
    expect(result.headers['x-share-src']).toBeUndefined();
    expect(result.headers['x-share-id']).toBeUndefined();
  });

  test('decodes the path and remembers ?dl=1', async () => {
    const sp = fakeSharePoint();
    edge.setSharePoint(sp);
    const result = await edge.handler(originRequest(`/f/Abc1234567/${encodeURIComponent('照片 1.JPG')}`, { querystring: 'dl=1' }));
    expect(sp.calls).toEqual([[LINK, '照片 1.JPG']]);
    expect(value(result.headers, 'x-share-file')).toBe(`dl:${encodeURIComponent('照片 1.JPG')}`);
  });

  test('requests without the share headers, or for another id, are 404', async () => {
    edge.setSharePoint(fakeSharePoint());
    for (const event of [
      originRequest('/f/Abc1234567/a/c.pdf', { src: '' }),
      originRequest('/f/Abc1234567/a/c.pdf', { id: 'Xyz1234567' }),
      originRequest('/g/Abc1234567/a/c.pdf'),
      originRequest('/f/Abc1234567/%zz'),
    ]) {
      const result = await edge.handler(event);
      expect(result.status).toBe('404');
      expect(result.body).toMatch(/Not found/);
    }
  });

  test('SharePoint errors become 404, 410 or 502', async () => {
    edge.setSharePoint(fakeSharePoint());
    expect((await edge.handler(originRequest('/f/Abc1234567/missing.pdf'))).status).toBe('404');
    expect((await edge.handler(originRequest('/f/Abc1234567/a/c.pdf', { src: `${LINK}x` }))).status).toBe('410');
    edge.setSharePoint({ origin: async () => { throw new Error('socket hang up'); } });
    const failed = await edge.handler(originRequest('/f/Abc1234567/a/c.pdf'));
    expect(failed.status).toBe('502');
    expect(value(failed.headers, 'cache-control')).toBe('no-store');
  });
});

describe('origin-response', () => {
  async function sent(uri, querystring = '') {
    edge.setSharePoint(fakeSharePoint());
    return edge.handler(originRequest(uri, { querystring }));
  }
  const sharePointHeaders = {
    ...h('Content-Type', 'text/html'),
    ...h('Content-Length', '1000'),
    ...h('Content-Range', 'bytes 0-999/1000'),
    ...h('Content-Disposition', 'attachment; filename="c.pdf"'),
    ...h('Set-Cookie', 'FedAuth=secret'),
    ...h('SPRequestGuid', 'abc'),
    ...h('ETag', '"1"'),
    ...h('Via', '1.1 x'),
  };

  test('keeps only safe headers and sets type, disposition and caching', async () => {
    const request = await sent('/f/Abc1234567/a/c.pdf');
    const result = await edge.handler(originResponse(request, 206, { ...sharePointHeaders }));
    expect(result.status).toBe('206');
    expect(Object.keys(result.headers).sort()).toEqual(
      ['cache-control', 'content-disposition', 'content-length', 'content-range', 'content-type', 'etag', 'via']);
    expect(value(result.headers, 'content-type')).toBe('application/pdf');
    expect(value(result.headers, 'content-disposition')).toBe('inline; filename="c.pdf"; filename*=UTF-8\'\'c.pdf');
    expect(value(result.headers, 'cache-control')).toMatch(/s-maxage=86400/);
    expect(value(result.headers, 'content-range')).toBe('bytes 0-999/1000');
  });

  test('?dl=1 and unsafe types are attachments', async () => {
    const dl = await edge.handler(originResponse(await sent('/f/Abc1234567/a/c.pdf', 'dl=1'), 200, { ...sharePointHeaders }));
    expect(value(dl.headers, 'content-disposition')).toMatch(/^attachment;/);
    const html = await edge.handler(originResponse(await sent('/f/Abc1234567/page.html'), 200, { ...sharePointHeaders }));
    expect(value(html.headers, 'content-type')).toBe('text/html; charset=utf-8');
    expect(value(html.headers, 'content-disposition')).toMatch(/^attachment;/);
    const photo = await edge.handler(originResponse(await sent(`/f/Abc1234567/${encodeURIComponent('照片 1.JPG')}`), 200, {}));
    expect(value(photo.headers, 'content-type')).toBe('image/jpeg');
    expect(value(photo.headers, 'content-disposition')).toBe(`inline; filename="__ 1.JPG"; filename*=UTF-8''${encodeURIComponent('照片 1.JPG')}`);
  });

  test('a refused guest session is a 503 to retry, and opens the link again next time', async () => {
    const request = await sent('/f/Abc1234567/a/c.pdf');
    for (const status of [302, 401, 403]) {
      const result = await edge.handler(originResponse(request, status, h('Location', 'https://login.microsoftonline.com/')));
      expect(result.status).toBe('503');
      expect(value(result.headers, 'retry-after')).toBe('5');
      expect(result.headers.location).toBeUndefined();
    }
  });

  test('other errors', async () => {
    const request = await sent('/f/Abc1234567/a/c.pdf');
    expect((await edge.handler(originResponse(request, 404, sharePointHeaders))).status).toBe('404');
    expect((await edge.handler(originResponse(request, 500, sharePointHeaders))).status).toBe('502');
    const range = await edge.handler(originResponse(request, 416, h('Content-Range', 'bytes */1000')));
    expect(range.status).toBe('416');
    expect(value(range.headers, 'cache-control')).toBe('no-store');
  });
});

test('disposition', () => {
  expect(edge.disposition('a "b";c%.pdf', false)).toBe('attachment; filename="a _b__c_.pdf"; filename*=UTF-8\'\'a%20%22b%22%3Bc%25.pdf');
  expect(edge.disposition("it's (1).txt", true)).toBe('inline; filename="it\'s (1).txt"; filename*=UTF-8\'\'it%27s%20%281%29.txt');
});
