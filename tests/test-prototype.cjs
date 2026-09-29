'use strict';
const assert = require('node:assert/strict');
const p = require('../pixiv-bookmark-analyzer-prototype.user.js');
const work = (id, tags, extra = {}) => ({ id: String(id), tags, ...extra });
let passed = 0;
function test(name, callback) { callback(); passed++; console.log(`PASS ${name}`); }

test('deduplicates artwork tags; preserves exact originals; ignores bookmark tags', () => {
  const r = p.normalizeWork(work(1, ['A', 'A', 'a', ' Ａ ', { tag: 'B' }], { bookmarkTags: ['WRONG'] }), 'show', 0, 1);
  assert.deepEqual(r.tags, ['A', 'a', ' Ａ ', 'B']);
  assert.equal(r.accessible, true);
});
test('masked works with absent PIDs keep distinct bookmark identities', () => {
  const a = p.normalizeWork({ id: '0', isMasked: true, bookmarkData: { id: '201' } }, 'show', 0, 1);
  const b = p.normalizeWork({ id: '0', isMasked: true, bookmarkData: { id: '202' } }, 'show', 1, 1);
  assert.notEqual(a.key, b.key); assert.equal(a.accessible, false); assert.equal(a.pid, null);
  assert.equal(a.reason, 'MASKED_OR_UNAVAILABLE');
});
test('unknown tags are exceptions, empty tags are valid zero-membership works', () => {
  assert.equal(p.normalizeWork(work(1, []), 'show', 0, 1).accessible, true);
  assert.equal(p.normalizeWork(work(1, undefined), 'show', 0, 1).reason, 'TAGS_UNAVAILABLE');
  assert.equal(p.normalizeWork(work(1, [42]), 'show', 0, 1).reason, 'MALFORMED_TAGS');
});
test('bad page envelope and total stop scanning', () => {
  for (const data of [null, {}, { error: true }, { error: false, body: { works: [], total: '1' } }])
    assert.throws(() => p.validatePage(data), p.ScanError);
});
test('server-clamped short page advances actual offset without declaring completion', () => {
  const s = p.newSession('123', 100), index = new Map();
  p.ingestPage(s, index, 'show', { works: [work(1, ['A']), work(2, ['B'])], total: 3 });
  assert.equal(s.scopes.show.offset, 2); assert.equal(s.scopes.show.done, false);
  p.ingestPage(s, index, 'show', { works: [work(3, ['C'])], total: 3 });
  assert.equal(s.scopes.show.offset, 3); assert.equal(s.scopes.show.done, true);
  p.ingestPage(s, index, 'hide', { works: [], total: 0 }); p.finalizeSession(s, index);
  assert.equal(s.complete, true); assert.equal(s.notices.length, 0);
});
test('early empty and repeated pages stop instead of producing false completion', () => {
  const s = p.newSession('123', 100), index = new Map();
  assert.throws(() => p.ingestPage(s, index, 'show', { works: [], total: 5 }), /提前收到空页/);
  p.ingestPage(s, index, 'show', { works: [work(1, ['A'])], total: 5 });
  assert.throws(() => p.ingestPage(s, index, 'show', { works: [work(1, ['A'])], total: 5 }), /全部重复/);
  assert.equal(s.scopes.show.offset, 1); assert.equal(s.complete, false);
});
test('reload reenumeration excludes stale records and removes absent PIDs only at completion', () => {
  const s = p.newSession('123', 100), index = new Map();
  p.ingestPage(s, index, 'show', { works: [work(1, ['old']), work(2, ['stale'])], total: 2 });
  p.restartEnumeration(s);
  p.ingestPage(s, index, 'show', { works: [work(1, ['new']), work(3, ['new'])], total: 2 });
  assert.equal(index.size, 3); assert.equal(p.activeRecords(s, index).length, 2);
  p.ingestPage(s, index, 'hide', { works: [], total: 0 }); p.finalizeSession(s, index);
  assert.equal(index.size, 2); assert.equal(index.has('p:2'), false);
  assert.deepEqual(index.get('p:1').tags, ['new']);
});
test('count, support denominators, intersections, containment, Jaccard and triples', () => {
  const rows = [work(1, ['A', 'B', 'C']), work(2, ['A', 'B']), work(3, ['A']), work(4, []),
    work(5, [], { isMasked: true })].map((w, i) => p.normalizeWork(w, i === 1 ? 'hide' : 'show', i, 1));
  const d = p.analyze(rows);
  assert.equal(d.readable, 4); assert.equal(d.failures.length, 1); assert.equal(d.emptyTagWorks, 1);
  assert.equal(d.memberships, 6); assert.deepEqual(d.ranked.map((r) => r.count), [3, 2, 1]);
  assert.deepEqual(d.pairRows[0], { a: 'A', b: 'B', intersection: 2, union: 3,
    aContainment: 2 / 3, bContainment: 1, jaccard: 2 / 3 });
  assert.equal(d.tripleRows[0].intersection, 1);
  const report = p.buildReport(p.newSession('123', 100), rows);
  assert.match(report, /"A"\t3\t0.60000000\t0.75000000\t3\t0|"A"\t3\t0.60000000\t0.75000000\t2\t1/);
});
test('interpolated quantiles, modes, unscaled MAD and empty distributions', () => {
  const d = p.distribution([1, 1, 2, 4]);
  assert.equal(d.median, 1.5); assert.equal(d.p25, 1); assert.equal(d.p75, 2.5); assert.equal(d.mad, .5);
  assert.deepEqual(d.modes, [1]); assert.equal(d.modeFrequency, 2);
  assert.equal(p.distribution([]).median, null);
  assert.deepEqual(p.distribution([1, 2]).modes, [1, 2]);
});
test('pattern annotations do not remove any tags; anonymous report omits identities', () => {
  const rows = [work(1234567, ['PrivateTag', '作品１０００users入り']), work(9876543, [], { isMasked: true })]
    .map((w, i) => p.normalizeWork(w, 'hide', i, 1));
  const d = p.analyze(rows); assert.equal(d.ranked.length, 2); assert.equal(d.patternMemberships, 1);
  const report = p.buildReport(p.newSession('87654321', 100), rows, true);
  for (const privateValue of ['PrivateTag', '作品１０００users入り', '1234567', '9876543', '87654321'])
    assert.equal(report.includes(privateValue), false, privateValue);
  assert.match(report, /TAG_000001/); assert.match(report, /EXCEPTION_000001/);
});
test('tag count output is complete while pair and triple output remain bounded', () => {
  const rows = Array.from({ length: 105 }, (_, i) => p.normalizeWork(work(i + 1, [`T${i}`]), 'show', i, 1));
  const d = p.analyze(rows);
  assert.equal(d.ranked.length, 105); assert.equal(d.pairRows.length, 3160); assert.equal(d.tripleRows.length, 220);
  assert.equal(d.pairRows.every((r) => r.intersection === 0), true);
});
test('Retry-After seconds and HTTP dates', () => {
  assert.equal(p.parseRetryAfter('30', 1000), 31000);
  assert.equal(p.parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 1000), 60000);
  assert.equal(p.parseRetryAfter('nonsense', 1000), 0);
});

