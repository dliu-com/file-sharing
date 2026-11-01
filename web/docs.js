import { t, say } from './i18n.js';
import { flow, tiers, stats, table, callout, more } from './diagram.js';

const TABS = ['architecture', 'security'];
const mono = (text) => ({ text, className: 'mono' });
const num = (text) => ({ text, className: 'num' });
const PASS = { text: say('✓ 通过', '✓ Pass'), className: 'status' };
const LOW = { text: say('低', 'Low'), className: 'risk-low' };
const MEDIUM = { text: say('中', 'Medium'), className: 'risk-medium' };

function writer(root) {
  return (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    root.append(node);
    return node;
  };
}

function list(items) {
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  return ul;
}

// ---------------------------------------------------------------- Architecture
function architecture(root) {
  const add = writer(root);
  add('h2', say('工作原理', 'How it works'));
  add('p', say(
    '文件仍放在 OneDrive。DL Share 只保存一个短链接到 OneDrive 分享链接的对应关系，由 AWS 在服务器端取文件，再从 share.dliu.com 发给朋友。',
    'Files stay in OneDrive. DL Share only stores which short link points to which OneDrive sharing link; AWS fetches the files server-side and serves them from share.dliu.com.',
  ), 'lead');

  root.append(stats([
    [say('0 台服务器', '0 servers'), say('没人访问时不运行任何东西', 'nothing runs while nobody visits'), 'power'],
    [say('35 个字符', '35 characters'), say('短链接长度，OneDrive 约 110', 'per short link; OneDrive’s are ~110'), 'link'],
    [say('1 天', '1 day'), say('文件在 CloudFront 边缘缓存', 'files cached at CloudFront edges'), 'clock'],
    [say('3 个函数', '3 functions'), say('链接检查、取文件、管理 API', 'link check, file fetch, owner API'), 'lambda'],
  ]));

  root.append(tiers({
    title: say('组成部分', 'Components'),
    rows: [
      {
        label: say('用户', 'People'), badge: say('浏览器', 'Browser'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: say('朋友', 'Friends'), text: say('打开短链接即可，无需登录', 'Open the short link; no sign-in') },
          { icon: 'china', title: say('中国大陆', 'Mainland China'), text: say('只访问 share.dliu.com，不直接连 OneDrive', 'Only reach share.dliu.com, never OneDrive') },
          { icon: 'user', title: say('站长', 'Owner'), text: say('用 Microsoft 登录，创建和管理链接', 'Signs in with Microsoft to create and manage links') },
        ],
      },
      {
        label: 'CloudFront', badge: say('边缘', 'Edge'), tone: 'edge', link: say('HTTPS，全球所有边缘节点', 'HTTPS, all edge locations worldwide'),
        nodes: [
          { icon: 'cloudfront', title: say('分发', 'Distribution'), text: say('TLS 1.2+、安全响应头、缓存文件', 'TLS 1.2+, security headers, caches files') },
          { icon: 'key', title: say('链接检查函数', 'Link check function'), text: say('在 KeyValueStore 里查短链接 ID', 'Looks the short-link ID up in a KeyValueStore') },
        ],
      },
      {
        label: 'Lambda', badge: say('按需', 'On demand'), tone: 'app', link: say('只经 CloudFront 调用', 'called only through CloudFront'),
        nodes: [
          { icon: 'download', title: 'Lambda@Edge', text: say('把文件请求指向 OneDrive，整理响应头', 'Points file requests at OneDrive, cleans the response') },
          { icon: 'lambda', title: say('API Lambda', 'API Lambda'), text: say('文件夹列表、登录、管理链接', 'Folder listings, sign-in, managing links') },
        ],
      },
      {
        label: say('存储与身份', 'Storage and identity'), badge: say('私有', 'Private'), tone: 'private', link: say('访问者不可见', 'never visible to visitors'),
        nodes: [
          { icon: 'onedrive', title: 'OneDrive', text: say('文件本身，用“任何人”分享链接读取', 'The files, read through an “Anyone” link') },
          { icon: 's3', title: say('网站存储桶', 'Site bucket'), text: say('本站的 HTML、CSS、JS', 'This site’s HTML, CSS and JS') },
          { icon: 'ssm', title: 'Parameter Store', text: say('Microsoft 登录密钥（加密）', 'Microsoft sign-in secret, encrypted') },
          { icon: 'entra', title: 'Microsoft Entra ID', text: say('站长登录', 'Owner sign-in') },
        ],
      },
    ],
  }));

  add('h2', say('打开一个链接', 'Opening a link'));
  root.append(flow({
    title: say('朋友的浏览器加载什么', 'What a friend’s browser loads'),
    numbered: true,
    steps: [
      { icon: 'link', title: say('短链接', 'Short link'), text: '/s/<id>' },
      { icon: 'key', title: say('检查', 'Check'), text: say('在 KeyValueStore 查 ID；不存在或已过期则 404', 'ID looked up in the KeyValueStore; unknown or expired → 404') },
      { icon: 'folder', title: say('列表', 'Listing'), text: say('API Lambda 从 OneDrive 读文件夹', 'API Lambda reads the folder from OneDrive') },
      { icon: 'download', title: say('文件', 'File'), text: say('Lambda@Edge 让 CloudFront 直接从 OneDrive 取文件', 'Lambda@Edge has CloudFront pull the bytes from OneDrive') },
      { icon: 'clock', title: say('缓存', 'Cache'), text: say('下一个朋友直接从边缘缓存拿到', 'The next friend gets it from the edge cache'), tone: 'good' },
    ],
    note: say('每个请求都会先做第 2 步，所以删除或过期的链接立即失效，缓存里的文件也拿不到。', 'Step 2 runs on every request, before the cache, so a deleted or expired link stops at once, even for cached files.'),
  }));

  add('h2', say('创建一个链接', 'Creating a link'));
  root.append(flow({
    numbered: true,
    steps: [
      { icon: 'entra', title: say('登录', 'Sign in'), text: say('Microsoft，只限 @dliu.com', 'Microsoft, @dliu.com only') },
      { icon: 'onedrive', title: say('粘贴', 'Paste'), text: say('OneDrive“任何人”分享链接', 'An OneDrive “Anyone” link') },
      { icon: 'check', title: say('验证', 'Verify'), text: say('API 打开该链接，确认可读', 'The API opens it to check it works') },
      { icon: 'key', title: say('保存', 'Save'), text: say('随机 10 位 ID → KeyValueStore', 'Random 10-character ID → KeyValueStore') },
      { icon: 'link', title: say('分享', 'Share'), text: 'share.dliu.com/s/<id>', tone: 'good' },
    ],
  }));

  add('h2', say('和直接分享 OneDrive 对比', 'Compared with sharing OneDrive directly'));
  root.append(table([say('项目', 'Item'), say('OneDrive 链接', 'OneDrive link'), say('DL Share 链接', 'DL Share link')], [
    [say('长度', 'Length'), num(say('约 110 字符', '~110 characters')), num(say('35 字符', '35 characters'))],
    [say('域名', 'Domain'), mono('*.sharepoint.com'), mono('share.dliu.com')],
    [say('中国大陆', 'Mainland China'), say('经常打不开', 'Often blocked'), say('由 AWS 边缘节点提供', 'Served from AWS edges')],
    [say('需要登录', 'Sign-in'), say('不需要', 'None'), say('不需要', 'None')],
    [say('过期', 'Expiry'), say('OneDrive 设置', 'OneDrive setting'), say('OneDrive 设置 + 可选的过期时间', 'OneDrive setting + optional own expiry')],
    [say('撤销', 'Revoke'), say('在 OneDrive 停止分享', 'Stop sharing in OneDrive'), say('任一边删除即可', 'Delete on either side')],
  ]));

  add('h2', say('网址', 'URLs'));
  root.append(table([say('路径', 'Path'), say('内容', 'What'), say('缓存', 'Caching')], [
    [mono('/'), say('首页', 'Home page'), say('每次重新验证', 'Revalidated every load')],
    [mono('/s/<id>/…'), say('文件夹或文件预览页', 'Folder or file viewer'), say('每次重新验证', 'Revalidated every load')],
    [mono('/api/s/<id>/info'), say('文件夹列表（JSON）', 'Folder listing (JSON)'), say('不缓存', 'Never')],
    [mono('/f/<id>/<path>'), say('文件内容，?dl=1 为下载', 'File bytes; ?dl=1 to download'), say('边缘 1 天，浏览器 1 小时', '1 day at edge, 1 hour in browser')],
    [mono('/admin'), say('站长页面', 'Owner page'), say('每次重新验证', 'Revalidated every load')],
    [mono('/api/* /auth/*'), say('管理 API 与登录', 'Owner API and sign-in'), say('不缓存', 'Never')],
    [mono('/docs'), say('本页', 'This page'), say('每次重新验证', 'Revalidated every load')],
  ]));

  add('h2', say('每个链接保存的数据', 'What each link stores'));
  root.append(table([say('字段', 'Field'), say('内容', 'Holds'), say('访问者可见', 'Visible to visitors')], [
    [mono('id'), say('10 位随机字符（KeyValueStore 的键）', '10 random characters (the KeyValueStore key)'), say('是', 'Yes')],
    [mono('src'), say('OneDrive 分享链接', 'The OneDrive sharing link'), say('否', 'No')],
    [mono('name'), say('显示名称', 'Display name'), say('是', 'Yes')],
    [mono('kind'), say('文件或文件夹', 'File or folder'), say('是', 'Yes')],
    [mono('created / exp'), say('创建和过期时间', 'Created and expiry times'), say('否', 'No')],
  ]));
  add('p', say('没有数据库：每条记录不超过 1 KB，存在 CloudFront KeyValueStore 中。', 'No database: each record is at most 1 KB in a CloudFront KeyValueStore.'), 'dg-note');

  root.append(more(say('构建、部署和测试', 'Build, deploy and test'), list([
    say('一个 AWS CDK 栈（TypeScript），在 eu-west-1；Lambda@Edge 和证书在 us-east-1。', 'One AWS CDK stack (TypeScript) in eu-west-1; Lambda@Edge and the certificate are in us-east-1.'),
    say('make deploy 一起部署网页和基础设施。', 'make deploy ships the pages and infrastructure together.'),
    say('Microsoft 登录密钥用脚本写入 Parameter Store，不在代码中。', 'The Microsoft sign-in secret is written to Parameter Store by a script, never into the code.'),
    say('Jest 单元测试覆盖链接检查函数、API、Lambda@Edge 和整个栈；冒烟测试在线上创建、打开并删除测试链接。', 'Jest tests cover the link check, API, Lambda@Edge and the stack; a smoke test creates, opens and deletes a link on the live site.'),
    say('访问量由 traffic.dliu.com 从 CloudFront 日志统计，本站不运行统计脚本。', 'Visits are counted by traffic.dliu.com from CloudFront logs; this site runs no analytics code.'),
  ])));
}

