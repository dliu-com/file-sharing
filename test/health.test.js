const fs = require('fs');
const path = require('path');

// Guards the dliu.com health contract (dliu-com/status HEALTH.md): the /docs#health Testing tab, /docs/health.md and /health.
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const docs = read('web/docs.html');
const html = docs.split('<article id="health" class="dl-docs" hidden>')[1].split('</article>')[0];
const md = read('web/health.md');
const { createHandler } = require('../lambda/api/index');
const { createHealth, checkLinks, checkSignin, FUNCTIONS, CHECK_TIMEOUT_MS } = require('../lambda/api/health');
const { NotConfigured } = require('../lambda/api/config');

const section = (title) => md.split(/^## /m).find((part) => part.startsWith(`${title}\n`));
const mdTable = (title) => section(title).split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
  .slice(1).map((line) => line.slice(2, -2).split(' | ').map((cell) => cell.replace(/^`|`$/g, '')));
const tableRows = () => [...html.matchAll(/<tr data-function="([a-z]+)"><th scope="row"><strong data-lang="en">([^<]+)<\/strong>/g)]
  .map(([, key, name]) => [key, name]);
const chart = () => Object.fromEntries([...html.matchAll(/<div class="health-row" data-function="([a-z]+)">(.*?)<\/div>/g)]
  .map(([, key, row]) => [key, [...row.matchAll(/class="health-bar health-(visit|self)" data-n="(\d)">\2</g)]
    .reduce((n, [, kind, count]) => ({ ...n, [kind]: Number(count) }), { visit: 0, self: 0 })]));

describe('/docs#health (people) and /docs/health.md (machines)', () => {
  test('Testing is a tab on /docs, and the separate health page is gone (viewer.test.js checks the 301)', () => {
    expect(docs).toContain('<a href="#health" data-tab="health" data-i18n="health">Testing</a>');
    expect(read('web/docs.js')).toContain("const TABS = ['architecture', 'cost', 'security', 'health'];");
    expect(fs.existsSync(path.join(__dirname, '..', 'web/health.html'))).toBe(false);
  });

  test('the tab has no exact technical details: no code, folded blocks, URLs, status codes, headers or JSON', () => {
    expect(html).not.toMatch(/<code|<pre|<details|<summary/);
    expect(html).not.toMatch(/https?:\/\/|\bGET\b|\bHEAD\b|\b(200|301|302|401|403|404|503)\b/);
    expect(html).not.toMatch(/content-type|cache-control|authorization|application\/|text\/html|"status"|\{ ?"/i);
    expect(html).not.toMatch(/\sstyle="/);
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links).toEqual(['<a href="/docs/health.md">']);
    expect(html.trim()).toMatch(/<a href="\/docs\/health\.md"><span data-lang="en">Technical version for machines \(Markdown\)<\/span>[\s\S]*<\/p>$/);
  });

  test('a flow shows how a run goes and ends in working, slow or not working', () => {
    expect(html).toContain('<div class="dg-flow">');
    expect((html.match(/<div class="dg-step">/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('<div class="dg-arrow" aria-hidden="true">');
    for (const result of ['dg-good', 'dg-warn', 'dg-bad']) expect(html).toContain(`<div class="dg-step ${result}">`);
    for (const [, name] of html.matchAll(/class="dg-icon (dg-c-[a-z]+)"/g)) expect(read('web/style.css')).toContain(`.dg-icon.${name} {`);
  });

  test('the big numbers match the Markdown file', () => {
    expect(html).toContain('<div class="dg-stats">');
    expect((html.match(/<div class="dg-stat">/g) || []).length).toBeGreaterThanOrEqual(4);
    const functions = mdTable('Functions').length;
    const visits = mdTable('Guest checks').length;
    const self = mdTable('Health endpoint').length;
    expect(html).toContain(`<strong data-lang="en">${functions} functions</strong>`);
    expect(html).toContain(`<strong data-lang="en">${visits + self} checks</strong>`);
    expect(html).toContain(`<small data-lang="en">${visits} page visits + ${self} self-checks</small>`);
    expect(html).toContain('<strong data-lang="en">0 sign-ins</strong>');
    expect(html).toContain('<strong data-lang="en">Every 15 minutes</strong>');
  });

  test('the table has one plain-words row per function, in the Markdown file\'s order and names', () => {
    expect(tableRows()).toEqual(mdTable('Functions').map((row) => [row[0], row[1]]));
    for (const [key, , , critical] of mdTable('Functions')) {
      const row = html.match(new RegExp(`<tr data-function="${key}">(.*?)</tr>`))[1];
      expect((row.match(/<td/g) || []).length).toBe(4);
      expect(row).toContain('<td class="health-ok">✓ ');
      expect(row).toContain('<td class="health-down">✗ ');
      expect(row).toContain(critical === 'yes' ? '>essential<' : '>optional<');
    }
  });

  test('the chart counts each function\'s checks exactly as the Markdown file lists them', () => {
    const visits = mdTable('Guest checks').map((row) => row[0]);
    const self = mdTable('Health endpoint').map((row) => row[0]);
    const expected = Object.fromEntries(mdTable('Functions').map(([key]) => [key, {
      visit: visits.filter((k) => k === key).length, self: self.filter((k) => k === key).length,
    }]));
    expect(chart()).toEqual(expected);
    for (const n of new Set(Object.values(expected).flatMap((c) => [c.visit, c.self]).filter(Boolean))) {
      expect(read('web/style.css')).toContain(`.health-bar[data-n="${n}"] {`);
    }
  });

  test('every plain-language line is in English and Chinese, and the not-tested list is there', () => {
    const en = (html.match(/data-lang="en"/g) || []).length;
    const zh = (html.match(/data-lang="zh" hidden/g) || []).length;
    expect(en).toBeGreaterThan(30);
    expect(zh).toBe(en);
    expect(html).toContain('<h2 id="not-tested">');
  });

  test('the Markdown file has every section the contract asks for, with every technical detail', () => {
    for (const title of ['Functions', 'Guest checks', 'Health endpoint', 'Not tested', 'Rules']) expect(section(title)).toBeDefined();
    expect(md).toContain('dliu-status-bot/1.0 (+https://status.dliu.com/docs)');
    for (const [, method, , status] of mdTable('Guest checks')) {
      expect(['GET', 'HEAD']).toContain(method);
      expect(status).toMatch(/^\d{3}$/);
    }
  });

  test('the routes in the guest checks exist', () => {
    const viewer = read('functions/viewer.js');
    const urls = mdTable('Guest checks').map((row) => row[2]);
    for (const url of ['https://share.dliu.com/', 'https://share.dliu.com/docs', 'https://share.dliu.com/docs/health',
      'https://share.dliu.com/docs/health.md', 'https://share.dliu.com/_app/style.css', 'https://share.dliu.com/s/0000000000/',
      'https://share.dliu.com/auth/login', 'https://share.dliu.com/api/me']) expect(urls).toContain(url);
    expect(viewer).toContain("location: { value: '/docs#health' }");
    expect(viewer).toContain('data-i18n="linkNotFound"');
    expect(read('web/style.css')).toContain('.file-head');
    expect(read('web/index.html')).toContain('class="dl-header"');
    expect(docs).toContain('<article id="health"');
    expect(md).toContain('## Guest checks');
  });

  test('/health reports a subset of the documented functions, with the same names', () => {
    const functions = Object.fromEntries(mdTable('Functions').map((row) => [row[0], row[1]]));
    const endpoint = Object.fromEntries(mdTable('Health endpoint').map((row) => [row[0], row[1]]));
    expect(Object.keys(endpoint)).toEqual(FUNCTIONS.map((f) => f.key));
    for (const { key, name } of FUNCTIONS) {
      expect(functions[key]).toBe(name);
      expect(endpoint[key]).toBe(name);
      expect(md).toContain(`{ "key": "${key}", "name": "${name}"`);
    }
  });
});

describe('GET /health', () => {
  const store = { describe: jest.fn(async () => 'READY') };
  const loadConfig = jest.fn(async () => ({ tenantId: 't', clientId: 'c', clientSecret: 's' }));

  // An event whose only readable fields are the method and path: anything else (cookies, headers, query) throws.
  function guardedEvent(method) {
    const allowed = { rawPath: '/health', requestContext: { http: { method } } };
    return new Proxy(allowed, {
      get(target, key) {
        if (typeof key === 'string' && !(key in target)) throw new Error(`/health read event.${key}`);
        return target[key];
      },
      has(target, key) { throw new Error(`/health checked event.${String(key)}`); },
    });
  }

  test('answers without reading cookies, headers or the query string', async () => {
    const handler = createHandler({ loadConfig, store, sharepoint: {}, now: () => Date.UTC(2026, 10, 3, 23) });
    for (const method of ['GET', 'HEAD']) {
      const response = await handler(guardedEvent(method));
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/health+json');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(response.cookies).toBeUndefined();
      expect(JSON.parse(response.body)).toEqual({
        status: 'pass',
        time: '2026-11-03T23:00:00Z',
        functions: [{ key: 'links', name: 'Share links', status: 'pass' }, { key: 'signin', name: 'Owner sign-in', status: 'pass' }],
      });
    }
    expect((await handler(guardedEvent('POST'))).statusCode).toBe(405);
  });

  test('the handler source never reads cookies or Authorization for /health', () => {
    const code = (file) => read(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(code('lambda/api/health.js')).not.toMatch(/event|cookie|authorization|getSession|queryString|header\(|\.headers/i);
    const handler = code('lambda/api/index.js').split('return async function handler(event) {')[1];
    const route = handler.indexOf("if (path === '/health')");
    expect(route).toBeGreaterThan(-1);
    for (const read of ['queryStringParameters', 'header(event', 'getSession', 'cookies']) {
      expect(handler.indexOf(read)).toBeGreaterThan(route);
    }
    expect(handler.slice(0, route)).not.toMatch(/headers|cookies|queryString/);
  });

  test('a failed dependency is 503 with a generic reason; a slow (once warm) or not-ready one is a warning', async () => {
    let time = 0;
    const slow = createHealth({ now: () => time, checks: { links: async () => { time += 1500; return null; }, signin: async () => null } });
    const cold = await slow();
    expect(JSON.parse(cold.body).functions[0]).toEqual({ key: 'links', name: 'Share links', status: 'pass' });
    const warn = await slow();
    expect(warn.statusCode).toBe(200);
    expect(JSON.parse(warn.body).status).toBe('warn');
    expect(JSON.parse(warn.body).functions[0]).toEqual({ key: 'links', name: 'Share links', status: 'warn', output: 'slow' });

    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = createHealth({ checks: {
      links: () => checkLinks({ describe: async () => { throw new Error('arn:aws:cloudfront::123456789012:key-value-store/secret'); } }),
      signin: () => checkSignin(async () => { throw new NotConfigured('Missing SSM parameters: /share/entra-client-id'); }),
    } });
    const fail = await failing();
    expect(fail.statusCode).toBe(503);
    const body = JSON.parse(fail.body);
    expect(body.status).toBe('fail');
    expect(body.functions.map((f) => f.output)).toEqual(['read failed', 'not configured']);
    expect(fail.body).not.toMatch(/arn:|123456789012|\/share\/|SSM|stack/);
    spy.mockRestore();

    const notReady = createHealth({ checks: { links: () => checkLinks({ describe: async () => 'PROVISIONING' }), signin: async () => null } });
    expect(JSON.parse((await notReady()).body).functions[0]).toMatchObject({ status: 'warn', output: 'not ready' });
  });

  test('a hanging dependency times out, so the whole answer stays within the 5 s budget', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const health = createHealth({ checks: { links: () => new Promise(() => {}), signin: async () => null } });
    const pending = health();
    await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    const response = await pending;
    expect(CHECK_TIMEOUT_MS).toBeLessThan(5000);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).functions[0]).toMatchObject({ status: 'fail', output: 'timeout' });
    spy.mockRestore();
    jest.useRealTimers();
  });
});
