import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutes,
  buildUnverifiedApiRoutes,
  checkPrerequisites,
  UNRESOLVED_ROUTES,
  PRIORITY,
} from '../src/crawl/routes.js';

const USER = 'mewcatcher';
const routes = buildRoutes({ username: USER });
/** @param {string} key */
const byKey = (key) => routes.find((r) => r.key === key);

describe('优先级：按不可替代性排', () => {
  test('身份最先，广播紧随，作品详情页最后', () => {
    const order = routes.map((r) => r.key);
    const idx = (k) => order.indexOf(k);

    assert.ok(idx('profile.overview') < idx('broadcast.timeline'), '身份要先于一切');
    assert.ok(
      idx('broadcast.timeline') < idx('interest.movie.collect'),
      '广播不可编辑、可静默删除，必须先于标记列表',
    );
    assert.ok(
      idx('interest.movie.collect') < idx('interest.item'),
      '作品详情页是目录数据，排最后',
    );
  });

  test('作品详情页的优先级明显低于其他', () => {
    assert.equal(byKey('interest.item').priority, PRIORITY.CATALOG);
    assert.ok(PRIORITY.CATALOG > PRIORITY.INTERESTS);
  });
});

describe('前置依赖：不能拿最不可替代的换最可替代的', () => {
  test('作品详情页必须等广播抓完', () => {
    assert.deepEqual(byKey('interest.item').requires, ['broadcast.timeline']);
  });

  test('广播没跑完时作品详情页不 ready', () => {
    const r = checkPrerequisites(byKey('interest.item'), new Set());
    assert.equal(r.ready, false);
    assert.deepEqual(r.waitingFor, ['broadcast.timeline']);
  });

  test('广播跑完后放行', () => {
    const r = checkPrerequisites(byKey('interest.item'), new Set(['broadcast.timeline']));
    assert.equal(r.ready, true);
  });

  test('没有前置依赖的路线始终 ready', () => {
    assert.equal(checkPrerequisites(byKey('broadcast.timeline'), new Set()).ready, true);
  });
});

describe('留存等级', () => {
  test('作品详情页进 catalog 段 —— 「仅删除详情页」靠这个', () => {
    assert.equal(byKey('interest.item').kind, 'catalog');
  });

  test('用户内容进 data 段', () => {
    assert.equal(byKey('broadcast.timeline').kind, 'data');
    assert.equal(byKey('interest.movie.collect').kind, 'data');
  });
});

describe('枚举方式决定下游能否推断删除', () => {
  test('广播是 bounded —— 只走到下界，缺失无法与「没抓到」区分', () => {
    assert.equal(byKey('broadcast.timeline').enumeration, 'bounded');
  });

  test('标记列表是 full —— 整份走完，「上次有这次没有」才有意义', () => {
    assert.equal(byKey('interest.movie.collect').enumeration, 'full');
  });
});