(async () => {
  global.location = { origin: 'https://www.pixiv.net' };
  const starts = [], methods = [];
  let active = 0, maxActive = 0;
  global.fetch = async (url, options) => {
    const parsed = new URL(url); assert.match(parsed.pathname, /^\/ajax\/user\/123\/illusts\/bookmarks$/);
    starts.push(performance.now()); methods.push(options.method); active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10)); active--;
    return { ok: true, json: async () => ({ error: false, body: { works: [], total: 0 } }) };
  };
  const api = new p.ReadOnlyAPI(), s = p.newSession('123', 100), abort = new AbortController();
  await api.page(s, 'show', abort.signal); await api.page(s, 'hide', abort.signal);
  assert.ok(starts[1] - starts[0] >= 99, `spacing ${starts[1] - starts[0]}`);
  assert.deepEqual(methods, ['GET', 'GET']); assert.equal(maxActive, 1); passed++;
  console.log('PASS GET-only sequential scheduler and minimum start spacing');
  global.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) });
  const start = Date.now();
  await assert.rejects(api.page(s, 'show', abort.signal), (err) => err.code === 'HTTP_429' && err.blockedUntil >= start + 2000);
  passed++; console.log('PASS 429 pauses with Retry-After, no automatic retry');
  abort.abort(); const before = s.requestCount;
  await assert.rejects(api.page(s, 'show', abort.signal), (err) => err.name === 'AbortError');
  assert.equal(s.requestCount, before); passed++;
  console.log('PASS pause abort sends no extra request');
  console.log(`${passed} validation cases passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
