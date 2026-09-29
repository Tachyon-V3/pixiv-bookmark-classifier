'use strict';
const assert = require('node:assert/strict');
const api = require('../pixiv-bookmark-analyzer-prototype.user.js');
const clone = (x) => JSON.parse(JSON.stringify(x));
const rec = (pid, tags, bookmarkTags = [], rest = 'show', accessible = true) => ({ key: `p:${pid}`, pid: String(pid),
  bookmarkId: String(1000 + pid), tags, bookmarkTags, rest, accessible, reason: accessible ? '' : 'MASKED_OR_UNAVAILABLE', seen: 1 });
const snapshot = (rows) => ({ records: rows, totals: { show: rows.filter(r => r.rest === 'show').length, hide: rows.filter(r => r.rest === 'hide').length },
  tagNames: new Set(rows.flatMap(r => r.bookmarkTags)) });
const session = { uid: '123' };
const token = '0123456789abcdef0123456789abcdef';
function harness(rows) {
  const data = clone(rows), posts = [], saved = [];
  class Backend extends api.AppendAPI {
    async list(uid, rest, signal, tag) {
      assert.equal(uid, '123');
      const found = data.filter(r => r.rest === rest && (!tag || r.bookmarkTags.includes(tag)));
      return { records: clone(found), total: found.length };
    }
    async request(path, signal, payload, authToken) {
      assert.equal(path, '/ajax/illusts/bookmarks/add_tags'); assert.equal(authToken, token);
      assert.deepEqual(Object.keys(payload).sort(), ['bookmarkIds', 'tags']);
      assert.equal(payload.tags.length, 1); assert.ok(payload.bookmarkIds.length <= 50);
      posts.push(clone(payload));
      for (const id of payload.bookmarkIds) {
        const row = data.find(r => r.bookmarkId === id); assert.ok(row);
        row.bookmarkTags = [...new Set([...row.bookmarkTags, ...payload.tags])];
        assert.ok(row.bookmarkTags.length <= 10);
      }
      if (this.uncertain) { this.uncertain = false; throw new api.ScanError('REQUEST_UNCERTAIN', 'simulated lost response'); }
      if (this.damage) data.find(r => r.bookmarkId === payload.bookmarkIds[0]).bookmarkTags = [...payload.tags];
      return [];
    }
  }
  const backend = new Backend();
  const hooks = (job, overrides = {}) => ({ signal: new AbortController().signal, stopped: () => false,
    auth: async () => ({uid:'123',token}), save: async () => saved.push(clone(job)), progress: () => {},
    categoryDone: async () => {}, ...overrides });
  return { data, posts, saved, backend, hooks };
}
(async () => {
  const names = api.newCategoryNames(['A', 'A B', 'A_B', '😀'.repeat(20)], new Set(['新_A']), '新_');
  assert.equal(names[0].target, '新_A_2'); assert.equal(new Set(names.map(m => m.target)).size, 4);
  assert.ok(names.every(m => m.target.length <= 20 && !/\s/u.test(m.target)));
  const normalizedNames=api.newCategoryNames(['Ａ','a'],new Set(['新_A']));
  assert.deepEqual(normalizedNames.map(m=>m.target),['新_Ａ_2','新_a_3']);
  assert.throws(() => api.newCategoryNames(['A'], new Set(), ''), /前缀/);
  assert.throws(() => api.remotePage({works:[],total:0}, 'show'), /已有收藏标签/);
  const untagged = api.remotePage({works:[{id:'1',tags:['A'],bookmarkData:{id:'1001'}}],total:1,bookmarkTags:{}}, 'show');
  assert.deepEqual(untagged[0].bookmarkTags, []);
  console.log('PASS new category names never collide, stay within naming bound; missing tag map is not treated as empty');

  const rows = [rec(1,['A','B'],['旧收藏'], 'show'),rec(2,['A'],[], 'hide'),
    rec(3,['A','B'],Array.from({length:9},(_,i)=>`旧${i}`)), rec(4,[],['手动合集']),rec(5,['B'],[], 'show',false)];
  const model = api.buildClassificationModel(rows), selected = new Set(['A','B']);
  const job = api.makeAppendJob(session, model, selected, 'hash', snapshot(rows), '新_');
  assert.equal(job.rows.length,4); assert.equal(job.ignored,1);
  assert.equal(job.rows.find(r=>r.pid==='3').reason,'NO_FREE_SLOTS');
  assert.equal(job.rows.find(r=>r.pid==='4').reason,'NO_SELECTED_CATEGORY');
  const h = harness(rows);
  await api.executeAppendJob(job,h.backend,h.hooks(job));
  assert.equal(h.posts[0].bookmarkIds.length,1, 'first request is read-back-verified pilot');
  assert.ok(h.saved[0].inflight && h.saved[0].hasRequests);
  assert.deepEqual(h.data.find(r=>r.pid==='1').bookmarkTags.sort(),['旧收藏','新_A','新_B'].sort());
  assert.equal(h.data.find(r=>r.pid==='2').rest,'hide');
  assert.deepEqual(h.data.find(r=>r.pid==='3').bookmarkTags,rows[2].bookmarkTags);
  assert.deepEqual(h.data.find(r=>r.pid==='5'),rows[4]);
  api.reconcileAppendJob(job,snapshot(h.data));
  assert.equal(api.appendSummary(job).ready,0);
  assert.equal(api.preservationCheck(job,snapshot(h.data)).passed,true);
  assert.equal(h.data.length,rows.length);
  const report = api.appendReport(job);
  assert.equal(report.uid,undefined); assert.equal(JSON.stringify(report).includes(token),false);
  console.log('PASS only adds new categories; total collection, old labels, private state and ignored works are preserved');

  const project = { mapping: clone(job.mapping), selected:[...selected], seenPids:model.records.map(r=>r.pid) };
  const repeated = api.makeAppendJob(session,api.buildClassificationModel(h.data),selected,'hash2',snapshot(h.data),'新_',project);
  api.reconcileAppendJob(repeated,snapshot(h.data));
  assert.equal(api.appendSummary(repeated).ready,0); assert.equal(repeated.newWorks,0);
  const oldPostCount=h.posts.length;
  await api.executeAppendJob(repeated,h.backend,h.hooks(repeated));
  assert.equal(h.posts.length,oldPostCount);
  h.data.push(rec(6,['A']),rec(7,['C']));
  const updated=api.makeAppendJob(session,api.buildClassificationModel(h.data),selected,'hash3',snapshot(h.data),'新_',project);
  assert.equal(updated.newWorks,2); assert.equal(updated.mapping.find(m=>m.source==='A').target,'新_A');
  api.reconcileAppendJob(updated,snapshot(h.data));
  assert.equal(api.appendSummary(updated).ready,1);
  await api.executeAppendJob(updated,h.backend,h.hooks(updated));
  assert.ok(h.data.find(r=>r.pid==='6').bookmarkTags.includes('新_A'));
  assert.deepEqual(h.data.find(r=>r.pid==='7').bookmarkTags,[]);
  const expanded = api.makeAppendJob(session,api.buildClassificationModel(h.data),new Set(['A','B','C']),'hash4',snapshot(h.data),'新_',project);
  assert.equal(expanded.mapping.find(m=>m.source==='A').target,'新_A');
  assert.equal(expanded.mapping.find(m=>m.source==='C').target,'新_C');
  await api.executeAppendJob(expanded,h.backend,h.hooks(expanded));
  assert.ok(h.data.find(r=>r.pid==='7').bookmarkTags.includes('新_C'));
  console.log('PASS repeated updates send no duplicate writes; new works reuse existing category IDs/names, new rules add only new mappings');

  const oldGroups = api.buildClassificationModel([rec(10,['A'],['手工']),rec(11,['B'])]);
  oldGroups.existingCovered.add(0);
  const additional = await api.automaticSelection(oldGroups);
  assert.deepEqual([...additional],['B']); assert.equal(api.selectionStats(oldGroups,additional).coverage,1);
  const oldJob=api.makeAppendJob(session,oldGroups,additional,'old',snapshot(oldGroups.records),'新_');
  assert.equal(oldJob.rows[0].reason,'EXISTING_CATEGORY');
  const oldHarness=harness(oldGroups.records);
  await api.executeAppendJob(oldJob,oldHarness.backend,oldHarness.hooks(oldJob));
  assert.deepEqual(oldHarness.data[0].bookmarkTags,['手工']);
  console.log('PASS opting into pre-existing sets counts their members as covered without changing those old collections');

  const uncertainRows=[rec(20,['A'],['Keep']),rec(21,['A'])], u=harness(uncertainRows);
  const uncertainJob=api.makeAppendJob(session,api.buildClassificationModel(uncertainRows),new Set(['A']),'u',snapshot(uncertainRows),'新_');
  u.backend.uncertain=true;
  await assert.rejects(api.executeAppendJob(uncertainJob,u.backend,u.hooks(uncertainJob)),/lost response/);
  assert.equal(u.posts.length,1); assert.ok(uncertainJob.inflight);
  api.reconcileAppendJob(uncertainJob,snapshot(u.data));
  await api.executeAppendJob(uncertainJob,u.backend,u.hooks(uncertainJob));
  assert.equal(u.posts.filter(p=>p.bookmarkIds.includes('1020')).length,1,'uncertain but applied write is not resent');
  assert.equal(api.preservationCheck(uncertainJob,snapshot(u.data)).passed,true);
  const damaged=harness(uncertainRows), damageJob=api.makeAppendJob(session,api.buildClassificationModel(uncertainRows),new Set(['A']),'d',snapshot(uncertainRows),'新_');
  damaged.backend.damage=true;
  await assert.rejects(api.executeAppendJob(damageJob,damaged.backend,damaged.hooks(damageJob)),/回读未通过/);
  assert.equal(damaged.posts.length,1,'pilot catches unexpected overwrite before continuing');
  const noStore=harness(uncertainRows), noStoreJob=api.makeAppendJob(session,api.buildClassificationModel(uncertainRows),new Set(['A']),'s',snapshot(uncertainRows),'新_');
  await assert.rejects(api.executeAppendJob(noStoreJob,noStore.backend,noStore.hooks(noStoreJob,{save:async()=>{throw Error('disk failed');}})),/disk failed/);
  assert.equal(noStore.posts.length,0);
  console.log('PASS uncertain response pauses, reconcile avoids duplicate retry, pilot detects destructive behavior, and storage failure blocks writes');

  const originalFetch=globalThis.fetch, originalLocation=globalThis.location;
  globalThis.location={origin:'https://www.pixiv.net'};
  const requests=[];
  globalThis.fetch=async (url,options)=>{requests.push({url,options});return {ok:false,status:429,headers:new Headers({'Retry-After':'60'})};};
  const liveAPI=new api.AppendAPI(), signal=new AbortController().signal;
  for(const path of ['/ajax/illusts/bookmarks/add','/ajax/illusts/bookmarks/remove','/ajax/illusts/bookmarks/remove_tags','/ajax/illusts/bookmarks/edit_restrict','https://example.com/ajax/illusts/bookmarks/add_tags'])
    await assert.rejects(liveAPI.request(path,signal,{tags:['新_A'],bookmarkIds:['1001']},token),/白名单/);
  await assert.rejects(liveAPI.request('/ajax/illusts/bookmarks/add_tags',signal,{tags:['新_A'],bookmarkIds:['1001'],restrict:0},token),/追加参数/);
  assert.equal(requests.length,0);
  await assert.rejects(liveAPI.request('/ajax/illusts/bookmarks/add_tags',signal,{tags:['新_A'],bookmarkIds:['1001']},token),/429/);
  assert.equal(requests.length,1); assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.headers['X-CSRF-TOKEN'],token); assert.ok(liveAPI.blockedUntil>Date.now());
  await assert.rejects(liveAPI.request('/ajax/illusts/bookmarks/add_tags',signal,{tags:['新_A'],bookmarkIds:['1001']},token),/尚未到/);
  assert.equal(requests.length,1);
  globalThis.fetch=originalFetch; globalThis.location=originalLocation;
  console.log('PASS network allowlist permits only add_tags mutations; no replace/delete/privacy calls and no automatic 429 retry');
  console.log('6 append validation cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
