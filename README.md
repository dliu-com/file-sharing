# share.dliu.com

A private file-sharing site. The owner keeps files in OneDrive and creates a normal "Anyone with the link" sharing link. After signing in at `https://share.dliu.com/admin`, the owner pastes that link and gets back a short link such as `https://share.dliu.com/s/k7Qx9pLmA2`. Friends open the short link without signing in. AWS fetches the files from OneDrive server-side and serves them from `dliu.com`, so friends never contact Microsoft. A folder link shows a file list with a **Download** button on every file. A file link shows a preview and a Download button.

## Goals

- **Short, clean links** instead of OneDrive's long sharing URLs.
- **Reachable from China.** OneDrive and SharePoint (`*.sharepoint.com`, `1drv.ms`) are often blocked there, so every byte is served from a `dliu.com` domain. Slow speeds are acceptable. The site is not hosted in China, so no ICP licence is needed.
- **OneDrive stays the only copy** of each file. There is no upload step and no second storage bill.
- **No access to the owner's Microsoft account.** The site gets no Graph permissions, no app registration with file scopes, and no refresh token. The most it ever holds is an "Anyone" sharing link, which only opens the one shared item.

## Trust model

**Microsoft's sharing is the real security boundary. This site's own controls are treated as untrusted.**

- **What can be exposed:** only what Microsoft lets an "Anyone" link reach, which is the shared item and nothing outside it (tested: the parent folder returned 403). A bug in this site, a leaked short link, or even a fully compromised AWS account can expose no more than the stored Anyone links would.
- **Real revocation:** turning off or expiring the link in OneDrive. Deleting or expiring a short link here is a convenience on top, not something to rely on.
- **Never shared:** anything that should never be public through a link stays unshared in OneDrive. The site can't reach it.
- **Owner sign-in** only identifies the owner (Entra `openid` scope, `@dliu.com` accounts only). It requests no file permissions.

## Using it

**Owner:**
1. In OneDrive, choose Share → "Anyone with the link" → Copy link.
2. Open `https://share.dliu.com/admin` and sign in with the Microsoft account.
3. Paste the link, optionally add a title and an expiry, and click **Create link**. The site opens the link once to check it works and to tell whether it is a file or a folder.
4. Copy the short link and send it to friends.

On the admin page each link can be copied, edited (title, expiry, or a new OneDrive link, keeping the same short link), refreshed after files change in OneDrive, or deleted.

