/**
 * 帮助页里那两块要由 JS 填的东西。
 *
 * **拆成两块，是按用途拆的，不是把一块「关于」抄成两份。**
 *
 *   `#about`（页首）—— 身份：这是什么、哪一版、谁做的、会不会把数据传走。
 *   `#links`（页尾）—— 去处：官网、各个仓库、致谢。
 *
 * 分界线是「答的是哪个问题」：页首答「我手上这个东西是什么」，页尾答
 * 「接下来去哪儿」。两边没有一句重复的话——真重复了就会漂，而漂了的那份
 * 谁也不知道该信哪个。
 */

import { $ } from './shared.js';

/**
 * 页首那条身份带：名字、版本号、第三方声明、不上传声明，以及出了问题去哪儿说。
 *
 * **版本号从 manifest 读，不写死在这儿。** 写死的那个迟早会与真实版本对不上，
 * 而一个连自己版本都报错的工具，你没法信它报的别的数字。
 *
 * **它原来在这一页的最后面**，压在九节说明底下。而翻到帮助页的人多半是有什么
 * 不对劲想说，「我装的是哪一版」正是他要说的第一句话——让他为此滚到页尾，
 * 等于把最有动力的那个人挡在外面。反馈的去处跟着一起上来，同一个理由。
 */
export function renderAbout() {
  const el = $('about');
  if (!el) return;
  const box = document.createElement('div');
  box.className = 'hint';

  const m = chrome.runtime.getManifest?.() ?? {};
  const who = document.createElement('p');
  const name = document.createElement('b');
  // **拿不到版本号时明说「版本未知」，不是悄悄不显示。** 少一个数字与从来
  // 没打算显示它，在页面上长得一模一样——而这一页存在的理由就是让人有话可说。
  name.textContent = `豆备 Doubak ${m.version ? `v${m.version}` : '（版本未知）'}`;
  who.append(name);
  box.append(who);

  const what = document.createElement('p');
  what.className = 'small';
  what.textContent = '在本地浏览器中备份豆瓣数据。这是第三方工具，与豆瓣官方无关。'
    + '不上传任何数据，没有服务器，也没有遥测——所有抓取均在本地浏览器中进行，'
    + '直接使用你本地的登录状态与网络连接。许可证为 Apache-2.0。';
  box.append(what);

  // ── 反馈。**跟着身份一起放在页首。**
  //
  // 与 doubak.com 页脚同一套去处。
  const fbTitle = document.createElement('p');
  const fbB = document.createElement('b');
  fbB.textContent = '遇到问题或有反馈建议？';
  fbTitle.append(fbB);
  box.append(fbTitle);

  const fb = document.createElement('ul');
  const FEEDBACK = [
    ['提 issue', 'https://github.com/Doubak/doubak-extension/issues',
      '建议附带上述版本号、「日志」页末尾相关记录，以及具体操作步骤'],
    ['发邮件', 'mailto:admin@doubak.com', 'admin@doubak.com'],
    ['帮忙测试', 'https://doubak.com/#contribute', '目前只有一个账号跑过，很多分支从没被真实数据碰过'],
  ];
  for (const [label, href, note] of FEEDBACK) {
    const li = document.createElement('li');
    li.append(link(label, href), muted(` ${note}`));
    fb.append(li);
  }
  box.append(fb);

  const priv = document.createElement('p');
  priv.className = 'muted small';
  // **报错前先说清楚会带出去什么。** 不说的话，一个在意隐私的人不敢提 issue，
  // 而他恰恰是最该被听见的那类用户。
  priv.textContent = '提交 issue 前请注意：「日志」页可能包含你的用户名与作品链接。'
    + '如有需要可删除相关信息后再张贴——排查问题依赖的是错误信息与操作路径，而非个人数据。';
  box.append(priv);

  el.replaceChildren(box);
}

/**
 * 页尾那一块：去处与致谢。
 *
 * **两类去处要分开。**「这东西是什么、我能拿它做什么」的答案在产品页；
 * 「它是怎么写的」的答案在代码仓库。混在一列里，想装的人会点进一个满是
 * JSON Schema 的仓库，想读代码的人则要在一堆介绍里找入口——两边都没服务好。
 */
export function renderLinks() {
  const el = $('links');
  if (!el) return;
  const box = document.createElement('div');

  const GROUPS = [
    ['了解这个项目', [
      ['官网', 'https://doubak.com', '项目介绍与使用说明'],
      ['样张', 'https://sample.doubak.com', '由真实数据生成的示例站点'],
      ['隐私政策', 'https://doubak.com/privacy/', '不收集、不上传、没有服务器'],
    ]],
    ['源码（Apache-2.0）', [
      // **不写「N 个仓库」。** 这里原来是「整条链路八个仓库」，而第九个
      // （导入适配器）落地时没人想起来改它——一句没有任何东西守着的计数，
      // 迟早会变成一句错话，而它错得毫无声响。链接指向组织页，那儿的列表
      // 永远是准的。
      ['全部仓库', 'https://github.com/Doubak', '整条链路的每一个仓库'],
      ['这个扩展', 'https://github.com/Doubak/doubak-extension', '抓取，产出档案'],
      ['档案格式', 'https://github.com/Doubak/doubak-data-specs', '规范文本与 JSON Schema'],
      ['解析器', 'https://github.com/Doubak/doubak-data-parser', '档案 → 结构化数据'],
      ['站点生成器', 'https://github.com/Doubak/doubak-site-generator', '结构化数据 → 个人存档站'],
      ['导出适配器', 'https://github.com/Doubak/doubak-export-adapters', '结构化数据 → NeoDB / Letterboxd / Goodreads'],
      ['导入适配器', 'https://github.com/Doubak/doubak-import-adapters', '别的工具存下来的页面 → 档案'],
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
      const a = link(href.replace('https://', ''), href);
      td.append(a);
      if (note) td.append(muted(` ${note}`));
      tr.append(th, td);
      tb.append(tr);
    }
    tbl.append(tb);
    box.append(tbl);
  }

  const credits = document.createElement('p');
  credits.className = 'muted small';
  credits.textContent = '致谢：前代命令行工具 its-my-data/doubak 沉淀的历史档案，'
    + '为本项目提供了宝贵的实测数据支持；当前「导入适配器」可将其直接转换为标准档案接入。'
    + '感谢 WARC 规范及 pywb、ReplayWeb.page 等生态工具，使得导出的档案无需依赖本项目即可独立查阅与复现。';
  box.append(credits);

  el.replaceChildren(box);
}

/**
 * 一个外链。
 *
 * `rel` 不是可选的：新标签页打开外链时不带 `noopener`，对方页面能通过
 * `window.opener` 操作这一页。而 `mailto:` 不该开新标签页——那会留下一个空白页。
 *
 * @param {string} text @param {string} href
 */
function link(text, href) {
  const a = document.createElement('a');
  a.href = href;
  if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
  a.textContent = text;
  return a;
}

/** 链接后面那句灰色小注。 @param {string} text */
function muted(text) {
  const n = document.createElement('span');
  n.className = 'muted small';
  n.textContent = text;
  return n;
}
