#!/usr/bin/env node
// Copies Mozilla PDF.js (pdfjs-dist, legacy build for older phone browsers) into web/vendor/pdfjs/, which the
// stack uploads with the rest of web/. The viewer draws PDFs with it instead of relying on the browser's own
// PDF viewer, which Android, WeChat and Chrome set to "Download PDFs" cannot show inside a page.
// Run by `make deploy` and `make dev`; web/vendor/ is git-ignored.

const fs = require('fs');
const path = require('path');

const SRC = path.dirname(require.resolve('pdfjs-dist/package.json'));
const OUT = path.join(__dirname, '../web/vendor/pdfjs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// Saved as .js: S3 and the dev server serve that as JavaScript (nosniff would block an unknown type).
for (const name of ['pdf.min', 'pdf.worker.min']) fs.copyFileSync(path.join(SRC, 'legacy/build', `${name}.mjs`), path.join(OUT, `${name}.js`));
for (const dir of ['cmaps', 'standard_fonts']) fs.cpSync(path.join(SRC, dir), path.join(OUT, dir), { recursive: true });
fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'LICENSE'));
console.log(`PDF.js ${require('pdfjs-dist/package.json').version} copied to web/vendor/pdfjs`);
