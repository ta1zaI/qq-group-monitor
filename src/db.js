const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function openDatabase(rootDir, filename = "data/qq-monitor.sqlite") {
  const dbPath = filename === ":memory:" ? filename : path.join(rootDir, filename);
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'onebot',
      platform_message_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, platform_message_id, group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_group_sent_at ON messages(group_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      summary_date TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, summary_date)
    );
  `);
  return db;
}

function insertMessage(db, msg) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      platform, platform_message_id, group_id, user_id, nickname,
      message_type, content, raw_json, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.platform || "onebot",
    String(msg.platformMessageId),
    String(msg.groupId),
    String(msg.userId),
    msg.nickname || "",
    msg.messageType || "text",
    msg.content || "",
    JSON.stringify(msg.raw || {}),
    msg.sentAt
  );
  return result.changes > 0;
}

function extractAttachments(rawJson) {
  const attachments = [];

  const pushImage = (data = {}) => {
    const url = data.url || data.file || "";
    if (!url) return;
    attachments.push({
      type: "image",
      url,
      file: data.file || "",
      summary: data.summary || data.sub_type || ""
    });
  };

  const segments = Array.isArray(rawJson?.message) ? rawJson.message : [];
  for (const segment of segments) {
    if (segment?.type === "image") pushImage(segment.data);
  }

  if (typeof rawJson?.message === "string") {
    const imagePattern = /\[CQ:image,([^\]]+)\]/g;
    for (const match of rawJson.message.matchAll(imagePattern)) {
      const data = {};
      for (const pair of match[1].split(",")) {
        const index = pair.indexOf("=");
        if (index > -1) data[pair.slice(0, index)] = pair.slice(index + 1);
      }
      pushImage(data);
    }
  }

  return attachments;
}

function displayNameForUser(db, userId) {
  const row = db.prepare(`
    SELECT nickname
    FROM messages
    WHERE user_id = ? AND nickname != ''
    ORDER BY sent_at DESC, id DESC
    LIMIT 1
  `).get(String(userId || ""));
  return row?.nickname || String(userId || "");
}

function displayNameForReply(db, messageId) {
  const row = db.prepare(`
    SELECT nickname, user_id AS userId
    FROM messages
    WHERE platform_message_id = ?
    ORDER BY sent_at DESC, id DESC
    LIMIT 1
  `).get(String(messageId || ""));
  return row?.nickname || row?.userId || String(messageId || "");
}

function stripFacePlaceholders(content) {
  return String(content || "")
    .replace(/\[face\]/g, "")
    .replace(/\[\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u52a8\u753b\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u8d34\u7eb8[^\]]*\]/g, "")
    .replace(/\[sticker[^\]]*\]/gi, "")
    .replace(/\[emoji[^\]]*\]/gi, "")
    .replace(/\[\u56fe\u7247[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findReplyPrefix(text) {
  const source = String(text || "");
  if (!source.startsWith("[回复 ")) return null;

  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(1, index);
        const match = body.match(/^回复\s+([^:：]+)[：:]/);
        if (!match) return null;
        return {
          name: match[1].trim(),
          end: index + 1
        };
      }
    }
  }
  return null;
}

function appendTextPart(parts, text) {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
  } else {
    parts.push({ type: "text", text });
  }
}

function richPartsFromPlainText(content) {
  let text = stripFacePlaceholders(content);
  const parts = [];
  const reply = findReplyPrefix(text);
  let replyName = "";

  if (reply) {
    replyName = reply.name.replace(/^@/, "");
    parts.push({ type: "reply", text: `回复 @${replyName}` });
    text = text.slice(reply.end).trimStart();
    const repeatedMention = new RegExp(`^@${replyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`);
    text = text.replace(repeatedMention, "");
  }

  const mentionPattern = /@([^\s@：:，,。?？!！\]]+)/g;
  let cursor = 0;
  for (const match of text.matchAll(mentionPattern)) {
    appendTextPart(parts, text.slice(cursor, match.index));
    parts.push({ type: "mention", text: `@${match[1]}` });
    cursor = match.index + match[0].length;
  }
  appendTextPart(parts, text.slice(cursor));

  return parts.some((part) => part.type === "mention" || part.type === "reply") ? parts : [];
}

function shouldHideMessage(message) {
  const cleaned = stripFacePlaceholders(message.content);
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  return !cleaned && !hasAttachments;
}

function visibleMessageSql() {
  const cleaned = `
    trim(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(content, '[face]', ''),
                '[表情]', ''
              ),
              '[动画表情]', ''
            ),
            '[贴纸]', ''
          ),
          '[sticker]', ''
        ),
        '[emoji]', ''
      )
    )
  `;
  return `NOT (${cleaned} = '' AND raw_json NOT LIKE '%"type":"image"%')`;
}

function richParts(db, rawJson) {
  const segments = Array.isArray(rawJson?.message) ? rawJson.message : [];
  const parts = [];

  for (const segment of segments) {
    if (segment?.type === "text") {
      const text = segment.data?.text || "";
      if (text) parts.push({ type: "text", text });
      continue;
    }

    if (segment?.type === "at") {
      const qq = segment.data?.qq || "";
      parts.push({
        type: "mention",
        text: `@${displayNameForUser(db, qq)}`,
        userId: String(qq)
      });
      continue;
    }

    if (segment?.type === "reply") {
      const id = segment.data?.id || "";
      parts.push({
        type: "reply",
        text: `回复 ${displayNameForReply(db, id)}`,
        messageId: String(id)
      });
    }
  }

  if (parts.some((part) => part.type === "mention" || part.type === "reply")) return parts;
  return richPartsFromPlainText(parts.map((part) => part.text || "").join(""));
}

function attachMessageExtras(db, row) {
  let raw = {};
  try {
    raw = JSON.parse(row.rawJson || "{}");
  } catch {
    raw = {};
  }
  const { rawJson, ...message } = row;
  return {
    ...message,
    content: stripFacePlaceholders(message.content),
    attachments: extractAttachments(raw),
    parts: richParts(db, raw),
    avatarUrl: /^\d+$/.test(String(message.userId || ""))
      ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(String(message.userId))}&s=100`
      : ""
  };
}

