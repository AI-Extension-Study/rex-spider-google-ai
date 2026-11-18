# rex-spider-google-ai

The Google AI Mode crawler for a research browser extension (this fork of bric-digital's `rex-spider-google-ai`). While a participant's browser is open and signed in to Google, it reads the list of their AI Mode threads with their own sign-in and uploads one record for each new or changed thread. A summary record holds the thread's two list times, ten small integers from the list and a hash of its title. A detail record adds two turns per exchange, the question's and the answer's, with counts made in the browser: characters, words and citations. No record holds a title or message text. Records follow format 1, the conversation record layout the ChatGPT and Gemini forks also use.

**Where it stands, 2026-11-17.** This README describes `main` at `3cee8e8`. The extension's release v0.0.59 installs bric-digital's crawler at `089c890` instead. That crawler sends one list record per thread with the whole list entry as `metadata` and `<mstk>_<mtid>` as `identifier`, and has no detail mode. This fork reaches participants only in a release that pins it.

## What it collects

| | summary mode | detail mode |
|---|---|---|
| per thread | the thread id (`mtid`), its created and last-used times from the list, the SHA-256 of its title, and ten small integers from the list entry | the same, plus how many turn blocks the thread held |
| per exchange | nothing | two turns, the question's and the answer's, each with character and word counts, and the answer's citation count |

Never collected: the title (only its hash), question and answer text (only counts), links and source cards, the `mstk` (the id the thread's URL carries, which changes with every turn), the values read from the thread page, and every other position of the list entry (`src/record.mts:1-9`).

## How a pass works

rex-spider starts a pass on a crawl round when none is running and `sleep_delay` has passed since the last one. The spider says it is crawling from the moment a pass starts, so a round while one runs starts none and rex-spider sends `[google-ai] Still crawling.` (`src/spider.mts:33-37, 57-60`).

1. If a back-off is running (see "When something fails"), end with `backoff` and make no request.
2. Read and, on a switch, write the mode record (see "Modes and the re-send"), and look up the crawl window.
3. Read `https://www.google.com/?hl=en`. The browser is signed in when the page holds `SignOutOptions` (`src/home.mts`); without it the pass ends as `not-signed-in` with no list request.
4. Walk the list: `GET /httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=[null,20,0,null,<cursor>]&msc=gwsclient` (`reqpld` percent-encoded, the cursor quoted or `null`), 20 threads a page, the next cursor at `outer[5]`, newest first (`src/list.mts`). The walk stops at the first thread last used before the window's start, at the last page, or after 100 pages. An entry that cannot be read is skipped and counted as `malformed`.
5. Check each thread in the window against the upload keys. The threads not sent yet go out newest first by last use.
6. Summary mode builds each record from the list entry, 25 at a time, and stamps their keys after a 3 s wait. Detail mode reads each thread with two requests (`src/read.mts`):
   - the thread page, `GET /search?udm=50&mstk=<mstk>&mtid=<mtid>&csuir=1&hl=en`, for five values: `data-garc`, `data-lro-token`, `data-lro-signature`, `data-xsrf-folwr-token` and `kEI`;
   - then `GET /async/folwr` with those five, whose answer streams every turn. A body over 40 Mi UTF-16 units is not read (`src/stream.mts:22`).
7. Store the back-off as the pass left it, and send one completion event (see "Reading the completion events").

The spider's `allowedUrls()` names exactly these four request forms, each anchored and pinned to the crawler's parameters, so the extension can let them through where it redirects AI Mode pages, and none of the requests Google's own pages were seen making matches one (`src/allowed.mts`, `tests/unit/allowed.test.mts`).

## Pacing and the read budget

- `crawl_delay` (default 30 s) is waited before every request after the home page: before each list page, before each thread, between a thread's page and its folwr, and before a home check. Thread reads are never closer than 3 s. `enabled` is read again after each wait, before the request (`src/pass.mts`).
- **Read budget:** at most 15 thread reads in any 60 minutes, counted across passes (`READ_BUDGET`, `src/budget.mts`).
  - Before each thread read the pass counts the stored read times. At 15 it stops with `stop=read-budget`, and the rest wait for a later pass.
  - A read's time is stored before its page request, so a read that fails counts too.
  - Read times that cannot be read or stored stop the pass as `store` before the read.
  - Summary passes read no thread and use none of the budget.
  - A first sweep of 60 threads takes about 4 hours.
- **Detail budget:** reads stop once a pass has spent 360 s reading (requests, parsing and storage calls; the waits do not count), counted from its first read.
- Threads not reached keep no key and go out in a later pass.
- Waits run in steps of at most 20 s with a cheap extension call before each, so Chrome does not stop the service worker mid-pass, and every request gives up after 20 s (`src/pacing.mts`, `src/client.mts:36`).

## What a record holds

Top level: `name` (`rex-conversation`), `platform` (`google-ai-mode`), `identifier` (the `mtid`, `[0][1]` of the list entry, which stays the same across follow-ups), `format_version` (`1`), `is_summary`, `date`, `started`, `ended`, `turns`, `metadata` (`src/record.mts`).

- `ended` is the list's last-use time `[6]`, or `[5]` when `[6]` is null.
- `started` is the earlier of `[5]` and `[6]`: on threads begun from an AI Overview follow-up, `[6]` can come seconds to minutes before `[5]`.
- Both times are whole seconds.
- `date` is `ended` in epoch ms for a summary record and `started` in epoch ms for a detail record.
- A summary record has `turns: []` and no `turns_complete`. A detail record adds `turns_complete`.

`metadata`:

| key | what it is |
|---|---|
| `title_hash` | SHA-256 of the title `[1]`, lowercase hex; null with no title, or when the hash fails |
| `created_at`, `updated_at` | `[5]` and the last-use time (`ended`'s) as ISO instants in UTC, such as `2025-11-16T13:33:20Z` |
| `list_numbers` | exactly the keys `"3"`, `"11"`, `"13"`, `"17"`, `"18"`, `"23"`, `"25"`, `"26"`, `"27"`, `"30"`, each that position's value when it is an integer from 0 to 999, else null. These positions held small integers on every entry seen; their meaning is not settled (`src/list.mts:20-22`) |
| `turn_blocks` | detail records only: the turn blocks the thread held |

A turn is one question or one answer, two per turn block, in the thread's order:

| key | user turn | assistant turn |
|---|---|---|
| `identifier`, `parent`, `when` | null | null |
| `speaker` | `user` | `assistant` |
| `on_current_branch` | `true` | `true` |
| `text_chars`, `text_words` | the question: the turn's heading text after its label ("You said:") | the answer's visible text |
| `citation_count` | 0 | the inline citation markers (`span[data-suuid^="nCd0md\|"]`) in the answer's blocks, the controls block left out |
| `search_result_count`, `attachments` | null | null |

- **Counting rule** (`src/text.mts`). `text_chars` counts Unicode code points, and `text_words` counts runs of non-space characters holding a letter or a number (`\p{L}`, `\p{N}`).
- **Visible text** (`src/turns.mts:28-31, 373`) leaves out:
  - `script`, `style`, `svg`, `button`, `template`, `noscript` and `textarea`;
  - elements hidden by the `hidden` attribute or an inline `display:none` or `visibility:hidden`;
  - the citation markers and chips.

**Always null, and why** (`src/record.mts:30-33`, `src/keep.mts:75-77`). Google's response for a thread carries no per-turn id or time, so `identifier`, `parent` and `when` are null. Nothing in it branches, so `on_current_branch` is always `true`. The source list's total is not in it, so `search_result_count` is null, and images are not read, so `attachments` is null.

**Null when unreadable.** The question's counts are null when the turn has no question heading, or the heading has no label (`src/turns.mts:468-476`). The answer's counts and citations are null when its body is not found. `citation_count` is also null when the answer has no marker but links outside Google, which means it cites in a way the count cannot see (`src/turns.mts:478-498`).

**`turns_complete` is false when** (`src/turns.mts:514-517`, `src/read.mts`, `src/record.mts:202-219`):
- a block lacked its question or answer, or the question headings did not number the blocks;
- the stream did not end whole;
- the turns were cut to the newest 1,000 or to 512 Ki characters of JSON.

A stream with no turn block, or none whose answer body is found, gives no detail record at all: it is a layout failure (see "When something fails"), since every thread has at least one turn.

## Modes and the re-send

`summarize: true` is summary mode; absent or `false` is detail mode, so with no `summarize` served the crawler runs detail mode. The spider takes `summarize` and `halt_on_error` again, in both directions, at every configuration refresh with a `google-ai` or `default` block. It checks them before each thread: a mode change during a pass ends the sending, and the next pass runs in the new mode (`src/spider.mts:40-55`).

Each mode has its own upload key, which rex-spider stores as `rex-spider-google-ai-conversation-upload-<id>-<ms>` with the thread's last use in ms (`src/keys.mts`). The id is the bare `mtid` in summary mode and `<mtid>-detail` in detail mode. The spider stores the served mode and when this browser's first pass in it ran (`rex-spider-google-ai-mode`).

The re-send rule (`src/mode.mts`):
- A thread with a key in the served mode at its current last use is not sent again. One with no key in either mode is sent.
- A thread with a key only in the other mode, or only under bric-digital's old key (`<mstk>_<mtid>`), is sent again, once, if it was last used no earlier than 90 days before this browser's first pass in the served mode. Older threads keep the record they have.
- A browser with no stored mode counts as switching on its first pass. So after the update, the threads used in the 90 days before go out once more in the served mode, and in detail mode the read budget spreads them over several hours.
- While the mode record cannot be read or written, threads sent only in the other mode are held back for a later pass.

## What is removed, and how

1. The spider builds each record from the fields above and nothing else, each in a checked form (`src/record.mts`, `src/list.mts`). The title is hashed in the spider with rex-core's `sha256`, and the counts are made in the browser, so no text leaves the spider.
2. Once the extension pins this fork, it runs the redactor, `src/redact.mts` with its tables in `src/keep.mts`, on every `rex-conversation` point with `platform` `google-ai-mode` before upload, as a copy rendered from the pinned commit (`src/redact.mts:1-15`).
   - A record the builders made comes back equal, each value written again from its checked form, and every other key dropped at every level.
   - A `started` or `ended` outside 2001 to 2286, or a `date` that does not match them, cuts the record to the scaffold.
   - A speaker other than `user` or `assistant` reads `unrecognised`, and an `identifier` outside the `mtid`'s form reads null.
   - A turn of another form is dropped, which makes `turns_complete` false.
   - Any other such point keeps only the scaffold: `date`, `name`, `platform`, `identifier` (in the `mtid`'s form) and the uploader's own keys (`generatorId`, `_pdk_trace_context`, `passive-data-metadata`). Every point bric-digital's crawler sent is one, since none has a `format_version`, and its `<mstk>_<mtid>` identifier is past the `mtid`'s 64 characters (every `mstk` seen was 135 characters or more), so it is left out (`src/keep.mts:36-40`).
   - The redactor never throws, because rex-content-processing uploads a failed processor's input unredacted. It imports nothing but rex-types.

The hash uses no secret key, so someone who guesses a title exactly can confirm the guess, and two threads with the same title share a hash.

## When something fails

- **Google asks for a wait** (`src/backoff.mts`, `src/pass.mts`). A 429, a 503, any `Retry-After` header, or a redirect to Google's unusual-traffic page (`/sorry/`) stops the pass. It can come at the home page, a list page, either of a thread's requests or a home check. The pass starts a back-off kept in the extension's storage (`rex-spider-google-ai-backoff`): 5 minutes, doubling with each refusal in a row, longer if `Retry-After` asks, at most 6 hours. A thread refused this way gets nothing and is read after the back-off.
- **Google's limited page.** After about 40 requests Google answers the thread page with a 200 page that holds none of the five values. A thread page with none of the four `data-` attributes, in any quoting (`src/read.mts:80-88`), is read as that page only when at least 5 reads are stored in the 3 hours before it (`LIMITED_AFTER_READS`, `LIMITED_WINDOW_MS`, `src/budget.mts`). The window is longer than the read budget's hour so that a limit outlasting the 60-minute back-off still reads as limited. With fewer reads it is a layout failure, with the home check, the summary and the memo below: on the one account tested live the limit came only after 19 to 36 thread reads, while a change to Google's markup would show from the first.
  - The pass first checks the home page once more: signed out ends it as `not-signed-in`, and a refusal stops it with that refusal's back-off.
  - Otherwise it stops with `stop=limited` and a back-off of 60 minutes, doubling, at most 6 hours, kept even if a switch-off ends the pass during the home check's wait.
  - That thread gets no summary and no memo, does not count as a failed read, and is read after the back-off.
- **How back-offs run.** Refusals in a row are counted across codes, and each wait is from its own code's base. Passes during a back-off end at once with no request. A pass that reads a list page with no refusal clears it. A stored wait more than 6 hours ahead is ignored, since only a clock that went back leaves one.
  - The back-off is read with rex-core's 1 s store deadline, and once more with 20 s when that gets no answer, since the extension's uploads share the same database. A pass goes ahead only when neither read answers.
  - Before a refusal's back-off is written, the stored one is read again, and the new one never waits less or counts fewer refusals than it, so a back-off the pass could not read is doubled, not restarted (`src/pass.mts`, `laterBackoff` in `src/backoff.mts`).
- **Sign-out.** A home page without `SignOutOptions`, a 401 anywhere, or a list page after a cursor with no entry list (`[]`, as a session signed out mid-walk answers; an empty last page `[null, null, 1]` is not one) ends the pass as not signed in, with no back-off (`src/list.mts:245-249`). A thread page that lacks a value but still holds one of the four attributes gets the same home check before its failure counts.
- **Any other failed read is that thread's alone.** That covers a page lacking a value or holding one out of form, a stream with no turn block or no answer found in any turn, a broken stream, a body over the cap, a 403, a 404, a 5xx and no answer.
  - Its summary record goes out in the detail's place, once per last use, unless one already went out at that time. It gets no key, so the detail read comes again.
  - A memo (`rex-spider-google-ai-detail-memo-<mtid>`) then holds the thread back. It waits 1 day after a first failure that may pass by itself (no answer, a 5xx or a redirect not followed, a page lacking a value, a stream with no answer found, a broken stream), and 7 days otherwise or on a repeat. A thread used since is read at once.
  - Three failed reads in a row end the reads, or the first with `halt_on_error` (see "Settings it reads").

## Reading the completion events

Each pass sends one event, `rex-spider-google-ai-complete`, with `crawled_count`, `crawled_ids` and `reason`.

- Only `ok` and `none` come with a count of 0 or more: the records sent, and the `mtid` of every thread listed in the crawl window.
- Every other reason comes with -1 and no ids, so a list read in part never looks like deleted threads, and the spider also puts it in the crawl's issues (`src/spider.mts:129-131`).
- A reason is a code followed by `key=value` fields, never free text (`src/reasons.mts`), such as `ok seen=40 dispatched=15 left=25 stop=read-budget ms=1350000` (made-up numbers).

| code | meaning |
|---|---|
| `ok` | the list read to its end: `seen` threads in the window, `dispatched` records sent |
| `partial` | a later list page failed, or the walk was cut; the same fields as `ok`, plus `cut` |
| `none` | signed in, and no thread since the window's start |
| `list-failed` | the list could not be read into a thread in the window: a first page that is not a list page, or a list read only in part that gave none; `cut` says why |
| `not-signed-in` | no `SignOutOptions`, a 401, or no entry list after a cursor; `stage` is `home` or `list` |
| `rate-limited`, `challenge` | a refusal at the home page or a list page, and a back-off started |
| `backoff` | skipped: a back-off runs `until` the time given; `code` is `rate-limited`, `challenge` or `limited` |
| `http-error`, `network`, `timeout` | the home page or the first list page did not answer properly |
| `disabled`, `store`, `internal` | switched off; the crawl window lookup got no answer; an unexpected error |
| `[google-ai] Still crawling.` | sent by rex-spider on a round while a pass is still running; not a pass |

On `ok` and `partial`:
- `stop` says why the sending ended before every due thread was handled: `budget`, `read-budget`, `mode`, `disabled`, `rate-limited`, `challenge`, `limited`, `not-signed-in`, `failed-reads`, `halt-on-error`, `store` or `internal`.
- `failed` counts failed detail reads, `held` the threads held back for a later pass, `left` the due threads a later pass sends, and `malformed` the list entries skipped.
- `cut` is one of `http-error`, `unreadable`, `timeout`, `network`, `repeated-cursor` or `page-limit`.

## Settings it reads

rex-spider merges `spider.spiders.google-ai` over `spider.spiders.default` from the served configuration.

| key | default | effect |
|---|---|---|
| `enabled` | `true` | `false` stops a pass before its next request |
| `summarize` | absent | `true` for summary mode, else detail mode |
| `halt_on_error` | `true` | `true` ends the detail reads at the first failed read, `false` at three in a row |
| `crawl_delay` | `30000` | ms before each request after the home page. A number or a numeric string is read as written, 0 included; anything else counts as 30000 (`src/pacing.mts:41-46`) |
| `sleep_delay` | `300000` | ms between passes, applied by rex-spider |
| `start`, `end`, `time_anchor` | none, none, `runtime` | the crawl window: `start` and `end` in ms from the install time (`install`) or from now (`runtime`), or as epoch ms (`absolute`). A thread is in it by its last-use time (`ended`) |

## What it cannot see

- Anything while the browser is closed or signed out of Google. The next pass picks up every thread that changed meanwhile, but a summary record carries only each thread's last use.
- A time or an id per turn, edits or branches, the number of sources an answer drew on, and attachments: Google's response for a thread does not carry them, or they are not read.
- Threads past 100 list pages (2,000 threads): the walk is cut and the pass reads as `partial`.
- A deletion as an event: a deleted thread stops appearing in the `crawled_ids` of `ok` events.

## Running the tests

CI uses Node 24.11 (`.github/workflows/ci.yml`).

- `npm ci`, then `npm run build` (`tsc`, type checks only) and `npm run lint`.
- `npm run test:unit` runs Node's test runner on `tests/unit`, with no browser.
- `npm run test:specs` builds a test extension and runs the Playwright specs in Chromium:
  - `tests/specs/crawl.spec.ts` runs whole passes in a real service worker, with www.google.com answered by routes and every id, title and text made up;
  - `tests/specs/spider.spec.ts` checks the module's registration, its flags and its allow patterns as Chrome rules;
  - `tests/specs/dependency-pins.spec.ts` checks the pins (below).
- The specs resolve no host but 127.0.0.1 and use no proxy, so nothing reaches Google. Playwright also starts `python3 -m http.server` on port 8080.
- `npm test` runs both suites. CI runs the build, lint and both suites on every pull request and on `main`.

## How a change reaches the extension

Once the extension pins this fork, it names it in its `package.json` at a full commit, and carries a copy of `src/keep.mts` and `src/redact.mts` rendered from that same commit as its Google AI Mode case. From then on a change here reaches participants only after the extension pins the new commit, its copy is made again from that commit, and a release ships both.

The REX modules this one needs at runtime (`@bric/rex-core`, `@bric/rex-spider`, `@bric/rex-types`) name their repos with no commit, on purpose. npm takes any commit of the right repo for such a spec and keeps the extension's single copy. A commit that differs from the extension's would make npm install a second copy under this package, which registers with an instance the extension never runs. The lockfile holds the commits the extension's v0.0.59 ships (rex-core `e7cd111`, rex-spider `774e813`, rex-types `76cbb61`), so the tests run on that code. When the extension moves one, update `SHIPPED` in `tests/specs/dependency-pins.spec.ts` and the lockfile together.

## Where to read next

| to... | read |
|---|---|
| see how a record is built | `src/record.mts`, then `src/turns.mts` for the turns and `src/text.mts` for the counts |
| see what the redactor keeps | `src/keep.mts`, then `src/redact.mts` |
| follow one pass | `src/pass.mts`, then `src/list.mts` and `src/read.mts` |
| see the waits and the budget | `src/pacing.mts`, `src/budget.mts`, `src/backoff.mts` |
| decode a completion reason | `src/reasons.mts` |

## What is in this repo

| path | what it holds |
|---|---|
| `src/` | the crawler: the entry point the extension imports (`service-worker.mts`), the spider (`spider.mts`) and one module per job. `browser.mts` and `extension.mts` are empty, since the crawler runs only in the service worker |
| `tests/unit/` | Node unit tests and their made-up fixtures |
| `tests/specs/` | the Playwright specs and the mocked www.google.com (`tests/specs/google-site.ts`) |
| `tests/src/`, `tests/extension/` | the test extension's sources, and its manifest and pages |
| `.github/workflows/ci.yml` | CI |

## Keeping this current

A pull request that changes what a record holds, what is removed, the requests made, the pace or the budget, the back-offs, the reasons or the settings updates this README in the same pull request.
