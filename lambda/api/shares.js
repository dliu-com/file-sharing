'use strict';

// Owner actions on share links. A share record: { src, kind, name, created, exp }
//   src     the OneDrive "Anyone with the link" link (never shown to visitors)
//   kind    'file' or 'folder'
//   name    title shown on the viewer page
//   created / exp   epoch milliseconds; exp 0 = never expires

const crypto = require('crypto');
const { isSharePointLink, ShareError } = require('../edge/sharepoint');
const { TooLarge } = require('./store');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 10;
const ID = /^[0-9A-Za-z]{10}$/;
const MAX_NAME = 100;
const MAX_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

class BadRequest extends Error {}
class NotFound extends Error {}

/** 10 random base62 characters (about 59 bits). Rejection sampling keeps every character equally likely. */
function newId(random = crypto.randomBytes) {
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const byte of random(16)) {
      if (byte < 248 && id.length < ID_LENGTH) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new BadRequest('Invalid link id');
  return id;
}

function cleanLink(link) {
  const value = typeof link === 'string' ? link.trim() : '';
  if (!isSharePointLink(value)) {
    throw new BadRequest('Paste a OneDrive sharing link that starts with https://…sharepoint.com/ (Share → "Anyone with the link" → Copy link).');
  }
  return value;
}

function cleanName(name) {
  if (name === undefined || name === null) return '';
  if (typeof name !== 'string') throw new BadRequest('Name must be text');
  const value = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (value.length > MAX_NAME) throw new BadRequest(`Name must be at most ${MAX_NAME} characters`);
  return value;
}

function cleanExpiry(exp, now) {
  if (exp === undefined || exp === null || exp === 0 || exp === '') return 0;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new BadRequest('Expiry must be a timestamp in milliseconds');
  if (exp <= now) throw new BadRequest('Expiry must be in the future');
  if (exp > now + MAX_EXPIRY_MS) throw new BadRequest('Expiry must be within 10 years');
  return Math.floor(exp);
}

function createShares({ store, sharepoint, invalidate, now = Date.now, random }) {
  // Opens the link as a guest, exactly as a visitor's request would, before saving it.
  async function check(src) {
    try {
      return await sharepoint.describe(src);
    } catch (error) {
      if (error instanceof ShareError && error.status !== 502) throw new BadRequest(`That link does not work without sign-in: ${error.message}`);
      throw error;
    }
  }

  async function save(id, record) {
    try {
      await store.put(id, record);
    } catch (error) {
      if (error instanceof TooLarge) throw new BadRequest(error.message);
      throw error;
    }
  }

  // Covers /f/<id>/... (the id is fixed length, so no other link matches).
  const purge = (id) => invalidate([`/f/${id}*`]);

  async function create(body) {
    const src = cleanLink(body.link);
    const name = cleanName(body.name);
    const exp = cleanExpiry(body.exp, now());
    const info = await check(src);
    const record = { src, kind: info.kind, name: name || info.name, created: now(), exp };
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId(random);
      if (await store.get(id)) continue;
      await save(id, record);
      return { id, ...record };
    }
    throw new Error('Could not pick an unused link id');
  }

  async function list() {
    const shares = await store.list();
    return { shares: shares.sort((a, b) => (b.created || 0) - (a.created || 0)) };
  }

  async function update(body) {
    const id = checkId(body.id);
    const record = await store.get(id);
    if (!record) throw new NotFound('That link no longer exists');
    let changedSource = false;
    if (body.link !== undefined) {
      const src = cleanLink(body.link);
      if (src !== record.src) {
        const info = await check(src);
        Object.assign(record, { src, kind: info.kind });
        changedSource = true;
      }
    }
    if (body.name !== undefined) record.name = cleanName(body.name) || record.name;
    if (body.exp !== undefined) record.exp = cleanExpiry(body.exp, now());
    await save(id, record);
    if (changedSource) await purge(id);
    return { id, ...record };
  }

  async function remove(body) {
    const id = checkId(body.id);
    await store.remove(id);
    await purge(id);
    return { id, deleted: true };
  }

  // Drops cached copies of the files, after they changed in OneDrive.
  async function refresh(body) {
    const id = checkId(body.id);
    if (!(await store.get(id))) throw new NotFound('That link no longer exists');
    await purge(id);
    return { id, refreshed: true };
  }

  return { create, list, update, remove, refresh };
}

module.exports = { createShares, newId, BadRequest, NotFound, ID };
