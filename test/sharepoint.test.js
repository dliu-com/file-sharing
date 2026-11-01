const { createSharePoint, isSharePointLink, segments, shareToken, ShareError } = require('../lambda/edge/sharepoint');

const HOST = 'contoso-my.sharepoint.com';
const SITE = `https://${HOST}/personal/user_example_com`;
const FOLDER_LINK = `https://${HOST}/:f:/g/personal/user_example_com/FolderToken?e=1`;
const FILE_LINK = `https://${HOST}/:b:/g/personal/user_example_com/FileToken?e=2`;
const ROOT = '/personal/user_example_com/Documents/Shared';
const FILE_ID = '0a1b2c3d-0000-4000-8000-123456789abc';

function response(status, { json, headers = [] } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => json,
    body: null,
  };
}

// A fake SharePoint: the folder "Shared" holds "b.txt", "a.pdf", "Photos/" (with "x.jpg") and "Dad's (1).pdf".
function fakeSharePoint() {
  const calls = [];
  let cookieValue = 'guest1';
  const state = { refuseNextCall: false, redeems: 0, signIn: false, noCookie: false };
  const tree = {
    [ROOT]: {
      Files: [
        { Name: 'b.txt', UniqueId: 'id-b', Length: '5', TimeLastModified: '2024-01-02T00:00:00Z' },
        { Name: 'a.pdf', UniqueId: 'id-a', Length: '1000', TimeLastModified: '2024-01-01T00:00:00Z' },
        { Name: "Dad's (1).pdf", UniqueId: 'id-d', Length: '7', TimeLastModified: '2024-01-01T00:00:00Z' },
      ],
      Folders: [{ Name: 'Photos', ItemCount: 1, TimeLastModified: '2024-01-03T00:00:00Z' }],
    },
    [`${ROOT}/Photos`]: { Files: [{ Name: 'x.jpg', UniqueId: 'id-x', Length: '42', TimeLastModified: '2024-01-04T00:00:00Z' }], Folders: [] },
  };
  const files = {};
  for (const [folder, { Files }] of Object.entries(tree)) for (const f of Files) files[`${folder}/${f.Name}`] = f;

  async function fetchImpl(url, options) {
    calls.push(url);
    const u = new URL(url);
    const cookie = options.headers.cookie || '';
    expect(options.redirect).toBe('manual');
    expect(options.headers['user-agent']).toMatch(/Mozilla/);
    if (u.pathname.startsWith('/:')) {
      state.redeems++;
      if (state.signIn) return response(302, { headers: [['location', 'https://login.microsoftonline.com/common/oauth2/authorize']] });
      return response(302, { headers: [['location', `${SITE}/_layouts/15/onedrive.aspx?id=x`], ['set-cookie', 'rtFa=; path=/; max-age=0']] });
    }
    if (u.pathname.endsWith('/onedrive.aspx')) {
      cookieValue = `guest${state.redeems}`;
      const headers = state.noCookie ? [] : [['set-cookie', `FedAuth=${cookieValue}; path=/; secure; HttpOnly`], ['set-cookie', 'other=1; path=/']];
      return response(200, { headers });
    }
    if (!cookie.includes(`FedAuth=${cookieValue}`)) return response(403);
    if (state.refuseNextCall) {
      state.refuseNextCall = false;
      return response(403);
    }
    if (u.pathname.startsWith('/_api/v2.0/shares/')) {
      const token = u.pathname.split('/')[4];
      if (token === shareToken(FOLDER_LINK)) {
        return response(200, { json: { name: 'Shared', webUrl: `https://${HOST}${ROOT}`, folder: { childCount: 4 }, sharepointIds: { siteUrl: SITE } } });
      }
      if (token === shareToken(FILE_LINK)) {
        return response(200, { json: { name: 'report.pdf', size: 1234, file: { mimeType: 'application/pdf' }, lastModifiedDateTime: '2024-02-01T00:00:00Z', sharepointIds: { siteUrl: SITE, listItemUniqueId: FILE_ID } } });
      }
      return response(404);
    }
    const param = u.searchParams.get('@p');
    const target = param && param.slice(1, -1).replace(/''/g, "'");
    if (u.pathname.includes('GetFolderByServerRelativePath')) {
      expect(u.searchParams.get('$select')).toMatch(/^Exists,/);
      if (!target.startsWith(ROOT)) return response(403);
      if (!tree[target]) return response(404);
      return response(200, { json: { Exists: true, ...tree[target] } });
    }
    if (u.pathname.includes('GetFileByServerRelativePath')) {
      if (!target.startsWith(ROOT)) return response(403);
      return files[target] ? response(200, { json: files[target] }) : response(404);
    }
    return response(500);
  }
  return { fetchImpl, calls, state };
}

