const fs = require('fs');
const path = require('path');

// Guards the shared dliu.com look: https://files.dliu.com/dliu.com/README.md
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const APP_CSS = '<link rel="stylesheet" href="/_app/style.css">';
// DL Share keeps its own logo instead of the DL icon (user decision).
const LOGO = '/_app/logo.svg';
const PAGES = ['index', 'admin', 'view', 'docs'];

// The link-not-found page that the CloudFront Function returns, as plain HTML.
function notFoundPage() {
  const source = read('functions/viewer.js');
  const ICON = LOGO;
  const body = source.slice(source.indexOf('const NOT_FOUND ='), source.indexOf("';\n", source.indexOf('const NOT_FOUND =')) + 2);
  return new Function('ICON', `${body}; return NOT_FOUND;`)(ICON);
}

const pages = () => [...PAGES.map((html) => [html, read(`web/${html}.html`)]), ['404', notFoundPage()]];

test('every page loads the shared dliu.com stylesheet before its own', () => {
  for (const [name, page] of pages()) {
    expect([name, page.includes(DL_CSS)]).toEqual([name, true]);
    expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf(APP_CSS));
    expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf('<script'));
  }
});

test('every page has the shared header with the DL Share logo, and the shared footer', () => {
  for (const [, page] of pages()) {
    expect(page).toContain(`<link rel="icon" type="image/svg+xml" href="${LOGO}">`);
    expect(page).toContain('<body class="dl-page">');
    expect(page).toContain(`<a class="dl-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${LOGO}" alt="DL Share"`);
    expect(page).toContain('<a class="dl-brand" href="/">DL Share</a>');
    expect(page).toContain('<nav class="dl-nav" aria-label="Site"');
    expect(page).toMatch(/<main class="dl-main[" ]/);
    expect(page).toContain('<footer class="dl-footer"><a href="https://dliu.com">dliu.com</a>');
    expect(page).not.toContain('files.dliu.com/dliu.com/favicon.png');
  }
});

test('the owner sign-in on the home page is the shared sign-in button', () => {
  expect(read('web/index.html')).toContain('<a class="dl-button dl-signin" href="/admin"');
});

test('the docs page loads the shared docs stylesheet and tabs, and the app has no docs stylesheet of its own', () => {
  const page = read('web/docs.html');
  expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">'));
  expect(page).toContain('<main class="dl-main dl-docs-main">');
  expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections">');
  expect(page).toContain('<article id="architecture" class="dl-docs">');
  expect(page).not.toContain('/_app/docs.css');
  expect(fs.existsSync(path.join(__dirname, '..', 'web/docs.css'))).toBe(false);
});

test('the header script uses the shared nav, Docs button and language switcher', () => {
  const script = read('web/i18n.js');
  expect(script).toContain("document.querySelector('header.dl-header .dl-nav')");
  expect(script).toContain("'dl-button dl-language-toggle'");
  expect(script).toContain("'dl-languages'");
  expect(script).not.toMatch(/header\.top|'button /);
});

test('the app stylesheet and scripts leave the header, buttons and palette to the shared stylesheet', () => {
  const css = read('web/style.css');
  expect(css).not.toMatch(/header\.top|\.brand|^\s*button|\.button\b|--accent:|:root|footer\.bottom/m);
  expect(css).not.toMatch(/var\(--(bg|panel|line|text|muted|accent|accent-2|danger|radius)\)/);
  for (const file of ['admin', 'view', 'common', 'docs', 'i18n']) {
    expect(read(`web/${file}.js`)).not.toMatch(/class: '(muted|error|button|primary|danger)\b|className = '(button|muted|error)\b/);
  }
});

test('the CSP allows only the shared stylesheets and icon from files.dliu.com', () => {
  const stack = read('lib/file-sharing-stack.ts');
  expect(stack).toContain(`"style-src 'self' https://files.dliu.com/dliu.com/ui/"`);
  expect(stack).toContain(`"img-src 'self' data: blob: https://files.dliu.com/dliu.com/"`);
});
