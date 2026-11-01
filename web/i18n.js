// Chinese / English for the pages friends see. The language follows the browser (the first of its preferred languages
// that is Chinese or English, else English) until someone picks one with the switch in the header, which is remembered.
// Importing this module translates every [data-i18n] element and adds the switch, so plain pages only need to load it.

const STRINGS = {
  en: {
    switchTo: '中文',
    switchLabel: '切换到中文',
    loading: 'Loading…',
    name: 'Name',
    size: 'Size',
    modified: 'Modified',
    folder: 'Folder',
    empty: 'This folder is empty.',
    download: 'Download',
    downloadFile: 'Download {name}',
    open: 'Open',
    previous: '← Previous',
    next: 'Next →',
    items: '{n} items',
    item: '1 item',
    retry: 'Retry',
    previewLoading: 'Loading preview…',
    previewTruncated: 'The preview shows the start of the file. Download it to see everything.',
    previewFailed: 'No preview available. Use Download.',
    noPreview: 'No preview for this type of file. Use Download to save it.',
    notFound: 'Not found.',
    linkGone: 'This link no longer works.',
    unreachable: 'Could not reach OneDrive. Please try again later.',
    failed: 'Something went wrong.',
    sharedVia: 'Shared via',
    ownerSignIn: 'Owner sign-in',
    homeTitle: 'Private file sharing',
    homeText: 'Files here are only reachable through links that Dewei Liu shares with you.',
    linkNotFound: 'Link not found',
    linkNotFoundText: 'This link does not exist, has expired or was removed.',
    home: 'Home',
    docs: 'Docs',
    docsTitle: 'How DL Share works and how it keeps files safe',
    architecture: 'Technical architecture',
    security: 'Security',
  },
  zh: {
    switchTo: 'EN',
    switchLabel: 'Switch to English',
    loading: '加载中…',
    name: '名称',
    size: '大小',
    modified: '修改时间',
    folder: '文件夹',
    empty: '此文件夹为空。',
    download: '下载',
    downloadFile: '下载 {name}',
    open: '打开',
    previous: '← 上一个',
    next: '下一个 →',
    items: '{n} 项',
    item: '1 项',
    retry: '重试',
    previewLoading: '正在加载预览…',
    previewTruncated: '仅显示文件开头部分，请下载查看全部内容。',
    previewFailed: '无法预览，请下载。',
    noPreview: '此类文件无法预览，请点击“下载”保存。',
    notFound: '未找到。',
    linkGone: '此链接已失效。',
    unreachable: '暂时无法连接 OneDrive，请稍后再试。',
    failed: '出错了。',
    sharedVia: '分享自',
    ownerSignIn: '管理员登录',
    homeTitle: '私人文件分享',
    homeText: '这里的文件只能通过 Dewei Liu 分享给你的链接访问。',
    linkNotFound: '链接无效',
    linkNotFoundText: '此链接不存在、已过期或已被删除。',
    home: '首页',
    docs: '文档',
    docsTitle: 'DL Share 的工作原理与安全',
    architecture: '技术架构',
    security: '安全',
  },
};

const STORAGE_KEY = 'lang';

function pick() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved in STRINGS) return saved;
  } catch { /* storage blocked: follow the browser */ }
  const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  for (const tag of preferred) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (code in STRINGS) return code;
  }
  return 'en';
}

export const lang = pick();

/** Locale for dates: the browser's own when it matches the language shown, else a default for that language. */
export const locale = String(navigator.language || '').toLowerCase().split('-')[0] === lang ? undefined : (lang === 'zh' ? 'zh-CN' : 'en-GB');

/** t('items', { n: 3 }) → "3 items" or "3 项". */
export function t(key, vars = {}) {
  const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

/** Inline text for long pages such as the docs: say('中文', 'English'). */
export const say = (zh, en) => (lang === 'zh' ? zh : en);

function docsButton() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const d of ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6M9 17h6']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  const link = document.createElement('a');
  link.className = 'button docs';
  link.href = '/docs';
  link.title = t('docsTitle');
  link.setAttribute('aria-label', t('docs'));
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = t('docs');
  link.append(svg, label);
  if (/^\/docs\/?$/.test(location.pathname)) link.setAttribute('aria-current', 'page');
  return link;
}

function apply() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = `${t(titleKey)} · DL Share`;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  for (const node of document.querySelectorAll('[data-lang]')) node.hidden = node.dataset.lang !== lang;

  const header = document.querySelector('header.top');
  if (!header) return;
  let nav = header.querySelector('nav');
  if (!nav) {
    nav = document.createElement('nav');
    header.append(nav);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button lang';
  button.lang = lang === 'zh' ? 'en' : 'zh-CN';
  button.textContent = t('switchTo');
  button.title = t('switchLabel');
  button.setAttribute('aria-label', t('switchLabel'));
  button.addEventListener('click', () => {
    try {
      localStorage.setItem(STORAGE_KEY, lang === 'zh' ? 'en' : 'zh');
    } catch { /* storage blocked: the switch only lasts for this page */ }
    location.reload();
  });
  nav.prepend(docsButton(), button);
}

apply();
