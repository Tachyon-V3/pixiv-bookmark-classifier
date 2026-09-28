# Implementation notes

The userscript is one dependency-free IIFE. Pure helpers are exported through CommonJS only when there is no browser `document`, allowing Node tests to exercise the same implementation. No bundled package or build tool is required at runtime.

## Scope and matching

The readable artwork records are the classification universe. Unavailable records remain in the checkpoint but are not classification targets. Tag strings are matched exactly; original data is never translated, normalized for matching, or merged by semantic similarity. NFKC normalization is used only for the numeric `users入り` exclusion pattern and collision checking of newly generated names.

Auto-selection greedily adds coverage within a local ten-category limit, then removes redundant selections. This is a feasible-cover heuristic, not a global optimum solver. Existing bookmark slots are checked separately before append. A work whose existing and proposed tags exceed ten is skipped entirely.

Generated names retain a stable source-to-target mapping. The `新_` prefix is intentionally language-independent. Names are limited conservatively to 20 UTF-16 code units without splitting surrogate pairs; that bound is a script setting, not a claim about an officially documented naming limit. Whitespace is replaced, and collisions receive suffixes. Deselected rules retain their old mappings and remote results.

## Network and verification

Same-origin reads are limited to:

- `/ajax/user/{uid}/illusts/bookmarks`
- `/ajax/user/{uid}/illusts/bookmark/tags`
- `/bookmark_add.php?type=illust&illust_id={pid}` as an optional account/CSRF metadata fallback; returned HTML is parsed inertly.

The only allowed mutation is `POST /ajax/illusts/bookmarks/add_tags` with exactly `{tags: [oneName], bookmarkIds: [...]}`. The payload has no privacy, comment, removal or bookmark-creation fields. Write batches contain up to 50 IDs; the pilot contains one. Requests are serial, with start gaps of at least 100 ms for reads and 500 ms for writes. These are script settings, not a server-approved rate guarantee.

The script saves intent before sending a write. Uncertain responses pause the job. Resuming reads actual state before calculating missing assignments. A final read compares original IDs, bookmark IDs, visibility, existing tags and totals. The code neither deletes nor rolls back remote data to fix a discrepancy.

Web Locks and stored-version comparisons protect against conflicting tabs. Concurrent edits outside the script can still stop a run. Pixiv's live offset pagination is not an atomic snapshot.

## Language layer

`TRANSLATIONS` maps Chinese source messages to English and Japanese. `t()` creates a deferred message with captured parameters; rendering uses the currently selected language. This lets old progress and error notices change language without reverse-translating rendered text or touching artwork data. Error codes and machine exports remain stable.

Static text and accessibility attributes use `data-i18n` bindings. Dynamic artwork and category names use `textContent`. Language changes repaint existing controls and calculated views without re-running coverage, invalidating a checked append preview or making network requests.

`pba:prototype:language:v1` holds `auto`, `zh`, `ja` or `en`. The automatic mode scans `navigator.languages` in order, falling back to `navigator.language` when needed and to English when no supported preference exists. Language choice is separate from scan/project/journal storage and survives clearing those records. A failed preference save leaves the previous language selected.

## Data and tests

The established checkpoint, selection, project and append-job keys and schemas remain unchanged. Exports use explicit fields; account IDs and credentials are not exported. Exported PIDs and category memberships can still reveal private collection information.

The published suite uses only synthetic data. DOM tests model text, attributes, controls and events; they do not validate browser layout or Tampermonkey's execution environment. The private source collection and real execution reports are not part of the repository.

## Protocol references

- [Pixiv bookmark tags and the ten-tag limit](https://www.pixiv.help/hc/ja/articles/235585488)
- [Pixiv bulk bookmark-tag operations](https://www.pixiv.help/hc/ja/articles/235585448)
- [Label Pixiv Bookmarks source](https://greasyfork.org/en/scripts/423823-pixiv%E6%94%B6%E8%97%8F%E5%A4%B9%E8%87%AA%E5%8A%A8%E6%A0%87%E7%AD%BE/code)
- [Pixiv Bookmark Tag Summary source](https://greasyfork.org/en/scripts/516047-pixiv-bookmark-tag-summary/code)
- [Tampermonkey documentation](https://www.tampermonkey.net/documentation.php)

These projects were consulted for internal endpoint and page-metadata behavior. The implementation here is independently written. Internal endpoints are not an official stable API contract.
