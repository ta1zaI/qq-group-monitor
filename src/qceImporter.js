const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { insertMessage, countMessagesForDay } = require("./db");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    const text = compact(value);
    if (text) return text;
  }
  return "";
}

function deepGet(object, paths) {
  for (const itemPath of paths) {
    let current = object;
    for (const key of itemPath.split(".")) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (current !== undefined && current !== null && String(current).trim() !== "") return current;
  }
  return "";
}

function parseSentAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number" || /^\d+$/.test(String(value || ""))) {
    const number = Number(value);
    const millis = number < 10_000_000_000 ? number * 1000 : number;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/\//g, "-").replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function localDay(sentAt) {
  const date = new Date(sentAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isProbablyMessage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const hasTime = deepGet(record, [
    "time", "timestamp", "msgTime", "sendTime", "createTime", "datetime", "date"
  ]);
  const hasText = deepGet(record, [
    "content", "text", "message", "msg", "plainText", "messageText", "rawMessage"
  ]);
  const hasSender = deepGet(record, [
    "sender.uin", "sender.uid", "sender.qq", "sender.id", "sender.user_id",
    "userId", "user_id", "qq", "uin", "fromUin", "senderUin"
  ]);
  return Boolean(hasTime && (hasText || hasSender || record.elements || record.attachments || record.files || record.images));
}

function findMessageArray(root) {
  if (Array.isArray(root) && root.some(isProbablyMessage)) return root;
  if (!root || typeof root !== "object") return [];

  const preferredKeys = ["messages", "messageList", "records", "items", "data", "list", "chatRecords"];
  for (const key of preferredKeys) {
    const value = root[key];
    if (Array.isArray(value) && value.some(isProbablyMessage)) return value;
    if (value && typeof value === "object") {
      const found = findMessageArray(value);
      if (found.length) return found;
    }
  }

  for (const value of Object.values(root)) {
    const found = findMessageArray(value);
    if (found.length) return found;
  }
  return [];
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
    } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildImageIndex(exportDir) {
  const index = new Map();
  if (!fs.existsSync(exportDir)) return index;
  for (const file of walkFiles(exportDir)) {
    const basename = path.basename(file).toLowerCase();
    if (!index.has(basename)) index.set(basename, file);
  }
  return index;
}

function sourceImagePath(value, exportDir, imageIndex) {
  const text = String(value || "").trim();
  if (!text || /^https?:\/\//i.test(text) || text.startsWith("/api/media")) return "";
  const candidates = [
    text,
    path.join(exportDir, text),
    path.join(exportDir, path.basename(text))
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return imageIndex.get(path.basename(text).toLowerCase()) || "";
}

function copyImage(source, mediaDir, copied) {
  if (!source) return "";
  if (copied.has(source)) return copied.get(source);
  fs.mkdirSync(mediaDir, { recursive: true });
  const ext = path.extname(source).toLowerCase() || ".jpg";
  const targetName = `qce-${sha1(`${source}:${fs.statSync(source).size}`).slice(0, 20)}${ext}`;
  const target = path.join(mediaDir, targetName);
  if (!fs.existsSync(target)) fs.copyFileSync(source, target);
  copied.set(source, targetName);
  return targetName;
}

function collectTextAndImages(value, context) {
  const texts = [];
  const images = [];

  const visit = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const text = compact(node);
      if (text && !IMAGE_EXTENSIONS.has(path.extname(text).toLowerCase())) texts.push(text);
      return;
    }
    if (typeof node !== "object") return;

    const type = compact(node.type || node.msgType || node.elemType || node.elementType).toLowerCase();
    const imageCandidate = firstString(
      node.path, node.filePath, node.localPath, node.file, node.fileName, node.name,
      node.url, node.src, node.md5, node.imagePath, node.originPath
    );
    const looksImage = type.includes("image")
      || type.includes("pic")
      || IMAGE_EXTENSIONS.has(path.extname(imageCandidate).toLowerCase());

    if (looksImage && imageCandidate) {
      const source = sourceImagePath(imageCandidate, context.exportDir, context.imageIndex);
      const targetFile = copyImage(source, context.mediaDir, context.copied);
      images.push({
        type: "image",
        data: {
          file: targetFile || path.basename(imageCandidate),
          url: /^https?:\/\//i.test(imageCandidate) ? imageCandidate : "",
          source: imageCandidate
        }
      });
      return;
    }

    const text = firstString(node.text, node.content, node.value, node.summary, node.display);
    if (text && !looksImage) texts.push(text);

    for (const key of ["elements", "elems", "message", "messages", "content", "items", "attachments", "files", "images", "resources"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };

  visit(value);
  return { texts, images };
}

function cleanQceContent(text, hasImages) {
  const cleaned = compact(text)
    .replace(/\[图片:\s*[^\]]+\]/g, "")
    .replace(/\[image:\s*[^\]]+\]/gi, "")
    .trim();
  return cleaned || (hasImages ? "[image]" : "");
}

