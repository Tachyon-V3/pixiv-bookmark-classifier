// ==UserScript==
// @name         Pixiv 收藏参数扫描器 · 只读原型
// @name:en      Pixiv Bookmark Classifier
// @name:ja      Pixiv ブックマーク分類ツール
// @namespace    local.pixiv-bookmark-analyzer
// @version      0.4.0
// @description  保留总收藏和已有分类，自动计算分类；核对预览后，仅追加新的收藏标签。
// @description:en  Preview and add bookmark categories, keep existing bookmarks and tags, and reuse saved rules for updates.
// @description:ja  ブックマークと既存タグを保持し、分類をプレビューして追加。保存したルールで新規作品も更新できます。
// @match        https://www.pixiv.net/*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// ==/UserScript==

/*
 * Standalone and same-origin only. No images, cookie reading or telemetry.
 * Only mutation allowed: POST /ajax/illusts/bookmarks/add_tags.
 * Never removes bookmarks/tags or changes privacy. CSRF stays in memory.
 * The legacy name and storage keys preserve installed userscript identity.
 * API observations and installation references are in the accompanying guide.
 */
(() => {
  'use strict';

  const VERSION = '0.4.0';
  const CACHE_KEY = 'pba:prototype:checkpoint:v1';
  const LOCK_KEY = 'pba:prototype:scan:v1';
  const SELECTION_KEY = 'pba:prototype:selection:v1';
  const APPEND_KEY = 'pba:prototype:append-job:v1';
  const PROJECT_KEY = 'pba:prototype:classification-project:v1';
  const APPEND = Object.freeze({ intervalMs: 500, batchSize: 50, nameUnits: 20, maxJobBytes: 16 * 1024 * 1024 });
  const LOCAL_TAG_LIMIT = 10;
  const CONFIG = Object.freeze({
    requestIntervalMs: 100, // User-chosen minimum request start-to-start interval.
    pageSize: 100,
    timeoutMs: 30000,
    checkpointEveryMs: 5000,
    maxCheckpointBytes: 16 * 1024 * 1024,
    maxRecords: 100000,
    maxPagesPerScope: 10000,
    pairTopN: 80,
    tripleTopN: 12,
    maxNotices: 20,
  });
  const SCOPES = ['show', 'hide'];

  const LANGUAGE_KEY = 'pba:prototype:language:v1';
  const LANGUAGES = Object.freeze(['zh', 'ja', 'en']);
  // Each source-language key maps to [English, Japanese]. Original tags are never translated.
  const TRANSLATIONS = Object.freeze({
    "公开": [
      "Public",
      "公開"
    ],
    "非公开": [
      "Private",
      "非公開"
    ],
    "接口格式发生变化；已暂停，请导出当前 TXT。": [
      "The API format changed. Paused; export the current TXT report.",
      "API の形式が変わりました。一時停止しました。現在の TXT をエクスポートしてください。"
    ],
    "Pixiv 返回接口错误；请检查登录状态及自己的收藏页。": [
      "Pixiv returned an API error. Check your login and your own bookmarks page.",
      "Pixiv が API エラーを返しました。ログイン状態と自分のブックマークページを確認してください。"
    ],
    "收藏页数据不符合预期；已暂停，未跳过这一页。": [
      "Unexpected bookmark page data. Paused without skipping this page.",
      "ブックマークのデータ形式が想定と異なります。このページを飛ばさずに一時停止しました。"
    ],
    "达到原型分页上限；已暂停，可导出当前数据。": [
      "The page limit was reached. Paused; you can export the current data.",
      "読み込みページ数の上限に達しました。一時停止しました。現在のデータをエクスポートできます。"
    ],
    "达到原型 100,000 条缓存上限；已暂停，请导出当前 TXT。": [
      "The 100,000-record cache limit was reached. Paused; export the current TXT report.",
      "キャッシュの上限 100,000 件に達しました。一時停止しました。現在の TXT をエクスポートしてください。"
    ],
    "提前收到空页；已暂停，避免把缺失数据当成完整结果。": [
      "An empty page arrived before the end. Paused to avoid treating incomplete data as complete.",
      "最後のページより前に空のページが返されました。データの欠落を避けるため一時停止しました。"
    ],
    "这一页全部重复；已暂停，请用“重新核对”检查列表。": [
      "Every record on this page is a duplicate. Paused; use “Rescan” to check the list.",
      "このページの全件が重複しています。一時停止しました。「再スキャン」で一覧を確認してください。"
    ],
    "服务端要求等待；请在提示的时间之后继续。": [
      "The server requested a delay. Continue after the indicated time.",
      "サーバーから待機を求められました。表示された時刻以降に再開してください。"
    ],
    "请求地址不在本脚本的只读白名单内。": [
      "The request URL is outside this script's read-only allowlist.",
      "リクエスト先が、このスクリプトで許可された読み取り先に含まれていません。"
    ],
    "HTTP 429：已暂停，不自动重试。": [
      "HTTP 429: paused, with no automatic retry.",
      "HTTP 429：一時停止しました。自動再試行は行いません。"
    ],
    "HTTP {0}：已暂停；请检查 Pixiv 页面后再继续。": [
      "HTTP {0}: paused. Check the Pixiv page before continuing.",
      "HTTP {0}：一時停止しました。Pixiv のページを確認してから再開してください。"
    ],
    "返回内容不是 JSON，可能是登录页或验证页；请正常打开 Pixiv 检查。": [
      "The response was not JSON; it may be a login or verification page. Open Pixiv normally to check.",
      "応答が JSON ではありません。ログイン・認証ページの可能性があります。通常の操作で Pixiv を開いて確認してください。"
    ],
    "请求超时；已暂停，当前页会在继续时重试。": [
      "The request timed out. Paused; this page will be retried when you continue.",
      "リクエストがタイムアウトしました。一時停止しました。再開時にこのページを再取得します。"
    ],
    "网络请求失败或发生重定向；已暂停，未把作品记成失效。": [
      "A network request failed or redirected. Paused; no works were marked unavailable because of this error.",
      "通信の失敗またはリダイレクトにより一時停止しました。このエラーを理由に作品を閲覧不可として扱うことはありません。"
    ],
    "无法确认已有收藏标签，已停止；不会按空标签处理。": [
      "Existing bookmark tags could not be verified. Stopped; they will not be assumed empty.",
      "既存のブックマークタグを確認できないため停止しました。タグが空とは判断しません。"
    ],
    "已有收藏标签的格式发生变化，已停止。": [
      "The existing bookmark tag format changed. Stopped.",
      "既存のブックマークタグの形式が変わったため停止しました。"
    ],
    "新分类前缀需为 1～8 个字符，不能含空格或控制字符。": [
      "The new category prefix must be 1–8 characters with no spaces or control characters.",
      "新しい分類の接頭辞は 1～8 文字で、空白や制御文字を含めることはできません。"
    ],
    "新分类出现计划外作品；已停止，请导出追加记录检查。": [
      "A new category contains unexpected works. Stopped; export the append log for inspection.",
      "新しい分類に予定外の作品が含まれています。停止しました。追加ログをエクスポートして確認してください。"
    ],
    "请求不在追加分类白名单内。": [
      "The request is outside the category-append allowlist.",
      "リクエストが分類追加用の許可リストに含まれていません。"
    ],
    "追加参数不符合要求，未发送请求。": [
      "Invalid append parameters. No request was sent.",
      "追加パラメータが不正です。リクエストは送信していません。"
    ],
    "尚未到服务端允许继续的时间。": [
      "The server's waiting period has not ended yet.",
      "サーバーが指定した待機時間はまだ終了していません。"
    ],
    "HTTP {0}：已暂停，不自动重试。": [
      "HTTP {0}: paused, with no automatic retry.",
      "HTTP {0}：一時停止しました。自動再試行は行いません。"
    ],
    "接口未明确返回成功；已暂停，请重新核对实际结果。": [
      "The API did not clearly confirm success. Paused; check the actual results again.",
      "API から明確な成功応答が得られませんでした。一時停止しました。実際の結果を再確認してください。"
    ],
    "追加请求结果不确定；已暂停。继续前会重新读取实际标签，不直接重发。": [
      "The append result is uncertain. Paused. Actual tags will be read before continuing; the request will not be resent blindly.",
      "追加結果を確認できないため一時停止しました。再開前に実際のタグを読み直し、未確認のまま再送しません。"
    ],
    "读取超时、失败或格式变化，已停止。": [
      "Reading timed out, failed, or returned a changed format. Stopped.",
      "読み取りのタイムアウト、失敗、または形式変更により停止しました。"
    ],
    "账户或公开状态无效。": [
      "Invalid account or visibility setting.",
      "アカウントまたは公開設定が不正です。"
    ],
    "核对期间收藏列表发生变化或缺页，请保持收藏不变后重试。": [
      "The bookmark list changed or a page is missing. Keep bookmarks unchanged and try again.",
      "確認中にブックマーク一覧が変わったか、ページが欠落しています。ブックマークを変更せずに再試行してください。"
    ],
    "列表出现重复记录，已停止核对。": [
      "Duplicate records were found. Verification stopped.",
      "重複したレコードが見つかったため、確認を停止しました。"
    ],
    "达到核对资源上限，已停止。": [
      "The verification resource limit was reached. Stopped.",
      "確認処理のリソース上限に達したため停止しました。"
    ],
    "核对数量与接口总数不一致。": [
      "The verified count differs from the API total.",
      "確認した件数が API の合計と一致しません。"
    ],
    "同一作品同时出现在两种公开状态中，请稍后重试。": [
      "The same work appears in both visibility groups. Try again later.",
      "同じ作品が公開・非公開の両方にあります。しばらくしてから再試行してください。"
    ],
    "达到核对资源上限。": [
      "The verification resource limit was reached.",
      "確認処理のリソース上限に達しました。"
    ],
    "无法确认现有分类名称，已停止。": [
      "Existing category names could not be verified. Stopped.",
      "既存の分類名を確認できないため停止しました。"
    ],
    "现有分类名称格式发生变化。": [
      "The existing category name format changed.",
      "既存の分類名の形式が変わりました。"
    ],
    "新分类回读未通过；已停止，请重新核对。": [
      "Verification of the new category failed. Stopped; check again.",
      "新しい分類の再読み取りによる検証に失敗しました。停止しました。再確認してください。"
    ],
    "当前登录账户与分类项目不一致，已停止。": [
      "The signed-in account differs from the classification project. Stopped.",
      "ログイン中のアカウントが分類プロジェクトと異なるため停止しました。"
    ],
    "{0}：已读 {1} / {2}{3}": [
      "{0}: read {1} / {2}{3}",
      "{0}：読み取り済み {1} / {2}{3}"
    ],
    "\n去重记录 {0} · 可读 {1} · 异常 {2}": [
      "\nUnique records {0} · Readable {1} · Unavailable {2}",
      "\n重複を除いた件数 {0} · 閲覧可能 {1} · 閲覧不可など {2}"
    ],
    "{0}\n已保存 {1} / 16 MiB": [
      "{0}\nSaved {1} / 16 MiB",
      "{0}\n保存済み {1} / 16 MiB"
    ],
    "仅保留一份进度；约每 5 秒及暂停、完成时覆盖保存。": [
      "One checkpoint is kept and replaced about every 5 seconds, on pause, and on completion.",
      "進捗は 1 件保持し、約 5 秒ごとと一時停止時・完了時に上書き保存します。"
    ],
    " · 自动跳过": [
      " · excluded from auto-selection",
      " · 自動選択の対象外"
    ],
    "{0} 件": [
      "{0} works",
      "{0} 件"
    ],
    "查看 {0} 的作品": [
      "View works tagged {0}",
      "「{0}」の作品を表示"
    ],
    "没有符合筛选条件的标签。": [
      "No tags match this filter.",
      "条件に一致するタグがありません。"
    ],
    "{0} 个 · {1} / {2} 页": [
      "{0} tags · Page {1} / {2}",
      "{0} 個 · {1} / {2} ページ"
    ],
    "分类：{0}": [
      "Category: {0}",
      "分類：{0}"
    ],
    "未覆盖作品": [
      "Uncovered works",
      "未分類の作品"
    ],
    "全部可读作品": [
      "All readable works",
      "閲覧可能な全作品"
    ],
    "当前分类：{0}": [
      "Current categories: {0}",
      "現在の分類：{0}"
    ],
    "已由原有分类覆盖。": [
      "Covered by an existing category.",
      "既存の分類に含まれています。"
    ],
    "未覆盖：可以从下方原始 tag 中选择分类。": [
      "Uncovered: select a category from the original tags below.",
      "未分類：下の元タグから分類を選択できます。"
    ],
    "原始 tag：{0}": [
      "Original tags: {0}",
      "元のタグ：{0}"
    ],
    "目前没有未覆盖的可读作品。": [
      "All readable works are currently covered.",
      "閲覧可能な作品はすべて分類されています。"
    ],
    "这里没有作品。": [
      "No works here.",
      "作品がありません。"
    ],
    "{0} 件 · {1} / {2} 页": [
      "{0} works · Page {1} / {2}",
      "{0} 件 · {1} / {2} ページ"
    ],
    "{0} / {1} 件已覆盖": [
      "{0} / {1} works covered",
      "{0} / {1} 件を分類済み"
    ],
    "全集为 {0} 件可读作品；{1} 条异常已忽略。同一作品可属于多个分类，覆盖率按 PID 去重。": [
      "The universe contains {0} readable works; {1} unavailable records are ignored. Works may belong to multiple categories; coverage counts each PID once.",
      "対象は閲覧可能な {0} 件です。閲覧不可などの {1} 件は除外します。作品は複数の分類に属する場合があり、網羅率は PID ごとに数えます。"
    ],
    "有未保存的本地改动": [
      "Unsaved local changes",
      "未保存の変更があります"
    ],
    "本地方案已保存": [
      "Local plan saved",
      "ローカルのプランを保存済み"
    ],
    "未加入“{0}”：PID {1} 已匹配 10 个本地分类。请先取消其他分类。": [
      "“{0}” was not added: PID {1} already matches 10 local categories. Deselect another category first.",
      "「{0}」は追加できません。PID {1} はすでに 10 個の分類に一致しています。先に別の分類の選択を解除してください。"
    ],
    "{0}“{1}”。{2}": [
      "{0} “{1}”. {2}",
      "「{1}」を{0}。{2}"
    ],
    "已加入": [
      "Selected",
      "選択しました"
    ],
    "已取消": [
      "Deselected",
      "選択解除しました"
    ],
    "当前有 {0} 件未覆盖，可点“只看未覆盖”。": [
      "{0} works remain uncovered. Use “Uncovered only” to view them.",
      "{0} 件が未分類です。「未分類のみ」で確認できます。"
    ],
    "全部可读作品已覆盖。": [
      "All readable works are covered.",
      "閲覧可能な作品をすべて分類できています。"
    ],
    "先点“核对 / 更新主收藏”读取已有分类，再计算包含已有集合的覆盖。": [
      "Use “Check / refresh bookmarks” to read existing categories before including them in coverage.",
      "既存の分類を網羅率に含めるには、先に「ブックマークを確認・更新」で読み取ってください。"
    ],
    "正在自动选集：先覆盖更多未分类作品，再移除多余标签…": [
      "Selecting automatically: cover more unclassified works, then remove redundant tags…",
      "自動選択中：未分類の作品を優先して網羅し、冗長なタグを除きます…"
    ],
    "正在计算：已覆盖 {0} / {1} 件，临时选择 {2} 个标签…": [
      "Calculating: {0} / {1} works covered, {2} tags provisionally selected…",
      "計算中：{0} / {1} 件を網羅、暫定で {2} 個のタグを選択…"
    ],
    "自动完成：{0} 个分类，覆盖 {1} / {2} 件。": [
      "Auto-selection complete: {0} categories cover {1} / {2} works.",
      "自動選択完了：{0} 個の分類で {1} / {2} 件を網羅しました。"
    ],
    "\n仍有 {0} 件未覆盖；请查看这些作品并手动补选。这不表示不存在其他全覆盖方案。": [
      "\n{0} works remain uncovered. Review them and select additional tags. Another full-coverage solution may still exist.",
      "\n{0} 件が未分類です。作品を確認してタグを追加選択してください。他の組み合わせで全件を網羅できる可能性はあります。"
    ],
    "\n这是可用的覆盖方案，未证明分类数量是全局最少。": [
      "\nThis is a working cover, not a proof of the smallest possible category count.",
      "\nこれは利用可能な組み合わせですが、分類数が全体で最少であるとは証明していません。"
    ],
    "\n可以继续勾选调整，满意后点“保存本地方案”。再次自动选集会重算，完成后可撤销。": [
      "\nAdjust the selection, then use “Save local plan”. Auto-selection recalculates the plan; you can undo it afterwards.",
      "\n選択を調整し、「ローカルに保存」を押してください。自動選択は再計算を行い、完了後に元に戻せます。"
    ],
    "已停止计算，保留开始计算前的选择。": [
      "Calculation stopped. The previous selection is kept.",
      "計算を停止しました。計算前の選択を保持しています。"
    ],
    "自动选集失败，原选择保留。可以导出原始 JSON 反馈。": [
      "Auto-selection failed. The previous selection is kept; export the raw JSON for troubleshooting.",
      "自動選択に失敗しました。以前の選択は保持しています。調査用に元データ JSON をエクスポートできます。"
    ],
    "正在用本地数据准备分类试用…": [
      "Preparing the classification preview from local data…",
      "ローカルデータから分類プレビューを準備中…"
    ],
    "没有已保存的方案，将自动计算。": [
      "No saved plan was found. A plan will be calculated automatically.",
      "保存済みのプランがないため、自動計算します。"
    ],
    "已恢复与这份数据对应的本地方案。勾选后覆盖率会即时更新。": [
      "Restored the local plan for this data. Coverage updates as you change the selection.",
      "このデータに対応するプランを復元しました。選択を変更すると網羅率が更新されます。"
    ],
    "旧方案与当前数据不匹配或无法读取；将重新计算，保存时才替换旧方案。": [
      "The old plan does not match this data or could not be read. A new plan will be calculated; saving will replace the old plan.",
      "以前のプランが現在のデータと一致しないか、読み取れません。再計算し、保存時に以前のプランを置き換えます。"
    ],
    "已恢复分类参数和名称。点“核对 / 更新主收藏”读取新增作品；也可以先调整规则。": [
      "Restored the classification rules and names. Use “Check / refresh bookmarks” to read new works, or adjust the rules first.",
      "分類ルールと名前を復元しました。「ブックマークを確認・更新」で新しい作品を読み取れます。先にルールを調整することもできます。"
    ],
    "分类试用使用已完成的本地数据。": [
      "The classification preview uses the completed local scan.",
      "分類プレビューでは、完了済みのローカルスキャンデータを使用します。"
    ],
    "无法打开分类试用。请保留本地扫描数据，导出原始 JSON 后反馈。": [
      "Could not open the classification preview. Keep the scan data and export the raw JSON for troubleshooting.",
      "分類プレビューを開けませんでした。スキャンデータを保持し、調査用に元データ JSON をエクスポートしてください。"
    ],
    "需要支持 Web Locks 的新版桌面 Chrome / Edge。": [
      "A recent desktop Chrome / Edge with Web Locks support is required.",
      "Web Locks に対応した新しいデスクトップ版 Chrome / Edge が必要です。"
    ],
    "另一个页面正在保存或扫描；请稍后再保存。": [
      "Another page is saving or scanning. Try saving again later.",
      "別のページが保存またはスキャン中です。終了後に保存してください。"
    ],
    "另一个页面已更新或清除扫描数据。请先导出本页方案，再刷新核对。": [
      "Another page updated or cleared the scan data. Export this plan, then refresh and check again.",
      "別のページがスキャンデータを更新または消去しました。このプランをエクスポートしてから、ページを再読み込みして確認してください。"
    ],
    "另一个页面已保存新方案。请先导出本页方案，再刷新核对，避免覆盖。": [
      "Another page saved a newer plan. Export this plan, then refresh to avoid overwriting it.",
      "別のページで新しいプランが保存されました。上書きを避けるため、このプランをエクスポートしてからページを再読み込みしてください。"
    ],
    "其他页面已更新项目参数，请刷新后再保存。": [
      "Another page updated the project settings. Refresh before saving.",
      "別のページがプロジェクト設定を更新しました。ページを再読み込みしてから保存してください。"
    ],
    "方案超过 1 MiB；请导出文件保存。": [
      "The plan exceeds 1 MiB. Export it to a file.",
      "プランが 1 MiB を超えています。ファイルにエクスポートしてください。"
    ],
    "本地方案已保存。刷新页面后会恢复这份选择；Pixiv 收藏未改变。": [
      "Local plan saved. This selection will be restored after a refresh. Pixiv bookmarks were not changed.",
      "ローカルに保存しました。再読み込み後にこの選択を復元します。Pixiv のブックマークは変更していません。"
    ],
    "保存失败：{0}": [
      "Save failed: {0}",
      "保存失敗：{0}"
    ],
    "请先导出本页方案。": [
      "Export this plan first.",
      "先にこのプランをエクスポートしてください。"
    ],
    "已发起下载 pixiv-classification-plan.json，包含已选分类和逐件分配结果。\n可以把方案发回继续检查；本次导出不会写回 Pixiv，也不会代替“保存本地方案”。": [
      "Started downloading pixiv-classification-plan.json with the selected categories and per-work assignments.\nYou can share the plan for review. Exporting does not write to Pixiv or replace “Save local plan”.",
      "選択した分類と作品ごとの割り当てを含む pixiv-classification-plan.json のダウンロードを開始しました。\n確認用に共有できます。エクスポートは Pixiv への書き込みや「ローカルに保存」の代わりにはなりません。"
    ],
    "导出失败；本页选择仍在，请先保存本地方案。": [
      "Export failed. Your selection remains on this page; save the local plan first.",
      "エクスポートに失敗しました。このページの選択は保持しています。先にローカルに保存してください。"
    ],
    "已读取 {0} 个原有分类；{1} 件计入已有集合。该选项只计入原成员，不向旧分类追加。": [
      "Read {0} existing categories; {1} works count as already covered. Only existing members count; no works are added to those categories.",
      "既存の分類を {0} 個読み取り、{1} 件を分類済みとして数えます。既存のメンバーだけが対象で、既存分類への追加は行いません。"
    ],
    "点“核对 / 更新主收藏”读取已有收藏标签。选择纳入后，可点“自动选集”补齐其余作品。": [
      "Use “Check / refresh bookmarks” to read existing tags. After including them, use “Auto-select” to cover the remaining works.",
      "「ブックマークを確認・更新」で既存タグを読み取ります。含める設定にした後、「自動選択」で残りの作品を網羅できます。"
    ],
    "当前登录账户与缓存账户不同，请切回原账户后刷新。": [
      "The signed-in account differs from the cached account. Switch back and refresh.",
      "ログイン中のアカウントがキャッシュと異なります。元のアカウントに戻してページを再読み込みしてください。"
    ],
    "没有可用于核对登录状态的作品。": [
      "No work is available for checking the login state.",
      "ログイン状態の確認に使える作品がありません。"
    ],
    "登录账户发生变化，已停止。": [
      "The signed-in account changed. Stopped.",
      "ログイン中のアカウントが変わったため停止しました。"
    ],
    "无法从页面确认当前账户及写入凭据。请登录自己的 Pixiv 收藏页并刷新后再试；无需提供 Cookie 或 Token。": [
      "Could not verify the current account and write credentials from the page. Sign in, open your own Pixiv bookmarks page, and refresh. No Cookie or Token needs to be shared.",
      "ページから現在のアカウントと書き込み用の認証情報を確認できません。ログインして自分のブックマークページを再読み込みしてください。Cookie や Token を他人に渡す必要はありません。"
    ],
    "参数记录超过上限，请先导出。": [
      "The settings record exceeds the size limit. Export it first.",
      "設定データがサイズ上限を超えています。先にエクスポートしてください。"
    ],
    "追加记录超过 16 MiB，未开始新的写入，请先导出。": [
      "The append log exceeds 16 MiB. No new write was started; export it first.",
      "追加ログが 16 MiB を超えています。新しい書き込みは開始していません。先にエクスポートしてください。"
    ],
    "另一个页面更新了参数或进度，请先导出本页方案，再刷新。": [
      "Another page updated settings or progress. Export this plan, then refresh.",
      "別のページが設定または進捗を更新しました。このプランをエクスポートしてから再読み込みしてください。"
    ],
    "保存的分类项目属于另一账户，请使用原账户和浏览器配置。": [
      "The saved project belongs to another account. Use the original account and browser profile.",
      "保存済みのプロジェクトは別のアカウント用です。元のアカウントとブラウザープロファイルを使用してください。"
    ],
    "需要支持 Web Locks 的新版桌面浏览器。": [
      "A recent desktop browser with Web Locks support is required.",
      "Web Locks に対応した新しいデスクトップブラウザーが必要です。"
    ],
    "另一个页面正在扫描或追加，请在它结束后再操作。": [
      "Another page is scanning or adding categories. Wait for it to finish.",
      "別のページがスキャンまたは分類を追加しています。終了後に操作してください。"
    ],
    "没有匹配规则": [
      "No matching rule",
      "一致するルールなし"
    ],
    "当前不可读或已不在收藏中": [
      "Currently unreadable or no longer bookmarked",
      "現在閲覧不可、またはブックマークに存在しない"
    ],
    "缺少收藏标识": [
      "Missing bookmark ID",
      "ブックマーク ID なし"
    ],
    "作品原始标签变化": [
      "Original artwork tags changed",
      "作品の元タグが変化"
    ],
    "已有标签加新分类超过 10 个": [
      "Existing tags plus new categories exceed 10",
      "既存タグと新分類の合計が 10 個を超過"
    ],
    "已由原分类覆盖": [
      "Covered by an existing category",
      "既存の分類に含まれる"
    ],
    "收藏标识或公开状态变化": [
      "Bookmark ID or visibility changed",
      "ブックマーク ID または公開設定が変化"
    ],
    "原有标签变化": [
      "Existing tags changed",
      "既存タグが変化"
    ],
    "开始追加 {0} 件": [
      "Add to {0} works",
      "{0} 件に追加"
    ],
    "总收藏 {0} 条 · 本次新发现 {1} 件可读作品 · 可追加 {2} 件 · 已满足 {3} 件 · 未处理 {4} 件": [
      "Total bookmarks {0} · Newly seen readable works {1} · Ready {2} · Satisfied {3} · Skipped {4}",
      "総ブックマーク {0} 件 · 新規検出の閲覧可能作品 {1} 件 · 追加可能 {2} 件 · 完了済み {3} 件 · 未処理 {4} 件"
    ],
    "未处理 {0} 件（最多显示 200 件，完整清单可导出）": [
      "{0} skipped works (showing at most 200; export for the full list)",
      "未処理 {0} 件（最大 200 件を表示。全件はエクスポートできます）"
    ],
    "正在核对{0}主收藏：{1} / {2}，此阶段只读取数据…": [
      "Checking {0} bookmarks: {1} / {2}. This stage only reads data…",
      "{0}ブックマークを確認中：{1} / {2}。この段階では読み取りのみ行います…"
    ],
    "上次暂停后原收藏或原标签发生变化。保留了追加记录，请先导出检查；未继续写入。": [
      "Original bookmarks or tags changed after the previous pause. The append log is kept; export it for inspection. Writing has not resumed.",
      "前回の一時停止後に元のブックマークまたはタグが変わりました。追加ログは保持しています。エクスポートして確認してください。書き込みは再開していません。"
    ],
    "核对完成：可追加 {0} 件，已满足 {1} 件，未处理 {2} 件。\n参数和分类名称已保存。{3}\n总收藏保留，既有标签和公开状态不改动。": [
      "Check complete: ready {0}, satisfied {1}, skipped {2}.\nRules and category names are saved. {3}\nAll bookmarks, existing tags, and visibility settings are preserved.",
      "確認完了：追加可能 {0} 件、完了済み {1} 件、未処理 {2} 件。\nルールと分類名を保存しました。{3}\n総ブックマーク、既存タグ、公開設定を保持します。"
    ],
    "展开下方查看新分类名称，点“开始追加”写入。": [
      "Expand the list below to review new names, then click “Start adding” to write.",
      "下の一覧で新しい分類名を確認し、「追加開始」で書き込みます。"
    ],
    "本次没有待追加内容。": [
      "There is nothing to add this time.",
      "今回は追加する項目がありません。"
    ],
    "已停止核对；没有开始新的追加。": [
      "Verification stopped. No new append operation was started.",
      "確認を停止しました。新たな追加は開始していません。"
    ],
    "核对失败，未开始追加。": [
      "Verification failed. Appending did not start.",
      "確認に失敗しました。追加は開始していません。"
    ],
    "核对后总收藏、原标签或公开状态有变化，请重新点“核对 / 更新主收藏”。": [
      "The total, original tags, or visibility changed after the preview. Use “Check / refresh bookmarks” again.",
      "プレビュー後に総数、元のタグ、または公開設定が変わりました。もう一度「ブックマークを確認・更新」を押してください。"
    ],
    "核对后部分作品的可用位置发生变化，请重新核对预览。": [
      "Some works have different available tag slots now. Check the preview again.",
      "確認後に一部作品のタグの空き枠が変わりました。プレビューを再確認してください。"
    ],
    "开始追加；先追加 1 件并回读，再继续处理其余项目。运行期间请保持页面打开。": [
      "Starting: add to one work and verify it first, then process the rest. Keep this page open.",
      "追加を開始します。まず 1 件に追加して再読み取りで確認し、残りを処理します。このページを開いたままにしてください。"
    ],
    "当前登录账户发生变化，已停止。": [
      "The signed-in account changed. Stopped.",
      "ログイン中のアカウントが変わったため停止しました。"
    ],
    "正在追加 {0}；已回读满足 {1} 件，待完成 {2} 件。": [
      "Adding {0}; {1} works verified, {2} remaining.",
      "「{0}」を追加中。{1} 件を再読み取りで確認済み、残り {2} 件。"
    ],
    "追加已发出，正在回读总收藏、原有标签及分类结果…": [
      "Append requests sent. Re-reading all bookmarks, original tags, and classification results…",
      "追加リクエストを送信しました。総ブックマーク、元のタグ、分類結果を再読み取り中…"
    ],
    "最终核对存在差异，已停止。请导出追加记录检查；不会自动删除或回滚标签。": [
      "The final check found differences. Stopped; export the append log for inspection. Tags will not be deleted or rolled back automatically.",
      "最終確認で差異が見つかりました。停止しました。追加ログをエクスポートして確認してください。タグの自動削除や巻き戻しは行いません。"
    ],
    "追加完成并回读核对：已满足 {0} 件，未处理 {1} 件。\n总收藏仍为 {2} 条，原有标签、收藏标识和公开状态均保留。\n以后点“更新分类”，会沿用这些分类名称，只补缺少的分配。": [
      "Append complete and verified: {0} works satisfied, {1} skipped.\nTotal bookmarks remain {2}; original tags, bookmark IDs, and visibility are preserved.\nUse “Update categories” next time to reuse these names and add only missing assignments.",
      "追加と再読み取り確認が完了しました：完了済み {0} 件、未処理 {1} 件。\n総ブックマークは {2} 件のままで、元のタグ、ブックマーク ID、公開設定を保持しています。\n次回は「分類を更新」で同じ名前を使い、不足分だけを追加できます。"
    ],
    "{0}\n继续时先点“核对 / 更新主收藏”，读取实际结果后再补缺少的标签。": [
      "{0}\nBefore continuing, use “Check / refresh bookmarks” to read actual results, then add only missing tags.",
      "{0}\n再開前に「ブックマークを確認・更新」で実際の結果を読み取り、不足するタグだけを追加してください。"
    ],
    "已暂停。已经追加的分类会保留。": [
      "Paused. Categories already added are kept.",
      "一時停止しました。追加済みの分類は保持しています。"
    ],
    "追加暂停。": [
      "Appending paused.",
      "追加を一時停止しました。"
    ],
    "分类选择暂留本页；刷新前请在试用窗口点“保存本地方案”。": [
      "The selection remains on this page. Use “Save local plan” in the preview before refreshing.",
      "選択はこのページに保持しています。再読み込みする前に、プレビューの「ローカルに保存」を押してください。"
    ],
    "超过 16 MiB，本次新进度未写入；旧进度保留。请先导出 TXT。": [
      "The new checkpoint exceeds 16 MiB and was not saved. The old checkpoint is kept; export TXT first.",
      "新しい進捗が 16 MiB を超えたため保存していません。以前の進捗は保持しています。先に TXT をエクスポートしてください。"
    ],
    "进度超过 16 MiB 上限，已暂停；请先导出 TXT。": [
      "The checkpoint exceeds 16 MiB. Paused; export TXT first.",
      "進捗データが 16 MiB を超えています。一時停止しました。先に TXT をエクスポートしてください。"
    ],
    "进度写入失败；本页数据仍在，请先导出 TXT。": [
      "Saving the checkpoint failed. Data remains on this page; export TXT first.",
      "進捗の保存に失敗しました。このページのデータは保持しています。先に TXT をエクスポートしてください。"
    ],
    "上次保存：{0}": [
      "Last saved: {0}",
      "最終保存：{0}"
    ],
    "另一个 Pixiv 标签页正在扫描；请在那个页面暂停后再操作。": [
      "Another Pixiv tab is scanning. Pause it before proceeding here.",
      "別の Pixiv タブがスキャン中です。そのタブで一時停止してから操作してください。"
    ],
    "请填写自己的 Pixiv 数字用户 ID。": [
      "Enter your own numeric Pixiv user ID.",
      "自分の Pixiv ユーザー ID を数字で入力してください。"
    ],
    "用户 ID 与当前登录账户不一致；请填自己的 ID，或切换账户并刷新。": [
      "The user ID differs from the signed-in account. Enter your own ID, or switch accounts and refresh.",
      "ユーザー ID がログイン中のアカウントと異なります。自分の ID を入力するか、アカウントを切り替えて再読み込みしてください。"
    ],
    "这轮已完成，可以打开分类试用或导出数据；需要更新时点“重新核对”。": [
      "This scan is complete. Open the classification preview or export data; use “Rescan” to refresh it.",
      "このスキャンは完了しています。分類プレビューやエクスポートを利用できます。更新する場合は「再スキャン」を押してください。"
    ],
    "本地进度无法解析；可先导出本页 TXT，再清除本地数据。": [
      "The local checkpoint could not be parsed. Export this page's TXT before clearing local data.",
      "ローカルの進捗を解析できません。ローカルデータを消去する前に、このページの TXT をエクスポートしてください。"
    ],
    "其他页面更新了进度，请刷新当前页面后继续。": [
      "Another page updated the checkpoint. Refresh this page before continuing.",
      "別のページが進捗を更新しました。このページを再読み込みしてから続行してください。"
    ],
    "服务端要求等待至 {0}，届时再点继续。": [
      "The server asks you to wait until {0}. Continue after that time.",
      "サーバーから {0} までの待機を求められています。その時刻以降に再開してください。"
    ],
    "正在扫描{0}收藏…": [
      "Scanning {0} bookmarks…",
      "{0}ブックマークをスキャン中…"
    ],
    "扫描完成。可以“打开分类试用”，或导出 TXT / 原始 JSON。": [
      "Scan complete. Open the classification preview, or export TXT / raw JSON.",
      "スキャンが完了しました。分類プレビューを開くか、TXT / 元データ JSON をエクスポートできます。"
    ],
    "\n发现数据一致性提示，详见 TXT；必要时点“重新核对”。": [
      "\nData consistency notices were found; see the TXT report. Use “Rescan” if needed.",
      "\nデータの整合性に関する通知があります。TXT を確認し、必要に応じて「再スキャン」を実行してください。"
    ],
    "已暂停；可以导出部分 TXT，或继续扫描。": [
      "Paused. Export a partial TXT report or continue scanning.",
      "一時停止しました。途中の TXT をエクスポートするか、スキャンを再開できます。"
    ],
    "发生未预期错误；已暂停，请导出当前 TXT。": [
      "An unexpected error occurred. Paused; export the current TXT report.",
      "予期しないエラーにより一時停止しました。現在の TXT をエクスポートしてください。"
    ],
    "\n最早继续时间：{0}": [
      "\nEarliest continuation time: {0}",
      "\n再開可能時刻：{0}"
    ],
    "读取本地进度失败；请刷新页面重试。": [
      "Could not read the local checkpoint. Refresh and try again.",
      "ローカルの進捗を読み取れませんでした。ページを再読み込みして再試行してください。"
    ],
    "正在生成完整计数及交集 TXT…": [
      "Generating the full counts and intersections TXT report…",
      "全件の集計とタグの重複を含む TXT を生成中…"
    ],
    "已发起下载 {0}。": [
      "Started downloading {0}.",
      "{0} のダウンロードを開始しました。"
    ],
    "\n这是部分结果，文件中 complete: false。": [
      "\nThis is a partial result; the file has complete: false.",
      "\nこれは途中の結果です。ファイル内の complete は false です。"
    ],
    "生成 TXT 失败；请保留本页数据并反馈面板状态。": [
      "Could not generate TXT. Keep this page's data and report the panel status.",
      "TXT を生成できませんでした。このページのデータを保持し、パネルの状態を報告してください。"
    ],
    "正在从本地进度导出完整 PID → tags 数据…": [
      "Exporting complete PID → tags data from the local checkpoint…",
      "ローカルの進捗から全 PID → tags データをエクスポート中…"
    ],
    "已发起下载 pixiv-bookmark-records.json，共 {0} 条。\n导出仅使用本地数据，没有重新请求 Pixiv。": [
      "Started downloading pixiv-bookmark-records.json with {0} records.\nOnly local data was used; no new Pixiv request was made.",
      "{0} 件を含む pixiv-bookmark-records.json のダウンロードを開始しました。\nローカルデータだけを使用し、Pixiv への再取得は行っていません。"
    ],
    "\n这是部分结果，complete: false。": [
      "\nThis is a partial result; complete: false.",
      "\nこれは途中の結果です。complete は false です。"
    ],
    "导出 JSON 失败；请保留本地进度并反馈面板状态。": [
      "JSON export failed. Keep the local checkpoint and report the panel status.",
      "JSON のエクスポートに失敗しました。ローカルの進捗を保持し、パネルの状態を報告してください。"
    ],
    "展开": [
      "Expand",
      "展開"
    ],
    "收起": [
      "Collapse",
      "折りたたむ"
    ],
    "正在暂停并保存…": [
      "Pausing and saving…",
      "一時停止して保存中…"
    ],
    "正在暂停；等待当前请求及进度保存结束后停止，不会开始下一批追加。": [
      "Pausing after the current request and checkpoint save. No new batch will start.",
      "現在のリクエストと進捗保存が終わり次第一時停止します。次のバッチは開始しません。"
    ],
    "已有集合选项已更新。可以重新自动选集；写入前请再次核对。": [
      "The existing-category option was updated. You can run auto-selection again; check again before writing.",
      "既存分類の設定を更新しました。自動選択を再実行できます。書き込み前に再確認してください。"
    ],
    "已撤销上次选择改动。": [
      "Undid the last selection change.",
      "直前の選択変更を元に戻しました。"
    ],
    "清除本脚本的扫描缓存、分类参数及追加进度？会失去沿用原分类的对应关系。Pixiv 总收藏和分类保留。请先导出参数。": [
      "Clear this script's scan cache, classification settings, and append progress? The mapping used to update existing categories will be lost. Pixiv bookmarks and categories are kept. Export your settings first.",
      "スキャンキャッシュ、分類設定、追加の進捗を消去しますか？既存の分類を更新するための対応表が失われます。Pixiv のブックマークと分類は保持されます。先に設定をエクスポートしてください。"
    ],
    "本地扫描数据已清除。": [
      "Local scan data cleared.",
      "ローカルのスキャンデータを消去しました。"
    ],
    "清除失败；本页数据保留。": [
      "Clearing failed. This page's data is kept.",
      "消去に失敗しました。このページのデータは保持しています。"
    ],
    "已恢复上次完成的数据；可直接打开分类试用或导出数据，无需重新扫描。": [
      "Restored the completed scan. Open the classification preview or export data without scanning again.",
      "完了済みのスキャンを復元しました。再スキャンせずに分類プレビューやエクスポートを利用できます。"
    ],
    "已恢复上次进度。继续时会从头核对列表并按 PID 去重，避免刷新后页码偏移。": [
      "Restored the checkpoint. Continuing will check the list from the start and deduplicate by PID to avoid page-offset drift after reload.",
      "前回の進捗を復元しました。再開時には先頭から確認して PID で重複を除き、再読み込み後のページ位置のずれを防ぎます。"
    ],
    "已识别账户，点“开始 / 继续”。": [
      "Account detected. Click “Start / resume”.",
      "アカウントを認識しました。「開始・再開」を押してください。"
    ],
    "先登录 Pixiv，再填写自己收藏页网址 /users/ 后的数字 ID。": [
      "Sign in to Pixiv, then enter the numeric ID after /users/ in your own bookmarks URL.",
      "Pixiv にログインし、自分のブックマーク URL の /users/ に続く数字の ID を入力してください。"
    ],
    "保存的分类参数或追加记录无法读取。请保留数据并反馈；追加功能已停用，避免创建重复分类。": [
      "Saved classification settings or the append log could not be read. Keep the data and report the issue. Appending is disabled to avoid duplicate categories.",
      "保存した分類設定または追加ログを読み取れません。データを保持して問題を報告してください。分類の重複を避けるため追加機能を無効にしています。"
    ],
    "本地进度读取失败。请保留当前脚本及数据并反馈，避免丢失已有分类参数。": [
      "Could not read the local checkpoint. Keep the script and data and report the issue to avoid losing classification settings.",
      "ローカルの進捗を読み取れません。分類設定を失わないよう、現在のスクリプトとデータを保持して問題を報告してください。"
    ],
    "收藏分类工具 · v0.4.0": [
      "Bookmark Classifier · v0.4.0",
      "ブックマーク分類ツール · v0.4.0"
    ],
    "保留总收藏 · 保留原分类 · 仅追加新分类": [
      "Keep all bookmarks and existing categories · Add new categories only",
      "総ブックマークと既存分類を保持 · 新しい分類のみ追加"
    ],
    "自己的 Pixiv 用户 ID": [
      "Your Pixiv user ID",
      "自分の Pixiv ユーザー ID"
    ],
    "开始 / 继续": [
      "Start / resume",
      "開始・再開"
    ],
    "暂停": [
      "Pause",
      "一時停止"
    ],
    "重新核对": [
      "Rescan",
      "再スキャン"
    ],
    "准备中…": [
      "Preparing…",
      "準備中…"
    ],
    "打开分类试用": [
      "Open classification preview",
      "分類プレビューを開く"
    ],
    "更新分类": [
      "Update categories",
      "分類を更新"
    ],
    "导出 TXT": [
      "Export TXT",
      "TXT を出力"
    ],
    "匿名 TXT": [
      "Anonymous TXT",
      "匿名 TXT"
    ],
    "导出原始 JSON": [
      "Export raw JSON",
      "元データ JSON を出力"
    ],
    "本地进度": [
      "Local progress",
      "ローカルの進捗"
    ],
    "最小请求启动间隔 100 ms，串行请求；出错即暂停。": [
      "Requests are serial, at least 100 ms apart. Errors pause the scan.",
      "リクエストは直列で、開始間隔は最低 100 ms です。エラー時に一時停止します。"
    ],
    "清除本地扫描数据": [
      "Clear local scan data",
      "ローカルのスキャンデータを消去"
    ],
    "已有完整数据时可直接试用分类。扫描中请保持此页打开，暂时别增删或切换收藏公开状态。": [
      "With a completed scan, you can open the preview immediately. Keep this page open while scanning; avoid adding, removing, or changing bookmark visibility.",
      "完了済みデータがあれば、そのままプレビューを開けます。スキャン中はページを開いたままにし、ブックマークの追加・削除・公開設定の変更を控えてください。"
    ],
    "分类预览与追加 · v0.4.0": [
      "Preview & add categories · v0.4.0",
      "分類のプレビューと追加 · v0.4.0"
    ],
    "返回扫描面板": [
      "Back to scanner",
      "スキャン画面に戻る"
    ],
    "已选分类": [
      "Selected categories",
      "選択した分類"
    ],
    "已覆盖 / 可读作品": [
      "Covered / readable works",
      "分類済み / 閲覧可能作品"
    ],
    "单件最多匹配分类": [
      "Most categories per work",
      "1 作品あたりの最大分類数"
    ],
    "先预览规则，再核对已有标签和剩余位置；点“开始追加”才会写入 Pixiv。总收藏保留，原有标签不删除。": [
      "Preview rules, then check existing tags and free slots. Pixiv is updated only after “Start adding”. All bookmarks and existing tags are kept.",
      "ルールをプレビューし、既存タグと空き枠を確認してください。「追加開始」を押すと Pixiv に書き込みます。総ブックマークと既存タグは保持します。"
    ],
    "已有分类要纳入已成集合吗？": [
      "Count existing categories as already covered?",
      "既存の分類を分類済みとして含めますか？"
    ],
    "纳入：原有分类中的作品算已覆盖，原分类成员保持原样。": [
      "Include: works in existing categories count as covered; their membership stays unchanged.",
      "含める：既存分類の作品を分類済みとして数え、既存のメンバーは変更しません。"
    ],
    "默认不纳入。点下方“核对 / 更新主收藏”会读取已有收藏标签。": [
      "Off by default. “Check / refresh bookmarks” reads existing bookmark tags.",
      "初期設定はオフです。「ブックマークを確認・更新」で既存のブックマークタグを読み取ります。"
    ],
    "核对 / 更新主收藏": [
      "Check / refresh bookmarks",
      "ブックマークを確認・更新"
    ],
    "开始追加": [
      "Start adding",
      "追加開始"
    ],
    "暂停追加": [
      "Pause adding",
      "追加を一時停止"
    ],
    "导出参数与追加记录": [
      "Export settings & append log",
      "設定と追加ログを出力"
    ],
    "规则和分类名称会保留，之后用“更新分类”继续处理新增收藏。": [
      "Rules and category names are saved. Use “Update categories” later to process new bookmarks.",
      "ルールと分類名を保存します。今後は「分類を更新」で新しいブックマークを処理できます。"
    ],
    "新增分类名称与未处理清单": [
      "New category names & skipped works",
      "新しい分類名と未処理一覧"
    ],
    "自动选集": [
      "Auto-select",
      "自動選択"
    ],
    "停止计算": [
      "Stop calculation",
      "計算を停止"
    ],
    "撤销上次改动": [
      "Undo last change",
      "直前の変更を戻す"
    ],
    "保存本地方案": [
      "Save local plan",
      "ローカルに保存"
    ],
    "导出分类方案": [
      "Export classification plan",
      "分類プランを出力"
    ],
    "正在准备…": [
      "Preparing…",
      "準備中…"
    ],
    "分类标签": [
      "Category tags",
      "分類タグ"
    ],
    "已选": [
      "Selected",
      "選択済み"
    ],
    "全部": [
      "All",
      "すべて"
    ],
    "未选": [
      "Unselected",
      "未選択"
    ],
    "勾选调整分类；点作品数量可查看对应 PID。自动选集跳过 R-18 和 users入り，手动仍可选择。": [
      "Use checkboxes to adjust categories; click a count to view PIDs. Auto-selection skips R-18 and users入り tags; manual selection is available.",
      "チェックで分類を調整し、件数を押すと PID を確認できます。自動選択は R-18 と users入り を除外しますが、手動で選択できます。"
    ],
    "上一页": [
      "Previous",
      "前へ"
    ],
    "下一页": [
      "Next",
      "次へ"
    ],
    "全部作品": [
      "All works",
      "すべての作品"
    ],
    "只看未覆盖": [
      "Uncovered only",
      "未分類のみ"
    ],
    "点击 PID 打开作品；下方列出当前匹配的分类及原始 tag。": [
      "Click a PID to open the work. Matching categories and original tags are listed below it.",
      "PID を押すと作品を開きます。その下に一致する分類と元のタグを表示します。"
    ],
    "Pixiv 收藏参数扫描器": [
      "Pixiv Bookmark Classifier",
      "Pixiv ブックマーク分類ツール"
    ],
    "收起或展开": [
      "Collapse or expand",
      "折りたたむ・展開する"
    ],
    "例如收藏页 /users/123456/ 中的数字": [
      "Digits in your bookmarks URL, e.g. /users/123456/",
      "ブックマーク URL の数字（例：/users/123456/）"
    ],
    "本地分类试用": [
      "Local classification preview",
      "ローカルの分類プレビュー"
    ],
    "搜索原始 tag": [
      "Search original tags",
      "元のタグを検索"
    ],
    "搜索分类标签": [
      "Search category tags",
      "分類タグを検索"
    ],
    "标签筛选": [
      "Tag filter",
      "タグの絞り込み"
    ],
    "界面语言": [
      "Interface language",
      "表示言語"
    ],
    "跟随浏览器": [
      "Browser default",
      "ブラウザーに合わせる"
    ],
    "语言设置保存失败，请重试。": [
      "Could not save the language preference. Try again.",
      "言語設定を保存できませんでした。再試行してください。"
    ]
  });

  function resolveLanguage(preference = 'auto', browserLanguages = []) {
    if (LANGUAGES.includes(preference)) return preference;
    const candidates = Array.isArray(browserLanguages) ? browserLanguages : [browserLanguages];
    for (const value of candidates) {
      const language = String(value || '').toLowerCase().split(/[-_]/u)[0];
      if (LANGUAGES.includes(language)) return language;
    }
    return 'en';
  }
  const browserLanguages = () => {
    if (typeof navigator === 'undefined') return [];
    return navigator.languages?.length ? [...navigator.languages] : [navigator.language];
  };
  let languagePreference = 'auto';
  let language = typeof document === 'undefined' ? 'zh' : resolveLanguage('auto', browserLanguages());
  function setLanguage(value) {
    language = LANGUAGES.includes(value) ? value : 'en';
  }
  function translate(key, values = [], locale = language) {
    const entry = TRANSLATIONS[key];
    const text = locale === 'zh' || !entry ? key : entry[locale === 'ja' ? 1 : 0];
    return text.replace(/\{(\d+)\}/gu, (token, index) => index < values.length ? String(values[index] ?? '') : token);
  }
  class LocalizedText {
    constructor(key, values) { this.key = key; this.values = values; }
    toString() { return translate(this.key, this.values); }
  }
  const t = (key, ...values) => new LocalizedText(key, values);
  const joinText = (...values) => t(values.map((_, i) => `{${i}}`).join(''), ...values);
  const dateText = (value, timeOnly = false) => ({ toString: () => {
    const date = new Date(value), locale = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US';
    return timeOnly ? date.toLocaleTimeString(locale) : date.toLocaleString(locale);
  } });
  class LocalizedError extends Error {
    constructor(detail) { super(String(detail)); this.detail = detail; }
  }
  const errorText = error => error?.detail || error?.message || '';

  const scopeName = (rest) => rest === 'show' ? t("公开") : t("非公开");
  const nowISO = () => new Date().toISOString();
  const numericId = (value) => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : null;
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const encoder = new TextEncoder();

  class ScanError extends LocalizedError {
    constructor(code, message, blockedUntil = 0) {
      super(message);
      this.code = code;
      this.blockedUntil = blockedUntil;
    }
  }

  function newScope() {
    return { offset: 0, pages: 0, totalFirst: null, totalLatest: null,
      rows: 0, duplicates: 0, done: false };
  }

  function newSession(uid, intervalMs) {
    return { schema: 1, version: VERSION, uid, intervalMs, pass: 1,
      startedAt: nowISO(), savedAt: null, finishedAt: null, complete: false,
      blockedUntil: 0, requestCount: 0, notices: [], records: [],
      scopes: { show: newScope(), hide: newScope() } };
  }

  function addNotice(session, code) {
    if (!session.notices.includes(code)) session.notices.push(code);
    session.notices = session.notices.slice(-CONFIG.maxNotices);
  }

  function restartEnumeration(session) {
    session.pass += 1;
    session.scopes = { show: newScope(), hide: newScope() };
    session.startedAt = nowISO();
    session.finishedAt = null;
    session.complete = false;
    session.notices = [];
    addNotice(session, 'REENUMERATED_AFTER_RELOAD');
  }

  function normalizeWork(work, rest, rowNumber, pass) {
    const valid = work && typeof work === 'object' && !Array.isArray(work);
    const pid = valid ? numericId(work.id) : null;
    const bookmarkId = valid ? numericId(work.bookmarkData?.id) : null;
    // Deleted/masked works may have no PID. Never collapse all of them into "0".
    const key = pid ? `p:${pid}` : bookmarkId ? `b:${bookmarkId}` : `row:${rest}:${rowNumber}`;
    const record = { key, pid, rest, seen: pass, accessible: false, reason: '', tags: [] };
    if (!valid) record.reason = 'MALFORMED_WORK';
    else if (work.isMasked === true || work.isMasked === 1) record.reason = 'MASKED_OR_UNAVAILABLE';
    else if (!pid) record.reason = 'MISSING_PID';
    else {
      const rawTags = Array.isArray(work.tags) ? work.tags : work.tags?.tags;
      if (!Array.isArray(rawTags)) record.reason = 'TAGS_UNAVAILABLE';
      else {
        const tags = rawTags.map((item) => typeof item === 'string' ? item : item?.tag);
        if (tags.some((tag) => typeof tag !== 'string' || !tag.length)) record.reason = 'MALFORMED_TAGS';
        else {
          // Exact original tag strings; no translation, case folding or synonym merge.
          record.tags = [...new Set(tags)];
          record.accessible = true;
        }
      }
    }
    return record;
  }

  function validatePage(json) {
    if (!json || typeof json !== 'object' || typeof json.error !== 'boolean')
      throw new ScanError('BAD_ENVELOPE', t("接口格式发生变化；已暂停，请导出当前 TXT。"));
    if (json.error) throw new ScanError('API_ERROR', t("Pixiv 返回接口错误；请检查登录状态及自己的收藏页。"));
    const body = json.body;
    if (!body || !Array.isArray(body.works) || !Number.isSafeInteger(body.total) || body.total < 0)
      throw new ScanError('BAD_PAGE', t("收藏页数据不符合预期；已暂停，未跳过这一页。"));
    return body;
  }

  function ingestPage(session, index, rest, body) {
    const state = session.scopes[rest];
    if (state.pages >= CONFIG.maxPagesPerScope)
      throw new ScanError('PAGE_CAP', t("达到原型分页上限；已暂停，可导出当前数据。"));
    const rows = body.works.map((work, i) => normalizeWork(work, rest, state.offset + i, session.pass));
    const newKeys = new Set(rows.filter((r) => !index.has(r.key)).map((r) => r.key));
    if (index.size + newKeys.size > CONFIG.maxRecords)
      throw new ScanError('RECORD_CAP', t("达到原型 100,000 条缓存上限；已暂停，请导出当前 TXT。"));
    if (state.totalFirst === null) state.totalFirst = body.total;
    if (state.totalLatest !== null && state.totalLatest !== body.total) addNotice(session, 'TOTAL_CHANGED_DURING_SCAN');
    state.totalLatest = body.total;
    if (!rows.length && state.offset < body.total)
      throw new ScanError('EARLY_EMPTY_PAGE', t("提前收到空页；已暂停，避免把缺失数据当成完整结果。"));
    let fresh = 0;
    for (const row of rows) {
      const previous = index.get(row.key);
      if (previous?.seen === session.pass) {
        state.duplicates += 1;
        addNotice(session, 'DUPLICATE_ROWS_OR_LIST_DRIFT');
      } else fresh += 1;
      if (row.key.startsWith('row:')) addNotice(session, 'UNIDENTIFIABLE_ROWS');
      index.set(row.key, row);
    }
    if (rows.length && !fresh) {
      // Keep the current offset on error; a manual continuation retries this page.
      throw new ScanError('REPEATED_PAGE', t("这一页全部重复；已暂停，请用“重新核对”检查列表。"));
    }
    state.rows += rows.length;
    state.pages += 1;
    // Use the actual returned page size: the server may silently clamp limit.
    state.offset += rows.length;
    state.done = rows.length === 0 || state.offset >= body.total;
  }

  function activeRecords(session, index) {
    return [...index.values()].filter((r) => r.seen === session.pass);
  }

  function finalizeSession(session, index) {
    for (const [key, record] of index) if (record.seen !== session.pass) index.delete(key);
    const counts = { show: 0, hide: 0 };
    for (const record of index.values()) counts[record.rest] += 1;
    for (const rest of SCOPES) {
      const state = session.scopes[rest];
      if (counts[rest] !== state.totalLatest || state.totalFirst !== state.totalLatest)
        addNotice(session, 'OBSERVED_TOTAL_MISMATCH');
    }
    session.complete = SCOPES.every((rest) => session.scopes[rest].done);
    session.finishedAt = nowISO();
  }

  function quantile(sorted, probability) {
    if (!sorted.length) return null;
    const at = (sorted.length - 1) * probability;
    const low = Math.floor(at), high = Math.ceil(at);
    return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
  }

  function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const frequencies = new Map();
    for (const value of sorted) frequencies.set(value, (frequencies.get(value) || 0) + 1);
    let modeFrequency = 0;
    for (const n of frequencies.values()) modeFrequency = Math.max(modeFrequency, n);
    const modes = [...frequencies].filter(([, n]) => n === modeFrequency).map(([v]) => v);
    const median = quantile(sorted, 0.5);
    const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const result = { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      median, mad: quantile(deviations, 0.5), modes, modeFrequency };
    for (const [label, p] of [['min', 0], ['p10', .1], ['p25', .25], ['p75', .75], ['p90', .9], ['p95', .95], ['p99', .99], ['max', 1]])
      result[label] = quantile(sorted, p);
    return result;
  }

  function patternMatches(tag) {
    return /\d[\d,.]*(?:万|千|[kKmM])?users入り$/u.test(tag.normalize('NFKC'));
  }

  function analyze(records) {
    const tags = new Map();
    const readable = records.filter((r) => r.accessible);
    let memberships = 0, patternArtworks = 0, patternMemberships = 0, emptyTagWorks = 0;
    for (const record of readable) {
      if (!record.tags.length) emptyTagWorks += 1;
      let hasPattern = false;
      for (const tag of record.tags) {
        if (!tags.has(tag)) tags.set(tag, { tag, count: 0, public: 0, private: 0, pattern: patternMatches(tag) });
        const item = tags.get(tag);
        item.count += 1;
        item[record.rest === 'show' ? 'public' : 'private'] += 1;
        memberships += 1;
        if (item.pattern) { hasPattern = true; patternMemberships += 1; }
      }
      if (hasPattern) patternArtworks += 1;
    }
    const ranked = [...tags.values()].sort((a, b) => b.count - a.count || compareText(a.tag, b.tag));
    const top = ranked.slice(0, CONFIG.pairTopN);
    const topIndex = new Map(top.map((item, i) => [item.tag, i]));
    const pairs = new Map(), triples = new Map();
    const pairKey = (a, b) => `${a},${b}`;
    for (const record of readable) {
      const present = record.tags.filter((tag) => topIndex.has(tag)).map((tag) => topIndex.get(tag)).sort((a, b) => a - b);
      for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
        const key = pairKey(present[i], present[j]);
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
      const few = present.filter((i) => i < CONFIG.tripleTopN);
      for (let i = 0; i < few.length; i++) for (let j = i + 1; j < few.length; j++) for (let k = j + 1; k < few.length; k++) {
        const key = `${few[i]},${few[j]},${few[k]}`;
        triples.set(key, (triples.get(key) || 0) + 1);
      }
    }
    const pairRows = [];
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j], intersection = pairs.get(pairKey(i, j)) || 0;
      const union = a.count + b.count - intersection;
      pairRows.push({ a: a.tag, b: b.tag, intersection, union,
        aContainment: intersection / a.count, bContainment: intersection / b.count, jaccard: intersection / union });
    }
    const tripleRows = [];
    const kTop = Math.min(top.length, CONFIG.tripleTopN);
    for (let i = 0; i < kTop; i++) for (let j = i + 1; j < kTop; j++) for (let k = j + 1; k < kTop; k++)
      tripleRows.push({ a: top[i].tag, b: top[j].tag, c: top[k].tag, intersection: triples.get(`${i},${j},${k}`) || 0 });
    const histogram = new Map();
    for (const item of ranked) histogram.set(item.count, (histogram.get(item.count) || 0) + 1);
    const counts = ranked.map((r) => r.count);
    return { ranked, readable: readable.length, memberships, patternArtworks, patternMemberships, emptyTagWorks,
      failures: records.filter((r) => !r.accessible), distribution: distribution(counts),
      logDistribution: distribution(counts.map(Math.log)),
      nonPatternDistribution: distribution(ranked.filter((r) => !r.pattern).map((r) => r.count)),
      histogram: [...histogram].sort((a, b) => a[0] - b[0]), pairRows, tripleRows };
  }

  const fmt = (value) => value === null || value === undefined || !Number.isFinite(value) ? 'NA' :
    Number.isInteger(value) ? String(value) : value.toFixed(8);
  const ratio = (a, b) => b ? a / b : null;
  // JSON quoting keeps original tags containing tabs/newlines unambiguous in TSV.
  const quote = (text) => JSON.stringify(text);

  function buildReport(session, records, anonymous = false) {
    const data = analyze(records);
    const aliases = new Map(data.ranked.map((r, i) => [r.tag, `TAG_${String(i + 1).padStart(6, '0')}`]));
    const label = (tag) => quote(anonymous ? aliases.get(tag) : tag);
    const lines = ['PIXIV BOOKMARK PARAMETERS', `report_schema: 1`, `prototype_version: ${VERSION}`,
      `generated_at_utc: ${nowISO()}`, `started_at_utc: ${session.startedAt}`,
      `finished_at_utc: ${session.finishedAt || 'NA'}`, `complete: ${session.complete}`,
      `anonymous: ${anonymous}`, 'scope: artwork bookmarks (illustrations / manga / ugoira); novels excluded',
      'source: artwork tags from bookmark-list API; bookmark tags excluded',
      'availability: list metadata only; no per-artwork access check',
      'count_unit: one artwork/PID, not one image page',
      'tags: exact strings, unique per artwork; no automatic filtering or selection',
      'fractions: 0..1; support_observed denominator includes unavailable records',
      'support_readable denominator includes readable empty-tag works',
      'quantiles: linear interpolation, index=(n-1)*p; ln=MATH.LOG; MAD unscaled',
      'snapshot: live offset pagination is not an atomic snapshot; keep bookmarks unchanged while scanning',
      'table_format: tab-separated; tag fields are JSON-quoted strings', '', '=== SUMMARY ===',
      `observed_unique_records: ${records.length}`, `successfully_readable: ${data.readable}`,
      `exceptions: ${data.failures.length}`, `readable_empty_tag_works: ${data.emptyTagWorks}`,
      `unique_tags: ${data.ranked.length}`, `tag_memberships: ${data.memberships}`,
      `request_interval_ms: ${session.intervalMs}`, `concurrency: 1`, `page_size_requested: ${CONFIG.pageSize}`,
      `requests_session_lifetime: ${session.requestCount}`];
    for (const rest of SCOPES) {
      const s = session.scopes[rest], prefix = rest === 'show' ? 'public' : 'private';
      lines.push(`${prefix}_api_total_first: ${fmt(s.totalFirst)}`, `${prefix}_api_total_latest: ${fmt(s.totalLatest)}`,
        `${prefix}_observed_unique: ${records.filter((r) => r.rest === rest).length}`,
        `${prefix}_pages: ${s.pages}`, `${prefix}_duplicates: ${s.duplicates}`, `${prefix}_complete: ${s.done}`);
    }
    const writeDistribution = (title, d, withModes = true) => {
      lines.push('', `=== ${title} ===`);
      for (const key of ['n', 'min', 'p10', 'p25', 'median', 'p75', 'p90', 'p95', 'p99', 'max', 'mean', 'mad']) lines.push(`${key}: ${fmt(d[key])}`);
      if (withModes) lines.push(`modes: ${d.modes.length ? d.modes.join(', ') : 'NA'}`, `mode_frequency: ${d.modeFrequency}`);
    };
    writeDistribution('TAG COUNT DISTRIBUTION — ALL TAGS', data.distribution);
    writeDistribution('LN(COUNT) DISTRIBUTION — ALL TAGS', data.logDistribution, false);
    writeDistribution('TAG COUNT DISTRIBUTION — EXCLUDING PATTERN MATCHES (COMPARISON ONLY)', data.nonPatternDistribution);
    lines.push('', '=== COUNT HISTOGRAM — COMPLETE ===', 'count\tnumber_of_tags');
    for (const [count, frequency] of data.histogram) lines.push(`${count}\t${frequency}`);
    lines.push('', '=== TAG COUNTS — COMPLETE ===', 'tag\tcount\tsupport_observed\tsupport_readable\tpublic\tprivate\tusers_iri_pattern');
    for (const item of data.ranked) lines.push([label(item.tag), item.count, fmt(ratio(item.count, records.length)),
      fmt(ratio(item.count, data.readable)), item.public, item.private, item.pattern].join('\t'));
    lines.push('', '=== PAIR INTERSECTIONS — TOP FREQUENCY TAGS ONLY ===',
      `top_n: ${Math.min(data.ranked.length, CONFIG.pairTopN)}`, 'selection: count descending, exact-string tie break; includes zero overlaps and pattern tags',
      'tag_a\ttag_b\tintersection\tunion\ta_containment\tb_containment\tjaccard');
    for (const row of data.pairRows) lines.push([label(row.a), label(row.b), row.intersection, row.union,
      fmt(row.aContainment), fmt(row.bContainment), fmt(row.jaccard)].join('\t'));
    lines.push('', '=== TRIPLE INTERSECTIONS — TOP FREQUENCY TAGS ONLY ===',
      `top_n: ${Math.min(data.ranked.length, CONFIG.tripleTopN)}`, 'tag_a\ttag_b\ttag_c\tintersection\tsupport_observed');
    for (const row of data.tripleRows) lines.push([label(row.a), label(row.b), label(row.c), row.intersection,
      fmt(ratio(row.intersection, records.length))].join('\t'));
    lines.push('', '=== PATTERN STATS ===', 'rule: numeric threshold + optional 万/千/k/m + users入り suffix; NFKC for matching only',
      `matched_unique_tags: ${data.ranked.filter((r) => r.pattern).length}`,
      `matched_memberships: ${data.patternMemberships}`, `artworks_with_pattern: ${data.patternArtworks}`,
      'action: annotation only; all original tags retained', '', '=== EXCEPTIONS ===',
      anonymous ? 'anonymous_record\tscope\taccessible\treason' : 'pid_or_placeholder\tscope\taccessible\treason');
    data.failures.forEach((r, i) => lines.push([anonymous ? `EXCEPTION_${String(i + 1).padStart(6, '0')}` : (r.pid || r.key),
      r.rest === 'show' ? 'public' : 'private', false, r.reason].join('\t')));
    lines.push('', '=== STATUS / NOTICES (LAST 20 UNIQUE CODES) ===', ...(session.notices.length ? session.notices : ['NONE']),
      session.complete ? 'SCAN_FINISHED: inspect exceptions and consistency notices above.' : 'PARTIAL_REPORT: scan has not finished both scopes.',
      anonymous ? 'Names and identifiers replaced; tag frequencies still describe the collection.' : 'Contains original tags and exception identifiers; no account ID, titles or image URLs.', '');
    return lines.join('\r\n');
  }

  function buildRawExport(session, records) {
    // Explicit field allowlist: never serialize the whole session (which holds the account ID).
    // Keep the v1 cache key and schema so 0.1.0 checkpoints work without rescanning.
    const current = records.filter((r) => r.seen === session.pass);
    const readable = current.filter((r) => r.accessible);
    const tags = new Set();
    let memberships = 0;
    for (const r of readable) for (const tag of r.tags) { tags.add(tag); memberships += 1; }
    return {
      export_schema: 'pixiv-bookmark-records/v1',
      exporter_version: VERSION,
      scanner_version: session.version,
      exported_at_utc: nowISO(),
      started_at_utc: session.startedAt,
      finished_at_utc: session.finishedAt,
      complete: session.complete,
      source: 'artwork tags from bookmark-list API; no per-artwork access check',
      summary: {
        observed_unique_records: current.length,
        successfully_readable: readable.length,
        exceptions: current.length - readable.length,
        unique_tags: tags.size,
        tag_memberships: memberships,
      },
      scopes: Object.fromEntries(SCOPES.map((rest) => [rest === 'show' ? 'public' : 'private', {
        api_total_first: session.scopes[rest].totalFirst,
        api_total_latest: session.scopes[rest].totalLatest,
        observed_unique: current.filter((r) => r.rest === rest).length,
        complete: session.scopes[rest].done,
      }])),
      notices: [...session.notices],
      records: current.map((r) => ({
        key: r.key,
        pid: r.pid,
        visibility: r.rest === 'show' ? 'public' : 'private',
        accessible: r.accessible,
        reason: r.reason || null,
        tags: [...r.tags],
      })),
    };
  }

  function buildClassificationModel(records) {
    const readable = records.filter((record) => record.accessible);
    const tags = new Map();
    readable.forEach((record, workIndex) => {
      for (const tag of new Set(record.tags)) {
        if (!tags.has(tag)) tags.set(tag, { tag, works: [], autoExcluded: tag === 'R-18' || patternMatches(tag) });
        tags.get(tag).works.push(workIndex);
      }
    });
    const ranked = [...tags.values()].sort((a, b) => b.works.length - a.works.length || compareText(a.tag, b.tag));
    return { records: readable, ignored: records.length - readable.length, tags, ranked, existingCovered: new Set() };
  }

  function selectionStats(model, selected) {
    const counts = new Uint32Array(model.records.length);
    let selectedCount = 0, assignments = 0, maximum = 0;
    for (const tag of selected) {
      const row = model.tags.get(tag);
      if (!row) continue;
      selectedCount += 1;
      for (const work of row.works) { counts[work] += 1; assignments += 1; }
    }
    const uncovered = [], overLimit = [];
    for (let i = 0; i < counts.length; i++) {
      if (!counts[i] && !model.existingCovered?.has(i)) uncovered.push(i);
      if (counts[i] > LOCAL_TAG_LIMIT) overLimit.push(i);
      maximum = Math.max(maximum, counts[i]);
    }
    return { counts, selectedCount, assignments, maximum, uncovered, overLimit,
      covered: counts.length - uncovered.length,
      coverage: counts.length ? (counts.length - uncovered.length) / counts.length : null };
  }

  async function automaticSelection(model, options = {}) {
    // Greedy set cover with a per-work local assignment cap. Exact original tags only.
    // A reverse deletion pass removes redundant choices; this is not a global optimum proof.
    const candidates = model.ranked.filter((row) => !row.autoExcluded);
    const selected = new Set(), counts = new Uint32Array(model.records.length);
    let covered = model.existingCovered?.size || 0, rounds = 0;
    const yieldNow = options.yieldNow || (() => Promise.resolve());
    const checkCancelled = () => { if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
    while (covered < model.records.length) {
      checkCancelled();
      let best = null, bestGain = 0;
      for (const row of candidates) {
        if (selected.has(row.tag)) continue;
        let gain = 0, fits = true;
        for (const work of row.works) {
          if (counts[work] >= LOCAL_TAG_LIMIT) { fits = false; break; }
          if (!counts[work] && !model.existingCovered?.has(work)) gain += 1;
        }
        if (fits && gain > bestGain) { best = row; bestGain = gain; }
      }
      if (!best) break;
      selected.add(best.tag);
      for (const work of best.works) { if (!counts[work] && !model.existingCovered?.has(work)) covered += 1; counts[work] += 1; }
      if (++rounds % 8 === 0) {
        options.progress?.({ covered, total: model.records.length, selected: selected.size });
        await yieldNow();
      }
    }
    for (const tag of [...selected].reverse()) {
      checkCancelled();
      const works = model.tags.get(tag).works;
      if (works.every((work) => counts[work] > 1 || model.existingCovered?.has(work))) {
        selected.delete(tag);
        for (const work of works) counts[work] -= 1;
      }
    }
    checkCancelled();
    return selected;
  }

  function buildSelectionExport(session, model, selected, fingerprint) {
    const stats = selectionStats(model, selected);
    return {
      export_schema: 'pixiv-bookmark-classification/v1', exporter_version: VERSION,
      exported_at_utc: nowISO(), mode: 'local_preview', source_complete: session.complete,
      source_finished_at_utc: session.finishedAt, source_fingerprint: fingerprint,
      existing_bookmark_tags_checked: !!model.existingTagSnapshot, remote_write_performed: false,
      existing_category_coverage: model.existingCovered?.size || 0,
      method: 'greedy_cover_then_reverse_prune_with_optional_manual_edits',
      globally_minimal: 'not_proven', local_tags_per_work_limit: LOCAL_TAG_LIMIT,
      automatic_exclusions: ['exact:R-18', 'numeric-users入り-suffix'],
      summary: { readable_universe: model.records.length, ignored_inaccessible: model.ignored,
        selected_tags: stats.selectedCount, covered: stats.covered, uncovered: stats.uncovered.length,
        coverage: stats.coverage, assignments: stats.assignments,
        max_selected_tags_per_work: stats.maximum, over_limit: stats.overLimit.length },
      selected_tags: model.ranked.filter((row) => selected.has(row.tag)).map((row) => row.tag),
      // No account ID, credentials, existing bookmark tags or inaccessible records in assignments.
      assignments: model.records.map((record) => ({ pid: record.pid,
        visibility: record.rest === 'show' ? 'public' : 'private',
        tags: [...new Set(record.tags)].filter((tag) => selected.has(tag)) })),
      uncovered_pids: stats.uncovered.map((work) => model.records[work].pid),
    };
  }

  async function sourceFingerprint(session, records) {
    const rows = records.map((record) => [record.key, record.rest, record.accessible, [...record.tags].sort(compareText)])
      .sort((a, b) => compareText(a[0], b[0]));
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([session.uid, rows])));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function parseRetryAfter(value, clock = Date.now()) {
    if (!value) return 0;
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return clock + Number(value) * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(date, clock) : 0;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  class ReadOnlyAPI {
    constructor() { this.lastStart = -Infinity; }
    async page(session, rest, signal) {
      // Timers can wake fractionally early; recheck the monotonic deadline.
      const earliestStart = this.lastStart + session.intervalMs;
      while (performance.now() < earliestStart) await sleep(earliestStart - performance.now(), signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (session.blockedUntil > Date.now()) throw new ScanError('RETRY_AFTER', t("服务端要求等待；请在提示的时间之后继续。"), session.blockedUntil);
      const url = new URL(`/ajax/user/${session.uid}/illusts/bookmarks`, location.origin);
      url.search = new URLSearchParams({ tag: '', offset: String(session.scopes[rest].offset),
        limit: String(CONFIG.pageSize), rest, lang: 'ja' }).toString();
      if (url.origin !== 'https://www.pixiv.net' || !/^\/ajax\/user\/[1-9]\d*\/illusts\/bookmarks$/.test(url.pathname))
        throw new ScanError('URL_GUARD', t("请求地址不在本脚本的只读白名单内。"));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) controller.abort();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, CONFIG.timeoutMs);
      try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        this.lastStart = performance.now();
        session.requestCount += 1;
        const response = await fetch(url.href, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) {
          const blockedUntil = parseRetryAfter(response.headers.get('Retry-After'));
          throw new ScanError(`HTTP_${response.status}`, response.status === 429 ?
            t("HTTP 429：已暂停，不自动重试。") : t("HTTP {0}：已暂停；请检查 Pixiv 页面后再继续。", response.status), blockedUntil);
        }
        let json;
        try { json = await response.json(); }
        catch (error) {
          if (signal.aborted || timedOut) throw error;
          throw new ScanError('NON_JSON', t("返回内容不是 JSON，可能是登录页或验证页；请正常打开 Pixiv 检查。"));
        }
        return validatePage(json);
      } catch (error) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (timedOut) throw new ScanError('TIMEOUT', t("请求超时；已暂停，当前页会在继续时重试。"));
        if (error instanceof ScanError) throw error;
        throw new ScanError('NETWORK_ERROR', t("网络请求失败或发生重定向；已暂停，未把作品记成失效。"));
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
      }
    }
  }

  // Append-only operations are deliberately separate from the original scanner.
  function remotePage(body, rest, offset = 0) {
    if (!body || !Array.isArray(body.works) || !Number.isSafeInteger(body.total) || body.total < 0 ||
        !body.bookmarkTags || typeof body.bookmarkTags !== 'object' ||
        (Array.isArray(body.bookmarkTags) && body.bookmarkTags.length))
      throw new ScanError('BOOKMARK_TAGS_FORMAT', t("无法确认已有收藏标签，已停止；不会按空标签处理。"));
    return body.works.map((work, i) => {
      const row = normalizeWork(work, rest, offset + i, 1);
      const bookmarkId = numericId(work?.bookmarkData?.id);
      const tags = bookmarkId && Object.prototype.hasOwnProperty.call(body.bookmarkTags, bookmarkId) ? body.bookmarkTags[bookmarkId] : [];
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.length))
        throw new ScanError('BOOKMARK_TAGS_FORMAT', t("已有收藏标签的格式发生变化，已停止。"));
      return { ...row, bookmarkId, bookmarkTags: [...new Set(tags)] };
    });
  }

  function shortName(text, units) {
    let result = '';
    for (const char of text) { if (result.length + char.length > units) break; result += char; }
    return result;
  }

  function newCategoryNames(tags, reserved, prefix = '新_') {
    if (!prefix || prefix.length > 8 || /[\s\u0000-\u001f\u007f]/u.test(prefix))
      throw new ScanError('PREFIX', t("新分类前缀需为 1～8 个字符，不能含空格或控制字符。"));
    const nameKey = (name) => name.normalize('NFKC').toLowerCase();
    const used = new Set([...reserved].map(nameKey)), mapping = [];
    for (const tag of tags) {
      const base = prefix + tag.replace(/[\s\u0000-\u001f\u007f]+/gu, '_');
      let target = shortName(base, APPEND.nameUnits), suffix = 1;
      while (used.has(nameKey(target))) {
        const tail = `_${++suffix}`;
        target = shortName(base, APPEND.nameUnits - tail.length) + tail;
      }
      used.add(nameKey(target)); mapping.push({ source: tag, target });
    }
    return mapping;
  }

  function makeAppendJob(session, model, selected, fingerprint, snapshot, prefix, project = null) {
    const previouslySeen = new Set(project?.seenPids || []);
    const previous = project?.mapping || [];
    const sources = model.ranked.filter((r) => selected.has(r.tag)).map((r) => r.tag);
    const newNames = newCategoryNames(sources.filter((tag) => !previous.some((m) => m.source === tag)),
      new Set([...snapshot.tagNames, ...previous.map((m) => m.target)]), prefix);
    const mapping = sources.map((source) => ({ ...(previous.find((m) => m.source === source) || newNames.find((m) => m.source === source)) }));
    const names = new Map(mapping.map((m) => [m.source, m.target]));
    const current = new Map(snapshot.records.filter((r) => r.pid).map((r) => [r.pid, r]));
    const rows = model.records.map((record, work) => {
      const live = current.get(record.pid), desired = record.tags.filter((tag) => names.has(tag)).map((tag) => names.get(tag));
      let reason = '';
      if (!desired.length) reason = model.existingCovered?.has(work) ? 'EXISTING_CATEGORY' : 'NO_SELECTED_CATEGORY';
      else if (!live || !live.accessible) reason = 'NO_LONGER_READABLE';
      else if (!live.bookmarkId) reason = 'NO_BOOKMARK_ID';
      else if (JSON.stringify([...live.tags].sort(compareText)) !== JSON.stringify([...record.tags].sort(compareText))) reason = 'ARTWORK_TAGS_CHANGED';
      else if (new Set([...live.bookmarkTags, ...desired]).size > LOCAL_TAG_LIMIT) reason = 'NO_FREE_SLOTS';
      return { pid: record.pid, bookmarkId: live?.bookmarkId || null, rest: live?.rest || record.rest,
        before: live ? [...live.bookmarkTags] : [], desired, eligible: !reason, reason, blocked: '',
        baseCovered: !!model.existingCovered?.has(work), present: live ? desired.filter((tag) => live.bookmarkTags.includes(tag)) : [] };
    });
    return { schema: 1, kind: 'append_only', version: VERSION, uid: session.uid, fingerprint,
      selection: [...selected].sort(compareText), prefix, mapping, rows, ignored: model.ignored,
      newWorks: model.records.filter((r) => !previouslySeen.has(r.pid)).length,
      createdAt: nowISO(), savedAt: null, checkedAt: nowISO(), status: 'prepared', hasRequests: false,
      requests: 0, inflight: null, blockedUntil: 0, preservation: null,
      baseline: snapshot.records.map((r) => ({ key: r.key, pid: r.pid, bookmarkId: r.bookmarkId, rest: r.rest, tags: [...r.bookmarkTags] })),
      totals: { ...snapshot.totals } };
  }

  function reconcileAppendJob(job, snapshot) {
    const byId = new Map(snapshot.records.filter((r) => r.pid).map((r) => [r.pid, r]));
    for (const row of job.rows) {
      row.blocked = '';
      const live = byId.get(row.pid);
      row.present = live?.bookmarkId === row.bookmarkId ? row.desired.filter((tag) => live.bookmarkTags.includes(tag)) : [];
      if (!row.eligible) continue;
      if (!live || !live.accessible) row.blocked = 'NO_LONGER_READABLE';
      else if (live.bookmarkId !== row.bookmarkId || live.rest !== row.rest) row.blocked = 'BOOKMARK_CHANGED';
      else if (!row.before.every((tag) => live.bookmarkTags.includes(tag))) row.blocked = 'ORIGINAL_TAGS_CHANGED';
      else if (new Set([...live.bookmarkTags, ...row.desired]).size > LOCAL_TAG_LIMIT) row.blocked = 'NO_FREE_SLOTS';
    }
    // A newly named category must not unexpectedly contain unrelated works.
    const targets = new Map(job.mapping.filter((m) => !m.committed).map((m) => [m.target, new Set(job.rows.filter((r) => r.eligible && r.desired.includes(m.target)).map((r) => r.pid))]));
    for (const live of snapshot.records) for (const tag of live.bookmarkTags) {
      if (targets.has(tag) && !targets.get(tag).has(live.pid))
        throw new ScanError('CATEGORY_COLLISION', t("新分类出现计划外作品；已停止，请导出追加记录检查。"));
    }
    job.checkedAt = nowISO(); job.inflight = null;
    return appendSummary(job);
  }

  function appendSummary(job) {
    let ready = 0, done = 0, skipped = 0, assignments = 0, covered = 0;
    for (const row of job.rows) {
      if (row.present.length || row.baseCovered) covered += 1;
      if (row.reason === 'EXISTING_CATEGORY') { done += 1; continue; }
      if (!row.eligible || row.blocked) { skipped += 1; continue; }
      const missing = row.desired.filter((tag) => !row.present.includes(tag));
      if (missing.length) { ready += 1; assignments += missing.length; } else done += 1;
    }
    return { universe: job.rows.length, ready, done, skipped, assignments, covered };
  }

  function preservationCheck(job, snapshot) {
    const live = new Map(snapshot.records.map((r) => [r.key, r]));
    let missing = 0, changed = 0, lostTags = 0;
    for (const original of job.baseline) {
      const row = live.get(original.key);
      if (!row) { missing += 1; continue; }
      if (row.bookmarkId !== original.bookmarkId || row.rest !== original.rest) changed += 1;
      if (!original.tags.every((tag) => row.bookmarkTags.includes(tag))) lostTags += 1;
    }
    const sameCount = snapshot.records.length === job.baseline.length && SCOPES.every((rest) => snapshot.totals[rest] === job.totals[rest]);
    return { checked_at_utc: nowISO(), original_records: job.baseline.length, current_records: snapshot.records.length,
      missing, changed_bookmark_or_visibility: changed, original_tags_missing: lostTags,
      totals_unchanged: sameCount, passed: !missing && !changed && !lostTags && sameCount };
  }

  function appendReport(job) {
    return { export_schema: 'pixiv-bookmark-append-job/v1', exporter_version: VERSION,
      exported_at_utc: nowISO(), mode: 'append_only', created_at_utc: job.createdAt,
      status: job.status, may_have_sent_requests: job.hasRequests, registered_write_attempts: job.requests,
      source_fingerprint: job.fingerprint, summary: appendSummary(job), new_works: job.newWorks, ignored_inaccessible: job.ignored,
      mapping: job.mapping, assignments: job.rows, original_bookmarks: job.baseline,
      inflight: job.inflight, preservation_check: job.preservation };
  }

  class AppendAPI {
    constructor() { this.lastStart = -Infinity; this.blockedUntil = 0; this.requestCount = 0; }
    async request(path, signal, payload = null, token = null, asText = false) {
      const url = new URL(path, location.origin), writing = payload !== null;
      const allowedRead = /^\/ajax\/user\/[1-9]\d*\/illusts\/(?:bookmarks|bookmark\/tags)$/.test(url.pathname) ||
        (url.pathname === '/bookmark_add.php' && url.searchParams.get('type') === 'illust' && numericId(url.searchParams.get('illust_id')));
      if (url.origin !== 'https://www.pixiv.net' || (writing ? url.pathname !== '/ajax/illusts/bookmarks/add_tags' || url.search : !allowedRead))
        throw new ScanError('URL_GUARD', t("请求不在追加分类白名单内。"));
      if (writing && (!token || Object.keys(payload).sort().join(',') !== 'bookmarkIds,tags' ||
          !Array.isArray(payload.tags) || payload.tags.length !== 1 || typeof payload.tags[0] !== 'string' ||
          !payload.tags[0].length || payload.tags[0].length > APPEND.nameUnits ||
          !Array.isArray(payload.bookmarkIds) || !payload.bookmarkIds.length || payload.bookmarkIds.length > APPEND.batchSize ||
          payload.bookmarkIds.some((id) => !numericId(id))))
        throw new ScanError('WRITE_GUARD', t("追加参数不符合要求，未发送请求。"));
      if (this.blockedUntil > Date.now()) throw new ScanError('RETRY_AFTER', t("尚未到服务端允许继续的时间。"), this.blockedUntil);
      const earliest = this.lastStart + (writing ? APPEND.intervalMs : CONFIG.requestIntervalMs);
      while (performance.now() < earliest) await sleep(earliest - performance.now(), signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const aborter = new AbortController(), abort = () => aborter.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, CONFIG.timeoutMs);
      try {
        this.lastStart = performance.now();
        this.requestCount += 1;
        const headers = { Accept: asText ? 'text/html' : 'application/json' };
        if (writing) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-TOKEN'] = token; }
        const response = await fetch(url.href, { method: writing ? 'POST' : 'GET', credentials: 'same-origin',
          cache: 'no-store', redirect: 'error', headers, ...(writing ? { body: JSON.stringify(payload) } : {}), signal: aborter.signal });
        if (!response.ok) {
          this.blockedUntil = Math.max(this.blockedUntil, parseRetryAfter(response.headers.get('Retry-After')));
          throw new ScanError(`HTTP_${response.status}`, t("HTTP {0}：已暂停，不自动重试。", response.status), this.blockedUntil);
        }
        if (asText) return await response.text();
        const result = await response.json();
        if (!result || typeof result.error !== 'boolean' || result.error)
          throw new ScanError('API_RESULT', t("接口未明确返回成功；已暂停，请重新核对实际结果。"));
        return result.body;
      } catch (error) {
        if (error instanceof ScanError) throw error;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        throw new ScanError('REQUEST_UNCERTAIN', writing ? t("追加请求结果不确定；已暂停。继续前会重新读取实际标签，不直接重发。") : t("读取超时、失败或格式变化，已停止。"));
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    async list(uid, rest, signal, tag = '', progress = () => {}) {
      if (!numericId(uid) || !SCOPES.includes(rest)) throw new ScanError('LIST_GUARD', t("账户或公开状态无效。"));
      const records = [], keys = new Set(); let offset = 0, total = null, pages = 0;
      do {
        const params = new URLSearchParams({ tag, offset: String(offset), limit: '100', rest, lang: 'ja' });
        const body = await this.request(`/ajax/user/${uid}/illusts/bookmarks?${params}`, signal);
        const rows = remotePage(body, rest, offset);
        if ((total !== null && total !== body.total) || (!rows.length && offset < body.total))
          throw new ScanError('LIST_CHANGED', t("核对期间收藏列表发生变化或缺页，请保持收藏不变后重试。"));
        total = body.total;
        for (const row of rows) {
          if (keys.has(row.key)) throw new ScanError('LIST_DUPLICATE', t("列表出现重复记录，已停止核对。"));
          keys.add(row.key); records.push(row);
        }
        offset += rows.length; pages += 1; progress({ rest, offset, total, tag });
        if (records.length > CONFIG.maxRecords || pages > CONFIG.maxPagesPerScope)
          throw new ScanError('READ_CAP', t("达到核对资源上限，已停止。"));
      } while (offset < total);
      if (records.length !== total) throw new ScanError('LIST_TOTAL', t("核对数量与接口总数不一致。"));
      return { records, total, pages };
    }
    async snapshot(uid, signal, progress = () => {}) {
      const records = [], totals = {}, tagNames = new Set(), keys = new Set(), pageCounts = {}, startedCount = this.requestCount;
      for (const rest of SCOPES) {
        const page = await this.list(uid, rest, signal, '', progress); totals[rest] = page.total;
        pageCounts[rest] = page.pages;
        for (const row of page.records) {
          if (keys.has(row.key)) throw new ScanError('VISIBILITY_DRIFT', t("同一作品同时出现在两种公开状态中，请稍后重试。"));
          keys.add(row.key); records.push(row); row.bookmarkTags.forEach((tag) => tagNames.add(tag));
        }
      }
      if (records.length > CONFIG.maxRecords) throw new ScanError('READ_CAP', t("达到核对资源上限。"));
      const catalog = await this.request(`/ajax/user/${uid}/illusts/bookmark/tags?lang=ja`, signal);
      if (!catalog || !Array.isArray(catalog.public) || !Array.isArray(catalog.private))
        throw new ScanError('CATALOG_FORMAT', t("无法确认现有分类名称，已停止。"));
      for (const row of [...catalog.public, ...catalog.private]) {
        if (typeof row.tag !== 'string') throw new ScanError('CATALOG_FORMAT', t("现有分类名称格式发生变化。"));
        tagNames.add(row.tag);
        try { tagNames.add(decodeURIComponent(row.tag)); } catch { /* retain exact name */ }
      }
      return { records, totals, tagNames, pageCounts, requestCount: this.requestCount - startedCount };
    }
    async verifyCategory(job, category, signal, onlyIds = null) {
      const targets = job.rows.filter((row) => row.eligible && !row.blocked && row.desired.includes(category) && (!onlyIds || onlyIds.includes(row.bookmarkId)));
      const live = new Map();
      for (const rest of SCOPES) {
        const part = await this.list(job.uid, rest, signal, category);
        for (const row of part.records) live.set(row.pid, row);
      }
      for (const row of targets) {
        const found = live.get(row.pid);
        if (!found || found.bookmarkId !== row.bookmarkId || found.rest !== row.rest ||
            !found.bookmarkTags.includes(category) || !row.before.every((tag) => found.bookmarkTags.includes(tag)) ||
            found.bookmarkTags.length > LOCAL_TAG_LIMIT)
          throw new ScanError('VERIFY_FAILED', t("新分类回读未通过；已停止，请重新核对。"));
        row.present = row.desired.filter((tag) => found.bookmarkTags.includes(tag));
      }
    }
  }

  async function executeAppendJob(job, api, hooks) {
    const signal = hooks.signal;
    const stop = () => { if (hooks.stopped() || signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
    for (const mapping of job.mapping) {
      stop();
      let pending = job.rows.filter((row) => row.eligible && !row.blocked && row.desired.includes(mapping.target) && !row.present.includes(mapping.target));
      if (!pending.length) continue;
      while (pending.length) {
        stop();
        const batch = pending.slice(0, job.pilotDone ? APPEND.batchSize : 1);
        const auth = await hooks.auth();
        if (auth.uid !== job.uid) throw new ScanError('ACCOUNT_CHANGED', t("当前登录账户与分类项目不一致，已停止。"));
        job.inflight = { category: mapping.target, bookmarkIds: batch.map((row) => row.bookmarkId), startedAt: nowISO(), acknowledged: false };
        job.hasRequests = true; job.requests += 1;
        await hooks.save(); // Persist intent BEFORE the request; failure prevents the write.
        stop();
        await api.request('/ajax/illusts/bookmarks/add_tags', signal,
          { tags: [mapping.target], bookmarkIds: job.inflight.bookmarkIds }, auth.token);
        job.inflight.acknowledged = true;
        await hooks.save();
        if (!job.pilotDone) {
          await api.verifyCategory(job, mapping.target, signal, batch.map((row) => row.bookmarkId));
          job.pilotDone = true; await hooks.save();
        }
        pending = pending.slice(batch.length);
        hooks.progress(mapping.target);
      }
      await api.verifyCategory(job, mapping.target, signal);
      mapping.committed = true; job.inflight = null;
      await hooks.categoryDone(mapping); await hooks.save(); hooks.progress(mapping.target);
    }
    stop();
  }

  // Pure helpers are also usable by the supplied offline validation harness.
  if (typeof module === 'object' && module.exports && typeof document === 'undefined') {
    module.exports = { CONFIG, ScanError, newSession, normalizeWork, validatePage, ingestPage, activeRecords,
      finalizeSession, restartEnumeration, quantile, distribution, patternMatches, analyze, buildReport, buildRawExport,
      buildClassificationModel, selectionStats, automaticSelection, buildSelectionExport, sourceFingerprint,
      parseRetryAfter, ReadOnlyAPI, remotePage, newCategoryNames, makeAppendJob, reconcileAppendJob,
      appendSummary, preservationCheck, appendReport, AppendAPI, APPEND, executeAppendJob, LANGUAGE_KEY, LANGUAGES, TRANSLATIONS, resolveLanguage, setLanguage, translate, t };
    return;
  }

  if (document.getElementById('pba-readonly-prototype')) return;
  let session = null, index = new Map(), running = false, needsReenumeration = false;
  let controller = null, lastSave = 0, cacheBytes = 0, cacheNote = '', busy = false;
  let classification = null, previewVisible = false;
  let project = null, projectDisk = null, appendJob = null, appendDisk = null, appendLoadError = '';
  let remoteSnapshot = null, appendController = null, appendPhase = '', stopAppend = false, writeReady = false;
  const appendAPI = new AppendAPI();
  const api = new ReadOnlyAPI();
  const host = document.createElement('div');
  host.id = 'pba-readonly-prototype';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;color-scheme:light;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial}*{box-sizing:border-box} .panel{width:min(350px,calc(100vw - 36px));background:#fff;color:#203044;border:1px solid #d5e0e9;border-radius:14px;box-shadow:0 8px 35px #10243b33;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
      header{background:#edf6ff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}strong{font-size:15px}.body{padding:14px;max-height:76vh;overflow:auto}.small{font-size:12px;color:#536579;margin:0 0 10px}label{display:block;margin:8px 0}input{width:100%;padding:7px;border:1px solid #b8c8d8;border-radius:6px;color:#203044;background:#fff;font:inherit}button{font:inherit;cursor:pointer;border:1px solid #bacbdb;background:#f5f8fb;color:#203044;border-radius:7px;padding:7px 10px}button:hover{background:#e6f2ff}button:disabled{opacity:.45;cursor:default}.primary{background:#0878d1;color:white;border-color:#0878d1}.primary:hover{background:#0567b6}.buttons{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}#status{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:10px;background:#f4f7fa;border-radius:8px}#progress,#cache{white-space:pre-wrap;font-size:12px;color:#536579}details{margin:10px 0}summary{cursor:pointer;color:#415975}#collapse{border:0;background:transparent;padding:0 5px} [hidden]{display:none!important}
      .overlay{position:fixed;inset:0;background:#132c4680;display:flex;align-items:center;justify-content:center;padding:18px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#203044}.planner{width:min(1100px,100%);max-height:94vh;display:flex;flex-direction:column;background:#fff;border:1px solid #d5e0e9;border-radius:14px;box-shadow:0 12px 60px #10243b44;overflow:hidden}.planner header{flex:none;gap:12px}.plan-body{padding:16px;overflow:auto}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.metric{background:#edf6ff;border-radius:9px;padding:10px}.metric b{display:block;font-size:21px;font-variant-numeric:tabular-nums}.metric span{font-size:12px;color:#536579}.plan-note{font-size:12px;color:#536579;margin:9px 0}#plan-status{white-space:pre-wrap;background:#f4f7fa;padding:10px;border-radius:8px;margin:8px 0}.plan-columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.plan-columns section{min-width:0;border:1px solid #d5e0e9;border-radius:9px;padding:12px}.plan-columns h3{font-size:15px;margin:0 0 8px}.tag-tools{display:flex;gap:6px;align-items:center}.tag-tools label{flex:1;margin:0}.tag-tools select{font:inherit;color:#203044;background:#fff;padding:7px;border:1px solid #b8c8d8;border-radius:6px}.scroll-list{max-height:38vh;overflow:auto;margin-top:9px}.tag-row{display:flex;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid #edf1f5}.tag-label{display:flex;flex:1;min-width:0;align-items:center;gap:7px;margin:0;cursor:pointer}.tag-label input{width:17px;height:17px;flex:none;accent-color:#0878d1}.tag-label span{overflow-wrap:anywhere}.tag-row button{padding:3px 7px;white-space:nowrap;font-size:12px}.tag-row small{color:#6d7480;font-size:11px}.pager{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:9px;font-size:12px}.pager button{padding:4px 8px}.work-row{padding:8px 0;border-bottom:1px solid #edf1f5;overflow-wrap:anywhere}.work-row a{color:#006dc1;font-weight:600;text-decoration:underline}.work-row p{margin:4px 0 0;font-size:12px;color:#536579}.work-row .missing{color:#a84213}.preview-heading{display:flex;gap:7px;flex-wrap:wrap;align-items:center;justify-content:space-between}.preview-heading button{font-size:12px;padding:4px 7px}#plan-save-state{font-size:12px;color:#536579;align-self:center}.planner button:focus-visible,.planner input:focus-visible,.planner select:focus-visible{outline:2px solid #0878d1;outline-offset:2px}@media(max-width:720px){.overlay{padding:8px}.plan-body{padding:10px}.plan-columns{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.scroll-list{max-height:30vh}.planner header strong{font-size:14px}}
      .language-picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:12px}.language-picker select{font:inherit;color:#203044;background:#fff;max-width:100%;padding:6px;border:1px solid #b8c8d8;border-radius:6px}.planner header{flex-wrap:wrap}.planner header .language-picker{margin:0 0 0 auto}.panel header strong{min-width:0}.panel header button{flex:none}.panel button{overflow-wrap:anywhere}.tag-row button{white-space:normal}.panel input:focus-visible,.panel select:focus-visible,.panel button:focus-visible{outline:2px solid #0878d1;outline-offset:2px}
    </style>
    <section class="panel" aria-label="Pixiv 收藏参数扫描器" data-i18n-aria-label="Pixiv 收藏参数扫描器">
      <header><strong data-i18n="收藏分类工具 · v0.4.0">收藏分类工具 · v0.4.0</strong><button id="collapse" title="收起或展开" data-i18n="收起" data-i18n-title="收起或展开">收起</button></header>
      <div class="body" id="body">
        <label class="language-picker"><span data-i18n="界面语言">界面语言</span><select id="language" aria-label="界面语言" data-i18n-aria-label="界面语言"><option value="auto" data-i18n="跟随浏览器">跟随浏览器</option><option value="zh">简体中文</option><option value="ja">日本語</option><option value="en">English</option></select></label>
        <p class="small" data-i18n="保留总收藏 · 保留原分类 · 仅追加新分类">保留总收藏 · 保留原分类 · 仅追加新分类</p>
        <label><span data-i18n="自己的 Pixiv 用户 ID">自己的 Pixiv 用户 ID</span><input id="uid" inputmode="numeric" autocomplete="off" placeholder="例如收藏页 /users/123456/ 中的数字" data-i18n-placeholder="例如收藏页 /users/123456/ 中的数字"></label>
        <div class="buttons"><button class="primary" id="start" data-i18n="开始 / 继续">开始 / 继续</button><button id="pause" disabled data-i18n="暂停">暂停</button><button id="rescan" data-i18n="重新核对">重新核对</button></div>
        <div id="status" role="status" aria-live="polite" data-i18n="准备中…">准备中…</div><div id="progress"></div>
        <div class="buttons"><button class="primary" id="classify" data-i18n="打开分类试用">打开分类试用</button><button id="update-classification" data-i18n="更新分类">更新分类</button></div>
        <div class="buttons"><button id="export" data-i18n="导出 TXT">导出 TXT</button><button id="anonymous" data-i18n="匿名 TXT">匿名 TXT</button><button id="raw" data-i18n="导出原始 JSON">导出原始 JSON</button></div>
        <details><summary data-i18n="本地进度">本地进度</summary>
          <p class="small" data-i18n="最小请求启动间隔 100 ms，串行请求；出错即暂停。">最小请求启动间隔 100 ms，串行请求；出错即暂停。</p>
          <p id="cache"></p><button id="clear" data-i18n="清除本地扫描数据">清除本地扫描数据</button>
        </details>
        <p class="small" data-i18n="已有完整数据时可直接试用分类。扫描中请保持此页打开，暂时别增删或切换收藏公开状态。">已有完整数据时可直接试用分类。扫描中请保持此页打开，暂时别增删或切换收藏公开状态。</p>
      </div>
    </section>
    <div class="overlay" id="plan-overlay" hidden>
      <section class="planner" role="dialog" aria-modal="true" aria-label="本地分类试用" data-i18n-aria-label="本地分类试用">
        <header><strong data-i18n="分类预览与追加 · v0.4.0">分类预览与追加 · v0.4.0</strong><label class="language-picker"><span data-i18n="界面语言">界面语言</span><select id="plan-language" aria-label="界面语言" data-i18n-aria-label="界面语言"><option value="auto" data-i18n="跟随浏览器">跟随浏览器</option><option value="zh">简体中文</option><option value="ja">日本語</option><option value="en">English</option></select></label><button id="plan-close" data-i18n="返回扫描面板">返回扫描面板</button></header>
        <div class="plan-body">
          <div class="metrics">
            <div class="metric"><b id="plan-selected">0</b><span data-i18n="已选分类">已选分类</span></div>
            <div class="metric"><b id="plan-coverage">—</b><span id="plan-covered" data-i18n="已覆盖 / 可读作品">已覆盖 / 可读作品</span></div>
            <div class="metric"><b id="plan-missing">0</b><span data-i18n="未覆盖作品">未覆盖作品</span></div>
            <div class="metric"><b id="plan-maximum">0 / 10</b><span data-i18n="单件最多匹配分类">单件最多匹配分类</span></div>
          </div>
          <p class="plan-note" id="plan-universe"></p>
          <p class="plan-note" data-i18n="先预览规则，再核对已有标签和剩余位置；点“开始追加”才会写入 Pixiv。总收藏保留，原有标签不删除。">先预览规则，再核对已有标签和剩余位置；点“开始追加”才会写入 Pixiv。总收藏保留，原有标签不删除。</p>
          <div style="border:1px solid #d5e0e9;border-radius:9px;padding:12px;margin:10px 0">
            <strong data-i18n="已有分类要纳入已成集合吗？">已有分类要纳入已成集合吗？</strong>
            <label class="tag-label"><input id="include-existing" type="checkbox"><span data-i18n="纳入：原有分类中的作品算已覆盖，原分类成员保持原样。">纳入：原有分类中的作品算已覆盖，原分类成员保持原样。</span></label>
            <p class="plan-note" id="existing-summary" data-i18n="默认不纳入。点下方“核对 / 更新主收藏”会读取已有收藏标签。">默认不纳入。点下方“核对 / 更新主收藏”会读取已有收藏标签。</p>
            <div class="buttons"><button id="append-prepare" data-i18n="核对 / 更新主收藏">核对 / 更新主收藏</button><button class="primary" id="append-start" disabled data-i18n="开始追加">开始追加</button><button id="append-stop" hidden data-i18n="暂停追加">暂停追加</button><button id="append-export" disabled data-i18n="导出参数与追加记录">导出参数与追加记录</button></div>
            <div id="append-status" role="status" aria-live="polite" data-i18n="规则和分类名称会保留，之后用“更新分类”继续处理新增收藏。">规则和分类名称会保留，之后用“更新分类”继续处理新增收藏。</div>
            <details id="append-details"><summary data-i18n="新增分类名称与未处理清单">新增分类名称与未处理清单</summary><div class="scroll-list" id="append-list"></div></details>
          </div>
          <div class="buttons">
            <button class="primary" id="plan-auto" data-i18n="自动选集">自动选集</button><button id="plan-cancel" hidden data-i18n="停止计算">停止计算</button>
            <button id="plan-undo" data-i18n="撤销上次改动">撤销上次改动</button><button id="plan-save" data-i18n="保存本地方案">保存本地方案</button>
            <button id="plan-export" data-i18n="导出分类方案">导出分类方案</button><span id="plan-save-state"></span>
          </div>
          <div id="plan-status" role="status" aria-live="polite" data-i18n="正在准备…">正在准备…</div>
          <div class="plan-columns">
            <section>
              <h3 data-i18n="分类标签">分类标签</h3>
              <div class="tag-tools">
                <label><input id="plan-search" type="search" placeholder="搜索原始 tag" aria-label="搜索分类标签" data-i18n-placeholder="搜索原始 tag" data-i18n-aria-label="搜索分类标签"></label>
                <select id="plan-filter" aria-label="标签筛选" data-i18n-aria-label="标签筛选"><option value="selected" data-i18n="已选">已选</option><option value="all" data-i18n="全部">全部</option><option value="unselected" data-i18n="未选">未选</option></select>
              </div>
              <p class="plan-note" data-i18n="勾选调整分类；点作品数量可查看对应 PID。自动选集跳过 R-18 和 users入り，手动仍可选择。">勾选调整分类；点作品数量可查看对应 PID。自动选集跳过 R-18 和 users入り，手动仍可选择。</p>
              <div class="scroll-list" id="plan-tags"></div>
              <div class="pager"><button id="plan-tags-prev" data-i18n="上一页">上一页</button><span id="plan-tags-page"></span><button id="plan-tags-next" data-i18n="下一页">下一页</button></div>
            </section>
            <section>
              <div class="preview-heading"><h3 id="plan-works-title" data-i18n="全部可读作品">全部可读作品</h3><div><button id="plan-show-all" data-i18n="全部作品">全部作品</button> <button id="plan-show-missing" data-i18n="只看未覆盖">只看未覆盖</button></div></div>
              <p class="plan-note" data-i18n="点击 PID 打开作品；下方列出当前匹配的分类及原始 tag。">点击 PID 打开作品；下方列出当前匹配的分类及原始 tag。</p>
              <div class="scroll-list" id="plan-works"></div>
              <div class="pager"><button id="plan-works-prev" data-i18n="上一页">上一页</button><span id="plan-works-page"></span><button id="plan-works-next" data-i18n="下一页">下一页</button></div>
            </section>
          </div>
        </div>
      </section>
    </div>`;
  document.documentElement.append(host);
  const $ = (id) => root.getElementById(id);
  // Keep translatable descriptors so an in-place language switch also updates old notices.
  const messages = new Map();
  const bindings = [];
  for (const attr of ['textContent', 'aria-label', 'title', 'placeholder']) {
    const name = attr === 'textContent' ? 'data-i18n' : `data-i18n-${attr}`;
    for (const node of root.querySelectorAll(`[${name}]`)) bindings.push({ node, attr, key: node.getAttribute(name) });
  }
  const showMessage = (id, text) => { messages.set(id, text); $(id).textContent = String(text); };
  const message = (text) => showMessage('status', text);
  let languageSaving = false, languageLoading = true;

  function paintLanguage() {
    for (const {node, attr, key} of bindings) {
      if (attr === 'textContent') node.textContent = translate(key);
      else node.setAttribute(attr, translate(key));
    }
    host.lang = language === 'zh' ? 'zh-CN' : language;
    for (const id of ['language', 'plan-language']) { $(id).value = languagePreference; $(id).disabled = languageLoading || languageSaving; }
    $('collapse').textContent = String($('body').hidden ? t('展开') : t('收起'));
    paint();
    if (classification) { paintPlan(); renderExistingSummary(); renderAppend(); }
    for (const [id, text] of messages) $(id).textContent = String(text);
  }

  async function changeLanguage(value) {
    if (languageLoading || languageSaving || !['auto', ...LANGUAGES].includes(value)) return;
    languageSaving = true;
    for (const id of ['language', 'plan-language']) $(id).disabled = true;
    try {
      await GM.setValue(LANGUAGE_KEY, value);
      languagePreference = value;
      setLanguage(resolveLanguage(value, browserLanguages()));
    } catch {
      (previewVisible ? planMessage : message)(t('语言设置保存失败，请重试。'));
    } finally { languageSaving = false; paintLanguage(); }
  }
  for (const id of ['language', 'plan-language']) $(id).onchange = () => void changeLanguage($(id).value);
  globalThis.addEventListener?.('languagechange', () => {
    if (languagePreference === 'auto') { setLanguage(resolveLanguage('auto', browserLanguages())); paintLanguage(); }
  });

  function detectSelf() {
    try {
      const meta = document.querySelector('meta#meta-global-data');
      return numericId(JSON.parse(meta?.content || '{}')?.userData?.id);
    } catch { return null; }
  }

  function paint() {
    $('start').disabled = running || busy || previewVisible;
    $('pause').disabled = !running;
    $('rescan').disabled = running || busy || previewVisible || !session;
    $('uid').disabled = running || busy || previewVisible || !!session;
    $('clear').disabled = running || busy || previewVisible || !session;
    $('export').disabled = running || busy || previewVisible || !session;
    $('anonymous').disabled = running || busy || previewVisible || !session;
    $('raw').disabled = running || busy || previewVisible || !session;
    $('classify').disabled = running || busy || previewVisible || !session?.complete;
    $('update-classification').disabled = running || busy || previewVisible || !session?.complete || !project;
    if (session) {
      const records = activeRecords(session, index);
      const good = records.filter((r) => r.accessible).length;
      $('progress').textContent = joinText(SCOPES.map((rest) => {
        const s = session.scopes[rest];
        return t("{0}：已读 {1} / {2}{3}", scopeName(rest), s.offset, s.totalLatest ?? '?', s.done ? ' ✓' : '');
      }).join('\n'), t("\n去重记录 {0} · 可读 {1} · 异常 {2}", records.length, good, records.length - good));
    } else $('progress').textContent = '';
    $('cache').textContent = t("{0}\n已保存 {1} / 16 MiB", cacheNote || t("仅保留一份进度；约每 5 秒及暂停、完成时覆盖保存。"), (cacheBytes / 1048576).toFixed(2));
  }

  const selectionSignature = (selected) => JSON.stringify([...selected].sort(compareText));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function planMessage(text) { showMessage('plan-status', text); }

  function renderTags() {
    const c = classification;
    if (!c) return;
    const query = $('plan-search').value.trim().toLowerCase();
    const filter = $('plan-filter').value || 'selected';
    const rows = c.model.ranked.filter((row) => (!query || row.tag.toLowerCase().includes(query)) &&
      (filter === 'all' || (filter === 'selected' ? c.selected.has(row.tag) : !c.selected.has(row.tag))));
    const pageSize = 40, pages = Math.max(1, Math.ceil(rows.length / pageSize));
    c.tagPage = Math.max(0, Math.min(c.tagPage, pages - 1));
    const nodes = rows.slice(c.tagPage * pageSize, (c.tagPage + 1) * pageSize).map((row) => {
      const line = element('div', undefined, 'tag-row');
      const label = element('label', undefined, 'tag-label'), check = element('input');
      check.type = 'checkbox'; check.checked = c.selected.has(row.tag); check.disabled = c.working;
      check.onchange = () => changeTag(row.tag, check.checked);
      const text = element('span', row.tag);
      if (row.autoExcluded) text.append(element('small', t(" · 自动跳过")));
      label.append(check, text);
      const view = element('button', t("{0} 件", row.works.length));
      view.disabled = c.working;
      view.title = t("查看 {0} 的作品", row.tag);
      view.onclick = () => { c.workView = { kind: 'tag', tag: row.tag }; c.workPage = 0; renderWorks(); };
      line.append(label, view);
      return line;
    });
    $('plan-tags').replaceChildren(...(nodes.length ? nodes : [element('p', t("没有符合筛选条件的标签。"), 'plan-note')]));
    $('plan-tags-page').textContent = t("{0} 个 · {1} / {2} 页", rows.length, c.tagPage + 1, pages);
    $('plan-tags-prev').disabled = c.working || c.tagPage === 0;
    $('plan-tags-next').disabled = c.working || c.tagPage >= pages - 1;
  }

  function renderWorks() {
    const c = classification;
    if (!c) return;
    let works;
    if (c.workView.kind === 'tag') {
      works = c.model.tags.get(c.workView.tag)?.works || [];
      $('plan-works-title').textContent = t("分类：{0}", c.workView.tag);
    } else if (c.workView.kind === 'uncovered') {
      works = c.stats.uncovered;
      $('plan-works-title').textContent = t("未覆盖作品");
    } else {
      works = c.model.records.map((_, work) => work);
      $('plan-works-title').textContent = t("全部可读作品");
    }
    const pageSize = 25, pages = Math.max(1, Math.ceil(works.length / pageSize));
    c.workPage = Math.max(0, Math.min(c.workPage, pages - 1));
    const nodes = works.slice(c.workPage * pageSize, (c.workPage + 1) * pageSize).map((work) => {
      const record = c.model.records[work], line = element('div', undefined, 'work-row');
      const link = element('a', `PID ${record.pid}`);
      const pid = numericId(record.pid);
      if (pid) { link.href = `https://www.pixiv.net/artworks/${pid}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      const matches = record.tags.filter((tag) => c.selected.has(tag));
      line.append(link, element('span', ` · ${scopeName(record.rest)}`),
        element('p', matches.length ? t("当前分类：{0}", matches.join(' / ')) : c.model.existingCovered.has(work) ? t("已由原有分类覆盖。") : t("未覆盖：可以从下方原始 tag 中选择分类。"), matches.length || c.model.existingCovered.has(work) ? '' : 'missing'),
        element('p', t("原始 tag：{0}", record.tags.join(' / '))));
      return line;
    });
    $('plan-works').replaceChildren(...(nodes.length ? nodes : [element('p', c.workView.kind === 'uncovered' ?
      t("目前没有未覆盖的可读作品。") : t("这里没有作品。"), 'plan-note')]));
    $('plan-works-page').textContent = t("{0} 件 · {1} / {2} 页", works.length, c.workPage + 1, pages);
    $('plan-works-prev').disabled = c.working || c.workPage === 0;
    $('plan-works-next').disabled = c.working || c.workPage >= pages - 1;
  }

  function paintPlan() {
    const c = classification;
    if (!c) return;
    const stats = c.stats;
    $('plan-selected').textContent = String(stats.selectedCount);
    $('plan-coverage').textContent = stats.coverage === null ? '—' : stats.covered === c.model.records.length ? '100%' :
      `${Math.floor(stats.coverage * 10000) / 100}%`;
    $('plan-covered').textContent = t("{0} / {1} 件已覆盖", stats.covered, c.model.records.length);
    $('plan-missing').textContent = String(stats.uncovered.length);
    $('plan-maximum').textContent = `${stats.maximum} / ${LOCAL_TAG_LIMIT}`;
    $('plan-universe').textContent = t("全集为 {0} 件可读作品；{1} 条异常已忽略。同一作品可属于多个分类，覆盖率按 PID 去重。", c.model.records.length, c.model.ignored);
    const dirty = selectionSignature(c.selected) !== c.savedSignature || (project && project.includeExisting !== $('include-existing').checked);
    $('plan-save-state').textContent = dirty ? t("有未保存的本地改动") : t("本地方案已保存");
    for (const id of ['plan-auto', 'plan-export', 'plan-close', 'plan-search', 'plan-filter', 'plan-show-all', 'plan-show-missing'])
      $(id).disabled = c.working;
    $('plan-save').disabled = c.working || !dirty;
    $('plan-undo').disabled = c.working || !c.undo;
    $('plan-cancel').hidden = !c.computeController;
    $('include-existing').disabled = c.working;
    $('append-prepare').disabled = c.working;
    $('append-start').disabled = c.working || !writeReady || !appendJob || !appendSummary(appendJob).ready;
    $('append-stop').hidden = !appendController;
    $('append-export').disabled = c.working || !project;
    renderTags(); renderWorks();
  }

  function setSelection(selected, remember = true) {
    const c = classification;
    if (remember && selectionSignature(c.selected) !== selectionSignature(selected)) c.undo = new Set(c.selected);
    c.selected = selected;
    c.stats = selectionStats(c.model, selected);
    writeReady = false;
    paintPlan();
  }

  function changeTag(tag, enabled) {
    const c = classification;
    if (!c || c.working) return;
    if (enabled) {
      const full = c.model.tags.get(tag).works.find((work) => c.stats.counts[work] >= LOCAL_TAG_LIMIT);
      if (full !== undefined) {
        planMessage(t("未加入“{0}”：PID {1} 已匹配 10 个本地分类。请先取消其他分类。", tag, c.model.records[full].pid));
        paintPlan(); return;
      }
    }
    const next = new Set(c.selected);
    if (enabled) next.add(tag); else next.delete(tag);
    setSelection(next);
    planMessage(t("{0}“{1}”。{2}", enabled ? t("已加入") : t("已取消"), tag, c.stats.uncovered.length ? t("当前有 {0} 件未覆盖，可点“只看未覆盖”。", c.stats.uncovered.length) : t("全部可读作品已覆盖。")));
  }

  async function autoClassify() {
    const c = classification;
    if (!c || c.working) return;
    if ($('include-existing').checked && !remoteSnapshot) { planMessage(t("先点“核对 / 更新主收藏”读取已有分类，再计算包含已有集合的覆盖。")); return; }
    c.working = true; c.computeController = new AbortController(); paintPlan();
    planMessage(t("正在自动选集：先覆盖更多未分类作品，再移除多余标签…"));
    await tick();
    try {
      const selected = await automaticSelection(c.model, { signal: c.computeController.signal, yieldNow: tick,
        progress: (p) => planMessage(t("正在计算：已覆盖 {0} / {1} 件，临时选择 {2} 个标签…", p.covered, p.total, p.selected)) });
      setSelection(selected);
      planMessage(joinText(joinText(t("自动完成：{0} 个分类，覆盖 {1} / {2} 件。", selected.size, c.stats.covered, c.model.records.length), c.stats.uncovered.length ? t("\n仍有 {0} 件未覆盖；请查看这些作品并手动补选。这不表示不存在其他全覆盖方案。", c.stats.uncovered.length) : t("\n这是可用的覆盖方案，未证明分类数量是全局最少。")), t("\n可以继续勾选调整，满意后点“保存本地方案”。再次自动选集会重算，完成后可撤销。")));
    } catch (error) {
      planMessage(error.name === 'AbortError' ? t("已停止计算，保留开始计算前的选择。") : t("自动选集失败，原选择保留。可以导出原始 JSON 反馈。"));
    } finally { c.working = false; c.computeController = null; paintPlan(); }
  }

  async function openClassification() {
    if (!session?.complete || running || busy || previewVisible) return;
    if (classification) {
      previewVisible = true; $('plan-overlay').hidden = false; paint(); paintPlan(); $('plan-search').focus(); return;
    }
    busy = true; paint(); message(t("正在用本地数据准备分类试用…"));
    await tick();
    try {
      const records = activeRecords(session, index), model = buildClassificationModel(records);
      const fingerprint = await sourceFingerprint(session, records);
      const diskValue = await GM.getValue(SELECTION_KEY, null);
      let selected = new Set(), savedSignature = null, restored = false;
      let note = t("没有已保存的方案，将自动计算。");
      if (diskValue !== null) {
        try {
          if (typeof diskValue !== 'string' || encoder.encode(diskValue).byteLength > 1024 * 1024) throw new Error('Size');
          const saved = JSON.parse(diskValue);
          if (saved.schema !== 1 || saved.fingerprint !== fingerprint || !Array.isArray(saved.selected) ||
              saved.selected.some((tag) => typeof tag !== 'string' || !model.tags.has(tag))) throw new Error('Source changed');
          selected = new Set(saved.selected);
          if (selectionStats(model, selected).overLimit.length) throw new Error('Limit');
          savedSignature = selectionSignature(selected); restored = true;
          note = t("已恢复与这份数据对应的本地方案。勾选后覆盖率会即时更新。");
        } catch { selected = new Set(); note = t("旧方案与当前数据不匹配或无法读取；将重新计算，保存时才替换旧方案。"); }
      }
      if (project && project.uid === session.uid) {
        selected = new Set(project.selected); retainRuleNames(model, selected);
        savedSignature = selectionSignature(selected); restored = true;
        note = t("已恢复分类参数和名称。点“核对 / 更新主收藏”读取新增作品；也可以先调整规则。");
      }
      classification = { model, fingerprint, selected, stats: selectionStats(model, selected),
        savedSignature, diskValue, undo: null, working: false, computeController: null,
        tagPage: 0, workPage: 0, workView: { kind: 'all' } };
      previewVisible = true; $('plan-overlay').hidden = false;
      $('plan-filter').value = 'selected'; $('plan-search').value = '';
      $('include-existing').checked = !!project?.includeExisting;
      renderAppend();
      paintPlan(); planMessage(note); paint();
      if (!restored) await autoClassify();
      $('plan-search').focus();
      message(t("分类试用使用已完成的本地数据。"));
    } catch { message(t("无法打开分类试用。请保留本地扫描数据，导出原始 JSON 后反馈。")); }
    finally { busy = false; paint(); }
  }

  async function saveClassification() {
    const c = classification;
    if (!c || c.working) return;
    c.working = true; paintPlan();
    try {
      if (!navigator.locks?.request) throw new LocalizedError(t("需要支持 Web Locks 的新版桌面 Chrome / Edge。"));
      await navigator.locks.request(LOCK_KEY, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new LocalizedError(t("另一个页面正在保存或扫描；请稍后再保存。"));
        const checkpoint = await GM.getValue(CACHE_KEY, null);
        if (!checkpoint || JSON.parse(checkpoint).savedAt !== session.savedAt)
          throw new LocalizedError(t("另一个页面已更新或清除扫描数据。请先导出本页方案，再刷新核对。"));
        const latest = await GM.getValue(SELECTION_KEY, null);
        if (latest !== c.diskValue) throw new LocalizedError(t("另一个页面已保存新方案。请先导出本页方案，再刷新核对，避免覆盖。"));
        if (project && await GM.getValue(PROJECT_KEY, null) !== projectDisk) throw new LocalizedError(t("其他页面已更新项目参数，请刷新后再保存。"));
        const value = JSON.stringify({ schema: 1, fingerprint: c.fingerprint, savedAt: nowISO(), selected: [...c.selected] });
        if (encoder.encode(value).byteLength > 1024 * 1024) throw new LocalizedError(t("方案超过 1 MiB；请导出文件保存。"));
        await GM.setValue(SELECTION_KEY, value);
        c.diskValue = value;
        if (project) {
          project.selected = [...c.selected].sort(compareText); project.includeExisting = $('include-existing').checked;
          await storeProject();
        }
        c.diskValue = value; c.savedSignature = selectionSignature(c.selected);
        planMessage(t("本地方案已保存。刷新页面后会恢复这份选择；Pixiv 收藏未改变。"));
      });
    } catch (error) { planMessage(t("保存失败：{0}", errorText(error) || t("请先导出本页方案。"))); }
    finally { c.working = false; paintPlan(); }
  }

  async function exportClassification() {
    const c = classification;
    if (!c || c.working) return;
    c.working = true; paintPlan(); await tick();
    try {
      const result = buildSelectionExport(session, c.model, c.selected, c.fingerprint);
      download(JSON.stringify(result, null, 2), 'pixiv-classification-plan.json', 'application/json;charset=utf-8', false);
      planMessage(t("已发起下载 pixiv-classification-plan.json，包含已选分类和逐件分配结果。\n可以把方案发回继续检查；本次导出不会写回 Pixiv，也不会代替“保存本地方案”。"));
    } catch { planMessage(t("导出失败；本页选择仍在，请先保存本地方案。")); }
    finally { c.working = false; paintPlan(); }
  }

  function retainRuleNames(model, selected) {
    for (const tag of selected) if (!model.tags.has(tag)) {
      const row = { tag, works: [], autoExcluded: tag === 'R-18' || patternMatches(tag) };
      model.tags.set(tag, row); model.ranked.push(row);
    }
    model.ranked.sort((a, b) => b.works.length - a.works.length || compareText(a.tag, b.tag));
  }

  function applyExistingCoverage() {
    const c = classification;
    if (!c) return;
    c.model.existingCovered = new Set();
    c.model.existingTagSnapshot = !!remoteSnapshot;
    if (remoteSnapshot) {
      const ownNames = new Set(project?.mapping.map((m) => m.target) || []);
      const labels = new Map(remoteSnapshot.records.map((r) => [r.pid, r.bookmarkTags.filter((tag) => !ownNames.has(tag))]));
      const names = new Set([...labels.values()].flat());
      if ($('include-existing').checked) c.model.records.forEach((r, i) => { if (labels.get(r.pid)?.length) c.model.existingCovered.add(i); });
      c.model.externalCategoryCount = names.size;
    }
    renderExistingSummary();
    c.stats = selectionStats(c.model, c.selected); writeReady = false;
  }

  function renderExistingSummary() {
    const c = classification;
    if (!c) return;
    $('existing-summary').textContent = remoteSnapshot ?
      t("已读取 {0} 个原有分类；{1} 件计入已有集合。该选项只计入原成员，不向旧分类追加。", c.model.externalCategoryCount || 0, c.model.existingCovered.size) :
      t("点“核对 / 更新主收藏”读取已有收藏标签。选择纳入后，可点“自动选集”补齐其余作品。");
  }

  function pageAuth(doc = document) {
    let uid = null, token = null;
    try {
      const data = JSON.parse(doc.querySelector('meta#meta-global-data')?.content || '{}');
      uid = numericId(data.userData?.id); token = data.token;
    } catch { /* other supported page layouts below */ }
    if (!uid || !token) {
      for (const script of doc.querySelectorAll?.('script') || []) {
        const text = script.textContent || '';
        const idMatch = /pixiv\.context\.userId\s*=\s*["']?([1-9]\d*)/u.exec(text);
        const tokenMatch = /pixiv\.context\.token\s*=\s*["']([A-Za-z0-9_-]{16,256})["']/u.exec(text);
        if (!uid && idMatch) uid = idMatch[1];
        if (!token && tokenMatch) token = tokenMatch[1];
      }
    }
    // Modern React pages expose the authenticated client at ancestor props.
    if ((!uid || !token) && doc === document) for (const node of doc.querySelectorAll?.('#root, [role="banner"]') || []) {
      const key = Object.keys(node).find((name) => /^__react(?:Fiber|InternalInstance)\$/u.test(name.slice(0, name.indexOf('$') + 1)));
      let fiber = key ? node[key] : null;
      for (let i = 0; fiber && i < 60; i++, fiber = fiber.return) {
        const client = fiber.memoizedProps?.client;
        if (numericId(client?.userId) && typeof client.token === 'string') { uid = String(client.userId); token = client.token; break; }
      }
    }
    return { uid, token: typeof token === 'string' && /^[A-Za-z0-9_-]{16,256}$/u.test(token) ? token : null };
  }

  async function writeAuth(signal) {
    let auth = pageAuth();
    if (auth.uid && auth.uid !== session.uid) throw new ScanError('ACCOUNT_CHANGED', t("当前登录账户与缓存账户不同，请切回原账户后刷新。"));
    if (!auth.uid || !auth.token) {
      const pid = classification.model.records.find((r) => numericId(r.pid))?.pid;
      if (!pid) throw new ScanError('AUTH_PAGE', t("没有可用于核对登录状态的作品。"));
      const html = await appendAPI.request(`/bookmark_add.php?type=illust&illust_id=${pid}`, signal, null, null, true);
      const fallback = pageAuth(new DOMParser().parseFromString(html, 'text/html'));
      if (fallback.uid && auth.uid && fallback.uid !== auth.uid) throw new ScanError('ACCOUNT_CHANGED', t("登录账户发生变化，已停止。"));
      auth = { uid: fallback.uid || auth.uid, token: fallback.token || auth.token };
    }
    if (auth.uid !== session.uid || !auth.token)
      throw new ScanError('AUTH_UNAVAILABLE', t("无法从页面确认当前账户及写入凭据。请登录自己的 Pixiv 收藏页并刷新后再试；无需提供 Cookie 或 Token。"));
    return auth;
  }

  async function storeProject() {
    project.savedAt = nowISO();
    const value = JSON.stringify(project);
    if (encoder.encode(value).byteLength > APPEND.maxJobBytes) throw new ScanError('PROJECT_SIZE', t("参数记录超过上限，请先导出。"));
    await GM.setValue(PROJECT_KEY, value); projectDisk = value;
  }

  async function storeAppendJob() {
    appendJob.savedAt = nowISO();
    const value = JSON.stringify(appendJob);
    if (encoder.encode(value).byteLength > APPEND.maxJobBytes) throw new ScanError('JOB_SIZE', t("追加记录超过 16 MiB，未开始新的写入，请先导出。"));
    await GM.setValue(APPEND_KEY, value); appendDisk = value;
  }

  async function checkAppendDisk() {
    if (appendLoadError) throw new ScanError('APPEND_CACHE', appendLoadError);
    const [savedProject, savedJob, savedScan, savedSelection] = await Promise.all([
      GM.getValue(PROJECT_KEY, null), GM.getValue(APPEND_KEY, null), GM.getValue(CACHE_KEY, null), GM.getValue(SELECTION_KEY, null)]);
    if (savedProject !== projectDisk || savedJob !== appendDisk || savedSelection !== classification.diskValue ||
        !savedScan || JSON.parse(savedScan).savedAt !== session.savedAt)
      throw new ScanError('STALE_TAB', t("另一个页面更新了参数或进度，请先导出本页方案，再刷新。"));
    if ((project && project.uid !== session.uid) || (appendJob && appendJob.uid !== session.uid))
      throw new ScanError('PROJECT_ACCOUNT', t("保存的分类项目属于另一账户，请使用原账户和浏览器配置。"));
  }

  async function appendLock(action) {
    if (!navigator.locks?.request) throw new ScanError('LOCK_UNAVAILABLE', t("需要支持 Web Locks 的新版桌面浏览器。"));
    return navigator.locks.request(LOCK_KEY, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new ScanError('OTHER_TAB', t("另一个页面正在扫描或追加，请在它结束后再操作。"));
      await checkAppendDisk(); return action();
    });
  }

  async function refreshCachedSnapshot(snapshot) {
    const updated = newSession(session.uid, CONFIG.requestIntervalMs);
    updated.complete = true; updated.finishedAt = nowISO();
    updated.requestCount = snapshot.requestCount || 0;
    updated.notices = ['REFRESHED_WITH_BOOKMARK_TAG_CHECK'];
    updated.records = snapshot.records.map((r) => ({ key: r.key, pid: r.pid, rest: r.rest,
      seen: 1, accessible: r.accessible, reason: r.reason, tags: [...r.tags] }));
    for (const rest of SCOPES) Object.assign(updated.scopes[rest], { offset: snapshot.totals[rest],
      rows: snapshot.totals[rest], pages: snapshot.pageCounts?.[rest] || 0, totalFirst: snapshot.totals[rest], totalLatest: snapshot.totals[rest], done: true });
    session = updated; index = new Map(updated.records.map((r) => [r.key, r]));
    await save(true);
    remoteSnapshot = snapshot;
    const c = classification;
    c.model = buildClassificationModel(snapshot.records); retainRuleNames(c.model, c.selected);
    c.fingerprint = await sourceFingerprint(session, updated.records);
    c.undo = null; c.tagPage = 0; c.workPage = 0;
    applyExistingCoverage();
  }

  function parameterExport() {
    return { schema: 'pixiv-classification-project/v1', version: VERSION, exported_at_utc: nowISO(),
      selected: project.selected, prefix: project.prefix, mapping: project.mapping,
      include_existing_categories: project.includeExisting, seen_pids: project.seenPids,
      last_updated_at_utc: project.lastUpdatedAt || null, append_job: appendJob ? appendReport(appendJob) : null };
  }

  function exportAppend() {
    if (!project) return;
    download(JSON.stringify(parameterExport(), null, 2), 'pixiv-classification-project.json', 'application/json;charset=utf-8', false);
  }

  const reasonNames = { NO_SELECTED_CATEGORY: t("没有匹配规则"), NO_LONGER_READABLE: t("当前不可读或已不在收藏中"),
    NO_BOOKMARK_ID: t("缺少收藏标识"), ARTWORK_TAGS_CHANGED: t("作品原始标签变化"), NO_FREE_SLOTS: t("已有标签加新分类超过 10 个"),
    EXISTING_CATEGORY: t("已由原分类覆盖"), BOOKMARK_CHANGED: t("收藏标识或公开状态变化"), ORIGINAL_TAGS_CHANGED: t("原有标签变化") };

  function renderAppend() {
    if (!appendJob) { $('append-list').replaceChildren(); return; }
    const s = appendSummary(appendJob);
    $('append-start').textContent = t("开始追加 {0} 件", s.ready);
    const nodes = [element('p', t("总收藏 {0} 条 · 本次新发现 {1} 件可读作品 · 可追加 {2} 件 · 已满足 {3} 件 · 未处理 {4} 件", appendJob.baseline.length, appendJob.newWorks, s.ready, s.done, s.skipped), 'plan-note')];
    for (const item of appendJob.mapping) nodes.push(element('p', `${item.source} → ${item.target}`, 'plan-note'));
    const skipped = appendJob.rows.filter((r) => (!r.eligible || r.blocked) && r.reason !== 'EXISTING_CATEGORY');
    if (skipped.length) nodes.push(element('strong', t("未处理 {0} 件（最多显示 200 件，完整清单可导出）", skipped.length)));
    for (const row of skipped.slice(0, 200)) nodes.push(element('p', `PID ${row.pid}：${reasonNames[row.blocked || row.reason] || row.blocked || row.reason}`, 'plan-note'));
    $('append-list').replaceChildren(...nodes);
  }

  const appendMessage = (text) => showMessage('append-status', text);
  const readProgress = (p) => appendMessage(t("正在核对{0}主收藏：{1} / {2}，此阶段只读取数据…", scopeName(p.rest), p.offset, p.total));

  async function prepareAppend() {
    const c = classification;
    if (!c || c.working || !session?.complete) return;
    c.working = true; writeReady = false; stopAppend = false; appendController = new AbortController(); appendPhase = 'read'; paintPlan();
    try {
      await appendLock(async () => {
        await writeAuth(appendController.signal);
        appendAPI.blockedUntil = Math.max(appendAPI.blockedUntil, appendJob?.blockedUntil || 0);
        const snapshot = await appendAPI.snapshot(session.uid, appendController.signal, readProgress);
        if (appendJob?.hasRequests && !/^complete/u.test(appendJob.status)) {
          const oldCheck = preservationCheck(appendJob, snapshot);
          if (oldCheck.missing || oldCheck.changed_bookmark_or_visibility || oldCheck.original_tags_missing)
            throw new ScanError('OLD_RUN_CHANGED', t("上次暂停后原收藏或原标签发生变化。保留了追加记录，请先导出检查；未继续写入。"));
          reconcileAppendJob(appendJob, snapshot);
          exportAppend(); // Keep the previous incomplete-run evidence before replacing its journal.
        }
        await refreshCachedSnapshot(snapshot);
        const active = [...c.selected].sort(compareText);
        if (!project) project = { schema: 1, uid: session.uid, prefix: '新_', selected: active,
          mapping: [], includeExisting: false, seenPids: [], createdAt: nowISO(), lastUpdatedAt: null };
        const job = makeAppendJob(session, c.model, c.selected, c.fingerprint, snapshot, project.prefix, project);
        for (const m of job.mapping) if (!project.mapping.some((old) => old.source === m.source)) project.mapping.push({ ...m, committed: false });
        project.selected = active; project.includeExisting = $('include-existing').checked;
        appendJob = job;
        reconcileAppendJob(job, snapshot);
        await storeProject(); await storeAppendJob();
        const value = JSON.stringify({ schema: 1, fingerprint: c.fingerprint, selected: active, savedAt: nowISO() });
        await GM.setValue(SELECTION_KEY, value); c.diskValue = value; c.savedSignature = selectionSignature(c.selected);
        const s = appendSummary(job);
        if (!s.ready) {
          job.status = s.skipped ? 'complete_with_skips' : 'complete'; job.preservation = preservationCheck(job, snapshot);
          project.seenPids = c.model.records.map((r) => r.pid); project.lastUpdatedAt = nowISO();
          await storeAppendJob(); await storeProject();
        }
        writeReady = !!s.ready;
        appendMessage(t("核对完成：可追加 {0} 件，已满足 {1} 件，未处理 {2} 件。\n参数和分类名称已保存。{3}\n总收藏保留，既有标签和公开状态不改动。", s.ready, s.done, s.skipped, s.ready ? t("展开下方查看新分类名称，点“开始追加”写入。") : t("本次没有待追加内容。")));
        renderAppend();
      });
    } catch (error) {
      appendMessage(error.name === 'AbortError' ? t("已停止核对；没有开始新的追加。") : (errorText(error) || t("核对失败，未开始追加。")));
    } finally { c.working = false; appendController = null; appendPhase = ''; paintPlan(); paint(); }
  }

  async function runAppend() {
    const c = classification;
    if (!c || c.working || !appendJob || !writeReady) return;
    c.working = true; writeReady = false; stopAppend = false; appendController = new AbortController(); appendPhase = 'read'; paintPlan();
    let ownsLock = false;
    try {
      await appendLock(async () => {
        ownsLock = true;
        const auth = await writeAuth(appendController.signal);
        const fresh = await appendAPI.snapshot(session.uid, appendController.signal, readProgress);
        const before = preservationCheck(appendJob, fresh);
        if (!before.passed) throw new ScanError('PREVIEW_CHANGED', t("核对后总收藏、原标签或公开状态有变化，请重新点“核对 / 更新主收藏”。"));
        const oldBlocked = new Set(appendJob.rows.filter((r) => r.blocked).map((r) => r.pid));
        reconcileAppendJob(appendJob, fresh);
        if (appendJob.rows.some((r) => r.blocked && !oldBlocked.has(r.pid)))
          throw new ScanError('SLOTS_CHANGED', t("核对后部分作品的可用位置发生变化，请重新核对预览。"));
        appendJob.status = 'writing'; await storeAppendJob(); exportAppend();
        appendPhase = 'write';
        appendMessage(t("开始追加；先追加 1 件并回读，再继续处理其余项目。运行期间请保持页面打开。"));
        await executeAppendJob(appendJob, appendAPI, { signal: appendController.signal, stopped: () => stopAppend,
          auth: async () => {
            const current = pageAuth();
            if (current.uid && current.uid !== auth.uid) throw new ScanError('ACCOUNT_CHANGED', t("当前登录账户发生变化，已停止。"));
            return auth;
          }, save: storeAppendJob,
          progress: (tag) => { const s = appendSummary(appendJob); appendMessage(t("正在追加 {0}；已回读满足 {1} 件，待完成 {2} 件。", tag, s.done, s.ready)); },
          categoryDone: async (m) => {
            const saved = project.mapping.find((item) => item.source === m.source && item.target === m.target);
            if (saved) saved.committed = true;
            await storeProject();
          } });
        appendMessage(t("追加已发出，正在回读总收藏、原有标签及分类结果…"));
        const finalSnapshot = await appendAPI.snapshot(session.uid, appendController.signal);
        reconcileAppendJob(appendJob, finalSnapshot);
        appendJob.preservation = preservationCheck(appendJob, finalSnapshot);
        if (!appendJob.preservation.passed || appendSummary(appendJob).ready)
          throw new ScanError('FINAL_CHECK', t("最终核对存在差异，已停止。请导出追加记录检查；不会自动删除或回滚标签。"));
        const s = appendSummary(appendJob);
        appendJob.status = s.skipped ? 'complete_with_skips' : 'complete'; appendJob.inflight = null;
        project.seenPids = finalSnapshot.records.filter((r) => r.accessible).map((r) => r.pid); project.lastUpdatedAt = nowISO();
        await storeAppendJob(); await storeProject();
        remoteSnapshot = finalSnapshot;
        appendMessage(t("追加完成并回读核对：已满足 {0} 件，未处理 {1} 件。\n总收藏仍为 {2} 条，原有标签、收藏标识和公开状态均保留。\n以后点“更新分类”，会沿用这些分类名称，只补缺少的分配。", s.done, s.skipped, appendJob.preservation.current_records));
        renderAppend(); exportAppend();
      });
    } catch (error) {
      if (ownsLock && appendJob) {
        appendJob.status = 'paused'; appendJob.blockedUntil = Math.max(appendJob.blockedUntil || 0, error.blockedUntil || 0, appendAPI.blockedUntil);
        try {
          await navigator.locks.request(LOCK_KEY, { ifAvailable: true }, async (lock) => {
            if (lock && await GM.getValue(APPEND_KEY, null) === appendDisk) await storeAppendJob();
          });
        } catch { /* existing persisted intent remains; no more requests */ }
      }
      appendMessage(t("{0}\n继续时先点“核对 / 更新主收藏”，读取实际结果后再补缺少的标签。", error.name === 'AbortError' ? t("已暂停。已经追加的分类会保留。") : errorText(error) || t("追加暂停。")));
      renderAppend();
    } finally { c.working = false; appendController = null; appendPhase = ''; paintPlan(); }
  }

  function closeClassification() {
    if (!previewVisible || classification?.working || busy) return;
    previewVisible = false; $('plan-overlay').hidden = true; paint(); $('classify').focus();
    message(t("分类选择暂留本页；刷新前请在试用窗口点“保存本地方案”。"));
  }

  async function save(force = false) {
    if (!session || (!force && Date.now() - lastSave < CONFIG.checkpointEveryMs)) return;
    session.records = [...index.values()];
    session.savedAt = nowISO();
    const json = JSON.stringify(session), bytes = encoder.encode(json).byteLength;
    if (bytes > CONFIG.maxCheckpointBytes) {
      addNotice(session, 'CHECKPOINT_SIZE_CAP');
      cacheNote = t("超过 16 MiB，本次新进度未写入；旧进度保留。请先导出 TXT。");
      throw new ScanError('CHECKPOINT_SIZE_CAP', t("进度超过 16 MiB 上限，已暂停；请先导出 TXT。"));
    }
    try { await GM.setValue(CACHE_KEY, json); }
    catch { cacheNote = t("进度写入失败；本页数据仍在，请先导出 TXT。"); throw new ScanError('STORAGE_ERROR', cacheNote); }
    cacheBytes = bytes;
    lastSave = Date.now();
    cacheNote = t("上次保存：{0}", dateText(session.savedAt, true));
  }

  async function withLock(action) {
    if (!navigator.locks?.request) { message(t("需要支持 Web Locks 的新版桌面 Chrome / Edge。")); return; }
    return navigator.locks.request(LOCK_KEY, { ifAvailable: true }, async (lock) => {
      if (!lock) { message(t("另一个 Pixiv 标签页正在扫描；请在那个页面暂停后再操作。")); return; }
      return action();
    });
  }

  async function scan(recheck = false) {
    if (running || busy || previewVisible) return;
    const uid = numericId($('uid').value.trim());
    if (!uid) { message(t("请填写自己的 Pixiv 数字用户 ID。")); return; }
    const self = detectSelf();
    if (self && self !== uid) { message(t("用户 ID 与当前登录账户不一致；请填自己的 ID，或切换账户并刷新。")); return; }
    const interval = CONFIG.requestIntervalMs;
    if (session?.complete && !recheck) { message(t("这轮已完成，可以打开分类试用或导出数据；需要更新时点“重新核对”。")); return; }
    busy = true; paint();
    try {
      await withLock(async () => {
        // Reject a stale tab instead of silently overwriting a newer checkpoint.
        const saved = await GM.getValue(CACHE_KEY, null);
        if (saved) {
          let disk;
          try { disk = JSON.parse(saved); } catch { throw new ScanError('BAD_CACHE', t("本地进度无法解析；可先导出本页 TXT，再清除本地数据。")); }
          if (disk.savedAt && disk.savedAt !== session?.savedAt)
            throw new ScanError('STALE_TAB', t("其他页面更新了进度，请刷新当前页面后继续。"));
        }
        if (!session) { session = newSession(uid, interval); index = new Map(); }
        if (needsReenumeration || recheck) { restartEnumeration(session); needsReenumeration = false; classification = null; }
        session.intervalMs = interval;
        if (session.blockedUntil > Date.now()) {
          message(t("服务端要求等待至 {0}，届时再点继续。", dateText(session.blockedUntil))); return;
        }
        running = true; controller = new AbortController(); paint();
        try {
          for (const rest of SCOPES) {
            while (!session.scopes[rest].done) {
              if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
              message(t("正在扫描{0}收藏…", scopeName(rest)));
              const body = await api.page(session, rest, controller.signal);
              ingestPage(session, index, rest, body);
              await save(); paint();
            }
          }
          finalizeSession(session, index);
          await save(true);
          message(joinText(t("扫描完成。可以“打开分类试用”，或导出 TXT / 原始 JSON。"), session.notices.some((n) => n !== 'REENUMERATED_AFTER_RELOAD') ? t("\n发现数据一致性提示，详见 TXT；必要时点“重新核对”。") : ''));
        } catch (error) {
          if (error.name === 'AbortError') { addNotice(session, 'USER_PAUSED'); message(t("已暂停；可以导出部分 TXT，或继续扫描。")); }
          else {
            addNotice(session, error.code || 'UNEXPECTED_ERROR');
            session.blockedUntil = Math.max(session.blockedUntil || 0, error.blockedUntil || 0);
            message(joinText(error instanceof ScanError ? errorText(error) : t("发生未预期错误；已暂停，请导出当前 TXT。"), session.blockedUntil > Date.now() ? t("\n最早继续时间：{0}", dateText(session.blockedUntil)) : ''));
          }
          try { await save(true); } catch (saveError) { message(t('{0}\n{1}', messages.get('status') || '', errorText(saveError))); }
        } finally { running = false; controller = null; paint(); }
      });
    } catch (error) { message(error instanceof ScanError ? errorText(error) : t("读取本地进度失败；请刷新页面重试。")); }
    finally { busy = false; paint(); }
  }

  function download(text, filename, mime = 'text/plain;charset=utf-8', withBom = true) {
    const url = URL.createObjectURL(new Blob(withBom ? ['\uFEFF', text] : [text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.hidden = true;
    document.documentElement.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function exportReport(anonymous) {
    if (!session || running || busy || previewVisible) return;
    busy = true; paint(); message(t("正在生成完整计数及交集 TXT…"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const report = buildReport(session, activeRecords(session, index), anonymous);
      download(report, anonymous ? 'parameters-anonymous.txt' : 'parameters.txt');
      message(joinText(t("已发起下载 {0}。", anonymous ? 'parameters-anonymous.txt' : 'parameters.txt'), session.complete ? '' : t("\n这是部分结果，文件中 complete: false。")));
    } catch { message(t("生成 TXT 失败；请保留本页数据并反馈面板状态。")); }
    finally { busy = false; paint(); }
  }

  async function exportRaw() {
    if (!session || running || busy || previewVisible) return;
    busy = true; paint(); message(t("正在从本地进度导出完整 PID → tags 数据…"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const result = buildRawExport(session, activeRecords(session, index));
      download(JSON.stringify(result, null, 2), 'pixiv-bookmark-records.json', 'application/json;charset=utf-8', false);
      message(joinText(t("已发起下载 pixiv-bookmark-records.json，共 {0} 条。\n导出仅使用本地数据，没有重新请求 Pixiv。", result.records.length), result.complete ? '' : t("\n这是部分结果，complete: false。")));
    } catch { message(t("导出 JSON 失败；请保留本地进度并反馈面板状态。")); }
    finally { busy = false; paint(); }
  }

  $('collapse').onclick = () => { $('body').hidden = !$('body').hidden; $('collapse').textContent = $('body').hidden ? t("展开") : t("收起"); };
  $('start').onclick = () => void scan();
  $('pause').onclick = () => { message(t("正在暂停并保存…")); controller?.abort(); };
  $('rescan').onclick = () => void scan(true);
  $('export').onclick = () => void exportReport(false);
  $('anonymous').onclick = () => void exportReport(true);
  $('raw').onclick = () => void exportRaw();
  $('classify').onclick = () => void openClassification();
  $('update-classification').onclick = async () => { await openClassification(); if (previewVisible && classification && !classification.working) await prepareAppend(); };
  $('append-prepare').onclick = () => void prepareAppend();
  $('append-start').onclick = () => void runAppend();
  $('append-export').onclick = () => { if (!classification?.working) exportAppend(); };
  $('append-stop').onclick = () => {
    stopAppend = true;
    if (appendPhase !== 'write') appendController?.abort();
    appendMessage(t("正在暂停；等待当前请求及进度保存结束后停止，不会开始下一批追加。"));
  };
  $('include-existing').onchange = () => {
    if (!classification || classification.working) return;
    applyExistingCoverage(); paintPlan();
    planMessage(t("已有集合选项已更新。可以重新自动选集；写入前请再次核对。"));
  };
  $('plan-close').onclick = closeClassification;
  $('plan-auto').onclick = () => void autoClassify();
  $('plan-cancel').onclick = () => classification?.computeController?.abort();
  $('plan-save').onclick = () => void saveClassification();
  $('plan-export').onclick = () => void exportClassification();
  $('plan-undo').onclick = () => {
    const c = classification;
    if (!c || c.working || !c.undo) return;
    const previous = c.undo; c.undo = null; setSelection(previous, false);
    planMessage(t("已撤销上次选择改动。"));
  };
  $('plan-search').oninput = $('plan-filter').onchange = () => {
    if (!classification || classification.working) return;
    classification.tagPage = 0; renderTags();
  };
  for (const kind of ['tags', 'works']) for (const direction of ['prev', 'next']) {
    $(`plan-${kind}-${direction}`).onclick = () => {
      if (!classification || classification.working) return;
      classification[kind === 'tags' ? 'tagPage' : 'workPage'] += direction === 'prev' ? -1 : 1;
      if (kind === 'tags') renderTags(); else renderWorks();
    };
  }
  for (const [id, kind] of [['plan-show-all', 'all'], ['plan-show-missing', 'uncovered']]) {
    $(id).onclick = () => {
      if (!classification || classification.working) return;
      classification.workView = { kind }; classification.workPage = 0; renderWorks();
    };
  }
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && previewVisible) { event.stopPropagation(); closeClassification(); }
  });
  $('clear').onclick = async () => {
    if (running || busy || previewVisible || !confirm(t("清除本脚本的扫描缓存、分类参数及追加进度？会失去沿用原分类的对应关系。Pixiv 总收藏和分类保留。请先导出参数。"))) return;
    busy = true; paint();
    try {
      await withLock(async () => {
        await GM.deleteValue(CACHE_KEY);
        await GM.deleteValue(SELECTION_KEY);
        await GM.deleteValue(PROJECT_KEY); await GM.deleteValue(APPEND_KEY);
        project = null; projectDisk = null; appendJob = null; appendDisk = null; remoteSnapshot = null; appendLoadError = ''; writeReady = false;
        session = null; index.clear(); classification = null; needsReenumeration = false; cacheBytes = 0; cacheNote = ''; lastSave = 0;
        $('uid').value = detectSelf() || ''; message(t("本地扫描数据已清除。"));
      });
    } catch { message(t("清除失败；本页数据保留。")); }
    finally { busy = false; paint(); }
  };

  async function boot() {
    busy = true; paint();
    try {
      const preference = await GM.getValue(LANGUAGE_KEY, 'auto');
      languagePreference = ['auto', ...LANGUAGES].includes(preference) ? preference : 'auto';
    } catch { languagePreference = 'auto'; }
    setLanguage(resolveLanguage(languagePreference, browserLanguages()));
    languageLoading = false; paintLanguage();
    try {
      const stored = await GM.getValue(CACHE_KEY, null);
      if (stored) {
        if (typeof stored !== 'string' || encoder.encode(stored).byteLength > CONFIG.maxCheckpointBytes) throw new Error('Invalid cache');
        const parsed = JSON.parse(stored);
        if (parsed.schema !== 1 || !numericId(parsed.uid) || !Array.isArray(parsed.records) || !parsed.scopes?.show || !parsed.scopes?.hide)
          throw new Error('Invalid cache');
        session = parsed; index = new Map(parsed.records.map((r) => [r.key, r]));
        needsReenumeration = !session.complete;
        cacheBytes = encoder.encode(stored).byteLength;
        $('uid').value = session.uid;
        message(session.complete ? t("已恢复上次完成的数据；可直接打开分类试用或导出数据，无需重新扫描。") :
          t("已恢复上次进度。继续时会从头核对列表并按 PID 去重，避免刷新后页码偏移。"));
      } else {
        const own = detectSelf();
        $('uid').value = own || '';
        message(own ? t("已识别账户，点“开始 / 继续”。") : t("先登录 Pixiv，再填写自己收藏页网址 /users/ 后的数字 ID。"));
      }
      try {
        projectDisk = await GM.getValue(PROJECT_KEY, null); appendDisk = await GM.getValue(APPEND_KEY, null);
        for (const raw of [projectDisk, appendDisk]) if (raw !== null && (typeof raw !== 'string' || encoder.encode(raw).byteLength > APPEND.maxJobBytes)) throw new Error('Size');
        if (projectDisk) {
          const parsed = JSON.parse(projectDisk);
          if (parsed.schema !== 1 || !numericId(parsed.uid) || !Array.isArray(parsed.selected) ||
              parsed.selected.some((tag) => typeof tag !== 'string' || !tag.length) ||
              !Array.isArray(parsed.mapping) || parsed.mapping.some((m) => typeof m.source !== 'string' || typeof m.target !== 'string' || !m.target.length || m.target.length > APPEND.nameUnits) ||
              new Set(parsed.mapping.map((m) => m.target)).size !== parsed.mapping.length ||
              new Set(parsed.mapping.map((m) => m.source)).size !== parsed.mapping.length ||
              !Array.isArray(parsed.seenPids) || parsed.seenPids.some((pid) => !numericId(pid))) throw new Error('Project');
          project = parsed;
        }
        if (appendDisk) {
          const parsed = JSON.parse(appendDisk);
          if (parsed.schema !== 1 || parsed.kind !== 'append_only' || !numericId(parsed.uid) ||
              !Array.isArray(parsed.rows) || !Array.isArray(parsed.baseline) || !Array.isArray(parsed.mapping) ||
              parsed.rows.some((r) => !numericId(r.pid) || !Array.isArray(r.before) || !Array.isArray(r.desired) || !Array.isArray(r.present))) throw new Error('Append');
          appendJob = parsed; appendAPI.blockedUntil = parsed.blockedUntil || 0;
        }
      } catch {
        appendLoadError = t("保存的分类参数或追加记录无法读取。请保留数据并反馈；追加功能已停用，避免创建重复分类。");
        message(appendLoadError);
      }
    } catch {
      // Permit clearing a corrupt cache without quietly deleting it.
      message(t("本地进度读取失败。请保留当前脚本及数据并反馈，避免丢失已有分类参数。"));
    } finally { busy = false; paint(); }
  }

  paintLanguage();
  void boot();
})();
