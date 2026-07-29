/**
 * 保真度取值。
 *
 * 从规范的 schema 生成的词表（spec-constants.js）给的是**取值列表**；这里
 * 给的是**语义命名**，让调用处读起来是「能不能观察到真实响应头」，而不是
 * 一串魔法字符串。
 *
 * 两者的一致性由测试守着——取值一旦与规范不符，测试会失败。
 */

import { CAPTURE_FIDELITIES } from '../core/spec-constants.js';

/** 线上原始字节。浏览器扩展目前无可行途径，预留。 */
export const RAW = 'raw';

/** 体来自 fetch()（已解码），头由 chrome.webRequest 观察补全，为真实响应头。 */
export const DECODED_OBSERVED = 'decoded_body+observed_headers';

/** 体已解码，头是 fetch() 给的过滤版（Set-Cookie 不可见，顺序与大小写已丢失）。 */
export const DECODED_FILTERED = 'decoded_body+filtered_headers';

/** 供测试核对：这里的取值必须都在规范的词表里。 */
export const ALL = [RAW, DECODED_OBSERVED, DECODED_FILTERED];

/** @param {string} v */
export function isKnownFidelity(v) {
  return CAPTURE_FIDELITIES.includes(v);
}
