/**
 * 量具的浏览器那一侧：**让面板以为自己装在扩展里**。
 *
 * 由 `tools/panel-shot.mjs` 抄成 `src/ui/_harness.js` 再塞进页面，**取代**
 * `panel.js` 原来那个 `<script type="module">` ——顺序是这台量具能不能工作的关键：
 * 先假造 `chrome`、铺好 OPFS，**然后**才 `import('./panel.js')`。反过来的话，
 * 面板一起来就开 OPFS worker 去读那些文件，而 worker 拿着 sync access handle 时
 * 写同一个文件会抛 `NoModificationAllowedError`。
 *
 * **这里的假答复是量具的一部分，它错了会显示成产品的 bug**（两次真实教训写在
 * `panel-shot.mjs` 的文件头）。所以：字段名照着界面真正读的那几个写，路线 key
 * 照着 `crawl/routes.js` 真正生成的写。`test/panel-shot.test.js` 钉住「面板发得出
 * 的每一种消息都有答复」。
 */

const Q = new URLSearchParams(location.search);
const STATE = Q.get('state') ?? 'first-run';

/** 路线 key 用**真的**：媒介 × `collect / do / wish`，见 `ui/route-names.js`。 */
const ROUTES = [
  ['broadcast.timeline', 1840, '2021-03-14', true],
  ['interest.movie.collect', 1157, '2019-08-02', true],
  ['interest.movie.wish', 508, '2020-01-11', true],
  ['interest.book.collect', 145, '2017-06-30', true],
  ['interest.music.collect', 84, null, false],
  ['interest.game.collect', 288, '2016-02-09', false],
  ['interest.item', 2094, null, true],
  ['note.list', 3, '2014-07-17', true],
].map(([routeKey, captured, at, contiguous]) => ({
  routeKey, captured, contiguous,
  progressTime: at ? `${at}T00:00:00+08:00` : null,
}));

const BUNDLE = '20260915T203114Z-8ab41c';
const RUNNER = {
  'first-run': { active: false },
  crawling: {
    active: true, stopped: false, bundleId: BUNDLE, intervalMs: 2600, backoffLevel: 0,
    current: 'https://movie.douban.com/people/someone/collect?start=1215&sort=time',
    currentActive: true, failures: [], routes: ROUTES,
  },
  paused: {
    active: true, stopped: true, stoppedBy: 'user_paused', bundleId: BUNDLE,
    intervalMs: 2600, backoffLevel: 0, failures: [], routes: ROUTES,
  },
  failures: {
    active: true, stopped: true, stoppedBy: 'failures_pending', bundleId: BUNDLE,
    intervalMs: 2600, backoffLevel: 0, routes: ROUTES,
    failures: [{ url: 'https://movie.douban.com/subject/1292052/', ordered: false, attempts: 11 }],
  },
};

/**
 * 假答复。**字段名照界面真正读的写**——写错了不会报错，只会在屏幕上显示成
 * 「可用 NaN GB」那样的东西，而那看起来像产品的 bug。
 */
const ANSWERS = {
  status: () => ({ ok: true, checkpoint: null, busyWith: null, runner: RUNNER[STATE] ?? RUNNER['first-run'] }),
  preflight: () => ({
    ok: true,
    permissions: { granted: true, missing: [] },
    storage: { enough: true, available: 63_000_000_000, need: 1_400_000_000 },
    incremental: null,
  }),
  exportRecords: () => ({ ok: true, exportedAt: {} }),
  chain: () => ({ ok: true, chain: { bundles: [] } }),
  readLog: () => ({
    ok: true,
    rows: [
      { at: '2026-09-15T20:31:14Z', type: 'crawl_started', message: `档案 ${BUNDLE}` },
      { at: '2026-09-15T20:31:22Z', type: 'page', routeKey: 'broadcast.timeline', verdict: 'ok',
        url: 'https://www.douban.com/people/someone/statuses?p=3' },
      { at: '2026-09-15T20:33:05Z', type: 'retry', reason: '请求超时',
        url: 'https://img1.doubanio.com/view/photo/l/public/p2888584528.webp' },
      { at: '2026-09-15T20:41:50Z', type: 'paused', reason: 'user_paused' },
    ],
  }),
  desktopUa: () => ({
    ok: true, installed: true, reason: '安卓 Chromium',
    browserUserAgent: navigator.userAgent, sentUserAgent: navigator.userAgent,
  }),
};

