// Shared helpers for the share.dliu.com pages.

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** GET when body is undefined, otherwise POST JSON. CloudFront (OAC) needs the body hash for POSTs to Lambda. */
export async function api(path, body) {
  const init = { credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    const text = JSON.stringify(body);
    init.method = 'POST';
    init.body = text;
    init.headers['content-type'] = 'application/json';
    init.headers['x-amz-content-sha256'] = await sha256Hex(text);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`, response.status);
  return data;
}

/** Encodes each segment of a path for a URL, keeping the slashes. */
export const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function formatDate(value, locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Creates an element: el('a', { href: '/' }, 'text', child). Text is always set as text, never as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function toast(message) {
  const node = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

export async function copyText(text, message = 'Link copied · 已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Copy failed; select the text and copy it yourself');
  }
}

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico'],
  video: ['mp4', 'm4v', 'webm', 'mov'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'log', 'srt', 'vtt'],
};
const ICONS = { folder: '📁', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', other: '📄' };

/** How the viewer can show a file: image, video, audio, pdf, text or other (download only). */
export function previewKind(name) {
  const match = EXTENSION.exec(name || '');
  const ext = match ? match[1].toLowerCase() : '';
  return Object.keys(KINDS).find((kind) => KINDS[kind].includes(ext)) || 'other';
}

export const iconFor = (kind) => ICONS[kind] || ICONS.other;
