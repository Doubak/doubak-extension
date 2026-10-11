/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-group.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 从小组页面抽出加入的小组与发起的讨论话题。
 *
 * ## 范围界定
 *
 * 【仅收录用户本人加入的小组与发起的讨论】
 * 他人发起的讨论、小组公共广场以及他人的回复回帖属于第三方社区动态，不在归档范围内；
 * 用户自己发布的主题内容与上传插图为用户创作的不可替代数字资产。
 */

import { decodeEntities } from './html-entities.js';
import { bodyText } from './extract-longform.js';

function text(s) {
  if (typeof s !== 'string') return null;
  const t = decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t || null;
}

const SYSTEM_GROUP_PATHS = new Set(['explore', 'people', 'topic', 'mine', 'search', 'my_topics', 'all', 'discover', 'explore_all']);

/**
 * 抽取加入的小组列表（group.joins）。
 *
 * @param {string} html
 * @returns {Array<{id: string, url: string, name: string|null, role: 'member'|'manager'|null, member_count: number|null, icon_url: string|null}>}
 */
export function extractGroupJoins(html) {
  if (typeof html !== 'string') return [];

  const groups = [];
  const seenIds = new Set();

  // 区分「管理的小组」与「加入的小组」两个区块
  const sections = [];
  const managerIdx = html.indexOf('<h2>管理的小组</h2>');
  const joinsIdx = html.indexOf('<h2>加入的小组</h2>');

  if (managerIdx >= 0 && joinsIdx >= 0) {
    if (managerIdx < joinsIdx) {
      sections.push({ role: 'manager', chunk: html.slice(managerIdx, joinsIdx) });
      sections.push({ role: 'member', chunk: html.slice(joinsIdx) });
    } else {
      sections.push({ role: 'member', chunk: html.slice(joinsIdx, managerIdx) });
      sections.push({ role: 'manager', chunk: html.slice(managerIdx) });
    }
  } else if (managerIdx >= 0) {
    sections.push({ role: 'manager', chunk: html });
  } else {
    sections.push({ role: 'member', chunk: html });
  }

  for (const { role, chunk } of sections) {
    const cardRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
    for (const m of chunk.matchAll(cardRe)) {
      const li = m[1];
      // 必须是小组卡片容器（带有 class="info" 或 class="pic"）
      if (!/<div\b[^>]*class="[^"]*info[^"]*"/.test(li) && !/<div\b[^>]*class="[^"]*pic[^"]*"/.test(li)) continue;

      const linkMatch = /href="https:\/\/www\.douban\.com\/group\/([^/"]+)\/?"/.exec(li);
      if (!linkMatch) continue;
      const id = linkMatch[1];
      if (SYSTEM_GROUP_PATHS.has(id)) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const titleMatch = /<div class="title">\s*<a[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(li)
        ?? /<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(li);
      const name = text(titleMatch?.[1] || titleMatch?.[2]);

      const countMatch = /<span class="num">\s*\((\d+)\)\s*<\/span>/.exec(li);
      const memberCount = countMatch ? Number(countMatch[1]) : null;

      const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(li);
      const iconUrl = imgMatch?.[1] ?? null;

      groups.push({
        id,
        url: `https://www.douban.com/group/${id}/`,
        name,
        role,
        member_count: memberCount,
        icon_url: iconUrl,
      });
    }
  }

  return groups;
}

/**
 * 抽取用户发起的讨论列表（group.publish）。
 *
 * @param {string} html
 * @returns {Array<{id: string, url: string, title: string|null, published_at: string|null, group_id: string|null, group_name: string|null, group_url: string|null}>}
 */
export function extractGroupPublish(html) {
  if (typeof html !== 'string') return [];

  const topics = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(trRe)) {
    const tr = m[1];
    // 必须包含 td.title
    if (!/<td\b[^>]*class="[^"]*title[^"]*"/.test(tr)) continue;

    const topicLink = /<td\b[^>]*class="[^"]*title[^"]*"[\s\S]*?<a[^>]+href="([^"]*\/group\/topic\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(tr);
    if (!topicLink) continue;
    const id = topicLink[2];
    const titleAttr = /title="([^"]*)"/i.exec(topicLink[0])?.[1];
    const title = text(titleAttr) || text(topicLink[3]) || null;

    const timeMatch = /<td\b[^>]*class="[^"]*td-time[^"]*"[^>]*>\s*([\d-]{10}(?:\s*[\d:]{8})?)\s*<\/td>/i.exec(tr);
    const publishedAt = timeMatch?.[1]?.trim() ?? null;

    const groupLink = /<td\b[^>]*class="[^"]*td-group[^"]*"[\s\S]*?<a[^>]+href="https:\/\/www\.douban\.com\/group\/([^/"]+)\/?"[^>]*>([\s\S]*?)<\/a>/i.exec(tr);
    const groupId = groupLink?.[1] ?? null;
    if (SYSTEM_GROUP_PATHS.has(groupId)) continue;
    const groupName = text(groupLink?.[2]);
    const groupUrl = groupId ? `https://www.douban.com/group/${groupId}/` : null;

    topics.push({
      id,
      url: `https://www.douban.com/group/topic/${id}/`,
      title,
      published_at: publishedAt,
      group_id: groupId,
      group_name: groupName,
      group_url: groupUrl,
    });
  }

  return topics;
}

