import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPowChallenge, extractPowChallenge, sha512Hex, solvePowChallenge } from '../src/crawl/pow.js';
import { fixtures } from './helpers/fixtures.js';

describe('PoW 算力挑战识别 (isPowChallenge)', () => {
  test('识别标准的 sec.douban.com/c 算力表单', () => {
    assert.equal(
      isPowChallenge('https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F123%2F', fixtures.powChallengePage),
      true,
    );
  });

  test('识别真实 dump 的豆瓣 PoW 页面', () => {
    try {
      const dump = readFileSync(new URL('../../downloads/豆瓣.html', import.meta.url), 'utf-8');
      assert.equal(isPowChallenge('https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F37134598%2F', dump), true);
    } catch {
      // 允许在没有外部 dump 文件的环境中跳过真实文件读取
    }
  });

  test('非 sec.douban.com 域名不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://movie.douban.com/c', fixtures.powChallengePage), false);
    assert.equal(isPowChallenge('https://www.douban.com/c', fixtures.powChallengePage), false);
  });

  test('非 /c 路径不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://sec.douban.com/b?r=x', fixtures.powChallengePage), false);
  });

  test('无表单的风控或普通页面不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', fixtures.blockedPage), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', fixtures.securityChallengePage), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', ''), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', null), false);
  });
});

describe('PoW 参数提取 (extractPowChallenge)', () => {
  test('从表单正确提取 tok, cha, red 与 difficulty', () => {
    const extracted = extractPowChallenge(fixtures.powChallengePage);
    assert.deepEqual(extracted, {
      tok: '1792280920@testtok',
      cha: 'testchallenge12345',
      red: 'https://movie.douban.com/subject/37134598/',
      difficulty: 4,
    });
  });

  test('支持自定义 difficulty 参数', () => {
    const html = fixtures.powChallengePage.replace('</form>', '</form><script>difficulty = 3;</script>');
    const extracted = extractPowChallenge(html);
    assert.equal(extracted?.difficulty, 3);
  });

  test('缺少 tok 或 cha 时返回 null', () => {
    assert.equal(extractPowChallenge('<form id="sec" action="/c"><input name="red" value="x"></form>'), null);
    assert.equal(extractPowChallenge(''), null);
    assert.equal(extractPowChallenge(null), null);
  });
});

describe('SHA-512 计算与 PoW 求解', () => {
  test('sha512Hex 输出已知向量', async () => {
    const emptyHash = await sha512Hex('');
    assert.equal(
      emptyHash,
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
  });

  test('solvePowChallenge 在指定难度下产出有效 nonce', async () => {
    const cha = 'test-challenge-seed';
    const nonce = await solvePowChallenge(cha, 2);
    assert.ok(nonce > 0);
    const hash = await sha512Hex(cha + nonce);
    assert.ok(hash.startsWith('00'), `Hash should start with '00', got: ${hash}`);
  });

  test('缺少 subtle.digest 时明确抛出错误', async () => {
    await assert.rejects(
      () => sha512Hex('test', {}),
      /缺少 crypto\.subtle\.digest 支持/,
    );
  });
});
