# share.dliu.com: health and guest checks

Full technical version of the Testing tab, https://share.dliu.com/docs#health, for machines and AI agents. It follows the dliu.com
health contract used by https://status.dliu.com and is enough on its own to implement the tests.

share.dliu.com (DL Share) turns OneDrive "Anyone" links into short `/s/<id>` links. CloudFront serves the pages from a
private S3 bucket; a CloudFront Function looks every link id up in a CloudFront KeyValueStore; Lambda@Edge fetches the
shared files from OneDrive; a Lambda function (behind a function URL that only CloudFront can call) runs the owner
sign-in, the owner API and `/health`.

## Functions

| Key | Name | What it does | Critical |
| --- | --- | --- | --- |
| `pages` | Pages | Serves the home page, the docs pages, this file and the stylesheet. | yes |
| `links` | Share links | Looks every `/s/<id>` link up in the link store; unknown ids get the "Link not found" page. | yes |
| `signin` | Owner sign-in | Sends the owner to Microsoft to sign in (`/auth/login`). | no |
| `api` | Owner API | The API behind the owner page; refuses anyone not signed in. | no |
| `https` | HTTPS | Redirects plain HTTP to HTTPS. | no |

The site is "down" when a critical function fails. Friends' links keep working when `signin` or `api` is down.

## Guest checks

Send each request with no cookies, no `Authorization` header and no query string, and do not follow redirects. A check
passes when the status code matches, the `Content-Type` starts with the expected type (`-` means not checked), and the
body contains the marker (or, for a redirect, the `Location` header starts with it). A check that passes but takes
longer than the slow threshold counts as slow.

| Function | Method | URL | Status | Content type | Body marker or `Location` prefix | Slow after (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| `pages` | GET | `https://share.dliu.com/` | 200 | `text/html` | `class="dl-header"` | 2000 |
| `pages` | GET | `https://share.dliu.com/docs` | 200 | `text/html` | `id="health"` | 2000 |
| `pages` | GET | `https://share.dliu.com/docs/health` | 301 | - | `/docs#health` | 2000 |
| `pages` | GET | `https://share.dliu.com/docs/health.md` | 200 | `text/markdown` | `## Guest checks` | 2000 |
| `pages` | GET | `https://share.dliu.com/_app/style.css` | 200 | `text/css` | `.file-head` | 2000 |
| `links` | GET | `https://share.dliu.com/s/0000000000/` | 404 | `text/html` | `data-i18n="linkNotFound"` | 2000 |
| `signin` | GET | `https://share.dliu.com/auth/login` | 302 | - | `https://login.microsoftonline.com/` | 3000 |
| `api` | GET | `https://share.dliu.com/api/me` | 401 | `application/json` | `"error"` | 3000 |
| `https` | HEAD | `http://share.dliu.com/` | 301 | - | `https://share.dliu.com/` | 2000 |

Notes:

- `/s/0000000000/` is a well-formed link id that is never issued (ids are 10 random characters from `[0-9A-Za-z]`), so
  the CloudFront Function looks it up in the KeyValueStore and returns its built-in 404 page.
- `/auth/login` only starts the sign-in: it sets a short-lived state cookie, which the checker ignores, and redirects to
  `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?...`. Do not follow the redirect.
- `/api/me` without a session returns `401 {"error":"Not signed in"}`.
- The Lambda-backed checks (`signin`, `api`) can take up to about 2 s on a cold start, hence the 3000 ms threshold.

## Health endpoint

`GET https://share.dliu.com/health` (also `HEAD`; other methods get `403` from CloudFront).

- **Response:** `Content-Type: application/health+json`, `Cache-Control: public, max-age=60`. HTTP `200` when `status`
  is `pass` or `warn`, `503` when it is `fail`.
- **Format:** `{ "status", "time", "functions": [{ "key", "name", "status", "output"? }] }`. `status` is `pass`, `warn`
  or `fail`; the top-level `status` is the worst of the functions'. `time` is ISO 8601 UTC without milliseconds.
- **Caching:** CloudFront's `health` behaviour caches the response for 60 s with a cache key of nothing (no headers,
  cookies or query string), so the function runs at most about once a minute per edge location.
- **No authentication:** the behaviour has no origin request policy, so no cookies, no `Authorization` header and no
  query string reach the function, and the handler reads none of them (it decides on the method and path alone).
- **Read only:** no writes, no S3 LIST, no calls to Microsoft or OneDrive. The checks run in parallel, each with a
  2000 ms timeout, so the response comes within about 2 s.
- **Slow:** a check over 1000 ms is `slow`, except on the function's first run after a cold start, whose time is
  mostly Lambda start-up rather than the dependency.
- **Private details:** none. `output` is only ever `slow`, `not ready`, `timeout`, `not configured` or `read failed`.

| Key | Name | Reads | `warn` | `fail` |
| --- | --- | --- | --- | --- |
| `links` | Share links | One CloudFront KeyValueStore `DescribeKeyValueStore` call (no keys read, no count reported). | `slow` (over 1000 ms) or `not ready` (status is not `READY`) | `timeout` or `read failed` |
| `signin` | Owner sign-in | SSM `GetParameters` for the sign-in settings, the read every sign-in does (cached 5 min in the function). Microsoft is not called. | `slow` (over 1000 ms) | `timeout`, `not configured` (a parameter is missing) or `read failed` |

Example:

```json
{
  "status": "pass",
  "time": "2026-11-03T23:00:00Z",
  "functions": [
    { "key": "links", "name": "Share links", "status": "pass" },
    { "key": "signin", "name": "Owner sign-in", "status": "pass" }
  ]
}
```

## Caching

HTML pages are sent with `Cache-Control: no-cache`. `/_app/style.css` and this file are sent with
`Cache-Control: public, max-age=0, must-revalidate, s-maxage=86400`, and every deploy invalidates them. The "Link not
found" page and every API response are sent with `Cache-Control: no-store`; `/health` with `public, max-age=60`.

## Not tested

- Opening real shared files and folders (`/s/<id>/...`, `/f/<id>/...`, `/api/s/<id>/info`): they need a real share
  link, and the files come from OneDrive through Lambda@Edge, which the checks never call.
- Owner actions after sign-in: creating, renaming, changing and deleting links (`/api/shares*`).
- Finishing the Microsoft sign-in (`/auth/callback`), which needs the owner's own account.
- CloudFront cache invalidation after a link is changed or deleted.

## Rules

- Only `GET` and `HEAD`, as an anonymous guest. The tests are read only and must never change content.
- Use the user agent `dliu-status-bot/1.0 (+https://status.dliu.com/docs)`, so traffic.dliu.com leaves the requests out.
- Request `/health` at most once a minute; it is cached for 60 s anyway.
- Keep this file and https://share.dliu.com/docs#health in sync; the repo's `test/health.test.js` checks that they list
  the same functions and checks, and that `/health` reports only those functions.
