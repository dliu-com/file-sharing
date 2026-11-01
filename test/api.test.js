const auth = require('../lambda/api/auth');
const { ShareError } = require('../lambda/edge/sharepoint');

const SITE = 'https://share.example.com';
process.env.SITE_URL = SITE;
const { createHandler } = require('../lambda/api/index');

const LINK = 'https://contoso-my.sharepoint.com/:f:/g/personal/user_example_com/AbCdEf?e=x';
const LINK2 = 'https://contoso-my.sharepoint.com/:b:/g/personal/user_example_com/GhIjKl?e=y';
const config = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret', allowedDomain: 'example.com' };
const NOW = 1_700_000_000_000;

function setup() {
  const records = new Map();
  const store = {
    get: async (id) => (records.has(id) ? { ...records.get(id) } : null),
    list: async () => [...records].map(([id, r]) => ({ id, ...r })),
    put: async (id, r) => { records.set(id, { ...r }); },
    remove: async (id) => { records.delete(id); },
  };
  const sharepoint = {
    describe: jest.fn(async (link) => {
      if (link === LINK) return { kind: 'folder', name: 'Shared', count: 3 };
      if (link === LINK2) return { kind: 'file', name: 'report.pdf', size: 10 };
      throw new ShareError('The link asks for sign-in', 410);
    }),
    browse: jest.fn(async (link, rel) => {
      if (rel === 'gone') throw new ShareError('Not found', 404);
      if (rel === 'expired') throw new ShareError('Removed', 410);
      if (rel === 'broken') throw new Error('boom');
      return { type: 'folder', kind: 'folder', share: 'Shared', name: 'Shared', path: rel, folders: [], files: [] };
    }),
  };
  const invalidate = jest.fn(async () => {});
  const handler = createHandler({ loadConfig: async () => config, store, sharepoint, invalidate, now: () => NOW });
  return { handler, records, sharepoint, invalidate };
}

const session = auth.sign({ user: 'owner@example.com', name: 'Owner', exp: NOW / 1000 + 600 }, auth.sessionKey(config));

function event(method, rawPath, { body, headers = {}, signedIn = true, query } = {}) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: { ...(method === 'POST' ? { origin: SITE } : {}), ...headers },
    cookies: signedIn ? [`${auth.SESSION_COOKIE}=${session}`] : [],
    ...(query ? { queryStringParameters: query } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

const parse = (result) => ({ status: result.statusCode, body: JSON.parse(result.body) });

describe('public listing', () => {
  const info = (id, headers, query) => event('GET', `/api/s/${id}/info`, { signedIn: false, headers, query });
  const share = { 'x-share-src': LINK, 'x-share-id': 'Abc1234567', 'x-share-name': encodeURIComponent('Holiday 照片') };

  test('lists the share with the owner title, no sign-in needed', async () => {
    const { handler, sharepoint } = setup();
    const result = parse(await handler(info('Abc1234567', share, { path: 'a/b/' })));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ type: 'folder', title: 'Holiday 照片', path: 'a/b/' });
    expect(JSON.stringify(result.body)).not.toContain(LINK);
    expect(sharepoint.browse).toHaveBeenCalledWith(LINK, 'a/b/', { folderFirst: true });
    await handler(info('Abc1234567', share, { path: 'a/c.pdf' }));
    expect(sharepoint.browse).toHaveBeenLastCalledWith(LINK, 'a/c.pdf', { folderFirst: false });
  });

  test('needs the headers from the viewer function, for the same id', async () => {
    const { handler, sharepoint } = setup();
    expect((await handler(info('Abc1234567', {}))).statusCode).toBe(404);
    expect((await handler(info('Xyz1234567', share))).statusCode).toBe(404);
    expect(sharepoint.browse).not.toHaveBeenCalled();
    expect((await handler(event('POST', '/api/s/Abc1234567/info', { headers: share }))).statusCode).toBe(405);
  });

  test('errors', async () => {
    const { handler } = setup();
    expect((await handler(info('Abc1234567', share, { path: 'gone' }))).statusCode).toBe(404);
    expect((await handler(info('Abc1234567', share, { path: 'expired' }))).statusCode).toBe(410);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await handler(info('Abc1234567', share, { path: 'broken' }))).statusCode).toBe(502);
  });

  test('works before sign-in is configured', async () => {
    const { NotConfigured } = require('../lambda/api/config');
    const handler = createHandler({
      loadConfig: async () => { throw new NotConfigured('x'); },
      sharepoint: { browse: async () => ({ type: 'folder', share: 'S' }) },
      store: {},
    });
    expect((await handler(info('Abc1234567', share))).statusCode).toBe(200);
  });
});