// ---------------------------------------------------------------- Security
function security(root) {
  const add = writer(root);
  add('h2', say('安全', 'Security'));
  add('p', say('有链接的人可以查看；只有站长能创建、修改或删除链接。', 'Anyone with a link can view it; only the owner can create, change or delete links.'), 'lead');
  root.append(callout('shield', say('以下 16 项检查已在 share.dliu.com 线上实测，全部通过。', 'The 16 checks below were run against the live share.dliu.com; all passed.')));

  root.append(stats([
    [say('8×10¹⁷', '8×10¹⁷'), say('可能的链接 ID（62¹⁰）', 'possible link IDs (62¹⁰)'), 'key'],
    [say('约 2.7 万年', '~27,000 years'), say('每秒猜 1 万次，碰中 100 个链接之一的平均时间', 'to hit one of 100 links at 10,000 guesses/s'), 'clock'],
    [say('0 个', '0'), say('OneDrive 账号权限：登录只要 openid、profile、email', 'OneDrive account permissions: sign-in asks only openid, profile, email'), 'lock'],
    [say('12 小时', '12 hours'), say('站长登录有效期', 'owner session lifetime'), 'entra'],
  ]));

  root.append(tiers({
    title: say('信任边界', 'Trust boundaries'),
    rows: [
      {
        label: say('互联网', 'Internet'), badge: say('不可信', 'Untrusted'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: say('有链接的人', 'Anyone with a link'), text: say('只能看这个链接里的内容', 'Sees only what that link shares') },
          { icon: 'bot', title: say('其他人', 'Everyone else'), text: say('只有首页和 404', 'Gets the home page and 404s') },
        ],
      },
      {
        label: 'CloudFront', badge: say('边缘', 'Edge'), tone: 'edge', link: say('TLS 1.2+，HSTS', 'TLS 1.2+, HSTS'),
        nodes: [
          { icon: 'key', title: say('链接检查', 'Link check'), text: say('每个请求都查 ID 和过期时间；删除访问者伪造的 x-share-* 头', 'Checks ID and expiry on every request; drops forged x-share-* headers') },
          { icon: 'shield', title: say('响应头', 'Headers'), text: say('CSP、nosniff、no-referrer、noindex', 'CSP, nosniff, no-referrer, noindex') },
        ],
      },
      {
        label: 'Lambda', badge: say('应用', 'App'), tone: 'app', link: say('只接受 CloudFront 签名的请求（OAC）', 'only CloudFront-signed calls (OAC)'),
        nodes: [
          { icon: 'download', title: 'Lambda@Edge', text: say('没有 AWS 权限；只保留安全的响应头', 'No AWS permissions; keeps only safe headers') },
          { icon: 'lock', title: 'API Lambda', text: say('管理操作需登录 + 本站 Origin', 'Owner actions need a session + this site’s Origin') },
        ],
      },
      {
        label: say('AWS 与 Microsoft', 'AWS and Microsoft'), badge: say('私有', 'Private'), tone: 'private', link: say('最小权限', 'least privilege'),
        nodes: [
          { icon: 's3', title: say('存储桶', 'Bucket'), text: say('禁止公开访问、加密、只限 HTTPS', 'Public access blocked, encrypted, HTTPS only') },
          { icon: 'ssm', title: 'Parameter Store', text: say('登录密钥用 KMS 加密', 'Sign-in secret encrypted with KMS') },
          { icon: 'onedrive', title: 'OneDrive', text: say('只读取分享链接所包含的内容', 'Only reads what the link shares') },
        ],
      },
    ],
  }));

  add('h2', say('朋友能看到什么', 'What friends can see'));
  root.append(table([say('数据', 'Data'), say('朋友可见', 'Visible to friends')], [
    [say('分享的文件和文件夹：名称、大小、日期、内容', 'Shared files and folders: names, sizes, dates, contents'), say('是', 'Yes')],
    [say('OneDrive 原始链接', 'The original OneDrive link'), say('否', 'No')],
    [say('SharePoint 访客 Cookie', 'SharePoint guest cookie'), say('否', 'No')],
    [say('站长的账号和邮箱', 'The owner’s account and email'), say('否', 'No')],
    [say('其他链接', 'Other links'), say('否，需要知道各自的 ID', 'No, each needs its own ID')],
  ]));

  add('h2', say('线上渗透测试', 'Live penetration test'));
  root.append(table([say('测试', 'Test'), say('结果', 'Result'), say('状态', 'Status')], [
    [say('HTTP 降级', 'HTTP downgrade'), say('http:// 返回 301 到 https://；HSTS 一年', 'http:// answers 301 to https://; HSTS for a year'), PASS],
    [say('旧 TLS', 'Old TLS'), say('拒绝 TLS 1.0 和 1.1', 'TLS 1.0 and 1.1 refused'), PASS],
    [say('安全响应头', 'Security headers'), say('CSP 只允许本站脚本、无内联；nosniff；no-referrer；noindex', 'CSP allows only this site’s scripts, no inline; nosniff; no-referrer; noindex'), PASS],
    [say('不存在的 ID', 'Unknown IDs'), say('返回 404，不说明原因', 'Return 404 without saying why'), PASS],
    [say('路径穿越', 'Path traversal'), say('/f/<id>/../ 返回 404', '/f/<id>/../ returns 404'), PASS],
    [say('伪造 x-share-src', 'Forged x-share-src'), say('被删除，返回 404', 'Stripped; 404'), PASS],
    [say('列表 API 泄漏', 'Listing API leaks'), say('不含 OneDrive / SharePoint 地址或 Cookie', 'No OneDrive/SharePoint URLs or cookies'), PASS],
    [say('文件响应头', 'File response headers'), say('不转发 SharePoint 的 Cookie 和响应头', 'No SharePoint cookies or headers passed on'), PASS],
    [say('HTML / SVG 文件', 'HTML / SVG files'), say('作为附件下载，不在本站运行', 'Downloaded as attachments, never rendered on this site'), PASS],
    [say('未登录访问 API', 'API without a session'), say('/api/me、/api/shares 返回 401', '/api/me and /api/shares return 401'), PASS],
    [say('跨站请求（CSRF）', 'Cross-site changes (CSRF)'), say('Origin 不是本站时返回 403', 'Origin other than this site gets 403'), PASS],
    [say('登录回调', 'Sign-in callback'), say('伪造 state 返回 400', 'Forged state returns 400'), PASS],
    [say('隐藏文件', 'Hidden files'), say('/.git/config、/.env、package.json 返回 404；无目录列表', '/.git/config, /.env, package.json return 404; no directory listing'), PASS],
    [say('其他 HTTP 方法', 'Other HTTP methods'), say('页面上的 PUT、DELETE、PATCH 返回 403', 'PUT, DELETE and PATCH on pages return 403'), PASS],
    [say('绕过 CloudFront', 'Bypassing CloudFront'), say('直接访问 Lambda 和 S3 返回 403', 'Lambda function URL and S3 called directly return 403'), PASS],
    [say('源码中的私密信息', 'Secrets in source'), say('扫描：无账号、租户 ID 或密钥', 'Scanned: no account or tenant IDs, no secrets'), PASS],
  ]));

  add('h2', say('威胁模型', 'Threat model'));
  root.append(table([say('场景', 'Scenario'), say('剩余风险', 'Residual risk'), say('防护', 'Controls')], [
    [say('有人猜中链接', 'Someone guesses a link'), LOW, say('8×10¹⁷ 种可能，用加密随机数生成', '8×10¹⁷ possibilities from a cryptographic random source')],
    [say('链接被搜索引擎收录', 'A link is indexed by search engines'), LOW, say('noindex、nofollow；robots.txt 禁止抓取', 'noindex, nofollow; robots.txt disallows crawling')],
    [say('链接通过 Referer 泄漏', 'A link leaks through Referer'), LOW, say('Referrer-Policy: no-referrer', 'Referrer-Policy: no-referrer')],
    [say('访问者拿到 OneDrive 链接', 'A visitor obtains the OneDrive link'), LOW, say('只存在 KeyValueStore 和 CloudFront 内部请求头里', 'Only in the KeyValueStore and internal CloudFront headers')],
    [say('文件里的脚本攻击本站', 'A shared file runs script on this site'), LOW, say('只有图片、视频、音频、PDF、纯文本在线显示；其余下载；nosniff；CSP', 'Only images, video, audio, PDF and plain text show inline; others download; nosniff; CSP')],
    [say('别人创建或删除链接', 'Someone else creates or deletes links'), LOW, say('Microsoft 登录（单租户、@dliu.com）+ HMAC 签名会话 + Origin 检查', 'Microsoft sign-in (single tenant, @dliu.com) + HMAC-signed session + Origin check')],
    [say('会话 Cookie 被盗或伪造', 'Session cookie stolen or forged'), LOW, say('__Host-、HttpOnly、Secure、SameSite=Lax，12 小时过期，常量时间比较', '__Host-, HttpOnly, Secure, SameSite=Lax, 12-hour expiry, constant-time compare')],
    [say('登录被劫持', 'Sign-in is hijacked'), LOW, say('PKCE（S256）、state、nonce；检查签发者、租户和受众', 'PKCE (S256), state, nonce; issuer, tenant and audience checked')],
    [say('AWS 账号被入侵', 'The AWS account is compromised'), MEDIUM, say('可读到 OneDrive 链接，但只能访问分享的那些项；启用 MFA', 'Exposes the OneDrive links, still limited to the shared items; MFA on')],
    [say('大量请求刷流量', 'Request floods run up the bill'), MEDIUM, say('边缘缓存吸收重复下载；没有 WAF 或限流', 'Edge cache absorbs repeats; no WAF or rate limit')],
  ]));

  add('h2', say('接受的剩余风险', 'Accepted residual risks'));
  root.append(list([
    say('链接可被转发：任何拿到链接的人都能打开，和 OneDrive“任何人”链接一样。', 'Links can be forwarded: anyone who has one can open it, just like an OneDrive “Anyone” link.'),
    say('聊天软件可能会抓取链接预览。', 'Chat apps may fetch a link to build a preview.'),
    say('在 OneDrive 停止分享后，已缓存的文件最多还能从边缘拿到 1 天；在本站删除链接则立即失效。', 'After stopping sharing in OneDrive, cached files can stay reachable at the edge for up to 1 day; deleting the link here stops it at once.'),
    say('使用了 SharePoint 未公开的接口，微软更改后可能需要修复。', 'Undocumented SharePoint endpoints are used; a Microsoft change may need a fix.'),
    say('没有 WAF 或限流。', 'No WAF or rate limit.'),
  ]));

  root.append(more(say('每个页面的响应头', 'Response headers on every page'),
    table([say('响应头', 'Header'), say('值', 'Value')], [
      [mono('Content-Security-Policy'), "default-src 'self'; script-src https://share.dliu.com/_app/; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"],
      [mono('Strict-Transport-Security'), 'max-age=31536000'],
      [mono('X-Content-Type-Options'), 'nosniff'],
      [mono('Referrer-Policy'), 'no-referrer'],
      [mono('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
      [mono('X-Robots-Tag'), 'noindex, nofollow'],
    ])));
}

architecture(document.getElementById('architecture'));
security(document.getElementById('security'));

function show(scroll) {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.info-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${t(current)} · ${t('docs')} · DL Share`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