describe('link and path checks', () => {
  test('isSharePointLink', () => {
    expect(isSharePointLink(FOLDER_LINK)).toBe(true);
    for (const bad of ['http://contoso-my.sharepoint.com/x', 'https://sharepoint.com.evil.com/x', 'https://evil.com/?x=.sharepoint.com',
      'https://user:pw@contoso.sharepoint.com/x', 'https://contoso.sharepoint.com:8443/x', 'https://1drv.ms/f/s!x', 'not a url',
      `https://contoso.sharepoint.com/${'x'.repeat(1000)}`]) {
      expect(isSharePointLink(bad)).toBe(false);
    }
  });

  test('segments', () => {
    expect(segments('')).toEqual([]);
    expect(segments('a/b c/d.pdf')).toEqual(['a', 'b c', 'd.pdf']);
    expect(segments('a/b/')).toEqual(['a', 'b']);
    for (const bad of ['../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\u0000b', '/a']) {
      expect(() => segments(bad)).toThrow(ShareError);
    }
  });

  test('shareToken is base64url without padding', () => {
    expect(shareToken('https://x.sharepoint.com/a?b=c')).toBe(`u!${Buffer.from('https://x.sharepoint.com/a?b=c').toString('base64url')}`);
  });
});

describe('createSharePoint', () => {
  test('describes a folder link with a guest session', async () => {
    const fake = fakeSharePoint();
    const sp = createSharePoint({ fetchImpl: fake.fetchImpl });
    expect(await sp.describe(FOLDER_LINK)).toEqual({ kind: 'folder', name: 'Shared', size: undefined, count: 4 });
  });

  test('lists a folder, sorted, folders first', async () => {
    const fake = fakeSharePoint();
    const sp = createSharePoint({ fetchImpl: fake.fetchImpl });
    const root = await sp.browse(FOLDER_LINK, '');
    expect(root).toMatchObject({ type: 'folder', kind: 'folder', share: 'Shared', name: 'Shared', path: '' });
    expect(root.folders).toEqual([{ name: 'Photos', count: 1, modified: '2024-01-03T00:00:00Z' }]);
    expect(root.files.map((f) => f.name)).toEqual(['a.pdf', 'b.txt', "Dad's (1).pdf"]);
    expect(root.files[0]).toEqual({ name: 'a.pdf', size: 1000, modified: '2024-01-01T00:00:00Z' });
    const photos = await sp.browse(FOLDER_LINK, 'Photos/');
    expect(photos).toMatchObject({ type: 'folder', name: 'Photos', path: 'Photos', files: [{ name: 'x.jpg', size: 42 }] });
    // One guest session for all of it.
    expect(fake.state.redeems).toBe(1);
  });

  test('finds files, including names with quotes and brackets', async () => {
    const sp = createSharePoint({ fetchImpl: fakeSharePoint().fetchImpl });
    expect(await sp.browse(FOLDER_LINK, 'Photos/x.jpg', { folderFirst: false })).toEqual({
      type: 'file', kind: 'folder', share: 'Shared', path: 'Photos/x.jpg', name: 'x.jpg', size: 42, modified: '2024-01-04T00:00:00Z',
    });
    // folderFirst falls back to the file.
    expect(await sp.browse(FOLDER_LINK, "Dad's (1).pdf")).toMatchObject({ type: 'file', size: 7 });
  });

  test('missing paths are 404', async () => {
    const sp = createSharePoint({ fetchImpl: fakeSharePoint().fetchImpl });
    for (const rel of ['nope', 'nope/', 'Photos/nope.jpg']) {
      await expect(sp.browse(FOLDER_LINK, rel)).rejects.toMatchObject({ status: 404 });
    }
    await expect(sp.origin(FOLDER_LINK, '')).rejects.toMatchObject({ status: 404 });
    await expect(sp.origin(FOLDER_LINK, '../x')).rejects.toMatchObject({ status: 404 });
  });

  test('origin points at download.aspx with the guest cookie', async () => {
    const sp = createSharePoint({ fetchImpl: fakeSharePoint().fetchImpl });
    const o = await sp.origin(FOLDER_LINK, 'Photos/x.jpg');
    expect(o).toMatchObject({
      host: HOST,
      path: '/personal/user_example_com/_layouts/15/download.aspx',
      querystring: 'UniqueId=id-x',
      name: 'x.jpg',
      size: 42,
    });
    expect(o.cookie).toContain('FedAuth=guest1');
    expect(o.cookie).toContain('other=1');
    expect(o.cookie).not.toContain('rtFa');
  });

  test('file links', async () => {
    const sp = createSharePoint({ fetchImpl: fakeSharePoint().fetchImpl });
    expect(await sp.describe(FILE_LINK)).toEqual({ kind: 'file', name: 'report.pdf', size: 1234, count: undefined });
    expect(await sp.browse(FILE_LINK, '')).toEqual({
      type: 'file', kind: 'file', share: 'report.pdf', path: '', name: 'report.pdf', size: 1234, modified: '2024-02-01T00:00:00Z',
    });
    expect((await sp.origin(FILE_LINK, '')).querystring).toBe(`UniqueId=${FILE_ID}`);
  });

  test('opens the link again when the guest cookie stops working', async () => {
    const fake = fakeSharePoint();
    const sp = createSharePoint({ fetchImpl: fake.fetchImpl });
    await sp.browse(FOLDER_LINK, '');
    fake.state.refuseNextCall = true;
    expect((await sp.browse(FOLDER_LINK, 'Photos/')).files).toHaveLength(1);
    expect(fake.state.redeems).toBe(2);
  });

  test('a new session after 30 minutes', async () => {
    const fake = fakeSharePoint();
    let time = 0;
    const sp = createSharePoint({ fetchImpl: fake.fetchImpl, now: () => time });
    await sp.browse(FOLDER_LINK, '');
    time += 29 * 60 * 1000;
    await sp.browse(FOLDER_LINK, '');
    expect(fake.state.redeems).toBe(1);
    time += 2 * 60 * 1000;
    await sp.browse(FOLDER_LINK, '');
    expect(fake.state.redeems).toBe(2);
  });

  test('links that need sign-in or give no guest cookie are 410', async () => {
    const fake = fakeSharePoint();
    fake.state.signIn = true;
    await expect(createSharePoint({ fetchImpl: fake.fetchImpl }).describe(FOLDER_LINK)).rejects.toMatchObject({ status: 410 });
    const fake2 = fakeSharePoint();
    fake2.state.noCookie = true;
    await expect(createSharePoint({ fetchImpl: fake2.fetchImpl }).describe(FOLDER_LINK)).rejects.toMatchObject({ status: 410 });
  });

  test('a failed session is not cached', async () => {
    const fake = fakeSharePoint();
    fake.state.noCookie = true;
    const sp = createSharePoint({ fetchImpl: fake.fetchImpl });
    await expect(sp.browse(FOLDER_LINK, '')).rejects.toMatchObject({ status: 410 });
    fake.state.noCookie = false;
    expect((await sp.browse(FOLDER_LINK, '')).type).toBe('folder');
  });

  test('rejects links that are not SharePoint links without fetching', async () => {
    const fake = fakeSharePoint();
    await expect(createSharePoint({ fetchImpl: fake.fetchImpl }).describe('https://example.com/x')).rejects.toMatchObject({ status: 400 });
    expect(fake.calls).toEqual([]);
  });
});
