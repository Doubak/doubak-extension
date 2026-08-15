/**
 * 界面里反复出现的那几块。
 *
 * ## 为什么要有这个文件
 *
 * 之前没有。于是「对用户说一句话」在 `panel.js` 里长出了**八种写法**：
 * `card idle` / `card run` / `card warn` / `card err` / `card good` / `hint` /
 * `muted` / `warn-text`，各自决定要不要加粗、要不要给按钮、错误算哪一档。
 * 界面看起来不统一只是表象——**真正的问题是没有一个地方能放共享的定义**，
 * 所以每加一块界面就现编一套。
 *
 * 这里只放最小的一组，够用就停。它不是组件框架。
 */

/**
 * 消息的**语气**。说的是这条消息的性质，不是它长什么样。
 *
 *   idle   没在做事，也没出问题
 *   busy   正在做事
 *   ok     做完了，而且验过了
 *   warn   需要人看一眼，但东西还在
 *   error  这一步没成
 *
 * 原来的代码把外观当语义（`card err`、`warn-text`），换套配色就得全文搜一遍。
 *
 * **卡片的类名只有一种写法：`card tone-<语气>`。** 面板里曾经并存着两套词
 * （`err` / `good` / `run` 与 `error` / `ok` / `busy`），而 CSS 里只有后一套有规则
 * ——于是 35 处卡片**一点颜色都没有**，包括「有 8 条在豆瓣上已经没有了」这种正是
 * 靠颜色区分轻重的。两套词并存时这件事看不出来：每一处单独看都像是写对了。
 * `test/ui.test.js` 现在守着只有一套。
 *
 * @typedef {'idle'|'busy'|'ok'|'warn'|'error'} Tone
 */

/**
 * 一张消息卡。**所有对用户说的话都从这儿出去。**
 *
 * ## `warn` 与 `error` 必须给出下一步
 *
 * `docs/ui.md` §5 写着：「每一种都要给出明确的下一步，不能只显示一个错误码」。
 * 那本来只是一句约定，靠人记得。这里把它变成**写不出反例**的东西：语气是
 * `warn` 或 `error` 时不给 `actions` 就直接抛。
 *
 * 例外只有一个 `allowNoAction`，用在「用户自己刚点了取消」这种确实无事可做的
 * 场合——而且要求显式写出来，于是每一处例外都是一次有意识的决定。
 *
 * @param {object} o
 * @param {Tone} o.tone
 * @param {string} [o.title]  一句话说清是什么事
 * @param {string|Node} [o.detail]  细节
 * @param {Array<{label: string, onClick: () => void, kind?: 'primary'|'danger'}>} [o.actions]
 * @param {boolean} [o.allowNoAction]  warn/error 确实无事可做时，显式声明
 * @returns {HTMLElement}
 */
export function statusCard({ tone, title, detail, actions = [], allowNoAction = false }) {
  if ((tone === 'warn' || tone === 'error') && actions.length === 0 && !allowNoAction) {
    throw new Error(
      `statusCard: 语气是 ${tone} 却没有给下一步。`
      + '出问题时只显示一句话、不告诉用户能做什么，是这套界面明令禁止的'
      + '（docs/ui.md §5）。确实无事可做就写 allowNoAction: true。',
    );
  }

  const el = document.createElement('div');
  el.className = `card tone-${tone}`;
  // 出错与需要人处理的消息要能被读屏软件立刻念出来；其余的安静更新就行。
  el.setAttribute('role', tone === 'error' || tone === 'warn' ? 'alert' : 'status');

  if (title) {
    const b = document.createElement('b');
    b.textContent = title;
    el.append(b);
  }
  if (detail !== undefined && detail !== null) {
    const d = document.createElement('div');
    d.className = 'detail';
    if (typeof detail === 'string') d.textContent = detail;
    else d.append(detail);
    el.append(d);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions btn-row';
    for (const a of actions) row.append(button(a));
    el.append(row);
  }
  return el;
}

/**
 * 把一个已有的容器换成一张消息卡。
 *
 * 界面里的每一块都有自己的容器（`docs/ui.md` §4.4h：**不许往兄弟节点里插**），
 * 所以「更新某一块」的正确做法是整块换掉，而不是追加。
 *
 * @param {HTMLElement} host
 * @param {Parameters<typeof statusCard>[0]} spec
 */
export function renderStatus(host, spec) {
  host.replaceChildren(statusCard(spec));
}

/**
 * @param {{label: string, onClick?: () => void, kind?: 'primary'|'danger', disabled?: boolean}} o
 */