function normalizeQceMessage(record, options, context) {
  const sentAt = parseSentAt(deepGet(record, [
    "time", "timestamp", "msgTime", "sendTime", "createTime", "datetime", "date"
  ]));
  if (!sentAt) return null;

  if (options.startDate && localDay(sentAt) < options.startDate) return null;
  if (options.endDate && localDay(sentAt) > options.endDate) return null;

  const groupId = firstString(
    options.groupId,
    deepGet(record, ["groupId", "group_id", "peerUin", "roomId", "group.uin", "group.id"])
  );
  if (!groupId) return null;

  const userId = firstString(deepGet(record, [
    "sender.uin", "sender.uid", "sender.qq", "sender.id", "sender.user_id",
    "userId", "user_id", "qq", "uin", "fromUin", "senderUin", "author.id"
  ]), "unknown");
  const nickname = firstString(deepGet(record, [
    "sender.card", "sender.remark", "sender.nickname", "sender.name",
    "senderName", "nickname", "userName", "author.name", "fromName"
  ]), userId);

  const collected = collectTextAndImages(record, context);
  const directText = firstString(deepGet(record, [
    "plainText", "messageText", "rawMessage", "content", "text", "msg"
  ]));
  const contentParts = [directText, ...collected.texts]
    .map((text) => compact(text))
    .filter(Boolean);
  const content = cleanQceContent(Array.from(new Set(contentParts)).join(" "), collected.images.length);
  if (!content && !collected.images.length) return null;

  const sourceId = firstString(deepGet(record, [
    "messageId", "message_id", "msgId", "msg_id", "id", "seq", "msgSeq", "messageSeq"
  ]));
  const fingerprint = sha1(JSON.stringify({
    groupId,
    userId,
    sentAt,
    content,
    images: collected.images.map((image) => image.data.file || image.data.source || "")
  }));

  return {
    platform: "qce",
    platformMessageId: sourceId ? `qce-${sourceId}` : `qce-${fingerprint}`,
    groupId,
    userId,
    nickname,
    messageType: collected.images.length ? (content === "[image]" ? "image" : "text,image") : "text",
    content,
    sentAt,
    raw: {
      ...record,
      message: collected.images.length
        ? [
            ...(content && content !== "[image]" ? [{ type: "text", data: { text: content } }] : []),
            ...collected.images
          ]
        : [{ type: "text", data: { text: content } }]
    }
  };
}

function importQceJson(db, inputFile, options = {}) {
  const exportDir = path.resolve(options.exportDir || path.dirname(inputFile));
  const mediaDir = path.resolve(options.mediaDir || path.join(process.cwd(), "data", "media"));
  const imageIndex = buildImageIndex(exportDir);
  const context = { exportDir, mediaDir, imageIndex, copied: new Map() };
  const parsed = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const records = findMessageArray(parsed);
  if (!records.length) throw new Error("没有在 QCE JSON 中找到可导入的消息数组");

  const dates = dateRange(options.startDate, options.endDate);
  const beforeCounts = Object.fromEntries(dates.map((date) => [date, countMessagesForDay(db, date, options.groupId)]));
  let inserted = 0;
  let skipped = 0;
  let images = 0;
  let normalized = 0;

  for (const record of records) {
    const msg = normalizeQceMessage(record, options, context);
    if (!msg) {
      skipped += 1;
      continue;
    }
    normalized += 1;
    images += Array.isArray(msg.raw.message) ? msg.raw.message.filter((item) => item.type === "image").length : 0;
    if (insertMessage(db, msg)) inserted += 1;
  }

  const afterCounts = Object.fromEntries(dates.map((date) => [date, countMessagesForDay(db, date, options.groupId)]));
  return {
    records: records.length,
    normalized,
    inserted,
    duplicates: normalized - inserted,
    skipped,
    images,
    beforeCounts,
    afterCounts
  };
}

function dateRange(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const dates = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    dates.push(localDay(current.toISOString()));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

module.exports = { importQceJson, normalizeQceMessage, findMessageArray };
