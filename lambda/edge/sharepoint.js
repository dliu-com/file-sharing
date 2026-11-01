'use strict';

// Everything this app knows about SharePoint lives in this file. It uses only an "Anyone with the link"
// sharing link: opening the link gives a guest session cookie that is limited to the shared file or folder,
// and the calls below use that cookie. These endpoints are not a documented public API; see
// "When SharePoint changes" in the README. Run `make probe` to check them against a real link.
//
// Plain Node (global fetch, no dependencies), so the same file runs in Lambda@Edge and in the API Lambda.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const SESSION_TTL_MS = 30 * 60 * 1000;
const ITEM_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 10;
const MAX_CACHE_ENTRIES = 500;

/** status: 404 = no such file or folder in the share, 410 = the link no longer works, 502 = SharePoint misbehaved. */
class ShareError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
class SessionExpired extends Error {}

function isSharePointLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && /^[a-z0-9-]+\.sharepoint\.com$/i.test(url.hostname)
    && !url.username && !url.password && !url.port && link.length <= 1000;
}

/** Splits a share-relative path ("a/b/c.pdf") into checked segments. Throws 404 for anything odd. */
function segments(relPath) {
  if (!relPath) return [];
  const parts = String(relPath).replace(/\/+$/, '').split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part)) throw new ShareError('Not found', 404);
  }
  return parts;
}

// Server-relative paths go in an OData parameter alias, so names with quotes, brackets, # or % work.
const quote = (path) => encodeURIComponent(`'${path.replace(/'/g, "''")}'`);

const shareToken = (link) => 'u!' + Buffer.from(link, 'utf8').toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function readCookies(jar, headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(';')[0];
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value || /;\s*max-age=0/i.test(line) || /;\s*expires=[^;]*19[0-9]{2}/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch { /* already consumed */ }
}

