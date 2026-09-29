'use strict';
const assert = require('node:assert/strict');
const api = require('../pixiv-bookmark-analyzer-prototype.user.js');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
const row = (id, tags, accessible = true) => ({ key: `p:${id}`, pid: String(id), rest: id % 2 ? 'show' : 'hide', tags, accessible });

(async () => {
  const records = [row(1, ['A', 'B', 'R-18']), row(2, ['A']), row(3, ['B', 'C']),
    row(4, ['C', '100users入り']), row(5, ['Ignored'], false)];
  const model = api.buildClassificationModel(records);
  const selected = await api.automaticSelection(model);
  const stats = api.selectionStats(model, selected);
  assert.equal(model.records.length, 4); assert.equal(model.ignored, 1);
  assert.equal(stats.covered, 4); assert.equal(stats.coverage, 1);
  assert.ok(!selected.has('R-18') && !selected.has('100users入り') && !selected.has('Ignored'));
  for (const tag of selected) assert.ok(model.tags.get(tag).works.some(work => stats.counts[work] === 1));
  const changed = new Set(selected); changed.delete([...selected][0]);
  const independent = new Set(model.records.filter(record => record.tags.some(tag => changed.has(tag))).map(record => record.pid));
  assert.equal(api.selectionStats(model, changed).covered, independent.size);
  console.log('PASS synthetic coverage, unavailable exclusions, redundant-tag pruning and distinct-PID counts');

  const session = { uid: '123', complete: true, finishedAt: '2026-01-01T00:00:00.000Z' };
  const fingerprint = await api.sourceFingerprint(session, records);
  assert.equal(await api.sourceFingerprint(session, [...records].reverse().map(r => ({ ...r, tags: [...r.tags].reverse() }))), fingerprint);
  assert.notEqual(await api.sourceFingerprint({ ...session, uid: '456' }, records), fingerprint);
  const output = api.buildSelectionExport(session, model, selected, fingerprint);
  assert.equal(output.assignments.length, 4); assert.equal(output.uid, undefined);
  assert.equal(output.remote_write_performed, false); assert.equal(output.existing_bookmark_tags_checked, false);
  assert.ok(output.assignments.every(a => a.tags.length && a.tags.every(tag => selected.has(tag))));
  console.log('PASS stable account-scoped fingerprints and credential-free original-tag exports');

  const gaps = api.buildClassificationModel([row(1, ['R-18']), row(2, ['X100users入り']), row(3, []), row(4, ['A', 'A'])]);
  const gapStats = api.selectionStats(gaps, await api.automaticSelection(gaps));
  assert.equal(gapStats.covered, 1); assert.equal(gapStats.uncovered.length, 3);
  const empty = api.buildClassificationModel([row(1, ['A'], false)]);
  assert.equal(api.selectionStats(empty, await api.automaticSelection(empty)).coverage, null);
  const names = Array.from({ length: 11 }, (_, i) => `T${i}`);
  const limited = api.buildClassificationModel([row(1, names), ...names.map((tag, i) => row(i + 2, [tag]))]);
  const limitedStats = api.selectionStats(limited, await api.automaticSelection(limited));
  assert.equal(limitedStats.maximum, 10); assert.equal(limitedStats.uncovered.length, 1);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(api.automaticSelection(model, { signal: cancel.signal }), { name: 'AbortError' });
  console.log('PASS unmatched and empty universes, duplicate tags, local ten-category limit and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
