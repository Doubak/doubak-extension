import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sha256Hex,
  sha1Base32,
  normalizeForDigest,
  digestFields,
  EMPTY_SHA256,
} from '../src/core/digest.js';

const enc = new TextEncoder();

describe('摘要', () => {
  test('sha256 与已知向量一致', async () => {
    assert.equal(
      await sha256Hex(enc.encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('空输入的 sha256 与规范里的常量一致', async () => {
    // 校验器靠这个常量识别零长度载荷（SPEC §6.5.2）。
    assert.equal(await sha256Hex(new Uint8Array(0)), EMPTY_SHA256);
  });

  test('sha1Base32 是 WARC 惯例的形式', async () => {
    // 期望值由 Python 独立算出（hashlib + base64.b32encode），不是从本实现
    // 的输出抄回来的——否则这个测试只能证明「代码没变」，证明不了「代码对」。
    const vectors = [
      ['abc', 'sha1:VGMT4NSHA2AWVOR6EVYXQUGCNSONBWE5'],
      ['', 'sha1:3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ'],
      ['WARC/1.1', 'sha1:UU6HXCCEQSPAF7JKQ4CYRDX4PKAJQFW7'],
    ];
    for (const [input, expected] of vectors) {
      assert.equal(await sha1Base32(enc.encode(input)), expected, `输入 ${JSON.stringify(input)}`);
    }
  });

  test('sha1Base32 只用 RFC 4648 字母表', async () => {
    assert.match(await sha1Base32(enc.encode('任意内容')), /^sha1:[A-Z2-7]+=*$/);
  });

  test('sha1Base32 长度固定（20 字节 → 32 个 base32 字符）', async () => {
    const d = await sha1Base32(enc.encode('任意内容'));
    assert.equal(d.slice('sha1:'.length).length, 32);
  });
});

describe('摘要前的归一化', () => {
  test('统一换行', () => {
    assert.equal(normalizeForDigest('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  });

  test('去掉行尾空白（含全角空格）', () => {
    assert.equal(normalizeForDigest('第一行   \n第二行\t\n第三行　'), '第一行\n第二行\n第三行');
  });

  test('NFC 规范化 —— 组合字符与预组合字符视为同一段文本', () => {
    const decomposed = 'é'; // e + 组合尖音符
    const precomposed = 'é'; // é
    assert.equal(normalizeForDigest(decomposed), normalizeForDigest(precomposed));
  });

  test('【不】折叠简繁 —— 那是真实的编辑', () => {
    // 把「喫」改成「吃」是用户改了字。折叠掉就再也看不见了。
    assert.notEqual(normalizeForDigest('喫飯'), normalizeForDigest('吃饭'));
    assert.notEqual(normalizeForDigest('電影'), normalizeForDigest('电影'));
  });

  test('【不】折叠大小写', () => {
    assert.notEqual(normalizeForDigest('Blade Runner'), normalizeForDigest('blade runner'));
  });

  test('不动行内空白与首部空白', () => {
    // 只清行尾。行内的两个空格是用户写的，缩进也是。
    assert.equal(normalizeForDigest('a  b'), 'a  b');
    assert.equal(normalizeForDigest('  缩进'), '  缩进');
  });

  test('保留空行', () => {
    assert.equal(normalizeForDigest('段一\n\n段二'), '段一\n\n段二');
  });

  test('拒绝非字符串', () => {
    assert.throws(() => normalizeForDigest(/** @type {any} */ (42)), /需要 string/);
  });
});

describe('逐字段摘要', () => {
  test('改评分不会看起来像改评论', async () => {
    // 整体对象比对会把两种完全不同的编辑混为一谈。
    const before = await digestFields({ rating: '4', comment: '还不错' });
    const after = await digestFields({ rating: '5', comment: '还不错' });

    assert.notEqual(before.rating, after.rating, 'rating 应当变了');
    assert.equal(before.comment, after.comment, 'comment 没动，摘要就不该变');
  });

  test('反过来也成立', async () => {
    const before = await digestFields({ rating: '4', comment: '还不错' });
    const after = await digestFields({ rating: '4', comment: '重看了一遍，很好' });

    assert.equal(before.rating, after.rating);
    assert.notEqual(before.comment, after.comment);
  });

  test('只有行尾空白差异时摘要相同', async () => {
    const a = await digestFields({ comment: '看过了   \n很好' });
    const b = await digestFields({ comment: '看过了\n很好' });
    assert.equal(a.comment, b.comment);
  });
});