/**
 * 故意不答的，两类：
 *
 * - **动作**（开始、暂停、删除、标记已导出……）。量具只用来看界面，让它去「执行」
 *   什么都是多余的，而 `deleteBundle` 这种要是真答了「删好了」，截出来的图会与
 *   面板真实的行为分家。
 * - **要编一大堆假数据才答得上、而这一页没了它照样看得出版式的**（演练、链路 diff）。
 *
 * 两类都会拿到 `{ ok: true }`。名单存在的意义是**说出来这是故意的**——
 * `test/panel-shot.test.js` 不许有第三类：漏掉的。
 */
const PASSTHROUGH = new Set([
  'start', 'pause', 'resume', 'abort', 'retryFailed', 'finishWithGaps',
  'deleteBundle', 'clearLog', 'markExported',
  'dryRun', 'chainDiff',
]);

globalThis.chrome = {
  runtime: {
    // 量具跑在 http 根上；扩展里这里是 chrome-extension://…/。`new Worker()` 靠它。
    getURL: (p) => '/' + p,
    getManifest: () => ({ version: '0.0.0-量具' }),
    lastError: null,
    sendMessage(msg, cb) { cb((ANSWERS[msg.type] ?? (() => ({ ok: true })))()); },
    onMessage: { addListener() {} },
  },
  storage: { local: { get: (_k, cb) => cb?.({}), set: (_v, cb) => cb?.() } },
  permissions: { contains: (_p, cb) => cb?.(true) },
};

/** 往 OPFS 里铺 N 份档案。只为把清单画出来，字节是假的。 */
async function seed(n) {
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    if (name.startsWith('doubak-bundle-')) await root.removeEntry(name, { recursive: true });
  }
  let prev = null;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 6, 30 + i * 3, 0, 50, 10 + i));
    const id = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + '-'
      + (0x3eef52 + i * 0x1a7f3).toString(16).slice(-6);
    const dir = await root.getDirectoryHandle(`doubak-bundle-${id}`, { create: true });
    const captures = 180 + i * 940;
    const put = async (name, text) => {
      const f = await dir.getFileHandle(name, { create: true });
      const w = await f.createWritable(); await w.write(text); await w.close();
    };
    await put('manifest.json', JSON.stringify({
      spec_version: 'bundle/1.4', bundle_id: id, created_at: d.toISOString(),
      previous_bundle_id: prev, status: 'complete',
      index: { filename: `index-${id}.ndjson`, line_count: captures },
      account: { user_id: '82160871', username: 'someone' },
      producer: { name: 'doubak-extension', version: '0.0.0-量具' },
    }, null, 2));
    await put(`index-${id}.ndjson`, 'x\n'.repeat(captures));
    await put(`data-${id}-000001.warc.gz`, 'y'.repeat(40_000 + i * 3_000));
    prev = id;
  }
}

/** 各页的真实高度：把每一页单独露出来量一次。`--measure` 用。 */
function measure() {
  const secs = [...document.querySelectorAll('main > section')];
  const was = secs.map((s) => s.hidden);
  const rows = [];
  for (const s of secs) {
    for (const o of secs) o.hidden = o !== s;
    rows.push([s.id.replace('tab-', ''), document.documentElement.scrollHeight]);
  }
  secs.forEach((s, i) => { s.hidden = was[i]; });
  const pre = document.createElement('pre');
  pre.className = 'shot-measure';
  pre.textContent = rows.sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k.padEnd(10)} ${v}px`).join('\n');
  pre.setAttribute('style', 'position:fixed;left:0;top:0;z-index:99999;margin:0;'
    + 'padding:10px;background:#000;color:#8f8;font:14px monospace;white-space:pre');
  document.body.prepend(pre);
}

(async () => {
  try {
    await seed(Number(Q.get('bundles') ?? 0));
    await import('./panel.js');
    // 模块跑完之后标签页的监听才装上；早于此 click() 是按钮在、监听不在。
    const tab = Q.get('tab');
    if (tab && tab !== 'overview') document.querySelector(`button[data-tab="${tab}"]`)?.click();
    // 让那一页自己的异步渲染跑完。`load` 被 /slow 按着，来得及。
    await new Promise((r) => setTimeout(r, 1200));
    if (Q.get('measure') === 'true') measure();
  } catch (e) {
    // **量具坏了要在图上看得见**，否则截出来的是一张「界面好像没画完」的图，
    // 而那与产品真的没画完长得一模一样。
    const pre = document.createElement('pre');
    pre.setAttribute('style', 'position:fixed;left:0;top:0;z-index:99999;padding:10px;'
      + 'background:#400;color:#fdd;font:13px monospace;white-space:pre-wrap');
    pre.textContent = '量具挂了（不是面板的问题）：\n' + (e?.stack ?? e);
    (document.body || document.documentElement).prepend(pre);
  }
})();