export function button({ label, onClick, kind, disabled = false }) {
  const b = document.createElement('button');
  b.className = kind ? `act ${kind}` : 'act';
  b.textContent = label;
  b.disabled = disabled;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/**
 * 一行「标签 + 值」。
 *
 * @param {string} cls
 * @param {string} text
 */
export function span(cls, text) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

/**
 * 档案选择器。**列表，不是下拉框。**
 *
 * ## 为什么换掉 `<select>`
 *
 * 原来是一个裸下拉框，选项文字就是档案编号：
 *
 *     20260801T005010Z-3eef52
 *     20260804T084014Z-627045
 *     20260806T083926Z-f72157
 *     …
 *
 * 八份长这样的东西，人只能靠后六位分辨，而后六位不携带任何意义。更别扭的是
 * **必须先选一份才看得见它有什么，而选择本身正需要那些信息**——鸡生蛋。
 *
 * 换成列表之后，每一行自己说清楚：什么时候抓的、是全量还是接着谁抓的、
 * 多大、多少条、导出了没有。这与 `docs/ui.md` §6 给存储页定的形状是同一套，
 * 那边早就是对的，只是档案页没照着做。
 *
 * @param {object} o
 * @param {Array<{
 *   id: string, at?: string|null, bytes?: number|null, captures?: number|null,
 *   previous?: string|null, live?: boolean, exported?: boolean|null,
 * }>} o.items  已按时间倒序
 * @param {string|null} o.selected
 * @param {(id: string) => void} o.onPick
 * @param {(n: number) => string} o.fmtBytes
 * @returns {HTMLElement}
 */
export function bundlePicker({ items, selected, onPick, fmtBytes }) {
  const box = document.createElement('div');
  box.className = 'picker';
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', '选择一份档案');

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(it.id === selected));
    // 选中标记之后还要能改：选哪一份是**开档案的时候**才定下的，而这张列表在那
    // 之前就画好了。见 `markPicked()`。
    row.dataset.id = it.id;
    row.tabIndex = 0;

    // 时间。**人读的格式**，不是 ISO 编号——`20260801T005010Z` 与
    // `2026-08-01 08:50` 是同一个时刻，但只有后者能一眼比出先后。
    row.append(span('when', it.at ? humanTime(it.at) : '时间不详'));

    // 这一份是怎么来的。增量要说清接在谁后面：链断了的话这里就看得出来。
    //
    // **三种状态，不是两种。** `previous_bundle_id` 写在 manifest 里，而 manifest
    // 要到收尾才写——所以正在抓的那一份读不出上游。原来的写法把「读不出来」和
    // 「没有上游」合成一个假值，于是一次正在跑的增量被标成「全量」：那不是缺一个
    // 值，那是一句错话，而且正好错在用户最会盯着看的那一行上。
    //
    // **这里不用箭头。** 一个箭头在这一行里有两种读法（「接自它」还是「产出它」），
    // 而这一行只讲一份档案、根本不需要方向符号——写成话就没有歧义。链条那张图另说，
    // 那里箭头是有方向约定的（见 docs/ui.md「链条画成什么样」）。
    row.append(span('rel',
      it.previous ? `增量 · 接自 ${shortId(it.previous)}`
        : it.previous === null ? '全量'
          : '还不知道'));

    const facts = [];
    if (it.captures != null) facts.push(`${it.captures.toLocaleString('zh-CN')} 条`);
    if (it.bytes != null) facts.push(fmtBytes(it.bytes));
    facts.push(shortId(it.id));
    row.append(span('facts', facts.join(' · ')));

    // 状态标记。**「没导出」要显眼**——那是这份档案还只存在于扩展存储里的意思，
    // 而扩展存储会被卸载扩展、清站点数据一次性抹掉，且不会问一句。
    if (it.live) row.append(span('flag flag-live', '进行中'));
    else if (it.exported) row.append(span('flag flag-saved', '已导出'));
    else if (it.exported === false) row.append(span('flag flag-unsaved', '未导出'));
    else row.append(span('flag', ''));

    const pick = () => onPick(it.id);
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    box.append(row);
  }
  return box;
}

/** `20260801T005010Z-3eef52` → `3eef52`。人认得住的只有这一截。 */
export function shortId(id) {
  return String(id).split('-').pop() ?? String(id);
}

/**
 * ISO 时间戳 → `2026-08-01 08:50`。
 *
 * 用**本地时区**，因为读它的人就在本地。带 Z 的 UTC 字符串直接显示会让
 * 「昨晚跑的那次」看起来像是今天凌晨。
 *
 * @param {string} iso
 */
export function humanTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}
