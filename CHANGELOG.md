# Changelog

## 0.4.0 — 2026-09-29

- Added English and Japanese interfaces alongside the existing Simplified Chinese interface.
- Follow browser language preferences by default; remember manual overrides independently of classification data.
- Change language in either panel without reloading, rescanning, changing tags or losing unsaved selections.
- Translate buttons, progress, errors, confirmations, filters, accessibility labels and skip reasons. Existing notices also update when the language changes.
- Keep the original userscript identity, storage keys, original tags, category mappings, append behavior and export schemas compatible with earlier versions.
- Add public documentation in three languages and a self-contained, synthetic-data test suite.

## 0.3.0 — 2026-09-28

- Append new bookmark tags after checking current tags and available slots.
- Preserve original bookmarks, tags and visibility; verify an initial write and the completed run.
- Persist rules, category mappings and execution records; update new and existing matching works without duplicate assignments.
- Optionally count members of existing external categories as already covered.

## 0.2.0 — 2026-09-28

- Add local classification preview, automatic coverage, manual selection, undo and plan export.

## 0.1.x — 2026-09-28

- Scan public and private artwork bookmarks, save progress and export statistics and raw original tags.