**Friends:** open the short link. There is nothing to sign in to. They can browse subfolders, preview images, video, audio, PDF and text files (PDFs are drawn in the page with a self-hosted copy of Mozilla PDF.js, so they show even where the browser can't embed PDFs: Android, WeChat, Chrome set to download PDFs), and download any file with its Download button. The pages friends see (landing, viewer, link-not-found) are in Chinese or English: the browser's preferred language picks one, and the 中文 / English switch at the end of the header (a 文/A menu on phones) changes and remembers the choice (`localStorage.lang`). The strings live in `web/i18n.js`. The admin page is English only. The DL Share logo and name (`web/logo.svg`, also the favicon) in the top left go to the home page, the DL icon at the start of the footer goes to dliu.com, and every page has a Docs button.

## How it works

```mermaid
flowchart LR
  friend[Friend's browser] --> cf[CloudFront<br>share.dliu.com]
  cf -->|viewer request| fn[CloudFront Function<br>link check]
  fn <--> kvs[(CloudFront<br>KeyValueStore)]
  cf -->|/_app/*| app[(S3: pages)]
  cf -->|/f/* on cache miss| edge[Lambda@Edge<br>origin request / response]
  edge -->|guest session, path → file id| sp[OneDrive / SharePoint<br>via the Anyone link]
  cf -->|fetches bytes| sp
  cf -->|/api/*, /auth/*| api[API Lambda<br>function URL + OAC]
  api -->|folder listing| sp
  api --> kvs
  owner[Owner's browser] -->|Entra sign-in| api
```

### URLs

| URL | What it serves | Handled by |
| --- | --- | --- |
| `/` | Landing page | S3 `/_app/index.html` |
| `/admin` | Owner page | S3 `/_app/admin.html`, which calls the API |
| `/docs` | Public docs (CN/EN): Architecture, Cost, Security and Testing tabs, drawn with the diagram kit shared with the other dliu.com sites (`web/diagram.js`, styled by the shared `dl-docs.css`). The penetration-test table lists checks run live; re-run them and keep it and this README in step when the design changes. | S3 `/_app/docs.html` |
| `/docs#health` | The docs page's **Testing** tab (CN/EN), "how to test this site" for [status.dliu.com](https://status.dliu.com), per the [HEALTH.md contract](https://github.com/dliu-com/status/blob/main/HEALTH.md): for people, with no exact technical details: a flow of a test run, big numbers, a plain-words table per function, a checks-per-function chart and what isn't tested, ending with a link to the Markdown version. It is static HTML in `web/docs.html`. | S3 `/_app/docs.html` |
| `/docs/health` | Old address of the Testing tab: `301` to `/docs#health` | CloudFront Function |
| `/docs/health.md` | Every technical detail (URLs, status codes, markers, the `/health` format), as `text/markdown`, for machines; enough on its own to implement the checks. `test/health.test.js` checks that the Testing tab's functions, numbers and chart match it, and that the tab has no code, URLs or folded blocks. | S3 `/_app/health.md` |
| `/health` | Public health check, `application/health+json`: `{status, time, functions}` with `links` (one KeyValueStore describe) and `signin` (the Entra config from SSM, cached 5 minutes). 200 for pass/warn, 503 for fail, no private details. Its own CloudFront behaviour forwards no cookies, headers or query string and caches for 60 s, so at most one Lambda call a minute per edge. | API Lambda |
| `/s/<id>/[path]` | Viewer page: the share's root, a subfolder (ending in `/`) or one file's preview | S3 `/_app/view.html`, which calls `/api/s/<id>/info` |
| `/f/<id>/<path>` | Raw file bytes, shown inline when the type is safe to show | Lambda@Edge and SharePoint, cached by CloudFront |
| `/f/<id>/<path>?dl=1` | The same bytes with `Content-Disposition: attachment` (the Download button) | Same, cached separately |
| `/api/s/<id>/info?path=` | Public JSON: a folder listing or one file's details | API Lambda |
| `/api/me`, `/api/shares…` | Owner API (signed-in only) | API Lambda |
| `/auth/login`, `/auth/callback`, `/auth/logout` | Entra sign-in (OIDC, PKCE) | API Lambda |

For a file share, `<path>` is the file name. For a folder share, it is the path inside the shared folder, for example `/f/k7Qx9pLmA2/day1/IMG_0012.jpg`. Unknown, deleted and expired links all get the same 404 page, so they can't be told apart.

### Links and share records

- A link id is 10 random base62 characters (about 59 bits), so ids can't be guessed.
- Each share is one CloudFront KeyValueStore entry of at most 1 KB. There is no database:

  ```json
  { "src": "<OneDrive Anyone link>", "kind": "folder", "name": "Tokyo trip", "created": 1793500000000, "exp": 0 }
  ```

  `created` and `exp` are milliseconds, and `exp: 0` means the link never expires.
- The OneDrive link is a secret, because anyone holding it could skip this site. It stays inside AWS and is never sent to visitors.
- The owner API writes the store with conditional ETag writes. New, changed and deleted links reach every edge location within a few seconds.

### Serving a file

1. **Viewer request (CloudFront Function `functions/viewer.js`).** This runs on every request, including cache hits, so a deleted or expired link stops working immediately.
   - It looks up `<id>` in the KeyValueStore and checks `exp`.
   - It rejects `.`, `..`, empty segments, `\` and control characters in the path.
   - It deletes any incoming `x-share-*` headers, then passes the OneDrive link to the origin in `x-share-src` (not part of the cache key).
   - It removes every query parameter except `dl=1`.
2. **Cache hit.** CloudFront serves the cached bytes and no Lambda runs.
3. **Cache miss: origin request (`lambda/edge/index.js`).**
   - Opens the OneDrive link as a guest, or reuses the guest session it has in memory.
   - Resolves the path to SharePoint's file id. SharePoint itself refuses anything outside the share.
   - Points this one origin request at `<tenant>-my.sharepoint.com/…/_layouts/15/download.aspx?UniqueId=…` with the guest cookie and a browser-like `User-Agent`. CloudFront then fetches the file, and `Range` is forwarded so downloads can resume and video can seek.
4. **Origin response.** Keeps only safe headers (length, range, ETag, dates), so nothing from SharePoint that identifies the account reaches visitors. It also:
   - sets the content type from the file name;
   - sets `Content-Disposition` to `inline` for images, video, audio, PDF and plain text, and to `attachment` for everything else and for `?dl=1`;
   - sets `Cache-Control` (browsers 1 hour, CloudFront 1 day).
5. **Viewer response.** The shared traffic-monitor `dliu-visitor-id` function sets the `dl_vid` visitor cookie, as on files.dliu.com. No CloudFront access logs are collected for this site, so traffic.dliu.com does not count it. If logging is ever added, leave out `cs(Cookie)` (it would record the owner's `__Host-share_session` cookie).

### Folder listings

The viewer page calls `GET /api/s/<id>/info?path=…`. The CloudFront Function validates the link and adds the trusted `x-share-src` header. The API's function URL uses `AWS_IAM` with CloudFront OAC, so only CloudFront can call it and the header can't be forged. The API lists the folder through SharePoint's REST API using the same guest session. It returns only names, sizes and dates, never SharePoint URLs or ids. Listings are not cached by CloudFront; the Lambda keeps them in memory for up to 5 minutes.

### Caching and Refresh

| What | Edge copy | Browser | Cleared by |
|---|---|---|---|
| Page HTML (`/`, `/s/…`, `/admin`, `/docs`) | none (`no-cache`) | revalidates | not needed |
| `/_app/*` scripts, styles, icons | 1 day (`s-maxage=86400`) | revalidates (`max-age=0, must-revalidate`) | every deploy invalidates `/_app/*` |
| `/_app/vendor/*` (PDF.js) | 1 day | 5 min (+ `stale-while-revalidate`) | every deploy invalidates `/_app/vendor/*` |
| `/f/<id>/…` file bytes | 1 day (Lambda@Edge sends `s-maxage=86400`; the cache policy's 7-day max TTL is only a cap) | 1 hour | admin **Refresh**, or editing / deleting the link (invalidates `/f/<id>*`) |
| `/api/*`, `/auth/*` | none (`no-store`) | none | — |
| `/health` | 60 s (own cache policy, keyed on nothing) | 60 s | expires |
| `/docs/health.md` | 1 day | revalidates | every deploy invalidates `/_app/health.md` |
| Folder listings | none at CloudFront | none | the API Lambda keeps them in memory for 5 minutes; Refresh clears them |

**Automatic clearing (S3 events → Lambda → invalidation): not used, by decision.** The only S3 bucket holds `/_app/`, which changes only on `make deploy`, and each deploy already invalidates it. The shared files come from OneDrive through Lambda@Edge, not from S3, so S3 events can't see their changes. Adding it would only spend the account's 1,000 free invalidation paths a month, which all dliu.com sites share.

**Known staleness:** if a file is replaced in OneDrive under the same name and Refresh isn't clicked, friends can get the old bytes for up to about 1 day from the edge, plus up to 1 hour in a browser that already fetched it. Meanwhile the listing shows the new size and date after 5 minutes. A new file name gets a new URL, so it is never stale.

### Security

- These headers are set on every response: a CSP that allows scripts only from `/_app/` (styles and images also from the shared UI on `files.dliu.com/dliu.com/`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (keeps link ids from leaking to other sites), HSTS, and `X-Robots-Tag: noindex`. A shared HTML or SVG file is therefore downloaded rather than shown, and can't run code on the site.
- Links are bearer tokens: anyone who has a link can use it. Expiry and deleting here are conveniences; the OneDrive link's own settings are the real control (see Trust model).
- Owner API `POST` requests need the session cookie (`SameSite=Lax`, `__Host-`) and a matching `Origin` header.
- The owner session and the transient sign-in cookie (state, nonce, PKCE verifier) are HMAC-signed with **different keys** derived from the Entra client secret, and each carries a `typ` claim; `getSession` accepts only `typ: "session"` with a user. Before this (SEC-1, fixed in `fba7bcb`) the sign-in cookie, which anyone can get from `/auth/login`, could be replayed as an owner session.
- The API Lambda has reserved concurrency 10 (SEC-2, `71565f8`), so anonymous `/auth/*` and `/api/*` floods can't starve the other sites' Lambdas or run up a large bill. Lambda@Edge is capped by the account's regional concurrency quota (10 outside eu-west-1; 1,000 requested in 12 regions on 2026-11-03, SEC-8).
- Logs: every log group keeps 90 days (SEC-3). CDK sets this for the API group. AWS creates the CDK helper and Lambda@Edge regional groups on first run, so their 90 days is set outside the stack; set it for any new edge region too.

**Security review, 2026-11-03.** Threat model (assets, actors, STRIDE per component, denial of wallet), findings SEC-1 to SEC-10, the live test table and residual risks are on [/docs#security](https://share.dliu.com/docs#security). To repeat it:

| Check | Command | Result on 2026-11-03 |
|---|---|---|
| Live black-box tests | `make pentest` | 93 / 93 pass |
| Live owner tests | `make pentest-owner` | 140 / 140 pass |
| Secrets in git history | `gitleaks git --log-opts=--all .` | no leaks |
| Runtime dependencies | `npm audit --omit=dev` | 2 moderate, build-time only (minimatch via aws-cdk-lib) |
| All dependencies | `npm audit` | 22 low/moderate in the jest and aws-cdk-lib tool chains; none in the Lambda bundles |
| Unit tests | `make test` | 60 pass, including SEC-1 and SEC-2 regressions |

No WAF or rate limit (SEC-4): the owner decided against WAF (about $6+ a month) on 2026-11-03 and accepts the risk, because links go only to friends and a misused link can be deleted.

Owner check (SEC-5): any @dliu.com account in the tenant counts as the owner. The owner accepted this on 2026-11-03 and manages who can sign in through the Microsoft Entra app, not in code.

Log retention (SEC-3): resolved on 2026-11-03; every log group keeps 90 days at the owner's request.

Lambda@Edge concurrency (SEC-8): the owner chose to raise it. On 2026-11-03, 1,000 was requested in us-east-1/2, us-west-1/2, eu-west-2, eu-central-1, ap-northeast-1/2, ap-southeast-1/2, ap-south-1 and sa-east-1 (eu-west-1 is already 400). It's pending AWS approval. Trade-off: fewer 503s under load, but the worst case for uncached random file paths with a valid link rises from about $1.1/h to about $110/h per region.

### China reachability

- CloudFront uses `PriceClass_All`, so visitors are served from Hong Kong, Tokyo or Singapore.
- Viewer pages load nothing from Google, Microsoft or other third-party CDNs. Besides `/_app/` they load only the shared stylesheets and the footer's DL icon from `files.dliu.com` (also CloudFront `PriceClass_All`). Only `/admin` sign-in goes to Microsoft.
- Reachability should be checked from mainland China, for example with boce.com or 17ce.com.

## Code

| Path | What it is |
| --- | --- |
| `bin/file-sharing.ts`, `lib/file-sharing-stack.ts` | CDK app and stack |
| `functions/viewer.js` | CloudFront Function: routing, link check, path validation |
| `lambda/edge/sharepoint.js` | **All SharePoint-specific code**, shared by Lambda@Edge and the API |
| `lambda/edge/index.js`, `lambda/edge/mime.js` | Lambda@Edge file proxy |
| `lambda/api/` | API Lambda: sign-in (`auth.js`), settings from SSM (`config.js`), KeyValueStore (`store.js`), link management (`shares.js`), routing (`index.js`) |
| `web/` | Static pages, uploaded to S3 under `/_app/`. They use the [shared dliu.com look](https://files.dliu.com/dliu.com/README.md): `dl.css` (and `dl-docs.css` on the docs page) load from `files.dliu.com` first, with the `dl-header`/`dl-footer` markup and `dl-*` buttons; `web/style.css` holds only this site's rules (file tables, previews, the PDF viewer) on the `--dl-*` colours, and `test/shared-ui.test.js` guards it. The site's own logo, `web/logo.svg`, is in the header (with "DL Share", linking home) and is the favicon (`/favicon.ico` serves it); the shared DL icon leads the footer and links to dliu.com. `web/pdf.js` draws PDF previews with PDF.js from `web/vendor/pdfjs/`. Cache headers are in [Caching and Refresh](#caching-and-refresh). The distribution serves HTTP/2 and HTTP/3 |
| `scripts/` | `set-secrets.sh`, `probe.js`, `smoke-test.js`, `pentest.js`, `dev-server.js`, `vendor-pdfjs.js` (copies `pdfjs-dist` into the git-ignored `web/vendor/pdfjs/`; `make test`, `synth`, `diff`, `deploy` and `dev` run it) |
| `test/` | Jest tests (`make test`) |

## Stacks

| Stack | Region | Contains |
| --- | --- | --- |
| `FileSharing` | eu-west-1 | CloudFront, KeyValueStore, CloudFront Function, S3 bucket for `/_app/`, API Lambda, DNS records, certificate (created in us-east-1) |
| `edge-lambda-stack-…` | us-east-1 | The Lambda@Edge function. CDK creates and deploys this stack automatically. |

Dependencies are the same as files.dliu.com: the root `dliu.com` stack exports (`MainDomain`, `MainHostedZoneId`) and traffic-monitor (`TrafficVisitorFunctionArn`, `TrafficGeoOriginRequestPolicyId`).

## Setup and deploy

Prerequisites: Node.js 22, AWS credentials for the account, and CDK bootstrapped in both eu-west-1 and us-east-1 (`npx cdk bootstrap aws://<account>/us-east-1`).

```sh
make install
make test       # unit tests
make dev        # optional local preview, see below
make deploy     # runs the tests, then deploys both stacks
make outputs    # shows SiteUrl, AuthRedirectUri, DistributionId, …
```

Sign-in setup, once:
1. In Microsoft Entra, add the redirect URI `https://share.dliu.com/auth/callback` (type Web) to an app registration. The files.dliu.com app registration can be reused. The app needs no API permissions beyond `openid`.
2. Run `make set-secrets`. It stores the client ID and client secret under `/share/` in SSM. It offers the values from `/share/` or `/files/` as defaults, and reuses the files.dliu.com secret when the same client ID is used. The tenant ID isn't stored here: the API reads the shared `/dliu/entra-tenant-id` (String) parameter from the dliu-com/audit stack, with `ssm:GetParameters` granted on exactly that ARN.

Then sign in at `https://share.dliu.com/admin` and create a link.

### Checks

| Command | What it does |
| --- | --- |
| `make test` | Jest tests for the viewer function, SharePoint module, edge function, API, `/health`, the Testing tab and `health.md` (in sync) and stack |
| `make probe` | From this computer, checks that SharePoint still answers the way the site expects (see below) |
| `make smoke` | Against the live site: creates a throwaway link to the test share, waits for it to reach the KeyValueStore, checks the viewer page, a range download, `?dl=1`, 404s and security headers, then deletes the link. `--keep` keeps it. |
| `make pentest` | Live black-box penetration tests (no credentials): auth bypass, forged and replayed cookies, OIDC, link guessing, XSS, CRLF, CORS, cache poisoning, hidden files, TLS and headers. Prints a Markdown table; exits 1 on any failure. |
| `make pentest-owner` | The same plus owner tests (needs AWS credentials): signs a 10-minute owner session from SSM, checks CSRF, injection, traversal and leaks, makes two throwaway links and checks revocation and expiry (including cached files), then deletes them. Prints no file names or links. Takes about 5 minutes. |
| `make dev` | Local preview at `http://localhost:8787` that runs the real viewer function, API and edge code against real OneDrive, with an in-memory store, a fake signed-in owner and no AWS |

`probe`, `smoke` and `dev` need a test OneDrive link (`pentest-owner` uses it too, or else the oldest existing share). Set it in `SHARE_PROBE_LINK`, or for `probe` in the untracked `config/probe.local.json` (`{ "link": "…" }`). Never commit it.

## When SharePoint changes

**Known risk, accepted by the owner.** The site uses SharePoint's undocumented web endpoints and the guest-cookie behaviour of "Anyone" links. There is no official API for anonymous access to a sharing link, and Microsoft can change these without notice. When that happens, the site breaks, and the fix is to update the code, for example with Copilot. Microsoft's access checks are unaffected, because anything that changes can only stop the site from reaching a share, never widen what it can reach.

### Where the dependency lives

All SharePoint-specific code is in **`lambda/edge/sharepoint.js`**. Nothing else builds SharePoint URLs or reads SharePoint responses. `createSharePoint()` returns:

| Function | Used by | Today's implementation |
| --- | --- | --- |
| `openShare(link)` | everything below | `GET <link>` with `redirect: manual`, following redirects only on the same host (a redirect elsewhere is a sign-in page, so the link is reported as no longer working). Collects the `FedAuth` guest cookie. Then `GET {site}/_api/v2.0/shares/u!<base64url(link)>/driveItem?$select=…` with a browser-like `User-Agent` to read the name, whether it is a file or folder, and its server-relative path. Sessions are kept in memory for 30 minutes. |
| `describe(link)` | API (creating a link) | `openShare`, returning only the kind, name, size and item count |
| `browse(link, path)` | API (listings) | Folders: `GET {site}/_api/web/GetFolderByServerRelativePath(decodedurl=@p)?@p='…'&$select=Exists,Files/…,Folders/…&$expand=Files,Folders`. Files: `GetFileByServerRelativePath`. Results are kept in memory for 5 minutes. |
| `origin(link, path)` | Lambda@Edge | Resolves the file to its `UniqueId` and returns the host, the path `{site}/_layouts/15/download.aspx?UniqueId=…` and the cookie. `download.aspx` answers `Range` with 206. |
| `forget(link)` | API (Refresh) | Drops the cached session and listings |

Any 401, 403 or redirect is retried once with a fresh guest session. Quirks to keep in mind:
- `Exists` must be in `$select`. Without it, a missing folder returns 200 with empty lists instead of an error.
- `Length` comes back as a string.
- Requests without a browser-like `User-Agent` are refused.

### Expected behaviour

`make probe` checks, against a real test share:
1. Opening the link as a guest works and tells whether it is a file or a folder.
2. A folder lists its files and subfolders, and the count matches.
3. Looking up a file returns the right size.
4. A `Range` download returns 206 with the right number of bytes.
5. A missing file and a `..` path return 404.

It prints only counts, sizes, status codes and timings, never names or links. `make smoke` checks the same through the live site. Microsoft's own scoping (the parent folder of a share returned 403) was checked by hand on 2026-11-01. If it ever stops holding, stop and investigate.

### Symptoms and where to look

| Symptom | Likely change | First thing to check |
| --- | --- | --- |
| Every link shows "This link no longer works" or 502 at once | Opening the link no longer sets `FedAuth`, or the redirects changed | Step 1 of `make probe`. Look at the redirect chain and the cookies set. |
| Listings fail but files download | The REST folder endpoint or JSON shape changed | Step 2. Compare the response with the fields `browse()` reads. |
| Files fail (503 or 502), listings work | `download.aspx` or `UniqueId` resolution changed | Step 4. As a fallback, the v2 driveItem's `@content.downloadUrl` (valid 60 minutes, no cookie needed) could be used. |
| Works, then fails after some hours | The guest session expires sooner | Check that sessions are re-opened on 401, 403 or sign-in redirects. |
| 403 or 429 only from AWS | Throttling or blocking of AWS IPs | Compare `make probe` from a laptop with the CloudWatch logs of the Lambda@Edge function (in the region nearest the visitor). |

**How to fix:** open the share link in a browser with dev tools' Network tab open, see which endpoints the OneDrive web viewer now calls, and update only `sharepoint.js` to match. Then run `make probe`, `make test`, `make deploy` and `make smoke`.

## Verified and open questions

Verified on the live site on 2026-11-01 (`make smoke`): SharePoint answers requests from AWS, the Lambda@Edge function on Node.js 22 can set the `Cookie`, `User-Agent` and `Host` headers for SharePoint, range downloads and the CloudFront cache work, Downloads keep the real (including Chinese) file names, and no SharePoint cookies or headers reach visitors.

Still open: (`:b:`, `:x:`, `:u:` and similar). Only a folder link has been tested.
- **Guest session lifetime.** How long SharePoint honours the `FedAuth` cookie server-side is unknown. The site re-opens the link when it expires.
- **Tenant expiry policy for Anyone links.** If the tenant forces Anyone links to expire, each share's OneDrive link must be replaced (Edit on the admin page) before then.

## Alternatives considered

**Graph app permissions** (`Sites.Selected` or `Files.Read.All`) would be the documented, stable API. They were rejected because the owner will not give the site access to the Microsoft account.

**Mirror into S3.** When a link is created, the backend would copy the files from the Anyone link into S3 and serve them like files.dliu.com. It was rejected because storage is duplicated, changed files need re-syncing, and very large files hit Lambda's 15-minute limit. It stays a fallback if Lambda@Edge proves troublesome.

Two other options were ruled out:
- **Redirecting** visitors to the SharePoint download URL fails the China goal.
- **Streaming bytes through a regional Lambda** hits Lambda's response size limits (about 200 MB with streaming) and costs Lambda time for every download.

## Costs

| Resource | You pay for |
| --- | --- |
| OneDrive | Nothing extra. It uses the existing Microsoft 365 storage. |
| CloudFront | Data transfer and requests. The free tier includes 1 TB and 10M requests per month. `PriceClass_All` costs a little more per GB outside the free tier. |
| CloudFront Functions and KeyValueStore | About $0.10 per million function runs plus $0.03 per million reads |
| Lambda@Edge | Cache misses only |
| Lambda | Owner actions and folder listings |
| S3 | The pages only (a few KB) |

When idle, there is effectively no cost. The docs page's Cost tab has the list prices and worked examples; keep both in step.

## Ideas for later

- A password per link, a download limit, or a view-only mode with no download buttons.
- Readable link prefixes, such as `/s/tokyo-trip-k7Qx9p`. The random part must remain.
- A scheduled `make smoke` to catch SharePoint changes before friends do.