function createSharePoint({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const sessions = new Map();
  const items = new Map();

  function remember(map, key, value) {
    if (map.size >= MAX_CACHE_ENTRIES) map.clear();
    map.set(key, value);
  }

  /** Opens the link like a browser would and keeps the guest cookies it hands out. */
  async function redeem(link) {
    const host = new URL(link).hostname;
    const jar = new Map();
    let url = link;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new ShareError('Too many redirects while opening the link', 502);
      const response = await fetchImpl(url, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, ...(jar.size ? { cookie: cookieHeader(jar) } : {}) },
      });
      readCookies(jar, response.headers);
      await discard(response);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new ShareError(`Redirect without a location (${response.status})`, 502);
        const next = new URL(location, url);
        // Anything that leaves the SharePoint host is a sign-in page: the link is not an "Anyone" link (any more).
        if (next.protocol !== 'https:' || next.hostname !== host) throw new ShareError('The link asks for sign-in; it is not (or no longer) an "Anyone with the link" link', 410);
        url = next.href;
        continue;
      }
      if (response.status === 403 || response.status === 404) throw new ShareError(`The link was removed or has expired (${response.status})`, 410);
      if (!response.ok) throw new ShareError(`Opening the link returned ${response.status}`, 502);
      break;
    }
    if (!jar.has('FedAuth')) throw new ShareError('SharePoint did not start a guest session; is this an "Anyone with the link" link?', 410);
    return cookieHeader(jar);
  }

  async function call(url, cookie) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { accept: 'application/json;odata=nometadata', cookie, 'user-agent': USER_AGENT },
    });
    if (response.ok) return response.json();
    await discard(response);
    if (response.status === 404) throw new ShareError('Not found', 404);
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new SessionExpired();
    throw new ShareError(`SharePoint returned ${response.status}`, 502);
  }

  /** Redeems the link and describes what it points at. */
  async function openShare(link) {
    if (!isSharePointLink(link)) throw new ShareError('Not a SharePoint / OneDrive for Business link', 400);
    const cookie = await redeem(link);
    const origin = new URL(link).origin;
    let item;
    try {
      item = await call(`${origin}/_api/v2.0/shares/${shareToken(link)}/driveItem`
        + '?$select=id,name,size,folder,file,webUrl,sharepointIds,lastModifiedDateTime', cookie);
    } catch (error) {
      if (error instanceof SessionExpired) throw new ShareError('The link opened, but SharePoint refused to describe it', 410);
      throw error;
    }
    const siteUrl = item.sharepointIds && item.sharepointIds.siteUrl;
    if (!siteUrl || new URL(siteUrl).origin !== origin) throw new ShareError('SharePoint did not return the site of the shared item', 502);
    const session = {
      cookie,
      origin,
      siteUrl: siteUrl.replace(/\/+$/, ''),
      sitePath: new URL(siteUrl).pathname.replace(/\/+$/, ''),
      name: item.name,
      modified: item.lastModifiedDateTime,
      openedAt: now(),
    };
    if (item.folder) {
      // A folder's webUrl is its address in the library; its path is what the REST calls below need.
      const rootPath = decodeURIComponent(new URL(item.webUrl).pathname).replace(/\/+$/, '');
      if (!rootPath.startsWith(`${session.sitePath}/`)) throw new ShareError('Unexpected folder address from SharePoint', 502);
      return { ...session, kind: 'folder', rootPath, count: item.folder.childCount };
    }
    const uniqueId = item.sharepointIds.listItemUniqueId;
    if (!/^[0-9a-f-]{36}$/i.test(uniqueId || '')) throw new ShareError('SharePoint did not return the file ID', 502);
    return { ...session, kind: 'file', uniqueId, size: item.size, mimeType: item.file && item.file.mimeType };
  }

  async function session(link, fresh) {
    const cached = sessions.get(link);
    if (!fresh && cached && now() - cached.at < SESSION_TTL_MS) return cached.promise;
    const promise = openShare(link);
    remember(sessions, link, { at: now(), promise });
    promise.catch(() => sessions.delete(link));
    return promise;
  }

  /** Runs fn with a guest session, opening the link again once if the cookie stopped working. */
  async function withSession(link, fn) {
    try {
      return await fn(await session(link, false));
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
    }
    try {
      return await fn(await session(link, true));
    } catch (error) {
      // A fresh session that is still refused is outside the share (SharePoint enforces the scope).
      if (error instanceof SessionExpired) throw new ShareError('Not found', 404);
      throw error;
    }
  }

  const serverPath = (s, parts) => [s.rootPath, ...parts].join('/');
  const fileOf = (f) => ({ name: f.Name, size: Number(f.Length), modified: f.TimeLastModified, uniqueId: f.UniqueId });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

  // One request for both lists. A missing folder is a 404 only when a folder field such as Exists is selected;
  // otherwise SharePoint returns empty lists.
  async function listFolder(s, parts) {
    const folder = await call(`${s.siteUrl}/_api/web/GetFolderByServerRelativePath(decodedurl=@p)`
      + '?$select=Exists,Files/Name,Files/UniqueId,Files/Length,Files/TimeLastModified,Folders/Name,Folders/ItemCount,Folders/TimeLastModified'
      + `&$expand=Files,Folders&@p=${quote(serverPath(s, parts))}`, s.cookie);
    if (folder.Exists === false) throw new ShareError('Not found', 404);
    if (!Array.isArray(folder.Files) || !Array.isArray(folder.Folders)) throw new ShareError('Unexpected folder listing from SharePoint', 502);
    return {
      type: 'folder',
      name: parts.length ? parts[parts.length - 1] : s.name,
      path: parts.join('/'),
      folders: folder.Folders.map((f) => ({ name: f.Name, count: f.ItemCount, modified: f.TimeLastModified })).sort(byName),
      files: folder.Files.map(fileOf).map(({ uniqueId, ...rest }) => rest).sort(byName),
    };
  }

  async function fileAt(s, parts) {
    if (s.kind === 'file') {
      return { name: s.name, size: s.size, modified: s.modified, uniqueId: s.uniqueId };
    }
    if (!parts.length) throw new ShareError('Not found', 404);
    const key = `${s.siteUrl}\n${serverPath(s, parts)}`;
    const cached = items.get(key);
    if (cached && now() - cached.at < ITEM_TTL_MS) return cached.file;
    const file = fileOf(await call(`${s.siteUrl}/_api/web/GetFileByServerRelativePath(decodedurl=@p)`
      + `?$select=Name,UniqueId,Length,TimeLastModified&@p=${quote(serverPath(s, parts))}`, s.cookie));
    remember(items, key, { at: now(), file });
    return file;
  }

  /** What a viewer page shows: a folder listing, or one file's details. */
  async function browse(link, relPath = '', { folderFirst = true } = {}) {
    const parts = segments(relPath);
    return withSession(link, async (s) => {
      if (s.kind === 'file') {
        const { uniqueId, ...file } = await fileAt(s, []);
        return { type: 'file', kind: 'file', share: s.name, path: '', ...file };
      }
      const attempts = folderFirst ? [listFolder, fileAt] : [fileAt, listFolder];
      for (const [index, attempt] of attempts.entries()) {
        try {
          const result = await attempt(s, parts);
          if (result.type === 'folder') return { kind: 'folder', share: s.name, ...result };
          const { uniqueId, ...file } = result;
          return { type: 'file', kind: 'folder', share: s.name, path: parts.join('/'), ...file };
        } catch (error) {
          if (!(error instanceof ShareError && error.status === 404) || index === attempts.length - 1) throw error;
        }
      }
      throw new ShareError('Not found', 404);
    });
  }

  /** Where CloudFront fetches a file's bytes: download.aspx with the guest cookie answers range requests. */
  async function origin(link, relPath = '') {
    const parts = segments(relPath);
    return withSession(link, async (s) => {
      const file = await fileAt(s, parts);
      return {
        host: new URL(s.origin).hostname,
        path: `${s.sitePath}/_layouts/15/download.aspx`,
        querystring: `UniqueId=${encodeURIComponent(file.uniqueId)}`,
        cookie: s.cookie,
        userAgent: USER_AGENT,
        name: file.name,
        size: file.size,
      };
    });
  }

  /** Checks a link before it is saved: it must open as a guest. */
  async function describe(link) {
    const s = await session(link, true);
    return { kind: s.kind, name: s.name, size: s.size, count: s.count };
  }

  function forget(link) {
    sessions.delete(link);
    items.clear();
  }

  return { browse, origin, describe, forget, openShare };
}

module.exports = { createSharePoint, isSharePointLink, segments, shareToken, ShareError, USER_AGENT };