/**
 * 抽取单个话题详情页（group.item）。
 *
 * @param {string} html
 * @param {string} [url]
 * @returns {object|null}
 */
export function extractGroupTopic(html, url = '') {
  if (typeof html !== 'string') return null;

  const idMatch = url.match(/\/group\/topic\/(\d+)/)
    ?? html.match(/_CONFIG\.topic\s*=\s*\{[^}]*"id":\s*"(\d+)"/)
    ?? html.match(/"topic":\s*\{\s*"id":\s*"(\d+)"/)
    ?? html.match(/\/group\/topic\/(\d+)\//);
  const id = idMatch?.[1] ?? null;
  if (!id) return null;

  // 标题
  const cfgTopicTitle = html.match(/_CONFIG\.topic\s*=\s*\{[^}]*"title":\s*"([^"]+)"/)?.[1]
    ?? html.match(/"topic":\s*\{[^}]*"title":\s*"([^"]+)"/)?.[1];
  const h1Text = /<h1>\s*([\s\S]*?)\s*<\/h1>/i.exec(html)?.[1]?.replace(/<div[\s\S]*$/, '');
  let title = text(h1Text) || (cfgTopicTitle ? decodeEntities(JSON.parse(`"${cfgTopicTitle}"`)) : null);

  // 发布时间
  const timeMatch = /<span class="create-time">\s*([\d:\- ]{10,19})\s*<\/span>/i.exec(html)
    ?? /"dateCreated":\s*"([^"]+)"/.exec(html);
  const publishedAt = timeMatch?.[1]?.trim() ?? null;

  // 所属小组
  const cfgGroupId = html.match(/_CONFIG\.group\s*=\s*\{[^}]*"id":\s*"([^"]+)"/)?.[1]
    ?? html.match(/"group":\s*\{[^}]*"id":\s*"([^"]+)"/)?.[1];
  const cfgGroupName = html.match(/_CONFIG\.group\s*=\s*\{[^}]*"name":\s*"([^"]+)"/)?.[1]
    ?? html.match(/"group":\s*\{[^}]*"name":\s*"([^"]+)"/)?.[1];

  let groupId = cfgGroupId ?? null;
  let groupName = cfgGroupName ? decodeEntities(JSON.parse(`"${cfgGroupName}"`)) : null;

  if (!groupId) {
    for (const gm of html.matchAll(/<a[^>]+href="https:\/\/www\.douban\.com\/group\/([^/"]+)\/?"[^>]*>([\s\S]*?)<\/a>/g)) {
      const gid = gm[1];
      if (!SYSTEM_GROUP_PATHS.has(gid)) {
        groupId = gid;
        if (!groupName) groupName = text(gm[2]);
        break;
      }
    }
  }
  const groupUrl = groupId ? `https://www.douban.com/group/${groupId}/` : null;

  // 正文与插图
  // 正文容器通常为 #link-report 或 .rich-content topic-richtext
  const contentMatch = /<div id="link-report"[^>]*>([\s\S]*?)(?=<div class="sns-bar"|<div id="sep"|<\/div>\s*<\/div>\s*<\/div>\s*<!--)/i.exec(html)
    ?? /<div class="rich-content topic-richtext"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="sns-bar"|<\/div>)/i.exec(html);

  const bodyRaw = contentMatch?.[1] ?? '';
  const body = bodyRaw ? bodyText(bodyRaw) : null;

  // 提取正文中的内嵌图片
  const images = [];
  const seenUrls = new Set();
  const imgRe = /<div class="image-container[^"]*">[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?(?:<div class="image-caption">([\s\S]*?)<\/div>[\s\S]*?)?<\/div>\s*<\/div>/g;
  for (const im of bodyRaw.matchAll(imgRe)) {
    const src = im[1];
    if (seenUrls.has(src)) continue;
    seenUrls.add(src);
    const caption = text(im[2]);
    images.push({ url: src, caption });
  }

  // 兜底提取未包在 image-container 的正文插图
  for (const m of bodyRaw.matchAll(/<img[^>]+src="(https:\/\/[^"]*doubanio\.com\/view\/group_topic\/[^"]+)"/gi)) {
    const src = m[1];
    if (!seenUrls.has(src)) {
      seenUrls.add(src);
      images.push({ url: src, caption: null });
    }
  }

  return {
    id,
    url: `https://www.douban.com/group/topic/${id}/`,
    title,
    published_at: publishedAt,
    group_id: groupId,
    group_name: groupName,
    group_url: groupUrl,
    body,
    images,
  };
}
