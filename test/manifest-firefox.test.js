/**
 * 两份 manifest，一个来源。
 *
 * ## 为什么这条检查值得存在
 *
 * 两份手写的 manifest **一定会漂**，而漂的方向是固定的：Chrome 那份加了个新权限
 * 或新文件，Firefox 那份忘了跟。症状是**装得上、某个功能悄悄不工作**——这个仓库
 * 为「同一条规则在两个地方各写一遍」付过好几次学费（sync-vendor 那次红了两天、
 * 删掉再重标晚了三天、buildMarkdown 少了私密过滤）。
 *
 * 所以只有一份是手写的（`manifest.json`），另一份由 `tools/make-manifest.mjs` 算出来。
 * 这里钉住那个等式——**手改 `manifest.firefox.json` 会红**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { toFirefox, STRICT_MIN_VERSION, DEV_GECKO_ID } from '../tools/make-manifest.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf-8'));

const chrome = read('manifest.json');
const firefox = read('manifest.firefox.json');

describe('manifest.firefox.json 是算出来的，不是写出来的', () => {
  test('它就等于 toFirefox(manifest.json)', () => {
    assert.deepEqual(firefox, toFirefox(chrome));
  });

  test('`--check` 连格式一起核（提交进仓库的是那一份字节）', () => {
    // deepEqual 比的是结构，而仓库里放的是文本。缩进变了、末尾换行没了，
    // 结构照样相等，但 git 上会看见一个没人改过的改动。
    execFileSync('node', ['tools/make-manifest.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  });

  test('**除了三处该不一样的，其余逐键相同**', () => {
    // 这一条才是防漂的那条：加了新权限、新资源而 Firefox 那份没跟上，会在这里红。
    const DIFFER = new Set(['background', 'permissions', 'browser_specific_settings']);
    const keys = new Set([...Object.keys(chrome), ...Object.keys(firefox)]);
    assert.ok(keys.size > 8, `只有 ${keys.size} 个键，判据多半坏了`);
    for (const k of keys) {
      if (DIFFER.has(k)) continue;
      assert.deepEqual(firefox[k], chrome[k], `${k} 在两份 manifest 之间漂了`);
    }
  });
});

describe('那三处差异各自说得出理由', () => {
  test('后台是事件页，不是 service worker', () => {
    // Firefox 没有 background.service_worker（BCD: firefox = NO）——写了它，
    // 载入时直接报 manifest 错误，扩展根本起不来。
    assert.equal(firefox.background.service_worker, undefined);
    assert.deepEqual(firefox.background.scripts, [chrome.background.service_worker]);
    assert.equal(firefox.background.type, 'module', '事件页要 type: module 才能用 ES 模块');
  });

  test('去掉 offscreen 权限，而且**只**去掉它', () => {
    assert.ok(chrome.permissions.includes('offscreen'));
    assert.ok(!firefox.permissions.includes('offscreen'));
    assert.deepEqual(
      firefox.permissions,
      chrome.permissions.filter((p) => p !== 'offscreen'),
      '除了 offscreen，权限不该有别的差别',
    );
  });

  test('**仓库里那份带的是开发用 id，不是真的 AMO id**', () => {
    // 这个扩展在 AMO 上已经有 id 了（归档主人持有），而真 id **不进版本库**。
    // 写错的后果不是报错：AMO 会把它当成一个新的扩展，现有那条上架记录、评价与
    // 用户全都不在这一份上，已经装了的人也收不到更新——「看起来成功了」的失败。
    //
    // MV3 下 Firefox 又**要求必须有 id**（lint 报 ADDON_ID_REQUIRED，量过），
    // 所以不能干脆不写；退而求其次写一个一眼就不像 AMO id 的开发值。
    assert.equal(firefox.browser_specific_settings.gecko.id, DEV_GECKO_ID);
    assert.match(DEV_GECKO_ID, /@localhost$/, '开发用 id 要一眼看得出不是真的');
  });

  test('带着开发用 id 不许出 Firefox 的包', () => {
    // 这条守的是最不可逆的那一步。`--list` 要照常能用（测试在用），
    // 出包才拦——而拦的是**默认路径**：想本地装来试得显式说 --dev。
    const r = spawnSync('node', ['tools/package.mjs', '--firefox'], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(r.status, 0, '带着开发 id 居然出包成功了');
    assert.match(r.stderr, /DOUBAK_GECKO_ID/, '要说清怎么给真的');
    const dev = spawnSync('node', ['tools/package.mjs', '--list', '--firefox'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(dev.status, 0, '--list 不该被拦');
  });

  test('给了环境变量就用真的那个', () => {
    const src = readFileSync(join(ROOT, 'tools/make-manifest.mjs'), 'utf-8');
    assert.match(src, /process\.env\.DOUBAK_GECKO_ID \|\| DEV_GECKO_ID/);
  });

  test('旧的占位不许再出现', () => {
    // 这个扩展在 AMO 上已经有 id 了（归档主人持有）。写错的后果不是报错：
    // AMO 会把它当成一个**新的扩展**，现有那条上架记录、评价与用户全都不在这一份上，
    // 已经装了的人也收不到更新——那种「看起来成功了」的失败。
    //
    // 临时载入与 `web-ext lint` 都不需要 id；只有上传 AMO 时才要，那时显式给
    // `DOUBAK_GECKO_ID=…`。所以仓库里这一份**不该有 id**。
    // 我一度自己编了一个 `doubak@doubak.com` —— 那正是「别替我建 AMO id」要挡的事。
    const all = JSON.stringify(firefox);
    assert.ok(!all.includes('doubak@doubak.com'), '别再编一个 AMO id 出来');
  });

  test('声明「什么都不收集」，而这正是版本下限的来源', () => {
    const g = firefox.browser_specific_settings.gecko;
    assert.deepEqual(g.data_collection_permissions, { required: ['none'] });
    // 这个字段要 Firefox 140。声明了它却把下限写在 140 以下的话，
    // web-ext lint 会报 KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION，而 AMO 会看见。
    assert.ok(
      Number.parseInt(g.strict_min_version, 10) >= 140,
      `声明了 data_collection_permissions 就必须 ≥140，现在是 ${g.strict_min_version}`,
    );
    assert.equal(g.strict_min_version, STRICT_MIN_VERSION);
  });
});

describe('Firefox 那个包带对了文件', () => {
  const list = (args) => execFileSync('node', ['tools/package.mjs', '--list', ...args], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((l) => l && !l.includes('个文件'));

  const ff = list(['--firefox']);
  const cr = list([]);

  test('两个包的差别**只有**那几个用不上的文件', () => {
    assert.ok(cr.length > 100, `Chrome 包只有 ${cr.length} 个文件，判据多半坏了`);
    const onlyChrome = cr.filter((f) => !ff.includes(f));
    const onlyFirefox = ff.filter((f) => !cr.includes(f));
    assert.deepEqual(onlyFirefox, [], 'Firefox 包里有 Chrome 包没有的文件');
    assert.deepEqual(
      onlyChrome.sort(),
      ['src/offscreen/offscreen.html', 'src/runtime/host-offscreen.js'],
      'Firefox 包丢掉的文件不是预期的那几个',
    );
  });

  test('**`offscreen.js` 必须留着** —— Firefox 那条路正靠它', () => {
    // 最容易顺手删错的一个：名字里有 offscreen，但它装的是 `handleOp`，
    // 也就是两个宿主共用的那份 switch。删掉的话 Firefox 上一条命令都派不出去。
    assert.ok(ff.includes('src/offscreen/offscreen.js'));
    assert.ok(ff.includes('src/offscreen/protocol.js'));
    assert.ok(ff.includes('src/runtime/host.js'));
    assert.ok(ff.includes('src/runtime/host-page.js'));
  });

  test('两个包里都有 manifest.json，且都在根部', () => {
    // 浏览器只认这个名字。仓库里 Firefox 那份叫 manifest.firefox.json，
    // 打包时映射成 manifest.json——映射写错的话，包是空壳。
    for (const l of [ff, cr]) assert.ok(l.includes('manifest.json'));
    assert.ok(!ff.includes('manifest.firefox.json'), '不该把那个名字原样打进包里');
  });
});
