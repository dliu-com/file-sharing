// Owner page: create share links from OneDrive links, and copy, edit, refresh or delete them.
import { api, ApiError, copyText, el, formatDate, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;
const shareUrl = (id) => `${location.origin}/s/${id}`;
let shares = [];
let editing = null;

/** Expiry from a select (days, 0 = never, "date") and its date input; undefined = keep. */
function expiryFrom(select, dateInput) {
  const value = select.value;
  if (value === 'keep') return undefined;
  if (value === 'date') {
    if (!dateInput.value) throw new Error('Pick an expiry date');
    // End of the chosen day, local time.
    return new Date(`${dateInput.value}T23:59:59`).getTime();
  }
  const days = Number(value);
  return days ? Date.now() + days * DAY : 0;
}

function wireExpiry(select, dateInput) {
  select.addEventListener('change', () => {
    dateInput.hidden = select.value !== 'date';
    if (!dateInput.hidden) dateInput.min = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  });
}

function expiryText(exp) {
  if (!exp) return el('span', { class: 'muted' }, 'Never');
  return exp <= Date.now() ? el('span', { class: 'error' }, `Expired ${formatDate(exp)}`) : formatDate(exp);
}

async function run(button, action) {
  button.disabled = true;
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) location.reload();
    toast(error.message);
    return undefined;
  } finally {
    button.disabled = false;
  }
}

function renderShares() {
  $('list-status').textContent = shares.length ? '' : 'No links yet.';
  $('shares').hidden = shares.length === 0;
  $('share-rows').replaceChildren(...shares.map((share) => {
    const url = shareUrl(share.id);
    const actions = el('div', { class: 'row' },
      el('button', { type: 'button', onclick: () => copyText(url) }, 'Copy'),
      el('button', { type: 'button', onclick: () => openEdit(share) }, 'Edit'),
      el('button', {
        type: 'button',
        title: 'Fetch the files from OneDrive again (after you changed them there)',
        onclick: (event) => run(event.currentTarget, async () => {
          await api('/api/shares/refresh', { id: share.id });
          toast('Cached files cleared; they are fetched from OneDrive again within a few minutes');
        }),
      }, 'Refresh'),
      el('button', {
        type: 'button',
        class: 'danger',
        onclick: (event) => {
          if (!confirm(`Delete the link “${share.name}”? It stops working at once. The files stay in OneDrive.`)) return;
          run(event.currentTarget, async () => {
            await api('/api/shares/delete', { id: share.id });
            shares = shares.filter((s) => s.id !== share.id);
            renderShares();
            toast('Link deleted');
          });
        },
      }, 'Delete'));
    return el('tr', {},
      el('td', { class: 'name' },
        el('a', { href: url, target: '_blank', rel: 'noopener' }, el('span', { class: 'icon' }, share.kind === 'file' ? '📄' : '📁'), share.name || share.id),
        el('div', { class: 'muted small mono' }, url)),
      el('td', { class: 'date' }, formatDate(share.created)),
      el('td', { class: 'date' }, expiryText(share.exp)),
      el('td', { class: 'actions' }, actions));
  }));
}

function openEdit(share) {
  editing = share;
  $('edit-url').textContent = shareUrl(share.id);
  $('edit-name').value = share.name || '';
  $('edit-expiry').value = 'keep';
  $('edit-expiry-date').hidden = true;
  $('edit-link').value = share.src || '';
  $('edit-error').textContent = '';
  $('edit').showModal();
}

async function saveEdit(event) {
  event.preventDefault();
  if (!editing) return;
  const body = { id: editing.id, name: $('edit-name').value };
  try {
    const exp = expiryFrom($('edit-expiry'), $('edit-expiry-date'));
    if (exp !== undefined) body.exp = exp;
  } catch (error) {
    $('edit-error').textContent = error.message;
    return;
  }
  if ($('edit-link').value.trim() !== editing.src) body.link = $('edit-link').value.trim();
  $('edit-error').textContent = '';
  await run($('edit-save'), async () => {
    try {
      const updated = await api('/api/shares/update', body);
      shares = shares.map((s) => (s.id === updated.id ? updated : s));
      renderShares();
      $('edit').close();
      toast('Saved');
    } catch (error) {
      $('edit-error').textContent = error.message;
    }
  });
}

async function create(event) {
  event.preventDefault();
  $('create-error').textContent = '';
  let exp;
  try {
    exp = expiryFrom($('expiry'), $('expiry-date'));
  } catch (error) {
    $('create-error').textContent = error.message;
    return;
  }
  const button = $('create-button');
  button.disabled = true;
  button.textContent = 'Checking the link…';
  try {
    const share = await api('/api/shares', { link: $('link').value.trim(), name: $('name').value, exp });
    shares = [share, ...shares];
    renderShares();
    $('result-url').value = shareUrl(share.id);
    $('result-open').href = shareUrl(share.id);
    $('result').hidden = false;
    $('link').value = '';
    $('name').value = '';
    copyText(shareUrl(share.id), 'Link created and copied');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) location.reload();
    $('create-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Create link';
  }
}

async function main() {
  let me;
  try {
    me = await api('/api/me');
  } catch (error) {
    $('status').hidden = true;
    if (error instanceof ApiError && error.status === 401) {
      $('signin').hidden = false;
      return;
    }
    $('status').hidden = false;
    $('status').textContent = error.message;
    return;
  }
  $('status').hidden = true;
  $('nav').replaceChildren(el('span', { class: 'muted small' }, me.user), el('a', { class: 'button', href: '/docs' }, 'Docs'), el('a', { class: 'button', href: '/auth/logout' }, 'Sign out'));
  $('owner').hidden = false;
  wireExpiry($('expiry'), $('expiry-date'));
  wireExpiry($('edit-expiry'), $('edit-expiry-date'));
  $('create').addEventListener('submit', create);
  $('edit-form').addEventListener('submit', saveEdit);
  $('edit-cancel').addEventListener('click', () => $('edit').close());
  $('result-copy').addEventListener('click', () => copyText($('result-url').value));
  $('list-status').textContent = 'Loading…';
  try {
    shares = (await api('/api/shares')).shares;
    renderShares();
  } catch (error) {
    $('list-status').textContent = error.message;
  }
}

main();
