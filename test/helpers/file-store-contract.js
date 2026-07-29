/**
 * FileStore 的契约测试。
 *
 * 同一组断言同时跑在两个实现上：
 * - Node 里跑 `MemoryFileStore`（test/file-store.test.js）
 * - 浏览器里跑 `OpfsFileStore`（selftest/，需要真实浏览器）
 *
 * 这样「内存实现过了但 OPFS 行为不一样」这个最危险的差异就跑不掉了——
 * 写入器的正确性全部建立在 FileStore 的语义上，两个实现不一致的话，
 * Node 里的 243 个测试就都在为一件不会真实发生的事背书。
 *
 * 刻意不依赖 node:test 或任何断言库：浏览器里也要能跑。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {boolean} cond @param {string} msg */
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** @param {unknown} a @param {unknown} b @param {string} msg */
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

/** @param {Uint8Array} a @param {Uint8Array} b @param {string} msg */
function bytesEq(a, b, msg) {
  if (a.length !== b.length) throw new Error(`${msg}：长度 ${a.length} ≠ ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`${msg}：第 ${i} 字节 ${a[i]} ≠ ${b[i]}`);
  }
}

/** @param {() => Promise<void>} fn @param {RegExp} re @param {string} msg */
async function rejects(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg}：错误信息不匹配——${e.message}`);
    return;
  }
  throw new Error(`${msg}：本应抛错却没有`);
}

/**
 * @typedef {{name: string, fn: (store: any) => Promise<void>}} ContractCase
 */

/**
 * 返回契约用例列表。
 *
 * 每个用例拿到一个**全新的空 store**，用例之间不共享状态。
 *
 * @returns {ContractCase[]}
 */
