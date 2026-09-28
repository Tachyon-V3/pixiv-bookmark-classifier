# Related projects and scope of the comparison

Reviewed on 2026-09-28. This comparison describes the linked projects' published documentation. “Not described” does not establish that a capability is impossible, absent from every version or unavailable in an unreviewed plugin. We have not run these tools against a common benchmark.

## Documented approaches

| Project | Documented focus | Whole-collection category-set selection |
| --- | --- | --- |
| [Label Pixiv Bookmarks](https://github.com/Ziqing19/LabelPixivBookmarks) | Match work tags to an existing tag pool; aliases, first-tag or all-tag options, repeated labeling and bookmark search. | Automatic cover selection and redundant-set pruning are not described. |
| [pixivブックマーク自動分類スクリプト](https://greasyfork.org/en/scripts/551184-pixivブックマーク自動分類スクリプト) | Classify uncategorized works using existing tags or saved custom rules, including AND/OR conditions, partial matching and fallback tags. | Collection-wide cover selection is not described. |
| [Pixiv Bookmark Tag Summary](https://greasyfork.org/en/scripts/516047-pixiv-bookmark-tag-summary) | Tag counts, threshold-based deletion, moving members between tags, renaming and translation. | A cover planner with uncovered-work inspection is not described. |
| Pixiv Bookmark Classifier | Choose original tags across the readable collection, remove redundant choices, inspect coverage and gaps, then check capacity and append with verification. | Implemented as greedy selection followed by reverse pruning, with optional existing-category coverage. |

## The specific distinction

This project makes the **selection of the category set itself** an explicit calculation over the complete readable collection. It then lets the user inspect the resulting coverage before doing any writes. Preservation checks, saved source-to-category mappings and later missing-assignment updates complete that workflow.

The comparison supports a focused positioning statement: **collection-wide coverage planning with visible gaps and verified, persistent classification updates**. It does not support a claim that automatic tagging, saved settings or incremental processing are universally unique to this project.

Our matching currently uses exact original tags. We do not provide the synonym dictionary or AND/OR rule language documented by the related tools. Which tool fits best depends on whether a user wants to discover a covering category set or apply a hand-authored taxonomy.

## What “coverage” means here

Let `U` be all readable bookmarked works, `C(t)` the works containing original tag `t`, and `S` the selected tags. With existing-category coverage disabled, preview coverage is:

```text
|union of C(t) for t in S| / |U|
```

When the existing-category option is enabled, its current members are included in that union. Overlaps count once. Unavailable records are excluded from `U` but remain bookmarked. An empty `U` has no percentage rather than being reported as 100%.

The planner attempts full coverage, caps local matches at ten per work and prunes choices whose removal preserves coverage. This is a heuristic, not a minimum-cover proof. Existing bookmark slots are checked afterwards: a fully covered preview can still contain skipped writes if existing plus proposed tags exceed ten. The execution journal reports actual assignments separately from preview coverage.

## 中文摘要

本项目着重自动决定分类集合、计算全收藏的覆盖率与漏项，再核对容量并执行可验证的追加。比较只限于上述三个项目的公开说明；不能据此声称所有其他插件都做不到。别名词典、AND/OR 自定义条件等能力在相关工具中已有实现，本项目目前使用精确原始标签。

## 日本語の要約

本ツールは分類集合自体を選び、コレクション全体の網羅率と未分類作品を確認してから、タグの空き枠の確認と検証付きの追加を行う点を重視します。比較対象は上記 3 件の公開説明に限られ、すべての他ツールに不可能だと主張するものではありません。本ツールの照合は元タグの完全一致です。
