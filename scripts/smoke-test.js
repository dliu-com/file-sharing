#!/usr/bin/env node
// End-to-end test against the deployed site: creates a throwaway share link to the test OneDrive link, opens the
// viewer, the listing API and a file (range, inline and ?dl=1), then deletes the link and checks it stops working.
// It signs a short-lived owner session with the session key derived from the Entra client secret in SSM, so it
// needs AWS credentials. The test link comes from SHARE_PROBE_LINK or config/probe.local.json, as for probe.js.
// Usage: node scripts/smoke-test.js [--keep]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const auth = require('../lambda/api/auth');

const SITE = process.env.SITE_URL || 'https://share.dliu.com';
const REGION = process.env.AWS_REGION || 'eu-west-1';
const PREFIX = process.env.PARAMETER_PREFIX || '/share';
const keep = process.argv.includes('--keep');

function testLink() {
  if (process.env.SHARE_PROBE_LINK) return process.env.SHARE_PROBE_LINK.trim();
  const file = path.join(__dirname, '../config/probe.local.json');
  if (fs.existsSync(file)) return String(JSON.parse(fs.readFileSync(file, 'utf8')).link || '').trim();
  console.error('Set SHARE_PROBE_LINK or create config/probe.local.json with {"link": "…"}.');
  process.exit(2);
}

const param = (name) => execFileSync('aws', ['ssm', 'get-parameter', '--region', REGION, '--name', `${PREFIX}/${name}`,
  '--with-decryption', '--query', 'Parameter.Value', '--output', 'text']).toString().trim();
const config = { clientSecret: param('entra-client-secret') };
const session = auth.sign({ user: `smoke-test@${new URL(SITE).hostname}`, name: 'Smoke test', exp: Math.floor(Date.now() / 1000) + 600 }, auth.sessionKey(config));
const cookie = `${auth.SESSION_COOKIE}=${session}`;

function check(condition, message) {
  if (!condition) throw new Error(`not ok - ${message}`);
  console.log(`ok - ${message}`);
}

async function api(route, body) {
  const text = JSON.stringify(body);
  const response = await fetch(SITE + route, {
    method: 'POST',
    headers: { cookie, origin: SITE, 'content-type': 'application/json', 'x-amz-content-sha256': crypto.createHash('sha256').update(text).digest('hex') },
    body: text,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${response.status} ${json.error || ''}`);
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// KeyValueStore changes reach every edge location within seconds, but not instantly.
async function waitFor(url, wanted, label) {
  const deadline = Date.now() + 90_000;
  let status;
  while (Date.now() < deadline) {
    status = (await fetch(url, { cache: 'no-store' })).status;
    if (status === wanted) return check(true, `${label} (${status})`);
    await sleep(3000);
  }
  check(false, `${label}: still ${status} after 90 s`);
}

async function main() {
  const link = testLink();
  const me = await fetch(`${SITE}/api/me`, { headers: { cookie } });
  check(me.status === 200, `owner session accepted (${me.status})`);

  const created = await api('/api/shares', { link, name: 'Smoke test' });
  check(/^[0-9A-Za-z]{10}$/.test(created.id), `created a link (${created.kind})`);
  const id = created.id;
  try {
    await waitFor(`${SITE}/api/s/${id}/info?path=`, 200, 'the new link works');

    const page = await fetch(`${SITE}/s/${id}/`);
    check(page.status === 200 && /text\/html/.test(page.headers.get('content-type')), 'viewer page served');
    check(/script-src/.test(page.headers.get('content-security-policy') || ''), 'security headers present');

    const info = await (await fetch(`${SITE}/api/s/${id}/info?path=`)).json();
    check(info.title === 'Smoke test', 'listing returns the title');
    let file = '';
    let size = 0;
    if (info.type === 'file') {
      file = info.name;
      size = info.size;
    } else if (info.files.length) {
      file = info.files[0].name;
      size = info.files[0].size;
    }
    if (file) {
      const url = `${SITE}/f/${id}/${encodePath(file)}`;
      let t = Date.now();
      const first = await fetch(url, { headers: { range: 'bytes=0-1023' } });
      const bytes = (await first.arrayBuffer()).byteLength;
      check(first.status === 206 && bytes === Math.min(1024, size), `file range served: ${first.status}, ${bytes} bytes, ${first.headers.get('x-cache')} (${Date.now() - t} ms)`);
      // dl_vid is the traffic-monitor visitor cookie that every dliu.com site sets; anything else would come from SharePoint.
      const foreign = first.headers.getSetCookie().map((c) => c.split('=')[0]).filter((name) => name !== 'dl_vid');
      check(foreign.length === 0, `no SharePoint cookies leak to the visitor${foreign.length ? ` (${foreign.join(', ')})` : ''}`);
      t = Date.now();
      const again = await fetch(url, { headers: { range: 'bytes=0-1023' } });
      await again.arrayBuffer();
      check(again.status === 206, `again: ${again.headers.get('x-cache')} (${Date.now() - t} ms)`);
      const download = await fetch(`${url}?dl=1`, { headers: { range: 'bytes=0-0' } });
      await download.arrayBuffer();
      check(/^attachment/.test(download.headers.get('content-disposition') || ''), '?dl=1 downloads as an attachment');
      const missing = await fetch(`${SITE}/f/${id}/missing-smoke-test-x7.txt`);
      check(missing.status === 404, `a missing file is 404 (${missing.status})`);
    } else {
      console.log('skip - the test share has no file at its top level');
    }
    const traversal = await fetch(`${SITE}/f/${id}/%2E%2E/x`);
    check(traversal.status === 404, `path traversal is 404 (${traversal.status})`);
    const forged = await fetch(`${SITE}/api/s/${id}/info?path=`, { headers: { 'x-share-src': 'https://example.sharepoint.com/x' } });
    check(forged.status === 200 && (await forged.json()).title === 'Smoke test', 'visitor x-share-* headers are ignored');
  } finally {
    if (!keep) {
      await api('/api/shares/delete', { id });
      console.log('ok - deleted the link');
    }
  }
  if (!keep) await waitFor(`${SITE}/s/${id}/`, 404, 'the deleted link stops working');
  const unknown = await fetch(`${SITE}/s/0000000000/`);
  check(unknown.status === 404, 'an unknown link is 404');
  console.log('\nAll checks passed');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
