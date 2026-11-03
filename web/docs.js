import { t, say } from './i18n.js';
import { flow, tiers, stats, table, callout, more } from './diagram.js';

const TABS = ['architecture', 'cost', 'security'];
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
    [mono('/_app/*'), say('脚本、样式、图标', 'Scripts, styles, icons'), say('边缘 1 天（发布时清除），浏览器每次验证', '1 day at edge (cleared on deploy), browser revalidates')],
    [mono('/_app/vendor/*'), say('PDF.js', 'PDF.js'), say('边缘 1 天，浏览器 5 分钟', '1 day at edge, 5 min in browser')],
  ]));

  add('h2', say('缓存如何清除', 'How cached copies are cleared'));
  root.append(table([say('内容', 'What'), say('边缘缓存', 'At the edge'), say('怎么清除', 'Cleared by'), say('自动清除（S3 事件）', 'Auto clear (S3 events)')], [
    [say('页面 HTML', 'Page HTML'), say('不保留', 'Not kept'), '—', say('不需要', 'Not needed')],
    [mono('/_app/*'), num(say('1 天', '1 day')), say('每次发布自动清除', 'Every deploy'), say('不需要：只在发布时变化', 'Not needed: changes only on deploy')],
    [mono('/f/…'), num(say('1 天', '1 day')), say('管理页“刷新”、修改或删除链接', 'Admin Refresh, editing or deleting the link'), say('不适用：文件在 OneDrive，不在 S3', 'Not possible: files live in OneDrive, not S3')],
  ]));
  root.append(callout('clock', say(
    '在 OneDrive 改了同名文件后，如果不点“刷新”，朋友最多会看到旧版本约 1 天（浏览器里已打开过的再加 1 小时）。',
    'If a file is replaced in OneDrive under the same name and Refresh isn’t clicked, friends can see the old copy for up to ~1 day (+1 hour in a browser that already opened it).')));

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
    say('Microsoft 登录密钥用脚本写入 Parameter Store，不在代码中。租户 ID 是所有 dliu.com 应用共用的 /dliu/entra-tenant-id。', 'The Microsoft sign-in secret is written to Parameter Store by a script, never into the code. The tenant ID is /dliu/entra-tenant-id, shared by every dliu.com app.'),
    say('Jest 单元测试覆盖链接检查函数、API、Lambda@Edge 和整个栈；冒烟测试在线上创建、打开并删除测试链接。', 'Jest tests cover the link check, API, Lambda@Edge and the stack; a smoke test creates, opens and deletes a link on the live site.'),
    say('本站不收集 CloudFront 访问日志（traffic.dliu.com 不统计本站），也不运行统计脚本。', 'This site collects no CloudFront access logs (traffic.dliu.com does not count it) and runs no analytics code.'),
  ])));
}

