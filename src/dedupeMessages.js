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
    .replace(/\[表情\]/g, "")
    .replace(/\[动画表情\]/g, "")
    .replace(/\[贴纸\]/g, "")
    .replace(/\[sticker\]/gi, "")
    .replace(/\[emoji\]/gi, "")
    .replace(/\[image\]/g, "")
    .replace(/\[图片:\s*[^\]]+\]/g, "")
    .replace(/\[image:\s*[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function imageNames(rawJson) {
  let raw = {};
  try {
    raw = JSON.parse(rawJson || "{}");
  } catch {
    return [];
  }

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

function minuteBucket(sentAt, offsetSeconds = 0) {
  const ms = new Date(sentAt).getTime() + offsetSeconds * 1000;
  return Math.floor(ms / 60000);
}

function duplicateKey(row, offsetSeconds = 0) {
  const text = normalizeContent(row.content);
  const hasImages = imageNames(row.raw_json).length > 0 || String(row.message_type || "").includes("image");
  const body = text || (hasImages ? "[image]" : String(row.message_type || ""));
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
  if (imageNames(row.raw_json).length) score += 10;
  if (normalizeContent(row.content)) score += 5;
  return score;
}

function findDuplicateIds(rows) {
  const buckets = new Map();
  for (const row of rows) {
    for (const offset of [-30, 0, 30]) {
      const key = duplicateKey(row, offset);
      const list = buckets.get(key) || [];
      list.push(row);
      buckets.set(key, list);
    }
  }

  const duplicateIds = new Set();
  const reviewed = new Set();
  for (const group of buckets.values()) {
    const unique = [...new Map(group.map((row) => [row.id, row])).values()];
    if (unique.length < 2) continue;
    const reviewKey = unique.map((row) => row.id).sort((a, b) => a - b).join(",");
    if (reviewed.has(reviewKey)) continue;
    reviewed.add(reviewKey);

    const sorted = unique.sort((a, b) => rank(b) - rank(a) || a.id - b.id);
    const keeper = sorted[0];
    for (const row of sorted.slice(1)) {
      if (row.platform === keeper.platform && row.platform !== "qce") continue;
      duplicateIds.add(row.id);
    }
  }
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