export function fileStoreContract() {
  return [
    {
      name: '追加：文件不存在时创建',
      async fn(store) {
        await store.append('a.warc.gz', enc.encode('第一段'));
        eq(dec.decode(await store.read('a.warc.gz')), '第一段', '内容应当写进去了');
      },
    },
    {
      name: '追加：多次追加首尾相接',
      async fn(store) {
        await store.append('a', enc.encode('一'));
        await store.append('a', enc.encode('二'));
        await store.append('a', enc.encode('三'));
        eq(dec.decode(await store.read('a')), '一二三', '应当首尾相接');
      },
    },
    {
      name: 'size 就是下一条记录的偏移量',
      async fn(store) {
        eq(await store.size('a'), 0, '不存在的文件长度为 0');
        const first = enc.encode('第一条记录');
        await store.append('a', first);
        eq(await store.size('a'), first.length, 'size 应等于已写字节数');

        const second = enc.encode('第二条');
        const offsetOfSecond = await store.size('a');
        await store.append('a', second);
        bytesEq(await store.read('a', offsetOfSecond, second.length), second, '按偏移量取回');
      },
    },
    {
      name: '追加后不共享底层缓冲',
      async fn(store) {
        const buf = enc.encode('原始');
        await store.append('a', buf);
        buf[0] = 0x41;
        eq(dec.decode(await store.read('a')), '原始', '调用方改自己的数组不该影响已写内容');
      },
    },
    {
      name: '替换：整体覆盖',
      async fn(store) {
        await store.append('manifest.json', enc.encode('{"v":1}'));
        await store.replace('manifest.json', enc.encode('{"v":2}'));
        eq(dec.decode(await store.read('manifest.json')), '{"v":2}', '应被整体替换');
      },
    },
    {
      name: '替换：文件不存在时也能用',
      async fn(store) {
        await store.replace('new.json', enc.encode('x'));
        eq(await store.size('new.json'), 1, '应当创建');
      },
    },
    {
      name: '替换：变短时不留残尾',
      async fn(store) {
        await store.append('a', enc.encode('很长很长的旧内容'));
        await store.replace('a', enc.encode('短'));
        eq(dec.decode(await store.read('a')), '短', '旧内容必须被完全清掉');
      },
    },
    {
      name: '读取：按 offset/length',
      async fn(store) {
        await store.append('a', enc.encode('0123456789'));
        eq(dec.decode(await store.read('a')), '0123456789', '读全文');
        eq(dec.decode(await store.read('a', 3, 4)), '3456', '按范围读');
        eq(dec.decode(await store.read('a', 7)), '789', '只给 offset 读到末尾');
      },
    },
    {
      name: '读取：越界必须抛，不能悄悄返回短数据',
      async fn(store) {
        await store.append('a', enc.encode('0123456789'));
        await rejects(() => store.read('a', 5, 10), /越界/, '超出末尾');
        await rejects(() => store.read('a', 11, 1), /越界/, '起点超出');
        await rejects(() => store.read('a', -1, 2), /越界/, '负偏移');
      },
    },
    {
      name: '读取：文件不存在必须抛',
      async fn(store) {
        await rejects(() => store.read('nope'), /文件不存在/, '不存在的文件');
      },
    },
    {
      name: '读取：返回副本',
      async fn(store) {
        await store.append('a', enc.encode('0123456789'));
        const got = await store.read('a');
        got[0] = 0x5a;
        eq(dec.decode(await store.read('a')), '0123456789', '改返回值不该影响存储');
      },
    },
    {
      name: '截断：切到指定长度',
      async fn(store) {
        await store.append('seg', enc.encode('0123456789'));
        await store.truncate('seg', 4);
        eq(dec.decode(await store.read('seg')), '0123', '应被切短');
        eq(await store.size('seg'), 4, 'size 应随之变化');
      },
    },
    {
      name: '截断：可以截到 0，但不等于删除',
      async fn(store) {
        await store.append('seg', enc.encode('0123456789'));
        await store.truncate('seg', 0);
        eq(await store.size('seg'), 0, '长度为 0');
        eq(await store.exists('seg'), true, '文件仍应存在');
      },
    },
    {
      name: '截断：拒绝「截」到比现有更长',
      async fn(store) {
        // 允许的话就成了补零扩展，会在段文件里悄悄插入合法的零字节，
        // 而崩溃恢复恰恰依赖「尾部要么是完整 member、要么解压失败」。
        await store.append('seg', enc.encode('0123456789'));
        await rejects(() => store.truncate('seg', 20), /大于文件长度/, '不许补零扩展');
      },
    },
    {
      name: '截断后继续追加，偏移量从新长度接上',
      async fn(store) {
        // 崩溃恢复之后就是这个流程。
        await store.append('seg', enc.encode('0123456789'));
        await store.truncate('seg', 4);
        const resumeOffset = await store.size('seg');
        await store.append('seg', enc.encode('ABC'));

        eq(resumeOffset, 4, '恢复点应为 4');
        eq(dec.decode(await store.read('seg')), '0123ABC', '接上写');
        eq(dec.decode(await store.read('seg', resumeOffset, 3)), 'ABC', '新内容按偏移量可取');
      },
    },
    {
      name: 'exists 与 remove',
      async fn(store) {
        eq(await store.exists('a'), false, '起初不存在');
        await store.append('a', enc.encode('x'));
        eq(await store.exists('a'), true, '写后存在');
        await store.remove('a');
        eq(await store.exists('a'), false, '删后不存在');
        await store.remove('nope'); // 不该抛
      },
    },
    {
      name: 'list 按字典序',
      async fn(store) {
        await store.append('data-B-00002.warc.gz', enc.encode('x'));
        await store.append('data-B-00001.warc.gz', enc.encode('x'));
        await store.append('data-A-00010.warc.gz', enc.encode('x'));
        const got = (await store.list()).join(',');
        eq(
          got,
          'data-A-00010.warc.gz,data-B-00001.warc.gz,data-B-00002.warc.gz',
          '段文件名带零填充序号，字典序即写入序',
        );
      },
    },
    {
      name: '文件名：拒绝路径分隔符与空名',
      async fn(store) {
        for (const bad of ['a/b', 'a\\b', '../x', '.', '..', '']) {
          await rejects(
            () => store.append(bad, enc.encode('x')),
            /路径分隔符|不能为空/,
            `不该接受 ${JSON.stringify(bad)}`,
          );
        }
      },
    },
    {
      name: '二进制安全：任意字节原样往返',
      async fn(store) {
        // 图片段存的就是这种东西。
        const raw = new Uint8Array(256);
        for (let i = 0; i < 256; i++) raw[i] = i;
        await store.append('bin', raw);
        bytesEq(await store.read('bin'), raw, '所有字节值都应原样保留');
      },
    },
    {
      name: '较大写入：分多次追加后整体一致',
      async fn(store) {
        // 真实段文件是几百 MB 级别，这里做个小规模的连续追加检查。
        const chunk = new Uint8Array(64 * 1024).fill(0xa5);
        for (let i = 0; i < 16; i++) await store.append('big', chunk);
        eq(await store.size('big'), 16 * chunk.length, '总长度应正确');
        const tail = await store.read('big', 15 * chunk.length, chunk.length);
        bytesEq(tail, chunk, '最后一块应完整');
      },
    },
  ];
}

export { ok, eq, bytesEq, rejects };
