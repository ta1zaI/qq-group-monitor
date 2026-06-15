const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { normalizeOneBotEvent, shouldAcceptGroup } = require("../src/onebot");
const { openDatabase, insertMessage, listMessages, messagesForDay, saveSummary, listSummaries } = require("../src/db");
const { importQceJson } = require("../src/qceImporter");
const { dedupeMessages } = require("../src/dedupeMessages");
const { localExtractiveSummary, analyzeMessages } = require("../src/summarizer");
const { createApp } = require("../src/server");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function request(server, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      port: server.address().port,
      host: "127.0.0.1",
      path,
      headers
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      app.router(req, res).catch((error) => {
        const text = JSON.stringify({ error: error.message });
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("normalizes OneBot group text messages", () => {
  const msg = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    time: 1710000000,
    message_id: 42,
    group_id: 10001,
    user_id: 20002,
    sender: { nickname: "玩家A" },
    message: [{ type: "text", data: { text: "今天活动有 bug" } }]
  });

  assert.equal(msg.groupId, 10001);
  assert.equal(msg.userId, 20002);
  assert.equal(msg.content, "今天活动有 bug");
  assert.equal(msg.messageType, "text");
});

test("ignores face-only messages and keeps text next to faces", () => {
  const faceOnly = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    time: 1710000000,
    message_id: 43,
    group_id: 10001,
    user_id: 20002,
    sender: { nickname: "玩家A" },
    message: [
      { type: "face", data: { id: "1" } },
      { type: "face", data: { id: "2" } }
    ]
  });
  assert.equal(faceOnly, null);

  const withText = normalizeOneBotEvent({
    post_type: "message",
    message_type: "group",
    time: 1710000000,
    message_id: 44,
    group_id: 10001,
    user_id: 20002,
    sender: { nickname: "玩家A" },
    message: [
      { type: "face", data: { id: "1" } },
      { type: "text", data: { text: " 这个可以" } },
      { type: "face", data: { id: "2" } }
    ]
  });
  assert.equal(withText.content, "这个可以");
  assert.equal(withText.messageType, "text");
});

test("filters configured group ids", () => {
  const config = { onebot: { groupIds: [10001] } };
  assert.equal(shouldAcceptGroup(config, 10001), true);
  assert.equal(shouldAcceptGroup(config, 10002), false);
});

test("deduplicates messages in sqlite", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  const msg = {
    platformMessageId: "m1",
    groupId: "g1",
    userId: "u1",
    nickname: "玩家A",
    messageType: "text",
    content: "掉线了",
    sentAt: new Date().toISOString(),
    raw: {}
  };

  assert.equal(insertMessage(db, msg), true);
  assert.equal(insertMessage(db, msg), false);
  assert.equal(listMessages(db, { groupId: "g1" }).length, 1);
});

test("hides stored face-only messages and strips face placeholders from text", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platformMessageId: "m-face-only",
    groupId: "g1",
    userId: "u1",
    nickname: "玩家A",
    messageType: "face",
    content: "[face][face]",
    sentAt: "2026-06-10T08:00:00.000Z",
    raw: {}
  });
  insertMessage(db, {
    platformMessageId: "m-face-text",
    groupId: "g1",
    userId: "u1",
    nickname: "玩家A",
    messageType: "face,text",
    content: "[face] 这个可以 [face]",
    sentAt: "2026-06-10T08:01:00.000Z",
    raw: {}
  });

  const listed = listMessages(db, { groupId: "g1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].content, "这个可以");

  const dayMessages = messagesForDay(db, "2026-06-10", "g1");
  assert.deepEqual(dayMessages.map((message) => message.content), ["这个可以"]);
});

test("queries summary messages by natural day", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  for (const msg of [
    { id: "before", sentAt: "2026-06-09T12:00:00.000Z" },
    { id: "inside-a", sentAt: "2026-06-10T02:00:00.000Z" },
    { id: "inside-b", sentAt: "2026-06-10T12:00:00.000Z" },
    { id: "after", sentAt: "2026-06-11T02:00:00.000Z" }
  ]) {
    insertMessage(db, {
      platformMessageId: msg.id,
      groupId: "g1",
      userId: "u1",
      nickname: "玩家A",
      messageType: "text",
      content: msg.id,
      sentAt: msg.sentAt,
      raw: {}
    });
  }

  const messages = messagesForDay(db, "2026-06-10", "g1");
  assert.deepEqual(messages.map((message) => message.content), ["inside-a", "inside-b"]);
});

