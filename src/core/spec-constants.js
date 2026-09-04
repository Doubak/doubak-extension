// 本文件由 tools/generate-spec-constants.mjs 自动生成，请勿手改。
// 来源：doubak-data-specs/bundle/v1/*.schema.json
// 重新生成：node tools/generate-spec-constants.mjs
//
// 规范是唯一权威，本文件是它的投影。手抄这些取值意味着规范新增一个
// verdict 之后，扩展会继续把它当非法值拒掉，且没有任何东西会提醒你。

/** 本扩展按哪一版规范写入。 */
export const SPEC_VERSION = "bundle/1.4";

/**
 * 生成来源的摘要：common.schema.json、index-entry.schema.json、crawl-state-entry.schema.json 的内容哈希。
 *
 * 这是溯源信息——回答「这份常量是照着哪一版 schema 生成的」。只覆盖实际
 * 读取的文件，所以规范仓库改文档或加测试用例不会让它变，只有真正影响生成
 * 结果的改动才会。
 */
export const SPEC_SOURCE_DIGEST = "d47f9abb353bb4775322f4147f355da292dcc75c77196bc160b53699378a523b";

/**
 * 响应可信度判定。封闭词表——安全相关字段，拼错必须失败。
 * 读者遇到未知取值必须当作不可信，不得当作 ok。
 */
export const VERDICTS = Object.freeze([
  "ok",
  "blocked",
  "challenge",
  "login",
  "gone",
  "soft404",
  "unknown",
]);

/** 抓取面。同一条内容可能在两面各存一份，不标注会被误认为两次修订。 */
export const SURFACES = Object.freeze([
  "html",
  "api",
  "asset",
]);

/** 保真度。浏览器拿不到完全未经处理的原始字节，此字段如实记录实际成色。 */
export const CAPTURE_FIDELITIES = Object.freeze([
  "raw",
  "decoded_body+observed_headers",
  "decoded_body+filtered_headers",
  "decoded_body+synthesized_headers",
]);

/** 枚举方式。决定下游有没有资格推断删除。 */
export const ENUMERATIONS = Object.freeze([
  "full",
  "bounded",
]);

/** 段前缀，表示留存等级而非媒体类型。 */
export const SEGMENT_KINDS = Object.freeze([
  "data",
  "assets",
  "catalog",
]);

/** index.ndjson 每行的必填字段，都属于事后不可恢复的那一类。 */
export const REQUIRED_INDEX_FIELDS = Object.freeze([
  "capture_id",
  "warc_record_id",
  "segment",
  "offset",
  "length",
  "url",
  "intent",
  "route_key",
  "surface",
  "verdict",
  "capture_fidelity",
  "observed_at",
]);
