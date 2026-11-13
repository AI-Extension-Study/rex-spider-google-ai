# rex-spider-google-ai

> **Do not pin this fork's `main`.** The extension installs bric-digital's `ck-refactoring` branch at `089c890` (2026-09-16), which is not on this fork. This fork's `main` (`fec20f6`) still has the crawler written for an older rex-spider: it has no `identifier()`, so it would not read `spider.spiders.google-ai`, and no `doBackgroundCrawl()`, so under the rex-spider the extension uses its passes would send nothing and never report an end, and every later round would report it as still crawling. To pin a change, first push bric-digital's `ck-refactoring` to this fork as a branch, then make the change on top of it.

The Google AI Mode crawler for a research browser extension. While a participant's browser is open and signed in to Google, it reads the list of their AI Mode threads with their own sign-in and uploads one record for each new or changed thread. Everything below describes `089c890`, the code the extension runs.

## What it collects

One record per thread each time the thread's last-change time is new, in the crawl window:

| field | what it is |
|---|---|
| `name`, `platform` | `rex-conversation`, `google-ai-mode` |
| `identifier` | the thread entry's two ids, `[0][0]` and `[0][1]`, joined by `_` |
| `started` | the entry's time at `[5][0]` (epoch seconds) |
| `ended` | the entry's time at `[6][0]`, or `started` when `[6]` is null |
| `date` | `ended` in epoch ms |
| `turns` | always empty |
| `metadata` | the whole thread entry from the list, an array |

There is no `is_summary`, no `format_version`, no per-message data and no detail mode. The crawler ignores `summarize`, `halt_on_error` and `crawl_delay`.

## How it collects, and what is removed

1. It reads `https://www.google.com/` with the browser's cookies and looks for the page token `SNlM0e`. A page without it ends the pass (reason `SNlM0e token not found in Google home page.`). The token is not sent anywhere.
2. It makes one request, `GET https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=[null,null,0]&msc=gwsclient` plus a random `opi`, with the cookies. There is no paging, and whether one answer holds every thread has not been checked.
3. It dispatches each thread in the crawl window that was not sent at its current `ended`, and ends the pass with reason `Crawl successful`, the count sent and the ids of every thread in the window. One malformed thread fails the whole list for that pass, with a reason starting `Error encountered fetching chats:`.
4. Before upload, the extension's redactor replaces `metadata[1]`, the thread's title or first query, with its SHA-256 hash and sets `[10]`, `[12]`, `[20]` and `[21]` to null. Every other position goes up as the list sent it.

## Pinning a change

The extension pins `github:bric-digital/rex-spider-google-ai#ck-refactoring`, locked at `089c890`. The branch comes here with `git fetch https://github.com/bric-digital/rex-spider-google-ai.git ck-refactoring` and `git push origin FETCH_HEAD:refs/heads/ck-refactoring`; a change then branches from it and the extension pins the new commit. That branch's `package.json` asks for bric-digital's rex-spider at a `ck-refactoring` branch, which no longer exists there (checked 2026-11-13); the extension's lockfile holds rex-spider at `774e813`.

## What is in this repo

`src/service-worker.mts` is the crawler, on this `main` the old one; `089c890`'s is on bric-digital's `ck-refactoring`. `tests/specs/serviceworker-parsing.spec.ts` is its Playwright spec, with list data in `tests/extension/data/`. `npm run build`, `npm run lint` and `npm test`, which starts Chromium and a Python web server on port 8080; CircleCI runs all three (`.circleci/config.yml`).

## Keeping this current

Update this README when this fork's `main` takes `ck-refactoring`, or when the extension pins this fork.
