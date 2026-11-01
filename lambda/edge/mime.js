'use strict';

// Content types come from the file extension, not from SharePoint, so a file can never be served as HTML or
// script by accident. Unknown types are downloads.
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  opus: 'audio/ogg', amr: 'audio/amr',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json', vtt: 'text/vtt; charset=utf-8', srt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xml: 'application/xml',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip',
  tar: 'application/x-tar', epub: 'application/epub+zip', apk: 'application/vnd.android.package-archive',
};

// Shown in the browser (and in the viewer page). Everything else, including HTML and SVG, is a download.
const INLINE = /^(image\/(jpeg|png|gif|webp|avif|bmp|x-icon)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf|text\/plain|text\/vtt)/;

const extension = (name) => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return match ? match[1].toLowerCase() : '';
};

const contentTypeFor = (name) => TYPES[extension(name)] || 'application/octet-stream';
const isInline = (type) => INLINE.test(type);

module.exports = { contentTypeFor, isInline, extension };
