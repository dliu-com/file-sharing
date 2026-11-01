#!/usr/bin/env node
// Checks that SharePoint still answers the way share.dliu.com expects, using lambda/edge/sharepoint.js directly.
// Run it when the site breaks (see "When SharePoint changes" in the README), and after changing sharepoint.js.
//
// It needs a test "Anyone with the link" link, which is private and never committed:
//   SHARE_PROBE_LINK='https://…sharepoint.com/…' node scripts/probe.js
//   or put { "link": "https://…" } in config/probe.local.json (git-ignored).
// A folder link checks the most; it should contain at least one file.
// Output shows only counts, sizes and status codes, never names or the link.
const fs = require('fs');
const path = require('path');
const { createSharePoint, ShareError } = require('../lambda/edge/sharepoint');

function testLink() {
  if (process.env.SHARE_PROBE_LINK) return process.env.SHARE_PROBE_LINK.trim();
  const file = path.join(__dirname, '../config/probe.local.json');
  if (fs.existsSync(file)) return String(JSON.parse(fs.readFileSync(file, 'utf8')).link || '').trim();
  console.error('Set SHARE_PROBE_LINK or create config/probe.local.json with {"link": "…"} (see the comment at the top).');
  process.exit(2);
}

let failed = 0;
function check(condition, message) {
  console.log(`${condition ? 'ok' : 'not ok'} - ${message}`);
  if (!condition) failed++;
}

async function expectError(promise, status, message) {
  try {
    await promise;
    check(false, `${message} (no error)`);
  } catch (error) {
    check(error instanceof ShareError && error.status === status, `${message} (${error.status || error.message})`);
  }
}

async function fetchStart(sp, link, rel) {
  const o = await sp.origin(link, rel);
  const t = Date.now();
  const response = await fetch(`https://${o.host}${o.path}${o.querystring ? `?${o.querystring}` : ''}`, {
    headers: { cookie: o.cookie, 'user-agent': o.userAgent, range: 'bytes=0-1023' },
    redirect: 'manual',
  });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { status: response.status, bytes, ms: Date.now() - t, size: o.size, range: response.headers.get('content-range') };
}

async function main() {
  const link = testLink();
  const sp = createSharePoint();

  let t = Date.now();
  const info = await sp.describe(link);
  check(info.kind === 'folder' || info.kind === 'file', `opens the link as a guest: ${info.kind} (${Date.now() - t} ms)`);

  if (info.kind === 'file') {
    const start = await fetchStart(sp, link, '');
    check(start.status === 206 && start.bytes === Math.min(1024, start.size), `downloads a byte range: ${start.status}, ${start.bytes} of ${start.size} bytes (${start.ms} ms)`);
    await expectError(sp.browse(link, 'missing-probe-file'), 404, 'a path inside a file link is not found');
  } else {
    t = Date.now();
    const root = await sp.browse(link, '', { folderFirst: true });
    check(root.type === 'folder', `lists the folder: ${root.folders.length} folders, ${root.files.length} files (${Date.now() - t} ms)`);
    check(info.count === undefined || info.count === root.folders.length + root.files.length, `item count matches (${info.count})`);

    // Breadth-first, up to a few folders deep, for a file to download.
    let rel = '';
    let folder = root;
    const queue = [];
    for (let depth = 0; !folder.files.length && depth < 20; depth++) {
      queue.push(...folder.folders.map((f) => (rel ? `${rel}/` : '') + f.name));
      if (!queue.length) break;
      rel = queue.shift();
      folder = await sp.browse(link, rel, { folderFirst: true });
    }
    if (folder.files.length) {
      const file = folder.files[0];
      const filePath = (rel ? `${rel}/` : '') + file.name;
      const entry = await sp.browse(link, filePath);
      check(entry.type === 'file' && entry.size === file.size, `looks up a file: ${entry.size} bytes`);
      const start = await fetchStart(sp, link, filePath);
      check(start.status === 206 && start.bytes === Math.min(1024, file.size), `downloads a byte range: ${start.status}, ${start.bytes} bytes, ${start.range} (${start.ms} ms)`);
    } else {
      check(false, 'found a file to download (the test folder has no files)');
    }
    if (root.folders.length) {
      const sub = await sp.browse(link, root.folders[0].name, { folderFirst: true });
      check(sub.type === 'folder', `lists a subfolder: ${sub.folders.length + sub.files.length} items`);
    }
    await expectError(sp.browse(link, 'missing-probe-folder-x7', { folderFirst: true }), 404, 'a missing folder is not found');
    await expectError(sp.browse(link, 'missing-probe-file-x7.txt'), 404, 'a missing file is not found');
  }
  await expectError(sp.browse(link, '../x'), 404, 'refuses paths outside the share');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`not ok - ${error instanceof ShareError ? `ShareError ${error.status}: ` : ''}${error.message}`);
  process.exit(1);
});
