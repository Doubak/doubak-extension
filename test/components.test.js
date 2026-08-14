/**
 * 界面里那几块共享的东西。
 *
 * 这些测试守的不是「渲染得出来」，而是**几条不这么做就会重新散掉的规矩**。
 * 之前没有这个文件，也没有这些规矩，于是「对用户说一句话」在 panel.js 里
 * 长出了八种写法。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.js';

/** 组件要操作 DOM，所以先把假 DOM 装上，再动态引入。 */
async function load() {
  const dom = await installFakeDom({ html: '<body><div id="host"></div></body>' });
  const mod = await import(`../src/ui/components.js?${Math.random()}`);
  return { dom, ...mod };
}

describe('消息卡', () => {
  test('**warn 与 error 不给下一步就直接抛**', async () => {
    // docs/ui.md §5：「每一种都要给出明确的下一步，不能只显示一个错误码」。
    // 那本来只是一句约定，靠人记得。这里把它变成写不出反例的东西。
    const { statusCard } = await load();
    for (const tone of ['warn', 'error']) {
      assert.throws(() => statusCard({ tone, title: '出事了' }), /没有给下一步/);
    }
  });

  test('确实无事可做时要显式写出来', async () => {
    // 例外必须是一次有意识的决定，不能靠沉默通过。
    const { statusCard } = await load();
    const el = statusCard({ tone: 'error', title: '已取消', allowNoAction: true });
    assert.match(el.className, /tone-error/);
  });

  test('idle / busy / ok 不需要动作', async () => {
    const { statusCard } = await load();
    for (const tone of ['idle', 'busy', 'ok']) {
      assert.doesNotThrow(() => statusCard({ tone, title: 'x' }));
    }
  });

  test('**文字一律走 textContent，不拼 HTML**', async () => {
    // 用户写的字里有尖括号很正常（实测「From <May December>」）。
    const { statusCard } = await load();
    const el = statusCard({ tone: 'idle', title: '<img src=x onerror=alert(1)>' });
    assert.equal(el.querySelector('b').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(el.querySelector('img'), null);
  });

  test('出错的卡片要能被读屏软件立刻念出来', async () => {
    const { statusCard } = await load();
    assert.equal(statusCard({ tone: 'error', title: 'x', allowNoAction: true }).getAttribute('role'), 'alert');
    assert.equal(statusCard({ tone: 'idle', title: 'x' }).getAttribute('role'), 'status');
  });

  test('语气写进 class，而不是写死颜色', async () => {
    // 把外观当语义（`card err`、`warn-text`）的话，换套配色就要全文搜一遍。
    const { statusCard } = await load();
    assert.equal(statusCard({ tone: 'ok', title: 'x' }).className, 'card tone-ok');
  });
});

describe('档案选择器', () => {
  const items = [
    { id: '20260807T083529Z-0fb09c', at: '2026-08-07T18:35:29+10:00', bytes: 172000000, captures: 5880, previous: null, live: true },
    { id: '20260807T062518Z-c34601', at: '2026-08-07T16:25:18+10:00', bytes: 500000, captures: 31, previous: '20260807T050438Z-9f5719', exported: true },
    { id: '20260801T005010Z-3eef52', at: '2026-08-01T10:50:10+10:00', bytes: 177000000, captures: 6399, previous: null, exported: false },
  ];
  const fmtBytes = (n) => `${Math.round(n / 1024 / 1024)} MB`;

  test('**每一行自己说清楚是哪一份**，不是一串编号', async () => {
    // 原来是个下拉框，选项文字就是 `20260801T005010Z-3eef52`。八份长这样的
    // 东西，人只能靠后六位分辨，而后六位不携带任何意义。
    const { bundlePicker } = await load();
    const el = bundlePicker({ items, selected: items[0].id, onPick: () => {}, fmtBytes });
    const rows = el.querySelectorAll('.picker-row');
    assert.equal(rows.length, 3);

    const first = rows[0].textContent;
    // **只断言形状，不断言具体时刻。** humanTime 按本地时区显示（那是对的，
    // 读它的人就在本地），所以写死 `18:35` 等于把这台机器的时区焊进测试——
    // CI 在 UTC 上跑，渲染出来是 08:35，于是本地全绿、CI 全红。
    // 时区换算本身由下面「时间显示」那组测试守，写法与时区无关。
    assert.match(first, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '要有人读得懂的时间');
    assert.match(first, /全量/);
    assert.match(first, /5,?880 条/);
    assert.match(first, /164 MB/);
    assert.match(first, /进行中/);
  });

  test('增量要说清接在谁后面 —— 链断了才看得出来', async () => {
    const { bundlePicker } = await load();
    const el = bundlePicker({ items, selected: null, onPick: () => {}, fmtBytes });
    // **不用箭头**：单独一行只讲一份档案，箭头在这里有两种读法（接自它 / 产出它），
    // 写成话就没有歧义。链条那张图才有方向约定，见 docs/ui.md「链条画成什么样」。
    assert.match(el.querySelectorAll('.picker-row')[1].textContent, /增量 · 接自 9f5719/);
    assert.doesNotMatch(el.querySelectorAll('.picker-row')[1].textContent, /[←→]/);
  });

  test('**「未导出」要显眼**', async () => {
    // 那是「这份还只存在于扩展存储里」的意思，而扩展存储会被卸载扩展、
    // 清站点数据一次性抹掉，且不会问一句。
    const { bundlePicker } = await load();
    const el = bundlePicker({ items, selected: null, onPick: () => {}, fmtBytes });
    const rows = el.querySelectorAll('.picker-row');
    assert.match(rows[1].textContent, /已导出/);
    assert.match(rows[2].textContent, /未导出/);
  });

  test('**导出记录读不出来时不显示成「未导出」**', async () => {
    // 那是替用户下一个我们没资格下的判断。exported 为 null 时什么都不说。
    const { bundlePicker } = await load();
    const el = bundlePicker({
      items: [{ id: 'a-111111', at: '2026-08-01T00:00:00+08:00', exported: null }],
      selected: null, onPick: () => {}, fmtBytes,
    });
    const t = el.querySelector('.picker-row').textContent;
    assert.ok(!/未导出|已导出/.test(t), `不该下判断，实际显示：${t}`);
  });

  test('选中的那一行标出来，且键盘也能选', async () => {
    const { bundlePicker } = await load();
    const picked = [];
    const el = bundlePicker({ items, selected: items[1].id, onPick: (id) => picked.push(id), fmtBytes });
    const rows = el.querySelectorAll('.picker-row');
    assert.equal(rows[1].getAttribute('aria-selected'), 'true');
    assert.equal(rows[0].getAttribute('aria-selected'), 'false');
    assert.equal(rows[0].tabIndex, 0, '要能用键盘走到');
  });

  test('元数据读不出来的档案照样列出来', async () => {
    // 一份读不出 manifest 的档案恰恰最需要能被选中——用户要去看它出了什么事。
    // 因为元数据缺失就让它从列表里消失，是最糟的处理。
    const { bundlePicker } = await load();
    const el = bundlePicker({
      items: [{ id: '20260801T005010Z-3eef52' }],
      selected: null, onPick: () => {}, fmtBytes,
    });
    const t = el.querySelector('.picker-row').textContent;
    assert.match(t, /3eef52/);
    assert.match(t, /时间不详/);
  });
});

describe('时间显示', () => {
  test('**用本地时区**', async () => {
    // 带 Z 的 UTC 字符串直接显示，会让「昨晚跑的那次」看起来像今天凌晨。
    const { humanTime } = await load();
    const iso = '2026-08-07T08:35:29+08:00';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    assert.equal(humanTime(iso), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
  });

  test('解析不了就原样显示，不显示 Invalid Date', async () => {
    const { humanTime } = await load();
    assert.equal(humanTime('不是时间'), '不是时间');
  });
});
