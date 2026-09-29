'use strict';
const assert=require('node:assert/strict');
const {browser,store,waitFor}=require('./test-flow.cjs');
const core=require('../pixiv-bookmark-analyzer-prototype.user.js');
const cacheKey='pba:prototype:checkpoint:v1', projectKey='pba:prototype:classification-project:v1';
const rows=[
 {id:'1',tags:['A','B'],old:['Keep','新_A'],rest:'show'},
 {id:'2',tags:['A'],old:[],rest:'hide'},
 {id:'3',tags:['B'],old:Array.from({length:10},(_,i)=>`Full${i}`),rest:'show'},
 {id:'4',tags:['C'],old:[],rest:'show'},
 {id:'5',tags:[],old:['Unavailable-old'],rest:'show',isMasked:true},
];
const posts=[];let reads=0;
const work=r=>({id:r.id,tags:r.tags,bookmarkData:{id:String(Number(r.id)+1000),private:r.rest==='hide'},isMasked:r.isMasked||false});
function body(rest,tag='',offset=0,limit=100){
 const all=rows.filter(r=>r.rest===rest&&(!tag||r.old.includes(tag))),page=all.slice(offset,offset+limit);
 return {works:page.map(work),total:all.length,bookmarkTags:Object.fromEntries(page.map(r=>[String(Number(r.id)+1000),[...r.old]]))};
}
const fetcher=async(url,options)=>{
 const u=new URL(url);
 assert.equal(u.origin,'https://www.pixiv.net');
 if(options.method==='POST'){
  assert.equal(u.pathname,'/ajax/illusts/bookmarks/add_tags');
  const payload=JSON.parse(options.body);posts.push(payload);
  assert.deepEqual(Object.keys(payload).sort(),['bookmarkIds','tags']);
  for(const id of payload.bookmarkIds){
   const row=rows.find(r=>String(Number(r.id)+1000)===id);assert.ok(row);
   const next=[...new Set([...row.old,...payload.tags])];assert.ok(next.length<=10);row.old=next;
  }
  return {ok:true,json:async()=>({error:false,body:[]})};
 }
 assert.equal(options.method,'GET');
 reads+=1;
 if(u.pathname.endsWith('/bookmark/tags')){
  const tags=rest=>[...new Set(rows.filter(r=>r.rest===rest).flatMap(r=>r.old))].map(tag=>({tag,cnt:1}));
  return {ok:true,json:async()=>({error:false,body:{public:tags('show'),private:tags('hide')}})};
 }
 assert.ok(u.pathname.endsWith('/illusts/bookmarks'));
 return {ok:true,json:async()=>({error:false,body:body(u.searchParams.get('rest'),u.searchParams.get('tag'),Number(u.searchParams.get('offset')),Number(u.searchParams.get('limit')))})};
};
const prepare=async page=>{
 page.$('append-prepare').onclick();
 await waitFor(()=>page.$('append-status').textContent.includes('核对完成')&&!page.$('append-prepare').disabled,'preparation');
};
const run=async page=>{
 assert.equal(page.$('append-start').disabled,false);page.$('append-start').onclick();
 await waitFor(()=>page.$('append-status').textContent.includes('追加完成并回读核对')&&!page.$('append-prepare').disabled,'append and verify');
};
(async()=>{
 store.clear();const original=JSON.parse(JSON.stringify(rows)),s=core.newSession('123',100),index=new Map();
 core.ingestPage(s,index,'show',body('show'));core.ingestPage(s,index,'hide',body('hide'));core.finalizeSession(s,index);
 s.savedAt=new Date().toISOString();s.records=[...index.values()];store.set(cacheKey,JSON.stringify(s));
 const page=browser(fetcher);
 await waitFor(()=>!page.$('classify').disabled,'boot');page.$('classify').onclick();
 await waitFor(()=>page.$('plan-status').textContent.includes('自动完成')&&!page.$('plan-auto').disabled,'automatic selection');
 await prepare(page);
 assert.equal(posts.length,0,'Preparation is read-only');
 assert.match(page.$('append-status').textContent,/可追加 3 件/);
 assert.equal(JSON.parse(store.get(projectKey)).mapping.find(m=>m.source==='A').target,'新_A_2');
 const savedBeforeSwitch=[...store.entries()],readBeforeSwitch=reads;
 for(const [locale,notice] of [['en','Check complete'],['ja','確認完了'],['zh','核对完成']]){
  page.$('plan-language').value=locale;page.$('plan-language').onchange();
  await waitFor(()=>!page.$('plan-language').disabled,'language switch after preflight');
  assert.equal(page.$('append-start').disabled,false,'Changing language retains the checked append preview');
  assert.ok(page.$('append-status').textContent.includes(notice));
 }
 assert.equal(reads,readBeforeSwitch);assert.equal(posts.length,0);
 for(const[key,value]of savedBeforeSwitch)assert.equal(store.get(key),value);
 await run(page);
 page.$('plan-language').value='ja';page.$('plan-language').onchange();
 await waitFor(()=>!page.$('plan-language').disabled,'translate completion');
 assert.match(page.$('append-status').textContent,/追加と再読み取り確認が完了/);
 assert.match(page.$('append-list').children.at(-1).textContent,/合計が 10 個を超過/);
 page.$('plan-language').value='zh';page.$('plan-language').onchange();await waitFor(()=>!page.$('plan-language').disabled,'restore Chinese');
 assert.equal(rows.length,original.length);
 for(const row of original){const live=rows.find(r=>r.id===row.id);assert.equal(live.rest,row.rest);assert.ok(row.old.every(t=>live.old.includes(t)));}
 assert.deepEqual(rows.find(r=>r.id==='3').old,original.find(r=>r.id==='3').old);
 assert.deepEqual(rows.find(r=>r.id==='5').old,original.find(r=>r.id==='5').old);
 assert.equal([...store.values()].some(v=>v.includes('0123456789abcdef0123456789abcdef')),false);
 assert.ok(page.downloaded.length>=2,'Before and after manifests available');
 console.log('PASS live UI simulation: preflight reads only; pilot and full append preserve total, old collections, private state, exclusions and credential privacy');

 const count=posts.length,again=browser(fetcher);
 await waitFor(()=>!again.$('update-classification').disabled,'project restore');
 again.$('update-classification').onclick();
 await waitFor(()=>again.$('append-status').textContent.includes('本次没有待追加内容')&&!again.$('append-prepare').disabled,'idempotent update');
 assert.equal(posts.length,count);assert.equal(again.$('append-start').disabled,true);
 rows.push({id:'6',tags:['A'],old:[],rest:'show'},{id:'7',tags:['D'],old:[],rest:'hide'});
 await prepare(again);assert.match(again.$('append-status').textContent,/可追加 1 件/);
 await run(again);
 assert.deepEqual(rows.find(r=>r.id==='6').old,['新_A_2']);assert.deepEqual(rows.find(r=>r.id==='7').old,[]);
 assert.equal(posts.slice(count).some(p=>p.bookmarkIds.some(id=>id!=='1006')),false);
 console.log('PASS UI reload restores parameters; unchanged updates do not write; new works reuse the same categories and unmatched works remain visible');

 again.$('plan-filter').value='all';again.$('plan-filter').onchange();
 again.$('plan-search').value='D';again.$('plan-search').oninput();
 const row=again.$('plan-tags').children.find(r=>r.children[0]?.children[1]?.textContent==='D');assert.ok(row);
 row.children[0].children[0].checked=true;row.children[0].children[0].onchange();
 again.$('plan-save').onclick();await waitFor(()=>again.$('plan-save-state').textContent==='本地方案已保存'&&!again.$('plan-auto').disabled,'rule save');
 await prepare(again);await run(again);
 assert.deepEqual(rows.find(r=>r.id==='7').old,['新_D']);
 const project=JSON.parse(store.get(projectKey));assert.equal(project.mapping.find(m=>m.source==='A').target,'新_A_2');assert.ok(project.selected.includes('D'));
 again.$('include-existing').checked=true;again.$('include-existing').onchange();
 again.$('plan-auto').onclick();await waitFor(()=>again.$('plan-status').textContent.includes('自动完成')&&!again.$('plan-auto').disabled,'existing-set recompute');
 assert.equal(again.$('plan-missing').textContent,'0');
 await prepare(again);
 assert.equal(JSON.parse(store.get(projectKey)).includeExisting,true);
 assert.equal(again.$('append-start').disabled,true);
 console.log('PASS saved rule edits add new mappings while keeping old results; opt-in existing sets cover old members without modifying their folders');
 console.log('3 append UI validation cases passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