test("pages older stored messages by sent_at cursor", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  for (const [index, sentAt] of [
    "2026-06-10T01:00:00.000Z",
    "2026-06-10T02:00:00.000Z",
    "2026-06-10T03:00:00.000Z"
  ].entries()) {
    insertMessage(db, {
      platformMessageId: `m-page-${index}`,
      groupId: "g1",
      userId: "u1",
      nickname: "玩家A",
      messageType: "text",
      content: `msg-${index}`,
      raw: {},
      sentAt
    });
  }

  const latest = listMessages(db, { groupId: "g1", limit: 2 });
  assert.deepEqual(latest.map((message) => message.content), ["msg-1", "msg-2"]);
  const older = listMessages(db, { groupId: "g1", before: latest[0].sentAt, limit: 2 });
  assert.deepEqual(older.map((message) => message.content), ["msg-0"]);
});

test("returns image attachments from stored OneBot messages", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platformMessageId: "m-img",
    groupId: "g1",
    userId: "u1",
    nickname: "玩家A",
    messageType: "image",
    content: "[image]",
    sentAt: new Date().toISOString(),
    raw: {
      message: [
        {
          type: "image",
          data: {
            file: "sample.jpg",
            url: "https://example.com/sample.jpg"
          }
        }
      ]
    }
  });

  const [message] = listMessages(db, { groupId: "g1" });
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].type, "image");
  assert.equal(message.attachments[0].url, "https://example.com/sample.jpg");
});

test("imports QCE JSON with local images and deduplicates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qce-import-"));
  const imagePath = path.join(tmp, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from("png"));
  const exportPath = path.join(tmp, "export.json");
  fs.writeFileSync(exportPath, JSON.stringify({
    messages: [
      {
        messageId: "qce-1",
        groupId: "g1",
        time: "2026-06-13 10:00:00",
        sender: { uin: "10001", nickname: "玩家A" },
        content: "截图来了",
        elements: [{ type: "image", file: "sample.png" }]
      },
      {
        messageId: "qce-1",
        groupId: "g1",
        time: "2026-06-13 10:00:00",
        sender: { uin: "10001", nickname: "玩家A" },
        content: "截图来了",
        elements: [{ type: "image", file: "sample.png" }]
      }
    ]
  }));

  const db = openDatabase(process.cwd(), ":memory:");
  const result = importQceJson(db, exportPath, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-15",
    exportDir: tmp,
    mediaDir: path.join(tmp, "media")
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.duplicates, 1);
  const [message] = listMessages(db, { groupId: "g1" });
  assert.equal(message.nickname, "玩家A");
  assert.equal(message.attachments.length, 1);
  assert.match(message.attachments[0].file, /^qce-/);
  assert.match(message.avatarUrl, /q1\.qlogo\.cn/);
});

test("deduplicates overlapping OneBot and QCE messages", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-1",
    groupId: "g1",
    userId: "10001",
    nickname: "玩家A",
    messageType: "text",
    content: "同一句话",
    sentAt: "2026-06-10T08:00:01.000Z",
    raw: { message: [{ type: "text", data: { text: "同一句话" } }] }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-1",
    groupId: "g1",
    userId: "10001",
    nickname: "玩家A",
    messageType: "text",
    content: "同一句话",
    sentAt: "2026-06-10T08:04:30.000Z",
    raw: { message: [{ type: "text", data: { text: "同一句话" } }] }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-unique",
    groupId: "g1",
    userId: "10002",
    nickname: "玩家B",
    messageType: "text",
    content: "只有导出里有",
    sentAt: "2026-06-13T08:00:00.000Z",
    raw: { message: [{ type: "text", data: { text: "只有导出里有" } }] }
  });

  const preview = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-15"
  });
  assert.equal(preview.duplicateCount, 1);
  assert.equal(listMessages(db, { groupId: "g1", limit: 10 }).length, 3);

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-15",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 2);
  assert(messages.some((message) => message.platformMessageId === "onebot-1"));
  assert(messages.some((message) => message.platformMessageId === "qce-unique"));
});

