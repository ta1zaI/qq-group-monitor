const fs = require("node:fs");
const path = require("node:path");
const { countMessagesForDay } = require("./db");

function localDay(sentAt) {
  const date = new Date(sentAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    dates.push(localDay(current.toISOString()));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function normalizeContent(content) {
  return String(content || "")
    .replace(/\[face\]/g, "")
    .replace(/\[\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u52a8\u753b\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u8d34\u7eb8[^\]]*\]/g, "")
    .replace(/\[sticker[^\]]*\]/gi, "")
    .replace(/\[emoji[^\]]*\]/gi, "")
    .replace(/\[image\]/g, "")
    .replace(/\[\u56fe\u7247[^\]]*\]/g, "")
    .replace(/\[image:\s*[^\]]+\]/gi, "")
    .replace(/\[\u56de\u590d[^\]]*\]\s*/g, "")
    .replace(/\[reply\]/gi, "")
    .replace(/\[at\]/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^@\S+\s*/, "")
    .trim();
}

function parseRaw(rawJson) {
  try {
    return JSON.parse(rawJson || "{}");
  } catch {
    return {};
  }
}

function hasStructuredPart(row, type) {
  const raw = parseRaw(row.raw_json);
  const message = raw.message;
  return Array.isArray(message) && message.some((segment) => segment?.type === type);
}

function imageNames(rawJson) {
  const raw = parseRaw(rawJson);

  const names = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const type = String(node.type || "").toLowerCase();
    const data = node.data || node;
    const name = data.file || data.filename || data.localPath || data.url || data.source || "";
    if (type.includes("image") || /\.(jpg|jpeg|png|gif|webp)$/i.test(String(name))) {
      names.push(path.basename(String(name)).toLowerCase());
    }
    for (const key of ["message", "elements", "resources", "content"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(raw);
  return [...new Set(names)].sort();
}

function rowTime(row) {
  const time = new Date(row.sent_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

function minuteBucket(sentAt, offsetSeconds = 0) {
  return Math.floor((rowTime({ sent_at: sentAt }) + offsetSeconds * 1000) / 60000);
}

function hasImages(row) {
  return imageNames(row.raw_json).length > 0 || String(row.message_type || "").includes("image");
}

function duplicateKey(row, offsetSeconds = 0) {
  const text = normalizeContent(row.content);
  const body = text || (hasImages(row) ? "[image]" : String(row.message_type || ""));
  return [
    row.group_id,
    row.user_id,
    minuteBucket(row.sent_at, offsetSeconds),
    body
  ].join("\u001f");
}

function rank(row) {
  let score = 0;
  if (row.platform === "onebot") score += 100;
  if (row.platform === "qce") score += 50;
  if (hasStructuredPart(row, "at")) score += 30;
  if (hasStructuredPart(row, "reply")) score += 20;
  if (hasImages(row)) score += 10;
  if (normalizeContent(row.content)) score += 5;
  return score;
}

function addDuplicateGroup(duplicateIds, group) {
  const unique = [...new Map(group.map((row) => [row.id, row])).values()];
  if (unique.length < 2) return;
  const sorted = unique.sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  for (const row of sorted.slice(1)) duplicateIds.add(row.id);
}

function addWindowedDuplicates(duplicateIds, groups, windowMs) {
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => rowTime(a) - rowTime(b) || a.id - b.id);
    let cluster = [];
    for (const row of sorted) {
      if (!cluster.length || rowTime(row) - rowTime(cluster[0]) <= windowMs) {
        cluster.push(row);
      } else {
        addDuplicateGroup(duplicateIds, cluster);
        cluster = [row];
      }
    }
    addDuplicateGroup(duplicateIds, cluster);
  }
}

function findDuplicateIds(rows) {
  const duplicateIds = new Set();
  const buckets = new Map();
  for (const row of rows) {
    for (const offset of [-30, 0, 30]) {
      const key = duplicateKey(row, offset);
      const list = buckets.get(key) || [];
      list.push(row);
      buckets.set(key, list);
    }
  }

  const reviewed = new Set();
  for (const group of buckets.values()) {
    const unique = [...new Map(group.map((row) => [row.id, row])).values()];
    if (unique.length < 2) continue;
    const reviewKey = unique.map((row) => row.id).sort((a, b) => a - b).join(",");
    if (reviewed.has(reviewKey)) continue;
    reviewed.add(reviewKey);
    addDuplicateGroup(duplicateIds, unique);
  }

  const textGroups = new Map();
  const imageGroups = new Map();
  const closeTextGroups = new Map();
  for (const row of rows) {
    const text = normalizeContent(row.content);
    const day = localDay(row.sent_at);
    if (text) {
      const key = [row.group_id, row.user_id, day, text].join("\u001f");
      const group = textGroups.get(key) || [];
      group.push(row);
      textGroups.set(key, group);

      const looseKey = [row.group_id, day, minuteBucket(row.sent_at), text].join("\u001f");
      const looseGroup = closeTextGroups.get(looseKey) || [];
      looseGroup.push(row);
      closeTextGroups.set(looseKey, looseGroup);
    } else if (hasImages(row)) {
      const key = [row.group_id, row.user_id, day, "[image]"].join("\u001f");
      const group = imageGroups.get(key) || [];
      group.push(row);
      imageGroups.set(key, group);
    }
  }

  addWindowedDuplicates(duplicateIds, textGroups, 5 * 60 * 1000);
  addWindowedDuplicates(duplicateIds, closeTextGroups, 90 * 1000);
  addWindowedDuplicates(duplicateIds, imageGroups, 90 * 1000);
  return duplicateIds;
}

function dedupeMessages(db, options = {}) {
  const groupId = String(options.groupId || "");
  const startDate = options.startDate;
  const endDate = options.endDate;
  if (!groupId || !startDate || !endDate) throw new Error("groupId, startDate and endDate are required");

  const dates = dateRange(startDate, endDate);
  const beforeCounts = Object.fromEntries(dates.map((date) => [date, countMessagesForDay(db, date, groupId)]));
  const rows = db.prepare(`
    SELECT id, platform, platform_message_id, group_id, user_id, message_type, content, raw_json, sent_at
    FROM messages
    WHERE group_id = ?
      AND date(sent_at, 'localtime') >= ?
      AND date(sent_at, 'localtime') <= ?
    ORDER BY sent_at ASC, id ASC
  `).all(groupId, startDate, endDate);
  const duplicateIds = findDuplicateIds(rows);

  if (options.apply && duplicateIds.size) {
    const backupPath = options.backupPath;
    if (backupPath && fs.existsSync(options.dbPath)) fs.copyFileSync(options.dbPath, backupPath);
    const deleteStmt = db.prepare("DELETE FROM messages WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const id of duplicateIds) deleteStmt.run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const afterCounts = Object.fromEntries(dates.map((date) => [date, countMessagesForDay(db, date, groupId)]));
  return {
    scanned: rows.length,
    duplicateCount: duplicateIds.size,
    apply: Boolean(options.apply),
    beforeCounts,
    afterCounts
  };
}

module.exports = { dedupeMessages, normalizeContent, imageNames, findDuplicateIds };
