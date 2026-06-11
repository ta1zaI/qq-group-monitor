const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { normalizeOneBotEvent, shouldAcceptGroup } = require("../src/onebot");
const { openDatabase, insertMessage, listMessages, messagesForDay, saveSummary, listSummaries } = require("../src/db");
const { localExtractiveSummary, analyzeMessages } = require("../src/summarizer");
const { createApp } = require("../src/server");

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
    assert.equal(calls[0].body.msg_type, "text");
    assert.match(calls[0].body.content.text, /日期：2026-06-10/);
    assert.match(calls[0].body.content.text, /日报正文/);
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
