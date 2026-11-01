// Viewer page for /s/<id>/<path>: a folder listing (every file has its own Download button) or one file's preview.
import { api, ApiError, el, encodePath, formatDate as formatDateIn, formatSize, iconFor, previewKind } from './common.js';
import { locale, t } from './i18n.js';

const TEXT_PREVIEW_BYTES = 256 * 1024;
const $ = (id) => document.getElementById(id);
const formatDate = (value) => formatDateIn(value, locale);

const match = /^\/s\/([0-9A-Za-z]{10})(?:\/(.*))?$/.exec(location.pathname);
const id = match ? match[1] : '';
let requested = '';
try {
  requested = match && match[2] ? match[2].split('/').map(decodeURIComponent).join('/') : '';
} catch { /* show the root */ }

let shareKind = 'folder';
let title = '';

/** Viewer page of a folder (trailing slash) or a file inside the share. */
const pageUrl = (path, folder) => `/s/${id}/${path ? encodePath(path) + (folder ? '/' : '') : ''}`;
/** The file's bytes. dl=1 makes it a download (Content-Disposition: attachment), even in in-app browsers. */
const fileUrl = (path, name, download) => `/f/${id}/${encodePath(shareKind === 'file' ? name : path)}${download ? '?dl=1' : ''}`;
const join = (folder, name) => (folder ? `${folder}/${name}` : name);
const parentOf = (path) => path.split('/').slice(0, -1).join('/');

function status(message, retry) {
  const node = $('status');
  node.hidden = false;
  node.className = retry === undefined ? 'muted' : 'error';
  node.replaceChildren(message, retry ? el('button', { type: 'button', class: 'retry', onclick: () => location.reload() }, t('retry')) : '');
}

function crumbs(path, isFile) {
  const nav = $('crumbs');
  const parts = path ? path.split('/') : [];
  const items = [shareKind === 'folder' ? el('a', { href: pageUrl('', true) }, title) : el('span', {}, title)];
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    items.push(el('span', { class: 'sep' }, '/'));
    items.push(last ? el('span', {}, part) : el('a', { href: pageUrl(parts.slice(0, index + 1).join('/'), true) }, part));
  });
  // A single shared file needs no trail; a file inside the folder shows its folder trail (the name is the heading).
  if (isFile) items.splice(shareKind === 'folder' ? -2 : 0);
  nav.replaceChildren(...items);
}

function downloadButton(path, name) {
  return el('a', { class: 'button download', href: fileUrl(path, name, true), download: name, title: t('downloadFile', { name }) },
    '⬇', el('span', { class: 'label' }, ` ${t('download')}`));
}

function showFolder(data) {
  const rows = [];
  for (const folder of data.folders) {
    rows.push(el('tr', {},
      el('td', { class: 'name' }, el('a', { href: pageUrl(join(data.path, folder.name), true) }, el('span', { class: 'icon' }, iconFor('folder')), folder.name)),
      el('td', { class: 'size' }, folder.count === 1 ? t('item') : t('items', { n: folder.count })),
      el('td', { class: 'date' }, formatDate(folder.modified)),
      el('td', { class: 'actions' })));
  }
  for (const file of data.files) {
    const path = join(data.path, file.name);
    rows.push(el('tr', {},
      el('td', { class: 'name' }, el('a', { href: pageUrl(path) }, el('span', { class: 'icon' }, iconFor(previewKind(file.name))), file.name)),
      el('td', { class: 'size' }, formatSize(file.size)),
      el('td', { class: 'date' }, formatDate(file.modified)),
      el('td', { class: 'actions' }, downloadButton(path, file.name))));
  }
  $('rows').replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;
  $('folder').hidden = false;
  crumbs(data.path, false);
  document.title = `${data.path ? data.name : title} · DL Share`;
}