function listMessagesPage(db, filters = {}) {
  const clauses = [visibleMessageSql()];
  const params = [];

  if (filters.groupId) {
    clauses.push("group_id = ?");
    params.push(String(filters.groupId));
  }
  if (filters.date) {
    clauses.push("date(sent_at, 'localtime') = ?");
    params.push(filters.date);
  }
  if (filters.before) {
    clauses.push("sent_at < ?");
    params.push(filters.before);
  }
  if (filters.q) {
    clauses.push("(content LIKE ? OR nickname LIKE ? OR user_id LIKE ?)");
    const q = `%${filters.q}%`;
    params.push(q, q, q);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Number(filters.limit) || 500, 5000);
  const fetchLimit = Math.min(limit + 1, 5000);
  const rows = db.prepare(`
    SELECT id, platform_message_id AS platformMessageId, group_id AS groupId,
           user_id AS userId, nickname, message_type AS messageType,
           content, raw_json AS rawJson, sent_at AS sentAt, created_at AS createdAt
    FROM messages
    ${where}
    ORDER BY sent_at DESC, id DESC
    LIMIT ${fetchLimit}
  `).all(...params);
  const visible = rows
    .map((row) => attachMessageExtras(db, row))
    .filter((message) => !shouldHideMessage(message));
  return {
    messages: visible.slice(0, limit).reverse(),
    hasMore: rows.length > limit
  };
}

function listMessages(db, filters = {}) {
  return listMessagesPage(db, filters).messages;
}

