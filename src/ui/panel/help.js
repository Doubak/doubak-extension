/**
 * 帮助页里「关于」那一块。
 */

import { $ } from './shared.js';

/**
 * 「关于」那一块。
 *
 * **版本号从 manifest 读，不写死在这儿。** 写死的那个迟早会与真实版本对不上，
 * 而一个连自己版本都报错的工具，你没法信它报的别的数字。
 */
export function renderAbout() {
  const el = $('about');
  if (!el) return;
  const m = chrome.runtime.getManifest?.() ?? {};
  const box = document.createElement('div');

  const who = document.createElement('p');
  who.className = 'muted';
  who.textContent = `豆备${m.version ? ` v${m.version}` : ''} —— 在你自己的浏览器里备份豆瓣。`
    + '这是第三方工具，与豆瓣官方无关。';
  box.append(who);

  // **两类去处要分开。**
  //
  // 「这东西是什么、我能拿它做什么」的答案在产品页；「它是怎么写的」的答案在
  // 代码仓库。混在一列里，想装的人会点进一个满是 JSON Schema 的仓库，
  // 想读代码的人则要在一堆介绍里找入口——两边都没服务好。
  const GROUPS = [
    ['了解这个项目', [
      ['官网', 'https://doubak.com', '它是什么、能做什么'],
      ['样张', 'https://sample.doubak.com', '用作者自己的数据生成的示例站点'],
      ['隐私政策', 'https://doubak.com/privacy/', '不收集、不上传、没有服务器'],
    ]],
    ['源码（Apache-2.0）', [
      ['全部仓库', 'https://github.com/Doubak', '整条链路七个仓库'],
      ['这个扩展', 'https://github.com/Doubak/doubak-extension', '抓取，产出档案'],
      ['档案格式', 'https://github.com/Doubak/doubak-data-specs', '规范文本与 JSON Schema'],
      ['解析器', 'https://github.com/Doubak/doubak-data-parser', '档案 → 结构化数据'],
      ['站点生成器', 'https://github.com/Doubak/doubak-site-generator', '结构化数据 → 个人存档站'],
    ]],
  ];
  for (const [heading, links] of GROUPS) {
    const h = document.createElement('p');
    const hb = document.createElement('b');
    hb.textContent = heading;
    h.append(hb);
    box.append(h);

    const tbl = document.createElement('table');
    const tb = document.createElement('tbody');
    for (const [label, href, note] of links) {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = label;
      const td = document.createElement('td');
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      // 新标签页打开外链时必须带上它，否则对方页面能通过 window.opener 操作这一页。
      a.rel = 'noreferrer noopener';
      a.textContent = href.replace('https://', '');
      td.append(a);
      if (note) {
        const n = document.createElement('span');
        n.className = 'muted small';
        n.textContent = ` ${note}`;
        td.append(n);
      }
      tr.append(th, td);
      tb.append(tr);
    }
    tbl.append(tb);
    box.append(tbl);
  }

  // ── 反馈。**放在关于的最上面，不是最下面。**
  //
  // 用户翻到这一页，多半是因为有什么不对劲想说；把「怎么说」压在致谢和许可
  // 下面，等于让最有动力的那个人去滚屏。与 doubak.com 页脚同一套去处。
  const fbTitle = document.createElement('p');
  const fbB = document.createElement('b');
  fbB.textContent = '出了问题，或者有想法？';
  fbTitle.append(fbB);
  box.append(fbTitle);

  const fb = document.createElement('ul');
  const FEEDBACK = [
    ['提 issue', 'https://github.com/Doubak/doubak-extension/issues',
      '最好带上「日志」页里的最后几行，以及你点了哪个按钮'],
    ['发邮件', 'mailto:admin@doubak.com', 'admin@doubak.com'],
    ['帮忙测试', 'https://doubak.com/#contribute', '目前只有一个账号跑过，很多分支从没被真实数据碰过'],
  ];
  for (const [label, href, note] of FEEDBACK) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = href;
    // mailto 不该开新标签页——那会留下一个空白页。
    if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
    a.textContent = label;
    const n = document.createElement('span');
    n.className = 'muted small';
    n.textContent = ` ${note}`;
    li.append(a, n);
    fb.append(li);
  }
  box.append(fb);

  const priv = document.createElement('p');
  priv.className = 'muted small';
  // **报错前先说清楚会带出去什么。** 不说的话，一个在意隐私的人不敢提 issue,
  // 而他恰恰是最该被听见的那类用户。
  priv.textContent = '提 issue 前请留意：「日志」页里可能含有你的用户名与作品链接。'
    + '需要的话删掉那几行再贴 —— 定位问题靠的是错误信息和你点了什么，不是你的数据。';
  box.append(priv);

  const credits = document.createElement('p');
  credits.className = 'muted small';
  credits.textContent = '致谢：前代命令行工具 its-my-data/doubak 抓下的那批档案，'
    + '是这个项目几乎所有实测结论的来源。WARC 格式与 pywb / ReplayWeb.page 生态，'
    + '让这些档案不依赖本工具也能打开。';
  box.append(credits);

  const legal = document.createElement('p');
  legal.className = 'muted small';
  legal.textContent = '许可 Apache-2.0。不上传任何数据，没有服务器，也没有遥测'
    + '——所有抓取都发生在你自己的浏览器里，用的是你自己的登录状态和网络。';
  box.append(legal);

  el.replaceChildren(box);
}