// ---------------------------------------------------------------- Cost
function cost(root) {
  const add = writer(root);
  add('h2', say('费用', 'Cost'));
  add('p', say(
    '没有服务器、数据库或固定月费：没人访问时几乎不花钱。文件本身仍在 OneDrive，不占 AWS 存储。',
    'No servers, database or monthly fee: when nobody visits, it costs almost nothing. The files stay in OneDrive and use no AWS storage.',
  ), 'lead');

  root.append(stats([
    ['$0', say('固定月费', 'fixed monthly fee'), 'budget'],
    [say('1 TB 免费', '1 TB free'), say('每月 CloudFront 流量', 'of CloudFront delivery each month'), 'cloudfront'],
    ['≈ $0.12 / GB', say('超出免费额度后发往香港、新加坡等地（欧洲 $0.085）', 'to Hong Kong, Singapore etc. beyond the free tier (Europe $0.085)'), 'china'],
    ['≈ $0.03', say('每 1,000 次未命中缓存的文件请求（Lambda@Edge）', 'per 1,000 file requests that miss the cache (Lambda@Edge)'), 'lambda'],
  ]));

  add('h2', say('各部分怎么计费', 'What each part costs'));
  add('p', say(
    '以下为 AWS 公开价格（2026 年 11 月核对）。免费额度按 AWS 账号计算，与其他 dliu.com 网站共用。',
    'AWS list prices, checked in November 2026. Free tiers are per AWS account, so they are shared with the other dliu.com sites.',
  ));
  root.append(table([say('部分', 'Part'), say('计费方式', 'How it is billed'), say('闲置月份', 'Idle month')], [
    ['OneDrive', say('使用现有 Microsoft 365 空间，不额外收费', 'Uses the existing Microsoft 365 storage; nothing extra'), num('$0')],
    ['CloudFront', say(
      '每月免费：1 TB 流出、1,000 万次请求。之后每 GB：欧洲和北美 $0.085，日本 $0.114，香港、新加坡、韩国、台湾 $0.120；每 1 万次 HTTPS 请求约 $0.01。从 OneDrive 取文件进 CloudFront 不收费',
      'Free each month: 1 TB out and 10 million requests. Then per GB: Europe and North America $0.085, Japan $0.114, Hong Kong, Singapore, South Korea and Taiwan $0.120; about $0.01 per 10,000 HTTPS requests. Fetching files from OneDrive into CloudFront is free',
    ), num('$0')],
    [say('CloudFront 函数', 'CloudFront Functions'), say('链接检查和访客 ID，每个请求各一次；每月 200 万次免费，之后每百万次 $0.10', 'Link check and visitor ID, once each per request; 2 million free a month, then $0.10 per million'), num('$0')],
    ['KeyValueStore', say(
      '读取：每月 200 万次免费，之后每百万次 $0.03。站长新建、修改或删除链接约 2 次管理调用，列出链接每 50 条 1 次；每 1,000 次 $1',
      'Reads: 2 million free a month, then $0.03 per million. Creating, changing or deleting a link makes about 2 management calls, and listing links 1 per 50 links; $1 per 1,000 calls',
    ), num('$0')],
    ['Lambda@Edge', say(
      '只在边缘缓存未命中时运行（每次 2 个触发器）；没有免费额度。每百万次 $0.60，每 GB-秒 $0.00005001（512 MB，打开访客会话约 1 秒）',
      'Runs only on edge cache misses (2 triggers each); no free tier. $0.60 per million runs and $0.00005001 per GB-second (512 MB; opening a guest session takes about a second)',
    ), num('$0')],
    ['API Lambda', say(
      '文件夹列表、登录和管理链接。每月免费 100 万次调用和 40 万 GB-秒，之后每百万次 $0.20（ARM，256 MB）',
      'Folder listings, sign-in and managing links. Free each month: 1 million calls and 400,000 GB-seconds, then $0.20 per million calls (ARM, 256 MB)',
    ), num('$0')],
    [say('S3 网站存储桶', 'S3 site bucket'), say('只放网页和 PDF.js，约 4 MB（S3 标准 $0.023 / GB-月）', 'Only the pages and PDF.js, about 4 MB (S3 Standard $0.023 per GB-month)'), num('< $0.01')],
    [say('缓存清除', 'Cache invalidations'), say('修改或删除链接时清除 1 个通配路径 /f/<id>*，部署时清除网站文件；每月前 1,000 条路径免费，之后每条 $0.005', 'One wildcard path, /f/<id>*, per changed or deleted link, plus the site files on deploy; the first 1,000 paths a month are free, then $0.005 per path'), num('$0')],
    ['Parameter Store、KMS', say('标准参数免费；登录密钥用 aws/ssm 密钥解密，每月 2 万次请求免费', 'Standard parameters are free; the sign-in secret is decrypted with the aws/ssm key, 20,000 free requests a month'), num('$0')],
    ['CloudWatch Logs', say('Lambda 日志保留一个月，每 GB $0.57，每月只有几 KB', 'Lambda logs kept one month; $0.57 per GB, a few KB a month'), num('$0')],
    [say('证书和 DNS', 'Certificate and DNS'), say('ACM 公共证书免费；别名记录在已有的 dliu.com 区域中，查询免费', 'ACM public certificates are free; alias records in the existing dliu.com zone answer free'), num('$0')],
    [say('访问日志', 'Traffic logs'), say('未启用：本站不收集 CloudFront 访问日志', 'Not enabled: this site collects no CloudFront access logs'), num('$0')],
  ]));
  root.append(callout('power', say(
    '没有 EC2、容器、负载均衡、NAT 网关、数据库或 WAF，所以不会因为“存在”而产生费用。删除所有链接后，账单实际为 $0。',
    'There is no EC2, container, load balancer, NAT gateway, database or WAF, so nothing costs money just by existing. Delete every link and the bill is effectively $0.',
  )));

  add('h2', say('示例', 'Examples'));
  root.append(table([say('情况', 'Situation'), say('估算', 'Estimate')], [
    [say('没人访问的一个月', 'A month with no visitors'), num('$0')],
    [say('把 100 MB 的相册分享给 10 位朋友（1 GB，在免费 1 TB 内）', 'A 100 MB photo album opened by 10 friends (1 GB, inside the free 1 TB)'), num('$0')],
    [say('超出免费额度后，中国大陆朋友下载 1 GB（经香港等节点）', 'A friend in mainland China downloading 1 GB beyond the free tier (via Hong Kong etc.)'), num('≈ $0.12')],
    [say('超出免费额度后，欧洲朋友下载 1 GB', 'A friend in Europe downloading 1 GB beyond the free tier'), num('≈ $0.085')],
    [say('1,000 次未命中缓存的文件请求', '1,000 file requests that miss the cache'), num('≈ $0.03')],
    [say('新建、修改或删除一个链接', 'Creating, changing or deleting a link'), num('≈ $0.002')],
  ]));

  root.append(flow({
    title: say('为什么账单很小', 'What keeps the bill small'),
    steps: [
      { icon: 'power', title: say('没有闲置服务器', 'No idle servers'), text: say('函数只在有请求时运行', 'Functions run only when a request comes in') },
      { icon: 'onedrive', title: say('文件留在 OneDrive', 'Files stay in OneDrive'), text: say('AWS 不存文件，不付存储费', 'AWS stores no files, so no storage bill') },
      { icon: 'cloudfront', title: say('边缘缓存 1 天', '1-day edge cache'), text: say('同一文件每个边缘只取一次', 'Each edge fetches a file once a day at most') },
      { icon: 'key', title: say('没有数据库', 'No database'), text: say('链接存在 KeyValueStore，每条 ≤ 1 KB', 'Links live in a KeyValueStore, ≤ 1 KB each') },
      { icon: 'check', title: say('免费额度', 'Free tiers'), text: say('平常的使用量都在免费额度内', 'Normal use stays inside the free tiers'), tone: 'good' },
    ],
  }));
  add('p', say(
    'CloudFront 使用所有边缘节点（PriceClass_All）并支持 HTTP/2 和 HTTP/3，因为大部分朋友在欧洲和亚洲；在每月免费的 1 TB 内不会多花钱。',
    'CloudFront serves from all edge locations (PriceClass_All) over HTTP/2 and HTTP/3, because most friends are in Europe and Asia. Within the free 1 TB a month it costs nothing extra.',
  ), 'dg-note');
}