describe('owner API', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));

  test('needs a session', async () => {
    const { handler } = setup();
    const result = await handler(event('GET', '/api/shares', { signedIn: false }));
    expect(result.statusCode).toBe(401);
    expect(result.cookies.join()).toContain(`${auth.SESSION_COOKIE}=;`);
    expect(parse(await handler(event('GET', '/api/me'))).body).toEqual({ user: 'owner@example.com', name: 'Owner' });
  });

  test('changes need the site origin', async () => {
    const { handler, records } = setup();
    const result = await handler(event('POST', '/api/shares', { body: { link: LINK }, headers: { origin: 'https://evil.example' } }));
    expect(result.statusCode).toBe(403);
    expect(records.size).toBe(0);
  });

  test('create, list, update, refresh and delete', async () => {
    const { handler, records, invalidate } = setup();
    const created = parse(await handler(event('POST', '/api/shares', { body: { link: ` ${LINK} `, name: '  Trip  ', exp: NOW + 86_400_000 } })));
    expect(created.status).toBe(200);
    const { id } = created.body;
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(records.get(id)).toEqual({ src: LINK, kind: 'folder', name: 'Trip', created: NOW, exp: NOW + 86_400_000 });

    const second = parse(await handler(event('POST', '/api/shares', { body: { link: LINK2 } }))).body;
    expect(records.get(second.id)).toMatchObject({ kind: 'file', name: 'report.pdf', exp: 0 });

    const list = parse(await handler(event('GET', '/api/shares'))).body;
    expect(list.shares.map((s) => s.id).sort()).toEqual([id, second.id].sort());

    // Renaming does not purge; a new OneDrive link does.
    await handler(event('POST', '/api/shares/update', { body: { id, name: 'Trip 2', exp: 0 } }));
    expect(records.get(id)).toMatchObject({ name: 'Trip 2', exp: 0, src: LINK });
    expect(invalidate).not.toHaveBeenCalled();
    await handler(event('POST', '/api/shares/update', { body: { id, link: LINK2 } }));
    expect(records.get(id)).toMatchObject({ src: LINK2, kind: 'file', name: 'Trip 2' });
    expect(invalidate).toHaveBeenLastCalledWith([`/f/${id}*`]);

    expect(parse(await handler(event('POST', '/api/shares/refresh', { body: { id } }))).body).toEqual({ id, refreshed: true });
    expect(invalidate).toHaveBeenCalledTimes(2);

    expect(parse(await handler(event('POST', '/api/shares/delete', { body: { id } }))).body).toEqual({ id, deleted: true });
    expect(records.has(id)).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect((await handler(event('POST', '/api/shares/refresh', { body: { id } }))).statusCode).toBe(404);
  });

  test('bad input is a 400', async () => {
    const { handler, records } = setup();
    const bad = async (route, body) => parse(await handler(event('POST', route, { body })));
    expect((await bad('/api/shares', { link: 'https://example.com/x' })).status).toBe(400);
    expect((await bad('/api/shares', { link: 'https://contoso.sharepoint.com/needs-sign-in' })).body.error).toMatch(/without sign-in/);
    expect((await bad('/api/shares', { link: LINK, exp: NOW - 1 })).status).toBe(400);
    expect((await bad('/api/shares', { link: LINK, exp: '2030-01-01' })).status).toBe(400);
    expect((await bad('/api/shares', { link: LINK, name: 'x'.repeat(101) })).status).toBe(400);
    expect((await bad('/api/shares/update', { id: '../x' })).status).toBe(400);
    expect((await bad('/api/shares/update', { id: 'Zzz1234567' })).status).toBe(404);
    expect(parse(await handler({ ...event('POST', '/api/shares'), body: '[1]' })).status).toBe(400);
    expect(records.size).toBe(0);
  });

  test('unknown routes', async () => {
    const { handler } = setup();
    expect((await handler(event('GET', '/api/nope'))).statusCode).toBe(404);
    expect((await handler(event('DELETE', '/api/shares'))).statusCode).toBe(405);
  });
});

describe('sign-in', () => {
  test('login redirects to Microsoft and returns to /admin by default', async () => {
    const { handler } = setup();
    const result = await handler(event('GET', '/auth/login', { signedIn: false }));
    expect(result.statusCode).toBe(302);
    const location = new URL(result.headers.location);
    expect(location.origin).toBe('https://login.microsoftonline.com');
    expect(location.searchParams.get('redirect_uri')).toBe(`${SITE}/auth/callback`);
    expect(result.cookies.join()).toContain(auth.AUTH_COOKIE);
  });

  test('logout clears the cookies', async () => {
    const { handler } = setup();
    const result = await handler(event('GET', '/auth/logout'));
    expect(result.headers.location).toBe('/');
    expect(result.cookies.join()).toContain(`${auth.OWNER_HINT_COOKIE}=;`);
  });

  test('not configured', async () => {
    const { NotConfigured } = require('../lambda/api/config');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const handler = createHandler({ loadConfig: async () => { throw new NotConfigured('x'); }, sharepoint: {}, store: {} });
    expect((await handler(event('GET', '/api/me'))).statusCode).toBe(503);
    const page = await handler(event('GET', '/auth/login'));
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('make set-secrets');
  });
});
