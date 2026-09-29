'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../pixiv-bookmark-analyzer-prototype.user.js'), 'utf8');
const store = new Map();
const work = (n, tags) => ({ id: String(n), tags });
const data = {
  show: [work(1, ['A', 'B']), work(2, ['A']), work(3, ['B']), work(4, ['C']), work(5, [])],
  hide: [work(6, ['A', 'C']), { id: '0', isMasked: true, bookmarkData: { id: '900' } }, work(7, ['C'])],
};

function browser(fetcher, options = {}) {
  let root; const downloaded = [], blobs = new Map(), events = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; this.children = []; this.attributes = {}; }
    set textContent(text) { this.text = String(text); }
    get textContent() { return this.text; }
    attachShadow() { root = new Element('shadow'); root.items = new Map(); return root; }
    set innerHTML(html) {
      this.all = [];
      for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>([^<]*)/g)) {
        const node = new Element(match[1]);
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2].replaceAll('&quot;', '"'));
        node.textContent = match[3]; node.hidden = /\bhidden\b/.test(match[2]); node.disabled = /\bdisabled\b/.test(match[2]);
        this.all.push(node);
        if (node.attributes.id) this.items.set(node.attributes.id, node);
      }
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelectorAll(selector) { const name = selector.slice(1, -1); return (this.all || []).filter(node => name in node.attributes); }
    getElementById(id) { if (!this.items.has(id)) throw new Error(`Missing DOM element ${id}`); return this.items.get(id); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() {} focus() {} addEventListener() {}
    click() { if (this.tag === 'a') downloaded.push({ filename: this.download, blob: blobs.get(this.href) }); }
  }
  class FakeURL extends URL {
    static createObjectURL(blob) { const key = `blob:mock-${blobs.size}`; blobs.set(key, blob); return key; }
    static revokeObjectURL() {}
  }
  const navigator = { languages: options.languages || ['zh-CN'], language: options.languages?.[0] || 'zh-CN', locks: { request: async (name, settings, action) => action({ name }) } };
  const context = vm.createContext({
    document: { getElementById: () => null, createElement: (tag) => new Element(tag),
      documentElement: new Element('html'), querySelector: () => ({ content: '{"userData":{"id":"123"},"token":"0123456789abcdef0123456789abcdef"}' }) },
    navigator,
    location: { origin: 'https://www.pixiv.net' },
    GM: { getValue: async (key, fallback) => store.has(key) ? store.get(key) : fallback,
      setValue: options.setValue || (async (key, value) => store.set(key, value)), deleteValue: async (key) => store.delete(key) },
    URL: FakeURL, URLSearchParams, TextEncoder, Blob, AbortController, DOMException, Headers, performance, crypto: require('node:crypto').webcrypto,
    fetch: fetcher, clearTimeout,
    setTimeout: (cb, ms) => { const timer = setTimeout(cb, ms); if (ms === 60000) timer.unref(); return timer; },
    confirm: (text) => { options.confirmed?.push(String(text)); return true; },
    addEventListener: (name, handler) => events.set(name, handler),
  });
  vm.runInContext(source, context);
  return { $: (id) => root.getElementById(id), downloaded, root, navigator, events };
}
async function waitFor(predicate, description) {
  const deadline = Date.now() + 20000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timeout: ${description}`); await new Promise((r) => setTimeout(r, 5)); }
}
let failedOnce = false; const requests = [];
const fetcher = async (url, options) => {
  const u = new URL(url); const rest = u.searchParams.get('rest'), offset = Number(u.searchParams.get('offset'));
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
  requests.push({ rest, offset });
  if (rest === 'hide' && !failedOnce) { failedOnce = true; throw new TypeError('simulated outage'); }
  return { ok: true, json: async () => ({ error: false, body: { works: data[rest].slice(offset, offset + 2), total: data[rest].length } }) };
};
module.exports = { browser, store, waitFor };
if (require.main === module) (async () => {
  const first = browser(fetcher);
  await waitFor(() => !first.$('start').disabled, 'initial load');
  assert.equal(first.$('uid').value, '123'); first.$('start').onclick();
  await waitFor(() => first.$('status').textContent.includes('网络请求失败') && !first.$('start').disabled, 'automatic pause');
  assert.equal(requests.length, 4); assert.match(first.$('progress').textContent, /去重记录 5/);
  first.$('start').onclick();
  await waitFor(() => first.$('status').textContent.includes('扫描完成') && !first.$('start').disabled, 'manual continue');
  assert.equal(requests.length, 6); assert.match(first.$('progress').textContent, /去重记录 8 · 可读 7 · 异常 1/);
  first.$('export').onclick();
  await waitFor(() => first.downloaded.length === 1, 'report download');
  const report = await first.downloaded[0].blob.text();
  assert.equal(first.downloaded[0].filename, 'parameters.txt');
  assert.match(report, /complete: true/); assert.match(report, /"A"\t3\t0.37500000/); assert.match(report, /b:900\tprivate\tfalse/);
  console.log('PASS full UI flow: public pages, outage pause, manual continuation, private pages, TXT download');
  const cacheKey = [...store.keys()][0];
  const legacy = JSON.parse(store.get(cacheKey));
  legacy.version = '0.1.0';
  store.set(cacheKey, JSON.stringify(legacy));
  const legacyBytes = store.get(cacheKey);
  const reloaded = browser(async () => { throw new Error('No requests expected for completed report'); });
  await waitFor(() => !reloaded.$('start').disabled, 'reload');
  assert.match(reloaded.$('status').textContent, /已恢复上次完成的数据/);
  reloaded.$('raw').onclick();
  await waitFor(() => reloaded.downloaded.length === 1 && !reloaded.$('start').disabled, 'raw export from old checkpoint');
  const rawFile = reloaded.downloaded[0];
  assert.equal(rawFile.filename, 'pixiv-bookmark-records.json');
  assert.equal(new Uint8Array(await rawFile.blob.arrayBuffer())[0], 123, 'JSON must start with { without a BOM');
  const raw = JSON.parse(await rawFile.blob.text());
  assert.equal(raw.scanner_version, '0.1.0'); assert.equal(raw.exporter_version, '0.4.0');
  assert.equal(raw.complete, true); assert.equal(raw.records.length, 8);
  assert.deepEqual(raw.summary, { observed_unique_records: 8, successfully_readable: 7, exceptions: 1, unique_tags: 3, tag_memberships: 8 });
  assert.deepEqual(raw.records.find((r) => r.pid === '6').tags, ['A', 'C']);
  assert.equal(raw.records.find((r) => r.key === 'b:900').pid, null);
  assert.equal(raw.uid, undefined); assert.equal(raw.records[0].seen, undefined);
  assert.equal(store.get(cacheKey), legacyBytes, 'Export must not mutate the old checkpoint');
  console.log('PASS 0.1.0 cache exports complete raw JSON with no fetch, cache mutation, account ID or BOM');
  reloaded.$('anonymous').onclick();
  await waitFor(() => reloaded.downloaded.length === 2, 'anonymous export after reload');
  const anonymous = await reloaded.downloaded[1].blob.text();
  assert.match(anonymous, /TAG_000001/); assert.equal(anonymous.includes('b:900'), false);
  console.log('PASS persisted complete state reloads and exports without fetching');
  const toggle = (page, tag, checked) => {
    const row = page.$('plan-tags').children.find((r) => r.children[0]?.children[1]?.textContent === tag);
    assert.ok(row, `Checkbox for ${tag}`);
    const input = row.children[0].children[0]; input.checked = checked; input.onchange();
  };
  reloaded.$('classify').onclick();
  await waitFor(() => reloaded.$('plan-status').textContent.includes('自动完成') && !reloaded.$('plan-auto').disabled, 'local classification');
  assert.equal(reloaded.$('plan-selected').textContent, '3');
  assert.equal(reloaded.$('plan-covered').textContent, '6 / 7 件已覆盖');
  assert.equal(reloaded.$('plan-coverage').textContent, '85.71%');
  assert.match(reloaded.$('plan-universe').textContent, /1 条异常已忽略/);
  toggle(reloaded, 'A', false);
  assert.equal(reloaded.$('plan-missing').textContent, '2');
  reloaded.$('plan-show-missing').onclick();
  assert.equal(reloaded.$('plan-works').children.length, 2);
  assert.equal(reloaded.$('plan-works').children[0].children[0].href, 'https://www.pixiv.net/artworks/2');
  reloaded.$('plan-undo').onclick();
  assert.equal(reloaded.$('plan-missing').textContent, '1');
  reloaded.$('plan-save').onclick();
  await waitFor(() => reloaded.$('plan-save-state').textContent === '本地方案已保存', 'save classification');
  assert.equal(store.get(cacheKey), legacyBytes, 'Classification must leave checkpoint unchanged');
  reloaded.$('plan-export').onclick();
  await waitFor(() => reloaded.downloaded.length === 3 && !reloaded.$('plan-auto').disabled, 'classification export');
  const plan = JSON.parse(await reloaded.downloaded[2].blob.text());
  assert.equal(plan.mode, 'local_preview'); assert.equal(plan.existing_bookmark_tags_checked, false);
  assert.equal(plan.summary.covered, 6); assert.equal(plan.summary.ignored_inaccessible, 1);
  assert.equal(plan.assignments.length, 7); assert.deepEqual(plan.uncovered_pids, ['5']);
  console.log('PASS classification from old cache, manual toggle, uncovered preview, undo, save and plan export without fetching');
  const second = browser(async () => { throw new Error('Classification must not fetch'); });
  await waitFor(() => !second.$('classify').disabled, 'classification reload');
  second.$('classify').onclick();
  await waitFor(() => second.$('plan-status').textContent.includes('已恢复与这份数据对应'), 'restore saved selection');
  assert.equal(second.$('plan-selected').textContent, '3');
  toggle(second, 'B', false); second.$('plan-save').onclick();
  await waitFor(() => second.$('plan-save-state').textContent === '本地方案已保存', 'second tab saves');
  toggle(reloaded, 'A', false); reloaded.$('plan-save').onclick();
  await waitFor(() => reloaded.$('plan-status').textContent.includes('另一个页面已保存新方案'), 'reject stale overwrite');
  assert.equal(JSON.parse(store.get('pba:prototype:selection:v1')).selected.includes('B'), false);
  console.log('PASS saved selection restores and stale tab cannot overwrite another tab’s newer plan');
  reloaded.$('plan-close').onclick();
  assert.equal(reloaded.$('plan-overlay').hidden, true);
  await reloaded.$('clear').onclick();
  assert.equal(store.size, 0); assert.equal(reloaded.$('uid').disabled, false);
  console.log('PASS local cleanup does not request any Pixiv mutation');
  // Fresh page: save a partial snapshot, then reload and fully re-enumerate.
  failedOnce = false; const partial = browser(fetcher);
  await waitFor(() => !partial.$('start').disabled, 'fresh boot'); partial.$('start').onclick();
  await waitFor(() => partial.$('status').textContent.includes('网络请求失败') && !partial.$('start').disabled, 'partial save');
  const resumed = browser(fetcher);
  await waitFor(() => !resumed.$('start').disabled, 'partial reload');
  assert.match(resumed.$('status').textContent, /从头核对/);
  const before = requests.length; resumed.$('start').onclick();
  await waitFor(() => resumed.$('status').textContent.includes('扫描完成') && !resumed.$('start').disabled, 're-enumeration');
  assert.deepEqual(requests[before], { rest: 'show', offset: 0 });
  assert.match(resumed.$('progress').textContent, /去重记录 8 · 可读 7 · 异常 1/);
  console.log('PASS reload of interrupted scan restarts enumeration and keeps PID counts unique');
  console.log('7 flow validation cases passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