test("deduplicates text with emoji placeholders", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-text",
    groupId: "g1",
    userId: "10001",
    nickname: "player-a",
    messageType: "text",
    content: "same message",
    sentAt: "2026-06-10T08:00:01.000Z",
    raw: { message: [{ type: "text", data: { text: "same message" } }] }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-text",
    groupId: "g1",
    userId: "10001",
    nickname: "player-a",
    messageType: "text",
    content: "same message[表情182]",
    sentAt: "2026-06-10T08:01:01.000Z",
    raw: { message: [{ type: "text", data: { text: "same message[表情182]" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-10",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "same message");
});

test("deduplicates plain at text and keeps structured mention", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-at",
    groupId: "g1",
    userId: "10001",
    nickname: "player-a",
    messageType: "at,text",
    content: "@target 怎么做到的",
    sentAt: "2026-06-10T08:00:01.000Z",
    raw: {
      message: [
        { type: "at", data: { qq: "20002" } },
        { type: "text", data: { text: " 怎么做到的" } }
      ]
    }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-at",
    groupId: "g1",
    userId: "10001",
    nickname: "player-a",
    messageType: "text",
    content: "@target 怎么做到的",
    sentAt: "2026-06-10T08:00:30.000Z",
    raw: { message: [{ type: "text", data: { text: "@target 怎么做到的" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-10",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformMessageId, "onebot-at");
  assert.equal(messages[0].parts[0].type, "mention");
});

test("deduplicates structured at content against exported plain text", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-at-marker",
    groupId: "g1",
    userId: "10001",
    nickname: "player-a",
    messageType: "at,text",
    content: "[at] 有几个活人？都是我们群里的嘛?",
    sentAt: "2026-06-11T04:12:42.000Z",
    raw: {
      message: [
        { type: "at", data: { qq: "20002" } },
        { type: "text", data: { text: " 有几个活人？都是我们群里的嘛?" } }
      ]
    }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-at-marker",
    groupId: "g1",
    userId: "different-export-id",
    nickname: "@.",
    messageType: "text",
    content: "@小豆子 有几个活人？都是我们群里的嘛?",
    sentAt: "2026-06-11T04:12:42.000Z",
    raw: { message: [{ type: "text", data: { text: "@小豆子 有几个活人？都是我们群里的嘛?" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-11",
    endDate: "2026-06-11",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformMessageId, "onebot-at-marker");
  assert.equal(messages[0].parts[0].type, "mention");
});

test("deduplicates structured reply content against exported reply text", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-reply-marker",
    groupId: "g1",
    userId: "10002",
    nickname: "player-b",
    messageType: "reply,at,text",
    content: "[reply][at] 你用谷歌账号登，稳定不掉线。",
    sentAt: "2026-06-11T04:13:38.000Z",
    raw: {
      message: [
        { type: "reply", data: { id: "parent" } },
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: " 你用谷歌账号登，稳定不掉线。" } }
      ]
    }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-reply-marker",
    groupId: "g1",
    userId: "10002",
    nickname: "player-b",
    messageType: "text",
    content: "[回复 不可以: 开了两把合作，都掉了] @不可以 你用谷歌账号登，稳定不掉线。",
    sentAt: "2026-06-11T04:13:38.000Z",
    raw: { message: [{ type: "text", data: { text: "[回复 不可以: 开了两把合作，都掉了] @不可以 你用谷歌账号登，稳定不掉线。" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-11",
    endDate: "2026-06-11",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformMessageId, "onebot-reply-marker");
  assert.equal(messages[0].parts[0].type, "reply");
});

test("deduplicates exported reply text containing image placeholder", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-reply-image-marker",
    groupId: "g1",
    userId: "10002",
    nickname: "player-b",
    messageType: "reply,at,text",
    content: "[reply][at] 山茶花啥效果",
    sentAt: "2026-06-15T05:29:06.000Z",
    raw: {
      message: [
        { type: "reply", data: { id: "parent" } },
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: " 山茶花啥效果" } }
      ]
    }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-reply-image-marker",
    groupId: "g1",
    userId: "10002",
    nickname: "player-b",
    messageType: "text",
    content: "[回复 灵魂行者: [图片]] @灵魂行者 山茶花啥效果",
    sentAt: "2026-06-15T05:29:06.000Z",
    raw: { message: [{ type: "text", data: { text: "[回复 灵魂行者: [图片]] @灵魂行者 山茶花啥效果" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-15",
    endDate: "2026-06-15",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformMessageId, "onebot-reply-image-marker");
  assert.equal(messages[0].parts[0].type, "reply");
});

test("deduplicates image-only messages by sender and nearby time", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platform: "onebot",
    platformMessageId: "onebot-img",
    groupId: "g1",
    userId: "10001",
    nickname: "玩家A",
    messageType: "image",
    content: "[image]",
    sentAt: "2026-06-10T08:00:01.000Z",
    raw: { message: [{ type: "image", data: { file: "onebot.jpg" } }] }
  });
  insertMessage(db, {
    platform: "qce",
    platformMessageId: "qce-img",
    groupId: "g1",
    userId: "10001",
    nickname: "玩家A",
    messageType: "image",
    content: "[image]",
    sentAt: "2026-06-10T08:00:45.000Z",
    raw: { message: [{ type: "image", data: { file: "qce.jpg" } }] }
  });

  const applied = dedupeMessages(db, {
    groupId: "g1",
    startDate: "2026-06-10",
    endDate: "2026-06-10",
    apply: true
  });
  assert.equal(applied.duplicateCount, 1);
  const messages = listMessages(db, { groupId: "g1", limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformMessageId, "onebot-img");
});

test("returns readable mention and reply parts", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  insertMessage(db, {
    platformMessageId: "m-parent",
    groupId: "g1",
    userId: "u-parent",
    nickname: "玩家甲",
    messageType: "text",
    content: "原消息",
    sentAt: "2026-06-10T08:00:00.000Z",
    raw: {}
  });
  insertMessage(db, {
    platformMessageId: "m-child",
    groupId: "g1",
    userId: "u-child",
    nickname: "玩家乙",
    messageType: "reply,at",
    content: "[reply][at] 收到",
    sentAt: "2026-06-10T08:01:00.000Z",
    raw: {
      message: [
        { type: "reply", data: { id: "m-parent" } },
        { type: "at", data: { qq: "u-parent" } },
        { type: "text", data: { text: " 收到" } }
      ]
    }
  });

  const messages = listMessages(db, { groupId: "g1" });
  const reply = messages.find((message) => message.platformMessageId === "m-child");
  assert.deepEqual(reply.parts.map((part) => part.text), ["回复 玩家甲", "@玩家甲", " 收到"]);
});

test("creates fallback summary with risks and active users", () => {
  const content = localExtractiveSummary({
    date: "2026-06-10",
    groupId: "10001",
    keywords: ["掉线"],
    messages: [
      { nickname: "玩家A", userId: "1", content: "一直掉线", sentAt: new Date().toISOString() },
      { nickname: "玩家A", userId: "1", content: "充值也卡", sentAt: new Date().toISOString() }
    ]
  });

  assert.match(content, /QQ群玩家日报/);
  assert.match(content, /一句话总结/);
  assert.match(content, /代表性发言/);
  assert.match(content, /建议关注动作/);
  assert.match(content, /掉线/);
  assert.match(content, /玩家A/);
});

test("analyzes dashboard metrics", () => {
  const analysis = analyzeMessages([
    { nickname: "玩家A", userId: "1", content: "下载太麻烦了", messageType: "text" },
    { nickname: "玩家B", userId: "2", content: "活动奖励不错", messageType: "text" },
    { nickname: "玩家A", userId: "1", content: "[image]", messageType: "image" }
  ], ["下载", "活动"]);

  assert.equal(analysis.totalMessages, 3);
  assert.equal(analysis.activeUsers, 2);
  assert.equal(analysis.topUsers[0][0], "玩家A");
  assert.ok(analysis.keywordHits.length >= 2);
});

test("lists historical summaries by date", () => {
  const db = openDatabase(process.cwd(), ":memory:");
  saveSummary(db, { groupId: "816998268", date: "2026-06-09", content: "日报 A" });
  saveSummary(db, { groupId: "816998268", date: "2026-06-10", content: "日报 B", status: "error", error: "模型未启动" });

  const reports = listSummaries(db, "816998268");
  assert.equal(reports.length, 2);
  assert.equal(reports[0].summaryDate, "2026-06-10");
  assert.equal(reports[0].status, "error");
});

test("requires admin password for manual generation and push", async () => {
  const db = openDatabase(process.cwd(), ":memory:");
  const app = createApp({
    db,
    config: {
      server: { host: "127.0.0.1", port: 0 },
      admin: { password: "20018001" },
      onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
      feishu: { webhookUrl: "", secret: "" },
      model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
      summary: { dailyTime: "10:00", keywords: [] }
    }
  });
  const server = await listen(app);
  try {
    const verifyDenied = await request(server, {
      method: "POST",
      path: "/api/admin/verify",
      headers: { "content-type": "application/json" },
      body: {}
    });
    assert.equal(verifyDenied.status, 401);

    const verified = await request(server, {
      method: "POST",
      path: "/api/admin/verify",
      headers: { "content-type": "application/json", "x-admin-password": "20018001" },
      body: {}
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.ok, true);

    const denied = await request(server, {
      method: "POST",
      path: "/api/summary/generate",
      headers: { "content-type": "application/json" },
      body: { date: "2026-06-10", groupId: "g1" }
    });
    assert.equal(denied.status, 401);

    const generated = await request(server, {
      method: "POST",
      path: "/api/summary/generate",
      headers: { "content-type": "application/json", "x-admin-password": "20018001" },
      body: { date: "2026-06-10", groupId: "g1" }
    });
    assert.equal(generated.status, 200);

    const pushDenied = await request(server, {
      method: "POST",
      path: "/api/summary/push",
      headers: { "content-type": "application/json" },
      body: { date: "2026-06-10", groupId: "g1" }
    });
    assert.equal(pushDenied.status, 401);
  } finally {
    server.close();
  }
});

test("pushes saved summary to configured Feishu webhook", async () => {
  const db = openDatabase(process.cwd(), ":memory:");
  saveSummary(db, { groupId: "g1", date: "2026-06-10", content: "日报正文" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: "ok" })
    };
  };

  const app = createApp({
    db,
    config: {
      server: { host: "127.0.0.1", port: 0 },
      admin: { password: "20018001" },
      onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
      feishu: { webhookUrl: "https://open.feishu.cn/webhook/test", secret: "" },
      model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
      summary: { dailyTime: "10:00", keywords: [] }
    }
  });
  const server = await listen(app);
  try {
    const pushed = await request(server, {
      method: "POST",
      path: "/api/summary/push",
      headers: { "content-type": "application/json", "x-admin-password": "20018001" },
      body: { date: "2026-06-10", groupId: "g1" }
    });
    assert.equal(pushed.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.msg_type, "interactive");
    assert.equal(calls[0].body.card.header.title.content, "《全植英雄》官方群日报 | 2026-06-10");
    assert.ok(calls[0].body.card.elements.length >= 1);
    assert.equal(calls[0].body.card.elements[0].tag, "div");
    assert.equal(calls[0].body.card.elements[0].text.tag, "lark_md");
    assert.match(calls[0].body.card.elements[0].text.content, /日报正文/);
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test("pushes saved summary to official Feishu webhook when requested", async () => {
  const db = openDatabase(process.cwd(), ":memory:");
  saveSummary(db, { groupId: "g1", date: "2026-06-10", content: "日报正文" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: "ok" })
    };
  };

  const app = createApp({
    db,
    config: {
      server: { host: "127.0.0.1", port: 0 },
      admin: { password: "20018001" },
      onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
      feishu: {
        testWebhookUrl: "https://open.feishu.cn/webhook/test",
        officialWebhookUrl: "https://open.feishu.cn/webhook/official",
        secret: ""
      },
      model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
      summary: { dailyTime: "10:00", keywords: [] }
    }
  });
  const server = await listen(app);
  try {
    const pushed = await request(server, {
      method: "POST",
      path: "/api/summary/push",
      headers: { "content-type": "application/json", "x-admin-password": "20018001" },
      body: { date: "2026-06-10", groupId: "g1", target: "official" }
    });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.target, "official");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://open.feishu.cn/webhook/official");
    assert.equal(calls[0].body.msg_type, "interactive");
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test("returns readable error when Feishu webhook is missing", async () => {
  const db = openDatabase(process.cwd(), ":memory:");
  saveSummary(db, { groupId: "g1", date: "2026-06-10", content: "日报正文" });
  const app = createApp({
    db,
    config: {
      server: { host: "127.0.0.1", port: 0 },
      admin: { password: "20018001" },
      onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
      feishu: { webhookUrl: "", secret: "" },
      model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
      summary: { dailyTime: "10:00", keywords: [] }
    }
  });
  const server = await listen(app);
  try {
    const pushed = await request(server, {
      method: "POST",
      path: "/api/summary/push",
      headers: { "content-type": "application/json", "x-admin-password": "20018001" },
      body: { date: "2026-06-10", groupId: "g1" }
    });
    assert.equal(pushed.status, 502);
    assert.match(pushed.body.error, /webhookUrl/);
  } finally {
    server.close();
  }
});

test("does not schedule automatic summary when disabled", () => {
  const originalSetTimeout = globalThis.setTimeout;
  let scheduled = false;
  globalThis.setTimeout = () => {
    scheduled = true;
    return 1;
  };

  try {
    const db = openDatabase(process.cwd(), ":memory:");
    const app = createApp({
      db,
      config: {
        server: { host: "127.0.0.1", port: 0 },
        admin: { password: "20018001" },
        onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
        feishu: { webhookUrl: "", secret: "" },
        model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
        summary: { autoGenerate: false, dailyTime: "00:05", keywords: [] }
      }
    });
    app.scheduleDailySummary();
    assert.equal(scheduled, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("scheduled summary generation does not push when autoPush is disabled", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  const callbacks = [];
  const fetchCalls = [];
  globalThis.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: "ok" })
    };
  };

  try {
    const db = openDatabase(process.cwd(), ":memory:");
    const app = createApp({
      db,
      config: {
        server: { host: "127.0.0.1", port: 0 },
        admin: { password: "20018001" },
        onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
        feishu: { officialWebhookUrl: "https://open.feishu.cn/webhook/official", secret: "" },
        model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
        summary: { autoGenerate: true, autoPush: false, dailyTime: "00:05", keywords: [] }
      }
    });
    app.scheduleDailySummary();
    assert.equal(callbacks.length, 1);
    await callbacks[0]();

    assert.equal(listSummaries(db, "g1").length, 1);
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("scheduled summary generation still pushes when autoPush is enabled", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  const callbacks = [];
  const fetchCalls = [];
  globalThis.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: "ok" })
    };
  };

  try {
    const db = openDatabase(process.cwd(), ":memory:");
    const app = createApp({
      db,
      config: {
        server: { host: "127.0.0.1", port: 0 },
        admin: { password: "20018001" },
        onebot: { wsUrl: "", accessToken: "", groupIds: ["g1"] },
        feishu: { officialWebhookUrl: "https://open.feishu.cn/webhook/official", secret: "" },
        model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
        summary: { autoGenerate: true, autoPush: true, dailyTime: "00:05", keywords: [] }
      }
    });
    app.scheduleDailySummary();
    assert.equal(callbacks.length, 1);
    await callbacks[0]();

    assert.equal(listSummaries(db, "g1").length, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://open.feishu.cn/webhook/official");
    assert.equal(fetchCalls[0].body.msg_type, "interactive");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("dashboard reads group member count from OneBot", async () => {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = {};
      setTimeout(() => this.listeners.open?.({}), 0);
    }

    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }

    send(text) {
      const payload = JSON.parse(text);
      setTimeout(() => {
        this.listeners.message?.({
          data: JSON.stringify({
            echo: payload.echo,
            status: "ok",
            data: { member_count: 128 }
          })
        });
      }, 0);
    }
  }
  globalThis.WebSocket = FakeWebSocket;

  const db = openDatabase(process.cwd(), ":memory:");
  const app = createApp({
    db,
    config: {
      server: { host: "127.0.0.1", port: 0 },
      admin: { password: "20018001" },
      onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "", groupIds: ["g1"] },
      feishu: { webhookUrl: "", secret: "" },
      model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
      summary: { dailyTime: "10:00", keywords: [] }
    }
  });
  app.connectOneBot();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const server = await listen(app);
  try {
    const dashboard = await request(server, { path: "/api/dashboard?date=2026-06-10&group_id=g1" });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.groupMemberCount, 128);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    server.close();
  }
});

test("sync history fetches multiple OneBot pages", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentParams = [];
  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = {};
      setTimeout(() => this.listeners.open?.({}), 0);
    }

    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }

    send(text) {
      const payload = JSON.parse(text);
      sentParams.push(payload.params);
      const start = payload.params.message_seq || 2000;
      const size = payload.params.message_seq ? 1 : 1000;
      const messages = Array.from({ length: size }, (_, index) => {
        const id = start - index;
        return {
          post_type: "message",
          message_type: "group",
          message_id: id,
          message_seq: id,
          group_id: 10001,
          user_id: 20002,
          time: id,
          sender: { nickname: "玩家A" },
          message: [{ type: "text", data: { text: `消息 ${id}` } }]
        };
      });
      setTimeout(() => {
        this.listeners.message?.({
          data: JSON.stringify({ echo: payload.echo, status: "ok", data: { messages } })
        });
      }, 0);
    }
  }
  globalThis.WebSocket = FakeWebSocket;

  try {
    const db = openDatabase(process.cwd(), ":memory:");
    const app = createApp({
      db,
      config: {
        server: { host: "127.0.0.1", port: 0 },
        admin: { password: "20018001" },
        onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "", groupIds: ["10001"] },
        feishu: { webhookUrl: "", secret: "" },
        model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
        summary: { dailyTime: "10:00", keywords: [] }
      }
    });
    app.connectOneBot();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await app.syncGroupHistory("10001", 1001);
    assert.equal(result.fetched, 1001);
    assert.equal(result.inserted, 1001);
    assert.equal(sentParams.length, 2);
    assert.equal(sentParams[1].message_seq, 1000);
    assert.equal(listMessages(db, { groupId: "10001", limit: 5000 }).length, 1001);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("sync history can backfill until a selected report date", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentParams = [];
  const pageDates = ["2026-06-15T12:00:00+08:00", "2026-06-14T12:00:00+08:00", "2026-06-12T12:00:00+08:00"];
  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = {};
      setTimeout(() => this.listeners.open?.({}), 0);
    }

    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }

    send(text) {
      const payload = JSON.parse(text);
      sentParams.push(payload.params);
      const pageIndex = sentParams.length - 1;
      const start = payload.params.message_seq || 3000;
      const time = Math.floor(new Date(pageDates[pageIndex] || pageDates.at(-1)).getTime() / 1000);
      const messages = Array.from({ length: 1000 }, (_, index) => {
        const id = start - index;
        return {
          post_type: "message",
          message_type: "group",
          message_id: id,
          message_seq: id,
          group_id: 10001,
          user_id: 20002,
          time,
          sender: { nickname: "玩家A" },
          message: [{ type: "text", data: { text: `消息 ${id}` } }]
        };
      });
      setTimeout(() => {
        this.listeners.message?.({
          data: JSON.stringify({ echo: payload.echo, status: "ok", data: { messages } })
        });
      }, 0);
    }
  }
  globalThis.WebSocket = FakeWebSocket;

  try {
    const db = openDatabase(process.cwd(), ":memory:");
    const app = createApp({
      db,
      config: {
        server: { host: "127.0.0.1", port: 0 },
        admin: { password: "20018001" },
        onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "", groupIds: ["10001"] },
        feishu: { webhookUrl: "", secret: "" },
        model: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKey: "" },
        summary: { dailyTime: "10:00", keywords: [] }
      }
    });
    app.connectOneBot();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await app.syncGroupHistory("10001", 5000, "2026-06-13");
    assert.equal(result.reachedUntilDate, true);
    assert.equal(sentParams.length, 3);
    assert.equal(result.fetched, 3000);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