async function textPreview(url) {
  const response = await fetch(url, { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(await response.arrayBuffer());
  const range = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
  const truncated = response.status === 206 && range && Number(range[1]) > TEXT_PREVIEW_BYTES;
  return [el('pre', { class: 'text' }, text), truncated ? el('p', { class: 'muted small' }, t('previewTruncated')) : ''];
}

async function showFile(data) {
  const path = data.path;
  const view = fileUrl(path, data.name, false);
  $('file-name').textContent = data.name;
  $('file-meta').textContent = [formatSize(data.size), formatDate(data.modified)].filter(Boolean).join(' · ');
  $('file-download').href = fileUrl(path, data.name, true);
  $('file-download').setAttribute('download', data.name);
  $('file-open').href = view;
  $('file').hidden = false;
  crumbs(path, true);
  document.title = `${data.name} · DL Share`;

  const preview = $('preview');
  const kind = previewKind(data.name);
  preview.classList.toggle('pdf-preview', kind === 'pdf');
  if (kind === 'image') preview.replaceChildren(el('img', { src: view, alt: data.name }));
  else if (kind === 'video') preview.replaceChildren(el('video', { src: view, controls: true, preload: 'metadata', playsinline: true }));
  else if (kind === 'audio') preview.replaceChildren(el('audio', { src: view, controls: true, preload: 'metadata' }));
  else if (kind === 'pdf') {
    const pages = el('div', { class: 'pdf' }, el('p', { class: 'muted' }, t('previewLoading')));
    preview.replaceChildren(pages);
    // If PDF.js can't read it (e.g. password-protected), fall back to the browser's own viewer.
    import('./pdf.js').then(({ renderPdf }) => renderPdf(pages, view))
      .catch(() => preview.replaceChildren(el('iframe', { src: view, title: data.name, class: 'pdf' })));
  } else if (kind === 'text') {
    preview.replaceChildren(el('p', { class: 'muted' }, t('previewLoading')));
    textPreview(view).then((nodes) => preview.replaceChildren(...nodes))
      .catch(() => preview.replaceChildren(el('p', { class: 'muted' }, t('previewFailed'))));
  } else {
    preview.replaceChildren(el('p', { class: 'muted no-preview' }, t('noPreview')));
  }
  if (shareKind === 'folder') pager(path).catch(() => {});
}

// Previous / next file in the same folder (also with the arrow keys), for flicking through photos.
async function pager(path) {
  const folder = await api(`/api/s/${id}/info?path=${encodeURIComponent(parentOf(path) ? `${parentOf(path)}/` : '')}`);
  if (folder.type !== 'folder') return;
  const names = folder.files.map((f) => f.name);
  const index = names.indexOf(path.split('/').pop());
  if (index < 0 || names.length < 2) return;
  const link = (node, offset) => {
    const target = names[index + offset];
    node.hidden = !target;
    if (target) node.href = pageUrl(join(folder.path, target));
  };
  link($('prev'), -1);
  link($('next'), 1);
  $('pager').hidden = false;
  document.addEventListener('keydown', (event) => {
    if (event.target.closest && event.target.closest('input, textarea, video, audio')) return;
    const node = event.key === 'ArrowLeft' ? $('prev') : event.key === 'ArrowRight' ? $('next') : null;
    if (node && !node.hidden) location.href = node.href;
  });
}

async function main() {
  if (!id) return status(t('linkNotFoundText'), false);
  const folderFirst = requested === '' || location.pathname.endsWith('/');
  const query = requested ? (folderFirst ? `${requested}/` : requested) : '';
  try {
    const data = await api(`/api/s/${id}/info?path=${encodeURIComponent(query)}`);
    shareKind = data.kind;
    title = data.title || data.share;
    $('status').hidden = true;
    if (data.type === 'folder') showFolder(data);
    else showFile(data);
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0;
    if (code === 410) return status(t('linkGone'), false);
    if (code === 404) return status(requested ? t('notFound') : t('linkNotFoundText'), false);
    status(code === 502 || code === 504 ? t('unreachable') : t('failed'), true);
  }
}

main();