describe('URL 构造（与真实档案里的分页器核对过）', () => {
  test('广播按页码', () => {
    const url = byKey('broadcast.timeline').entryUrl({ username: USER, offset: 5 });
    assert.equal(url, `https://www.douban.com/people/${USER}/statuses?p=5`);
  });

  test('电影带 type=all —— 前代手搓的模板漏了这个参数', () => {
    // 真实档案里页面自己的分页器给的是这套参数。
    const url = byKey('interest.movie.collect').entryUrl({ username: USER, offset: 15 });
    assert.ok(url.startsWith('https://movie.douban.com/people/mewcatcher/collect?start=15'));
    assert.match(url, /type=all/);
    assert.match(url, /sort=time/);
  });

  test('三种状态各自成路线', () => {
    for (const s of ['collect', 'wish', 'do']) {
      const r = byKey(`interest.movie.${s}`);
      assert.ok(r, `应有 interest.movie.${s}`);
      assert.match(r.entryUrl({ username: USER, offset: 0 }), new RegExp(`/${s}\\?`));
    }
  });

  test('游戏走 www 子域并用 action 参数', () => {
    const url = byKey('interest.game.collect').entryUrl({ username: USER, offset: 30 });
    assert.equal(url, `https://www.douban.com/people/${USER}/games?action=collect&start=30`);
  });

  test('舞台剧走 location 路径，且没有「在看」', () => {
    assert.match(
      byKey('interest.drama.collect').entryUrl({ username: USER, offset: 0 }),
      /location\/people\/mewcatcher\/drama\/collect/,
    );
    assert.equal(byKey('interest.drama.do'), undefined, '实测舞台剧没有 do');
  });

  test('书与音乐各走自己的子域', () => {
    assert.match(byKey('interest.book.collect').entryUrl({ username: USER, offset: 0 }), /^https:\/\/book\.douban\.com\//);
    assert.match(byKey('interest.music.collect').entryUrl({ username: USER, offset: 0 }), /^https:\/\/music\.douban\.com\//);
  });

  test('用户名会被转义', () => {
    const rs = buildRoutes({ username: 'a b&c' });
    const url = rs.find((r) => r.key === 'broadcast.timeline').entryUrl({ username: 'a b&c', offset: 1 });
    assert.ok(!url.includes(' '), 'URL 里不该有裸空格');
    assert.match(url, /a%20b%26c/);
  });
});

describe('分页步长', () => {
  test('标记列表每页 15', () => {
    assert.deepEqual(byKey('interest.movie.collect').pagination, {
      kind: 'start',
      step: 15,
      first: 0,
    });
  });

  test('广播按页码从 1 开始', () => {
    assert.deepEqual(byKey('broadcast.timeline').pagination, { kind: 'page', step: 1, first: 1 });
  });
});

describe('出处必须标注', () => {
  test('每条路线都有 source', () => {
    for (const r of routes) {
      assert.ok(['archive', 'tofu', 'unknown'].includes(r.source), `${r.key} 缺少可信的 source`);
    }
  });

  test('已核对的路线标 archive', () => {
    // 这些的 URL 在真实档案的分页器里核对过。
    for (const k of ['broadcast.timeline', 'interest.movie.collect', 'interest.game.collect']) {
      assert.equal(byKey(k).source, 'archive');
    }
  });

  test('抄自 tofu 的接口路线明确标出未核对', () => {
    const api = buildUnverifiedApiRoutes({ userId: '82160871' });
    for (const r of api) {
      assert.equal(r.source, 'tofu');
      assert.match(r.note, /未经核对/);
      assert.equal(r.surface, 'api');
    }
  });

  test('Rexxar 路线用数字 ID 而不是用户名', () => {
    const api = buildUnverifiedApiRoutes({ userId: '82160871' });
    assert.match(api[0].entryUrl({ offset: 0 }), /user\/82160871\//);
    assert.throws(() => buildUnverifiedApiRoutes({ userId: '' }), /数字用户 ID/);
  });
});

describe('没有可用 URL 的路线单独列出', () => {
  test('app 的列表路线仍是未知', () => {
    // 混进 buildRoutes 会让覆盖率报告出现一个永远为 0 的条目，看起来像 bug。
    const app = UNRESOLVED_ROUTES['interest.app'];
    assert.equal(app.source, 'unknown');
    assert.match(app.reason, /未知/);
    assert.equal(routes.find((r) => r.key.includes('app')), undefined);
  });
});

describe('范围可裁剪', () => {
  test('可以只抓部分分类', () => {
    const only = buildRoutes({ username: USER, mediums: ['movie'] });
    assert.ok(only.some((r) => r.key === 'interest.movie.collect'));
    assert.ok(!only.some((r) => r.key.startsWith('interest.book')));
  });

  test('可以关掉作品详情页', () => {
    const noCatalog = buildRoutes({ username: USER, includeCatalog: false });
    assert.equal(noCatalog.find((r) => r.key === 'interest.item'), undefined);
    assert.ok(noCatalog.some((r) => r.key === 'broadcast.timeline'), '其他路线不受影响');
  });

  test('缺 username 直接抛', () => {
    assert.throws(() => buildRoutes({}), /username/);
  });
});