// ---------------------------------------------------------------- Security
const REVIEWED = say('2026 年 11 月 3 日', '3 November 2026');
const FIXED = (commit) => ({ text: say(`已修复 ${commit}`, `Fixed ${commit}`), className: 'status fixed' });
const ACCEPTED = { text: say('接受', 'Accepted'), className: 'status' };
const RESOLVED = { text: say('已解决', 'Resolved'), className: 'status fixed' };
const REQUESTED = { text: say('已申请', 'Requested'), className: 'status fixed' };

function security(root) {
  const add = writer(root);
  add('h2', say('安全', 'Security'));
  add('p', say('有链接的人可以查看；只有站长能创建、修改或删除链接。', 'Anyone with a link can view it; only the owner can create, change or delete links.'), 'lead');
  root.append(callout('shield', say(
    `全面安全审查（${REVIEWED}）：威胁建模、233 项线上渗透测试（93 项匿名 + 140 项带站长会话）、逐个阅读处理程序、依赖和密钥扫描。发现 1 个严重和 1 个中等问题，均已修复并在线上复测。`,
    `Thorough security review (${REVIEWED}): threat model, 233 live penetration tests (93 anonymous + 140 with an owner session), every handler read, dependency and secret scans. It found 1 critical and 1 medium issue; both are fixed and retested live.`,
  )));

  root.append(stats([
    [say('8×10¹⁷', '8×10¹⁷'), say('可能的链接 ID（62¹⁰）', 'possible link IDs (62¹⁰)'), 'key'],
    [say('约 2.7 万年', '~27,000 years'), say('每秒猜 1 万次，碰中 100 个链接之一的平均时间', 'to hit one of 100 links at 10,000 guesses/s'), 'clock'],
    [say('0 个', '0'), say('OneDrive 账号权限：登录只要 openid、profile、email', 'OneDrive account permissions: sign-in asks only openid, profile, email'), 'lock'],
    [say('233 / 233', '233 / 233'), say(`线上渗透测试通过（${REVIEWED}）`, `live penetration tests passed (${REVIEWED})`), 'check'],
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
          { icon: 'lock', title: 'API Lambda', text: say('管理操作需登录 + 本站 Origin；最多同时运行 10 个', 'Owner actions need a session + this site’s Origin; at most 10 run at once') },
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
    [say('分享文件夹之外的内容', 'Anything outside the shared folder'), say('否：路径穿越返回 404，微软也拒绝上级文件夹（403）', 'No: traversal returns 404, and Microsoft refuses the parent folder (403)')],
  ]));

  add('h2', say('审查发现', 'Review findings'));
  root.append(table([say('编号', 'ID'), say('严重度', 'Severity'), say('问题', 'Finding'), say('状态', 'Status')], [
    [mono('SEC-1'), say('严重', 'Critical'), say(
      '任何人从 /auth/login 拿到的临时登录 Cookie 与会话用同一密钥签名，且会话检查不看类型；改名为会话 Cookie 即获得站长权限（已线上复现）。修复：两种令牌用不同密钥派生并带 typ 字段，会话必须是 typ=session 且有用户名；加了回归测试。日志中没有被利用的迹象（所有修改都来自站长或测试账号），但只读的链接列表不记日志，无法完全排除。',
      'The temporary sign-in cookie anyone gets from /auth/login was signed with the same key as the session, and the session check ignored the token type, so renaming it to the session cookie gave owner access (reproduced live). Fix: separate derived keys and a typ claim; a session must be typ=session with a user; regression tests added. Logs show no exploitation (every change came from the owner or the test account), but the read-only link list is not logged, so a read cannot be ruled out.',
    ), FIXED('fba7bcb')],
    [mono('SEC-2'), say('中', 'Medium'), say(
      '匿名的 /auth/* 和 /api/* 请求会运行 API Lambda，而它没有并发上限，可耗尽账号里其他网站共用的并发并推高费用。修复：保留并发 10。',
      'Anonymous /auth/* and /api/* requests run the API Lambda, which had no concurrency cap, so a flood could starve the other sites sharing the account and run up the bill. Fix: reserved concurrency of 10.',
    ), FIXED('71565f8')],
    [mono('SEC-3'), say('低', 'Low'), say(
      'Lambda@Edge 的区域日志组和 CDK 辅助函数的日志组永不过期（只含 ID、状态和错误信息）。设置保留期会删除旧日志，需站长同意。',
      'The Lambda@Edge regional log groups and the CDK helper log groups never expire (they hold only IDs, statuses and errors). Setting retention deletes old logs, so it needs the owner’s OK.',
    ) + say('已解决（2026-11-03）：站长要求所有日志组保留 90 天，已全部设置；新的边缘区域也需同样设置。', ' Resolved (3 November 2026): at the owner’s request every log group keeps 90 days; a new edge region needs the same setting.'), RESOLVED],
    [mono('SEC-4'), say('低', 'Low'), say(
      '没有 WAF 或限流；拿到有效链接的人反复下载大文件，流量费没有上限（见下方“费用攻击”）。WAF 每月约 $6 起。',
      'No WAF or rate limit; someone with a valid link who downloads a large file over and over has no cap on transfer cost (see “Denial of wallet” below). WAF starts at about $6 a month.',
    ) + say('站长决定不使用 WAF（2026-11-03）：链接只发给朋友，可随时删除。', ' The owner chose not to use WAF (3 November 2026): links go only to friends and can be deleted at any time.'), ACCEPTED],
    [mono('SEC-5'), say('低', 'Low'), say(
      '站长判断只看 Microsoft 账号是否为本租户的 @dliu.com，没有对象 ID 白名单；租户里的任何账号都能管理链接。',
      'The owner check only requires an @dliu.com account in this tenant, with no object-ID allow-list; any account in the tenant could manage links.',
    ) + say('站长接受（2026-11-03）：在 Microsoft Entra 应用中管理谁可以登录。', ' Accepted by the owner (3 November 2026): who can sign in is managed in the Microsoft Entra app.'), ACCEPTED],
    [mono('SEC-6'), say('低', 'Low'), say(
      '会话 12 小时有效，无法在服务器端撤销；退出只清除 Cookie。GET /auth/logout 可被跨站触发（只会让站长退出）。',
      'A session lasts 12 hours and cannot be revoked server-side; signing out only clears cookies. GET /auth/logout can be triggered cross-site (it can only sign the owner out).',
    ), ACCEPTED],
    [mono('SEC-7'), say('低', 'Low'), say(
      'IAM 通配符：CDK 内部的证书和部署辅助函数（acm:*、cloudfront:CreateInvalidation 作用于 *）；API 的 kms:Decrypt 作用于 *，但限定只能经 eu-west-1 的 SSM 调用；ssm:GetParameters 只限 /share/* 和共用的 /dliu/entra-tenant-id。',
      'IAM wildcards: CDK’s own certificate and deployment helpers (acm:*, cloudfront:CreateInvalidation on *); the API’s kms:Decrypt on * is limited to calls through SSM in eu-west-1; ssm:GetParameters is limited to /share/* and the shared /dliu/entra-tenant-id.',
    ), ACCEPTED],
    [mono('SEC-8'), say('低', 'Low'), say(
      'Lambda@Edge 在 us-east-1 以外的区域并发配额为 10：它限制了费用，但流量大时可能出现 503。免费提高配额是站长的决定。',
      'Lambda@Edge concurrency is 10 per region outside us-east-1: it caps cost, but heavy traffic could see 503s. Raising the quota is free and the owner’s call.',
    ) + say('站长决定提高（2026-11-03）：已在 12 个区域申请 1000，等待 AWS 批准。代价是下方“费用攻击”的上限随之提高。', ' The owner chose to raise it (3 November 2026): 1,000 requested in 12 regions, pending AWS approval. The trade-off is a higher cap in “Denial of wallet” below.'), REQUESTED],
    [mono('SEC-9'), say('信息', 'Info'), say(
      '删除链接约 1 分钟后才到达所有 CloudFront 主机（实测 44–60 秒）；过期由时间判断，立即生效。',
      'A deleted link takes about a minute to reach every CloudFront host (44–60 s measured); expiry is checked by time and is immediate.',
    ), ACCEPTED],
    [mono('SEC-10'), say('信息', 'Info'), say(
      'npm audit：运行时依赖 0 个；构建和测试依赖中 2 个（生产）/ 22 个（全部）中低风险，都在 aws-cdk-lib 和 jest 的 minimatch、glob 链中，不进入 Lambda 包。',
      'npm audit: 0 in runtime code; 2 (prod) / 22 (all) low and moderate in build and test tools, all in the minimatch and glob chains of aws-cdk-lib and jest, none in the Lambda bundles.',
    ), ACCEPTED],
  ]));

  add('h2', say('威胁模型', 'Threat model'));
  add('h3', say('资产', 'Assets'));
  root.append(table([say('资产', 'Asset'), say('在哪里', 'Where'), say('泄漏的后果', 'Impact if exposed')], [
    [say('OneDrive“任何人”链接', 'OneDrive “Anyone” links'), say('KeyValueStore；CloudFront 内部请求头', 'KeyValueStore; internal CloudFront headers'), say('可直接从 OneDrive 打开分享的内容（仍只限分享的项）', 'The shared items open directly from OneDrive (still only those items)')],
    [say('分享的文件', 'Shared files'), say('OneDrive；CloudFront 缓存 1 天', 'OneDrive; CloudFront cache for 1 day'), say('有短链接的人本来就能看', 'Already visible to anyone with the short link')],
    [say('站长会话', 'Owner session'), say('浏览器中的 __Host- HttpOnly Cookie', '__Host- HttpOnly cookie in the browser'), say('可读取全部 OneDrive 链接、新建和删除短链接', 'Read every OneDrive link; create and delete short links')],
    [say('Entra 客户端密钥', 'Entra client secret'), say('SSM SecureString /share/*', 'SSM SecureString /share/*'), say('可伪造会话（密钥同时用于派生会话签名密钥）', 'Could forge sessions (session keys are derived from it)')],
    [say('AWS 账单', 'The AWS bill'), say('与其他 dliu.com 网站同一账号', 'Same account as the other dliu.com sites'), say('费用攻击', 'Denial of wallet')],
  ]));
  add('h3', say('攻击者', 'Actors'));
  root.append(list([
    say('匿名访客：没有链接，只能看到首页、文档和 404。', 'Anonymous visitor: no link; sees the home page, docs and 404s.'),
    say('有链接的朋友，或拿到转发链接的人：只能看到这一个链接分享的内容。', 'A friend with a link, or anyone it was forwarded to: sees only what that one link shares.'),
    say('非站长的 Microsoft 账号：其他租户被拒绝；本租户的其他 @dliu.com 账号会被当作站长（SEC-5）。', 'A signed-in non-owner: other tenants are refused; another @dliu.com account in this tenant counts as the owner (SEC-5).'),
    say('偷到 Cookie 的人：最多 12 小时站长权限（SEC-6）；__Host-、HttpOnly、CSP 无内联脚本降低被偷的可能。', 'Someone with a stolen cookie: owner access for up to 12 hours (SEC-6); __Host-, HttpOnly and a CSP with no inline script make theft hard.'),
    say('被入侵的依赖：运行时只有 Node.js 自带模块和 AWS SDK；浏览器只运行本站脚本和 PDF.js（禁用 eval）。', 'A compromised dependency: runtime code uses only Node.js built-ins and the AWS SDK; the browser runs only this site’s scripts and PDF.js (eval disabled).'),
  ]));

  add('h3', say('STRIDE（按组件）', 'STRIDE per component'));
  root.append(table([say('组件', 'Component'), say('主要威胁', 'Main threats'), say('防护', 'Controls')], [
    [say('CloudFront 函数 + KeyValueStore', 'CloudFront Function + KeyValueStore'), say('仿冒（伪造 x-share-*）、信息泄漏（猜 ID）、提权（过期链接）', 'Spoofing (forged x-share-*), information disclosure (guessing IDs), elevation (expired links)'), say('删除访问者的 x-share-*；ID 必须是 10 位字母数字；在缓存前检查存在和过期；只有 API 能写 KVS', 'Strips visitor x-share-*; IDs must be 10 alphanumerics; existence and expiry checked before the cache; only the API can write the KVS')],
    [mono('Lambda@Edge FileProxy'), say('篡改（路径穿越、SSRF）、信息泄漏（SharePoint Cookie/头）、拒绝服务', 'Tampering (traversal, SSRF), information disclosure (SharePoint cookies and headers), denial of service'), say('路径逐段检查；只连链接自己的 SharePoint 主机且只跟随同主机跳转；响应头白名单；HTML/SVG 作为附件；没有 AWS 权限；受账号每区域并发配额限制（SEC-8）', 'Path checked segment by segment; talks only to the link’s own SharePoint host and same-host redirects; response header allow-list; HTML/SVG as attachments; no AWS permissions; bounded by the account’s per-region concurrency quota (SEC-8)')],
    [mono('API Lambda'), say('仿冒（会话伪造、令牌混用 SEC-1）、篡改（CSRF、注入）、拒绝服务（SEC-2）', 'Spoofing (forged sessions, token confusion SEC-1), tampering (CSRF, injection), denial of service (SEC-2)'), say('HMAC 会话带 typ、常量时间比较；POST 需会话 + 本站 Origin + JSON；输入校验（链接主机、ID、过期时间、10 KB 上限）；函数地址只接受 CloudFront 签名；并发 10', 'HMAC session with typ, constant-time compare; POST needs a session, this site’s Origin and JSON; input validation (link host, id, expiry, 10 KB limit); function URL accepts only CloudFront-signed calls; concurrency 10')],
    [say('Microsoft 登录', 'Microsoft sign-in'), say('仿冒（伪造回调、重放、开放重定向）', 'Spoofing (forged callback, replay, open redirect)'), say('PKCE S256、state、nonce；检查签发者、租户、受众；返回地址只能是本站相对路径', 'PKCE S256, state, nonce; issuer, tenant and audience checked; return path must be relative to this site')],
    [say('S3 网站存储桶', 'S3 site bucket'), say('信息泄漏、篡改', 'Information disclosure, tampering'), say('全部禁止公开、只能经 CloudFront（OAC）读取、SSE-S3、只限 HTTPS', 'Block all public access, readable only through CloudFront (OAC), SSE-S3, HTTPS only')],
    [say('SSM + KMS', 'SSM + KMS'), say('信息泄漏（密钥）', 'Information disclosure (secret)'), say('SecureString；只有 API 角色可读 /share/*；不写入日志或代码', 'SecureString; only the API role reads /share/*; never in logs or code')],
    [say('浏览器页面', 'Browser pages'), say('XSS、点击劫持、Referer 泄漏', 'XSS, clickjacking, Referer leaks'), say('只用 textContent 生成内容；CSP 只允许本站脚本；frame-ancestors self；no-referrer', 'Content built with textContent only; CSP allows only this site’s scripts; frame-ancestors self; no-referrer')],
    [say('日志', 'Logs'), say('抵赖、信息泄漏', 'Repudiation, information disclosure'), say('每次修改链接都记录站长和 ID；日志不含 OneDrive 链接、Cookie 或文件内容；没有 CloudFront 访问日志', 'Every link change logs the owner and id; logs hold no OneDrive links, cookies or file contents; no CloudFront access logs')],
  ]));

  add('h3', say('费用攻击（每小时最坏情况）', 'Denial of wallet (worst case per hour)'));
  root.append(table([say('路径', 'Path'), say('最坏情况', 'Worst case'), say('上限', 'Cap')], [
    [say('没有链接：/auth/*、/api/*', 'No link: /auth/*, /api/*'), num('≈ $0.20 / h'), say('API 并发 10（SEC-2）', 'API concurrency 10 (SEC-2)')],
    [say('没有链接：其他地址', 'No link: anything else'), num(say('≈ $1 / 100 万次请求', '≈ $1 per million requests')), say('CloudFront 函数直接返回 404；请求费没有上限', 'The CloudFront Function answers 404; request fees have no cap')],
    [say('有链接：未缓存的随机文件路径', 'With a link: uncached random file paths'), num(say('并发 10 时 ≈ $1.1 / h / 区域（约 $15 / h）；1000 时 ≈ $110 / h / 区域', '≈ $1.1 / h per region at 10 concurrent (~$15 / h); ≈ $110 / h per region at 1,000')), say('Lambda@Edge 每区域并发配额（SEC-8）', 'Lambda@Edge per-region concurrency quota (SEC-8)')],
    [say('有链接：反复下载大文件', 'With a link: repeated large downloads'), num('10 Gbps 时 ≈ $380–540 / h'), say('没有（SEC-4）；先用掉每月免费 1 TB', 'None (SEC-4); the free 1 TB a month goes first')],
  ]));

  add('h3', say('场景', 'Scenarios'));
  root.append(table([say('场景', 'Scenario'), say('剩余风险', 'Residual risk'), say('防护', 'Controls')], [
    [say('有人猜中链接', 'Someone guesses a link'), LOW, say('8×10¹⁷ 种可能，用加密随机数生成；不存在和格式错误一律 404', '8×10¹⁷ possibilities from a cryptographic random source; unknown and malformed IDs all return 404')],
    [say('链接被搜索引擎收录', 'A link is indexed by search engines'), LOW, say('noindex、nofollow；robots.txt 禁止抓取', 'noindex, nofollow; robots.txt disallows crawling')],
    [say('链接通过 Referer 泄漏', 'A link leaks through Referer'), LOW, say('Referrer-Policy: no-referrer', 'Referrer-Policy: no-referrer')],
    [say('访问者拿到 OneDrive 链接', 'A visitor obtains the OneDrive link'), LOW, say('只存在 KeyValueStore 和 CloudFront 内部请求头里', 'Only in the KeyValueStore and internal CloudFront headers')],
    [say('文件里的脚本攻击本站', 'A shared file runs script on this site'), LOW, say('只有图片、视频、音频、PDF、纯文本在线显示；其余下载；nosniff；CSP', 'Only images, video, audio, PDF and plain text show inline; others download; nosniff; CSP')],
    [say('别人创建或删除链接', 'Someone else creates or deletes links'), LOW, say('Microsoft 登录（单租户、@dliu.com）+ 带类型的 HMAC 会话 + Origin 检查', 'Microsoft sign-in (single tenant, @dliu.com) + typed HMAC session + Origin check')],
    [say('会话 Cookie 被盗或伪造', 'Session cookie stolen or forged'), LOW, say('__Host-、HttpOnly、Secure、SameSite=Lax，12 小时过期；登录 Cookie 不能当会话用', '__Host-, HttpOnly, Secure, SameSite=Lax, 12-hour expiry; the sign-in cookie cannot be used as a session')],
    [say('登录被劫持', 'Sign-in is hijacked'), LOW, say('PKCE（S256）、state、nonce；检查签发者、租户和受众', 'PKCE (S256), state, nonce; issuer, tenant and audience checked')],
    [say('AWS 账号被入侵', 'The AWS account is compromised'), MEDIUM, say('可读到 OneDrive 链接，但只能访问分享的那些项；启用 MFA', 'Exposes the OneDrive links, still limited to the shared items; MFA on')],
    [say('大量请求刷流量', 'Request floods run up the bill'), MEDIUM, say('边缘缓存吸收重复下载；函数有并发上限；没有 WAF 或限流', 'Edge cache absorbs repeats; functions have concurrency caps; no WAF or rate limit')],
  ]));

  add('h2', say('线上渗透测试', 'Live penetration test'));
  add('p', say(
    `${REVIEWED}在 share.dliu.com 线上运行 scripts/pentest.js，233 项全部通过。可重跑：make pentest（匿名）和 make pentest-owner（需要 AWS 凭证；会签发 10 分钟站长会话、建两个临时链接并删除）。`,
    `scripts/pentest.js was run against the live share.dliu.com on ${REVIEWED}; all 233 tests passed. Rerun with make pentest (anonymous) and make pentest-owner (needs AWS credentials; signs a 10-minute owner session, makes two throwaway links and deletes them).`,
  ));
  root.append(table([say('测试', 'Test'), say('预期', 'Expected'), say('实际', 'Actual'), say('状态', 'Status')], [
    [say('未登录访问每个 API 路由和方法（22 项）', 'Every API route and method without a session (22)'), '401 / 403', '401 / 403', PASS],
    [say('伪造会话：随机 HMAC、空签名、alg=none、乱码；把登录 Cookie 当会话（SEC-1）', 'Forged sessions: random HMAC, empty signature, alg=none, garbage; sign-in cookie replayed as the session (SEC-1)'), '401', '401', PASS],
    [say('登录：PKCE、state、nonce、redirect_uri、错误 state、伪造 code、开放重定向（13 项）', 'Sign-in: PKCE, state, nonce, redirect_uri, wrong state, forged code, open redirects (13)'), say('拒绝，只跳回本站', 'Refused; redirects stay on this site'), say('同预期', 'As expected'), PASS],
    [say('猜测和畸形链接 ID，伪造 x-share-*（23 项）', 'Guessed and malformed link IDs, forged x-share-* (23)'), say('404（或 CloudFront 400）', '404 (or CloudFront 400)'), say('同预期', 'As expected'), PASS],
    [say('路径穿越：/f/<id>/..、%2e%2e、%5c、%00、//、超长 UTF-8；列表 API 的 path 参数（20 项）', 'Traversal: /f/<id>/.., %2e%2e, %5c, %00, //, overlong UTF-8; the listing API path parameter (20)'), '404 / 400', '404 / 400', PASS],
    [say('列表和文件响应不含 OneDrive 链接、SharePoint Cookie 或响应头', 'Listings and file responses carry no OneDrive links, SharePoint cookies or headers'), say('无', 'None'), say('无', 'None'), PASS],
    [say('删除链接后：页面、已缓存文件、列表 API', 'After deleting a link: page, cached file, listing API'), '404', say('404（44 秒内到达所有主机）', '404 (all hosts within 44 s)'), PASS],
    [say('过期后：页面、已缓存文件、列表 API', 'After expiry: page, cached file, listing API'), '404', '404', PASS],
    [say('CSRF：其他 Origin、没有 Origin、表单类型', 'CSRF: other Origin, no Origin, form content type'), '403', '403', PASS],
    [say('注入：错误 JSON、20 KB 正文、SSRF 链接、NoSQL 对象、../ ID、过去的过期时间', 'Injection: bad JSON, 20 KB body, SSRF links, NoSQL objects, ../ ids, past expiry'), '400 / 413', '400', PASS],
    [say('XSS：404 页面不回显地址；HTML/SVG 作为附件', 'XSS: 404 page reflects nothing; HTML/SVG as attachments'), say('不回显', 'Not reflected'), say('不回显', 'Not reflected'), PASS],
    [say('CRLF 头注入', 'CRLF header injection'), say('不注入', 'No injection'), say('不注入', 'No injection'), PASS],
    [say('缓存欺骗和投毒：/api/me/x.css、X-Forwarded-Host、多余查询参数', 'Cache deception and poisoning: /api/me/x.css, X-Forwarded-Host, extra query strings'), say('不缓存私有内容', 'Nothing private cached'), say('同预期', 'As expected'), PASS],
    [say('CORS', 'CORS'), say('不发送 CORS 头', 'No CORS headers'), say('无', 'None'), PASS],
    [say('绕过 CloudFront：Lambda 函数地址（含伪造头）、S3、*.cloudfront.net', 'Bypassing CloudFront: Lambda function URL (with forged headers), S3, *.cloudfront.net'), say('403；同样的检查', '403; same checks'), say('同预期', 'As expected'), PASS],
    [say('隐藏文件：.git、.env、source map、package.json、目录列表（14 项）', 'Hidden files: .git, .env, source maps, package.json, directory listings (14)'), '404 / 403', '404 / 403', PASS],
    [say('错误信息', 'Error messages'), say('无堆栈或 AWS 细节', 'No stack traces or AWS details'), say('无', 'None'), PASS],
    [say('TLS 1.0、1.1；HTTP', 'TLS 1.0, 1.1; HTTP'), say('拒绝；301 到 HTTPS', 'Refused; 301 to HTTPS'), say('同预期', 'As expected'), PASS],
    [say('6 类页面的安全响应头', 'Security headers on 6 kinds of page'), say('CSP、HSTS、nosniff、no-referrer、noindex', 'CSP, HSTS, nosniff, no-referrer, noindex'), say('全部存在', 'All present'), PASS],
  ]));

  add('h2', say('代码审查', 'Code review'));
  root.append(list([
    say('逐个阅读：API（路由、登录、链接、存储、配置）、Lambda@Edge（入口、SharePoint、MIME）、CloudFront 函数和浏览器脚本。浏览器脚本不用 innerHTML。', 'Read in full: the API (router, sign-in, links, store, config), Lambda@Edge (entry, SharePoint, MIME), the CloudFront Function and the browser scripts. The browser scripts never use innerHTML.'),
    say('每个路由都检查授权；输入校验链接主机、ID 格式、过期时间和正文大小；错误只返回通用信息。', 'Every route checks authorisation; input validation covers link host, ID format, expiry and body size; errors return only generic messages.'),
    say('密钥：gitleaks 8.30.1 扫描全部 git 历史，0 处泄漏；代码和日志中没有密钥、账号 ID 或租户 ID。', 'Secrets: gitleaks 8.30.1 over the full git history found 0 leaks; no secrets, account IDs or tenant IDs in code or logs.'),
    say('依赖：见 SEC-10。', 'Dependencies: see SEC-10.'),
    say('AWS：存储桶禁止公开访问、SSE-S3、只限 HTTPS、OAC；所有日志保留 90 天（SEC-3）；IAM 见 SEC-7。', 'AWS: bucket blocks public access, SSE-S3, HTTPS only, OAC; all logs kept 90 days (SEC-3); IAM: SEC-7.'),
    say('测试：60 个 Jest 测试，包括 SEC-1 的回归测试（登录 Cookie 不能当会话、会话不能当登录 Cookie、伪造/篡改/无类型/过期令牌被拒）和 SEC-2 的并发上限。', 'Tests: 60 Jest tests, including SEC-1 regressions (sign-in cookie refused as a session, session refused as the sign-in cookie, forged, tampered, untyped and expired tokens refused) and the SEC-2 concurrency cap.'),
  ]));

  add('h2', say('接受的剩余风险', 'Accepted residual risks'));
  root.append(list([
    say('链接可被转发：任何拿到链接的人都能打开，和 OneDrive“任何人”链接一样。', 'Links can be forwarded: anyone who has one can open it, just like an OneDrive “Anyone” link.'),
    say('聊天软件可能会抓取链接预览。', 'Chat apps may fetch a link to build a preview.'),
    say('在 OneDrive 停止分享后，已缓存的文件最多还能从边缘拿到 1 天；在本站删除链接约 1 分钟内失效（SEC-9）。', 'After stopping sharing in OneDrive, cached files can stay reachable at the edge for up to 1 day; deleting the link here stops it within about a minute (SEC-9).'),
    say('使用了 SharePoint 未公开的接口，微软更改后可能需要修复。', 'Undocumented SharePoint endpoints are used; a Microsoft change may need a fix.'),
    say('没有 WAF 或限流（SEC-4）；会话不能在服务器端撤销（SEC-6）。', 'No WAF or rate limit (SEC-4); sessions cannot be revoked server-side (SEC-6).'),
  ]));

  root.append(more(say('每个页面的响应头', 'Response headers on every page'),
    table([say('响应头', 'Header'), say('值', 'Value')], [
      [mono('Content-Security-Policy'), "default-src 'self'; script-src https://share.dliu.com/_app/; style-src 'self' https://files.dliu.com/dliu.com/ui/; img-src 'self' data: blob: https://files.dliu.com/dliu.com/; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"],
      [mono('Strict-Transport-Security'), 'max-age=31536000'],
      [mono('X-Content-Type-Options'), 'nosniff'],
      [mono('Referrer-Policy'), 'no-referrer'],
      [mono('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
      [mono('X-Robots-Tag'), 'noindex, nofollow'],
    ])));
}

architecture(document.getElementById('architecture'));
cost(document.getElementById('cost'));
security(document.getElementById('security'));

function show(scroll) {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.dl-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${t(current)} · ${t('docs')} · DL Share`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
