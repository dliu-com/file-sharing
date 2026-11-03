// Chinese / English for the pages friends see. The language follows the browser (the first of its preferred languages
// that is Chinese or English, else English) until someone picks one with the switch in the header, which is remembered.
// Importing this module translates every [data-i18n] element and adds the switch, so plain pages only need to load it.

const STRINGS = {
  en: {
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
    cost: 'Cost',
    security: 'Security',
  },
  zh: {
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
    cost: '费用',
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
  const link = document.createElement('a');
  link.className = 'dl-button';
  link.href = '/docs';
  link.title = t('docsTitle');
  link.textContent = t('docs');
  if (/^\/docs\/?$/.test(location.pathname)) link.setAttribute('aria-current', 'page');
  return link;
}

// The shared dl-language switcher: both languages side by side, or a 文/A menu on narrow screens.
function languageSwitcher() {
  const box = document.createElement('div');
  box.className = 'dl-language';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dl-button dl-language-toggle';
  toggle.setAttribute('aria-controls', 'dl-languages');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Language / 语言');
  toggle.textContent = '文/A';
  const group = document.createElement('div');
  group.id = 'dl-languages';
  group.className = 'dl-languages';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language / 语言');
  const setOpen = (open) => {
    group.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  for (const [code, htmlLang, label] of [['zh', 'zh-CN', '中文'], ['en', 'en', 'English']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.language = code;
    button.lang = htmlLang;
    button.textContent = label;
    button.setAttribute('aria-pressed', String(code === lang));
    button.addEventListener('click', () => {
      setOpen(false);
      if (code === lang) return;
      try {
        localStorage.setItem(STORAGE_KEY, code);
      } catch { /* storage blocked: the switch only lasts for this page */ }
      location.reload();
    });
    group.append(button);
  }
  toggle.addEventListener('click', () => setOpen(!group.classList.contains('is-open')));
  document.addEventListener('click', (event) => { if (!box.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
  box.append(toggle, group);
  return box;
}

function apply() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = `${t(titleKey)} · DL Share`;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  for (const node of document.querySelectorAll('[data-lang]')) node.hidden = node.dataset.lang !== lang;

  const nav = document.querySelector('header.dl-header .dl-nav');
  if (!nav) return;
  nav.prepend(docsButton());
  nav.append(languageSwitcher());
}

apply();