function messagesForDay(db, date, groupId = "") {
  const filters = ["date(sent_at, 'localtime') = ?"];
  const params = [date];
  if (groupId) {
    filters.push("group_id = ?");
    params.push(String(groupId));
  }
  return db.prepare(`
    SELECT group_id AS groupId, user_id AS userId, nickname, message_type AS messageType,
           content, sent_at AS sentAt
    FROM messages
    WHERE ${filters.join(" AND ")}
    ORDER BY sent_at ASC, id ASC
  `).all(...params)
    .map((message) => ({ ...message, content: stripFacePlaceholders(message.content) }))
    .filter((message) => message.content);
}

function countMessagesForDay(db, date, groupId = "") {
  const filters = ["date(sent_at, 'localtime') = ?"];
  const params = [date];
  if (groupId) {
    filters.push("group_id = ?");
    params.push(String(groupId));
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE ${filters.join(" AND ")}
  `).get(...params);
  return Number(row?.count || 0);
}

function messagesForRange(db, startAt, endAt, groupId = "") {
  const filters = ["sent_at >= ?", "sent_at < ?"];
  const params = [startAt, endAt];
  if (groupId) {
    filters.push("group_id = ?");
    params.push(String(groupId));
  }
  return db.prepare(`
    SELECT group_id AS groupId, user_id AS userId, nickname, message_type AS messageType,
           content, sent_at AS sentAt
    FROM messages
    WHERE ${filters.join(" AND ")}
    ORDER BY sent_at ASC, id ASC
  `).all(...params)
    .map((message) => ({ ...message, content: stripFacePlaceholders(message.content) }))
    .filter((message) => message.content);
}

function groupIdsForDay(db, date) {
  return db.prepare(`
    SELECT DISTINCT group_id AS groupId
    FROM messages
    WHERE date(sent_at, 'localtime') = ?
    ORDER BY group_id
  `).all(date).map((row) => row.groupId);
}

function groupIdsForRange(db, startAt, endAt) {
  return db.prepare(`
    SELECT DISTINCT group_id AS groupId
    FROM messages
    WHERE sent_at >= ? AND sent_at < ?
    ORDER BY group_id
  `).all(startAt, endAt).map((row) => row.groupId);
}

function saveSummary(db, { groupId, date, content, status = "ok", error = "" }) {
  db.prepare(`
    INSERT INTO summaries (group_id, summary_date, content, status, error, generated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(group_id, summary_date) DO UPDATE SET
      content = excluded.content,
      status = excluded.status,
      error = excluded.error,
      generated_at = CURRENT_TIMESTAMP
  `).run(String(groupId || "all"), date, content || "", status, error || "");
}

function getSummary(db, date, groupId = "all") {
  return db.prepare(`
    SELECT group_id AS groupId, summary_date AS summaryDate, content, status, error,
           generated_at AS generatedAt
    FROM summaries
    WHERE group_id = ? AND summary_date = ?
  `).get(String(groupId || "all"), date);
}

function listSummaries(db, groupId = "all", limit = 90) {
  return db.prepare(`
    SELECT group_id AS groupId, summary_date AS summaryDate, status, error,
           generated_at AS generatedAt,
           substr(content, 1, 160) AS preview
    FROM summaries
    WHERE group_id = ?
    ORDER BY summary_date DESC
    LIMIT ?
  `).all(String(groupId || "all"), Math.min(Number(limit) || 90, 365));
}

function stats(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS totalMessages,
      COUNT(DISTINCT group_id) AS totalGroups,
      COUNT(DISTINCT user_id) AS totalUsers
    FROM messages
  `).get();
}

module.exports = {
  openDatabase,
  insertMessage,
  listMessages,
  listMessagesPage,
  messagesForDay,
  countMessagesForDay,
  messagesForRange,
  groupIdsForDay,
  groupIdsForRange,
  saveSummary,
  getSummary,
  listSummaries,
  stats
};
