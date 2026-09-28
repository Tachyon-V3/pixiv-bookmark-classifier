# Pixiv Bookmark Classifier

English · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

**Find a compact set of categories for your whole readable collection, measure what it covers, and keep using it as your bookmarks grow.**

Pixiv Bookmark Classifier is a standalone Tampermonkey userscript that selects category tags from your collection itself. It aims to cover every readable bookmarked work while removing redundant choices, then checks whether the proposed tags can actually be appended without exceeding each work's available tag slots.

**Version: 0.4.0.** Interface languages: English, Japanese and Simplified Chinese. The default follows the browser's language preferences; a manual selection is remembered.

## What makes this useful

- **Discover the category set from the whole collection.** Start without manually building a tag dictionary. A greedy set-cover calculation selects tags and removes redundant choices. A rare tag can stay when it is needed to cover a few otherwise missed works.
- **See whether the collection is covered.** Preview the distinct-work coverage rate, uncovered PIDs and maximum categories per work. Manual edits update those measurements immediately. The target is that the categories' union covers the readable collection; overlaps are allowed.
- **Check real tag capacity before writing.** The planner caps local assignments at ten per work. Preflight then checks existing tags together with proposed tags against Pixiv's ten-tag limit. Over-capacity works are explicitly skipped; existing tags are retained.
- **Append and verify.** Add new category tags while keeping the original collection, existing tags and visibility. Verify an initial write and read back the finished result, with an exportable per-work journal.
- **Keep the classification useful over time.** Save exact rules and category-name mappings, then append only missing assignments on later updates. Optionally count members of external existing categories as already covered and plan the remaining coverage.

The main distinction is this **whole-collection coverage planning → capacity check → verified append → saved-rule update** workflow. Automatic tagging and saved rules also exist elsewhere. The built-in combination of category-set selection, redundant-tag pruning and explicit uncovered-work inspection is not described in the three related projects reviewed in [the comparison notes](docs/COMPARISON.md).

The algorithm is a heuristic: it neither proves the smallest possible category count nor guarantees 100% coverage for every collection. Existing-tag capacity is checked after selection, so full preview coverage can still include works that cannot receive all proposed tags. Gaps and skipped works stay visible.

## Install or update

Use a desktop browser with Tampermonkey and Web Locks support. The intended environment is a recent desktop Chrome or Edge.

1. Install [Tampermonkey](https://www.tampermonkey.net/) and enable userscript execution and access to `www.pixiv.net` when requested.
2. Download [the installation ZIP](dist/pixiv-bookmark-analyzer-install.zip), then import it in **Tampermonkey → Dashboard → Utilities → ZIP import**. This ZIP contains only the userscript.
3. Existing users: update the existing entry. Keep its stored data. If import is not recognized as an update, replace the entire contents of that entry's editor with [the current userscript](pixiv-bookmark-analyzer-prototype.user.js), then save.
4. Sign in to Pixiv and refresh your own artwork bookmarks page.

The base userscript name remains `Pixiv 收藏参数扫描器 · 只读原型` for update compatibility; localized names may appear in the manager. Version 0.4.0 includes explicit, button-triggered tag appending. No build step is needed to install it.

## First classification

1. Enter your own numeric Pixiv user ID if it is not detected, then select **Start / resume**. Public and private artwork bookmarks are read. Illustrations, manga and ugoira are included; novels are outside the scope.
2. Select **Open classification preview**. Auto-selection proposes a set of original tags; you can adjust it and inspect uncovered works.
3. Optionally enable **Count existing categories as already covered?** This counts their existing members without changing those external categories or guessing what their names mean.
4. Select **Check / refresh bookmarks**. This reads current bookmarks, existing bookmark tags and category names, then prepares the append plan. Review ready and skipped counts and the proposed names.
5. Select **Start adding**. The button displays the number of works to process. The script verifies one initial write before processing the rest, and reads back the final results.

Keep the page open and avoid editing bookmarks in other tabs while a run is in progress. Completion downloads `pixiv-classification-project.json`, containing rules, name mappings and the execution log.

## Update and language controls

- **Update categories** restores the saved rules, reads the current collection and prepares missing assignments. Review the plan and start adding. Works already satisfying the rules need no new writes.
- Adding a rule can add a new category to both old and new matching works. Deselecting a rule stops future assignments; earlier results remain.
- **Interface language**, available in both panels, offers **Browser default**, **简体中文**, **日本語**, and **English**. It updates the current view immediately and preserves unsaved selections.
- Automatic language selection uses the first supported browser preference. Regional Chinese variants use the Simplified Chinese interface. If no preference is supported, English is used.
- Original artwork tags, existing category names, saved mappings, the default `新_` prefix, JSON keys and diagnostic codes stay unchanged across languages.

## Behavior and limits

Categories are Pixiv bookmark tags. A work may belong to multiple categories; coverage counts distinct works, so category counts may add up to more than the collection size.

The script preserves bookmarks, existing tags and visibility. Its only permitted write is adding bookmark tags. Unavailable records are excluded from classification and retained in the main collection. [Pixiv allows up to 10 bookmark tags per illustration](https://www.pixiv.help/hc/ja/articles/235585488). A work exceeding that limit after combining existing and proposed tags is skipped entirely for that run.

Auto-selection uses exact original tags, greedy coverage and redundant-tag pruning. It does not prove a globally minimum category count. Exact `R-18` and numeric `users入り` tags are excluded from auto-selection; they remain manually selectable. Works that do not match a selected rule remain uncovered.

Updates still read the paginated collection to check current state. Only writes are incremental. Network errors, uncertain responses and rate limits pause the run; they do not trigger an automatic retry loop. Use **Check / refresh bookmarks** before resuming.

## Stored data and exports

Settings stay in this userscript's Tampermonkey storage in the same browser profile. Keep the existing entry when updating. **Clear local scan data** also clears rules, mappings and the append journal; it keeps the language preference. It does not delete anything on Pixiv.

Project JSON exports contain artwork IDs, category choices and original bookmark tags, including information about private bookmarks. Keep them private or redact them before opening an issue. They contain no account ID, cookies or CSRF token. Cross-browser JSON import is not implemented.

There are no external runtime dependencies, telemetry or image downloads. Pixiv requests use the signed-in same-origin session; write credentials stay in memory. See [implementation notes](docs/DESIGN.md) for the endpoint allowlist and checks.

## Development and verification

With Node.js 20 or later:

```sh
npm test
```

There are no npm dependencies to install. The included tests use synthetic fixtures and mocked DOM/network/storage. They check language changes, old cache compatibility, coverage, append-only behavior, tag limits, pauses, uncertain results and repeat updates. They do not sign in to or write to Pixiv. They are not a browser rendering test.

The earlier 0.3.0 append flow also completed a user-run Pixiv execution whose exported report passed preservation checks. The 0.4.0 language UI has been checked locally; compatibility with future Pixiv page/API changes is not guaranteed.

To rebuild the installation ZIP using Python 3:

```sh
python3 scripts/package.py
```

See [CHANGELOG](CHANGELOG.md) and [publication instructions](docs/RELEASING.zh-CN.md). A distribution license has not yet been selected.
