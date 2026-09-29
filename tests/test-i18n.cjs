'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../pixiv-bookmark-analyzer-prototype.user.js');
const { browser, store, waitFor } = require('./test-flow.cjs');
const cacheKey = 'pba:prototype:checkpoint:v1';
const projectKey = 'pba:prototype:classification-project:v1';
const switchTo = async (page, value, id = 'language') => {
  page.$(id).value = value; page.$(id).onchange();
  await waitFor(() => !page.$(id).disabled, `switch to ${value}`);
};
const boot = async page => waitFor(() => !page.$('language').disabled && !page.$('start').disabled, 'boot');
const noRequests = () => { throw new Error('Language changes must not make network requests'); };

(async () => {
  for (const [preference, languages, expected] of [
    ['auto', ['ja-JP', 'en-US'], 'ja'], ['auto', ['en-GB'], 'en'],
    ['auto', ['zh-TW'], 'zh'], ['auto', ['zh_Hant_HK'], 'zh'],
    ['auto', ['de-DE', 'ja'], 'ja'], ['auto', ['fr-FR'], 'en'],
    ['auto', [], 'en'], ['ja', ['en-US'], 'ja'], ['en', ['ja-JP'], 'en'],
  ]) assert.equal(core.resolveLanguage(preference, languages), expected);
  const slots = s => (s.match(/\{\d+\}/g) || []).sort();
  for (const [key, pair] of Object.entries(core.TRANSLATIONS)) {
    assert.equal(pair.length, 2); assert.ok(pair.every(text => typeof text === 'string' && text.length));
    for (const text of pair) assert.deepEqual(slots(text), slots(key), key);
  }
  const source = fs.readFileSync(path.join(__dirname, '../pixiv-bookmark-analyzer-prototype.user.js'), 'utf8');
  const used = [...source.matchAll(/\bt\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)]
    .map(match => require('node:vm').runInNewContext(match[1]));
  used.push(...[...source.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map(match => match[1]));
  for (const key of used.filter(key => /[\u3400-\u9fff]/u.test(key))) assert.ok(core.TRANSLATIONS[key], `Missing translations: ${key}`);
  console.log('PASS regional language detection, fallback, manual override and complete translation placeholders');

  store.clear();
  const page = browser(noRequests, { languages: ['ja-JP'] }); await boot(page);
  assert.equal(page.$('language').value, 'auto'); assert.equal(store.has(core.LANGUAGE_KEY), false);
  assert.equal(page.$('start').textContent, '開始・再開');
  assert.match(page.$('status').textContent, /アカウントを認識/);
  assert.equal(page.$('uid').getAttribute('placeholder'), 'ブックマーク URL の数字（例：/users/123456/）');
  await switchTo(page, 'en');
  assert.equal(page.$('plan-language').value, 'en');
  assert.equal(page.$('start').textContent, 'Start / resume');
  assert.match(page.$('status').textContent, /Account detected/);
  assert.equal(page.$('plan-search').getAttribute('aria-label'), 'Search category tags');
  const reload = browser(noRequests, { languages: ['ja-JP'] }); await boot(reload);
  assert.equal(reload.$('language').value, 'en'); assert.equal(reload.$('start').textContent, 'Start / resume');
  await switchTo(reload, 'auto'); assert.equal(reload.$('start').textContent, '開始・再開');
  reload.navigator.languages = ['en-US']; reload.events.get('languagechange')();
  assert.equal(reload.$('start').textContent, 'Start / resume');
  console.log('PASS browser default, persisted manual override, live static/status/accessibility translation and return to automatic mode');

  store.clear();
  const s = core.newSession('123', 100); s.version = '0.3.0'; s.complete = true; s.savedAt = new Date().toISOString();
  s.records = [
    { key: 'p:1', pid: '1', rest: 'show', seen: 1, accessible: true, reason: '', tags: ['公开'] },
    { key: 'p:2', pid: '2', rest: 'hide', seen: 1, accessible: true, reason: '', tags: ['日本語'] },
  ];
  for (const rest of ['show', 'hide']) Object.assign(s.scopes[rest], { offset: 1, totalFirst: 1, totalLatest: 1, done: true });
  const project = { schema: 1, uid: '123', selected: ['公开'], prefix: '新_',
    mapping: [{ source: '公开', target: '新_公开', committed: true }], includeExisting: false,
    seenPids: ['1'], createdAt: s.savedAt, savedAt: s.savedAt, lastUpdatedAt: s.savedAt };
  store.set(cacheKey, JSON.stringify(s)); store.set(projectKey, JSON.stringify(project));
  const original = [...store.entries()];
  const preview = browser(noRequests, { languages: ['en-US'] }); await boot(preview);
  preview.$('classify').onclick();
  await waitFor(() => preview.$('plan-status').textContent.includes('Restored the classification rules'), 'legacy project restore');
  assert.equal(preview.$('plan-tags').children[0].children[0].children[1].textContent, '公开');
  assert.match(preview.$('plan-covered').textContent, /1 \/ 2 works covered/);
  preview.$('plan-filter').value = 'all'; preview.$('plan-filter').onchange();
  const row = preview.$('plan-tags').children.find(node => node.children[0]?.children[1]?.textContent === '日本語');
  row.children[0].children[0].checked = true; row.children[0].children[0].onchange();
  preview.$('plan-search').value = '日本語'; preview.$('plan-search').oninput();
  await switchTo(preview, 'ja', 'plan-language');
  assert.equal(preview.$('language').value, 'ja'); assert.equal(preview.$('plan-search').value, '日本語');
  assert.equal(preview.$('plan-selected').textContent, '2');
  assert.equal(preview.$('plan-save-state').textContent, '未保存の変更があります');
  assert.match(preview.$('plan-status').textContent, /「日本語」を選択しました/);
  assert.equal(preview.$('plan-tags').children[0].children[0].children[1].textContent, '日本語');
  preview.$('plan-undo').onclick(); assert.equal(preview.$('plan-selected').textContent, '1');
  for (const [key, value] of original) assert.equal(store.get(key), value, 'Language switching must not rewrite old project/cache bytes');
  preview.$('plan-export').onclick();
  await waitFor(() => preview.downloaded.length === 1, 'plan export');
  const output = JSON.parse(await preview.downloaded[0].blob.text());
  assert.equal(output.mode, 'local_preview'); assert.deepEqual(output.selected_tags, ['公开']);
  assert.equal(output.assignments[0].visibility, 'public'); assert.deepEqual(output.assignments[0].tags, ['公开']);
  console.log('PASS 0.3.0 project/cache compatibility; live language switch preserves exact tags, unsaved selection, search, undo and export schema');

  store.clear();
  const paused = browser(async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) }), { languages: ['ja-JP'] });
  await boot(paused); paused.$('start').onclick();
  await waitFor(() => paused.$('status').textContent.includes('HTTP 429') && !paused.$('start').disabled, '429 pause');
  assert.match(paused.$('status').textContent, /一時停止/);
  await switchTo(paused, 'en'); assert.match(paused.$('status').textContent, /HTTP 429: paused/);
  assert.match(paused.$('status').textContent, /Earliest continuation time/);
  const failing = browser(noRequests, { languages: ['ja-JP'], setValue: async () => { throw Error('disk'); } });
  await boot(failing); await switchTo(failing, 'ja');
  assert.equal(failing.$('language').value, 'en'); assert.equal(store.get(core.LANGUAGE_KEY), 'en');
  assert.match(failing.$('status').textContent, /Could not save the language preference/);
  const confirmed = [], clearing = browser(noRequests, { languages: ['ja-JP'], confirmed }); await boot(clearing);
  await clearing.$('clear').onclick();
  assert.match(confirmed[0], /classification settings/);
  assert.equal(store.get(core.LANGUAGE_KEY), 'en', 'Clearing project data keeps language preference');
  console.log('PASS existing errors retranslate in place, save failure rolls back language, and clear-data confirmation is localized');
})().catch(error => { console.error(error); process.exitCode = 1; });
