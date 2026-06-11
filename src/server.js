const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { loadConfig } = require("./config");
const {
  openDatabase,
  insertMessage,
  listMessages,
  messagesForDay,
  groupIdsForDay,
  saveSummary,
  getSummary,
  listSummaries,
  stats
} = require("./db");
const { normalizeOneBotEvent, shouldAcceptGroup } = require("./onebot");
const { generateSummary, analyzeMessages } = require("./summarizer");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

function ensureDirs() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(DATA, "media"), { recursive: true });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function reportWindowForDate(date) {
  return {
    date: String(date || localDateString()),
    label: String(date || localDateString())
  };
}

function previousDateString(date = new Date()) {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localDateString(previous);
}

function defaultGroupId(config) {
  return String(config.onebot?.groupIds?.[0] || "816998268");
}

function isAdmin(req, config) {
  return req.headers["x-admin-password"] === String(config.admin?.password || "");
}

function requireAdmin(req, res, config) {
  if (isAdmin(req, config)) return true;
  json(res, 401, { error: "需要管理员密码" });
  return false;
}

function isAllowedMediaUrl(mediaUrl) {
  return mediaUrl.protocol === "https:" && [
    "multimedia.nt.qq.com.cn",
    "gchat.qpic.cn",
    "c2cpicdw.qpic.cn"
  ].includes(mediaUrl.hostname);
}

function safeMediaFile(file) {
  const name = path.basename(String(file || ""));
  return /^[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|gif|webp)$/i.test(name) ? name : "";
}

function mediaPath(rootDir, file) {
  const safeFile = safeMediaFile(file);
  return safeFile ? path.join(rootDir, "data", "media", safeFile) : "";
}

function sendExpiredImage(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220">
  <rect width="320" height="220" rx="14" fill="#0c1320"/>
  <rect x="12" y="12" width="296" height="196" rx="10" fill="#111827" stroke="#263247"/>
  <text x="160" y="98" fill="#8c9aaf" font-size="18" font-family="Microsoft YaHei, Segoe UI, sans-serif" text-anchor="middle">图片链接已过期</text>
  <text x="160" y="128" fill="#64748b" font-size="13" font-family="Microsoft YaHei, Segoe UI, sans-serif" text-anchor="middle">新的图片会自动保存到本地</text>
</svg>`;
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-length": Buffer.byteLength(svg),
    "cache-control": "no-store"
  });
  res.end(svg);
}

function sendLocalMedia(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp"
  }[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(res);
}

function imageSegments(raw) {
  const message = raw?.message;
  if (Array.isArray(message)) return message.filter((segment) => segment?.type === "image");
  return [];
}

async function fetchImageBuffer(url) {
  let mediaUrl;
  try {
    mediaUrl = new URL(url);
  } catch {
    throw new Error("图片地址无效");
  }

  if (!isAllowedMediaUrl(mediaUrl)) {
    throw new Error("不支持的图片来源");
  }

  const response = await fetch(mediaUrl, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`图片拉取失败：${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!contentType.startsWith("image/")) {
    throw new Error("远端内容不是图片");
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_MEDIA_BYTES) throw new Error("图片过大");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error("图片过大");
  return { buffer, contentType };
}

async function cacheImageAttachment(rootDir, image) {
  const file = safeMediaFile(image?.data?.file);
  const url = image?.data?.url;
  if (!file || !url) return;
  const filePath = mediaPath(rootDir, file);
  if (!filePath || fs.existsSync(filePath)) return;
  try {
    const { buffer } = await fetchImageBuffer(url);
    await fs.promises.writeFile(filePath, buffer, { flag: "wx" });
  } catch {
    // Some QQ download URLs expire quickly. Future messages still get cached when available.
  }
}

async function cacheMessageMedia(rootDir, msg) {
  const segments = imageSegments(msg.raw);
  await Promise.all(segments.map((segment) => cacheImageAttachment(rootDir, segment)));
}

async function proxyMedia(rootDir, { url, file }, res) {
  const filePath = mediaPath(rootDir, file);
  if (filePath && fs.existsSync(filePath)) {
    sendLocalMedia(filePath, res);
    return;
  }

  if (!url) {
    sendExpiredImage(res);
    return;
  }

  let fetched;
  try {
    fetched = await fetchImageBuffer(url);
  } catch {
    sendExpiredImage(res);
    return;
  }

  if (filePath) {
    fs.promises.writeFile(filePath, fetched.buffer, { flag: "wx" }).catch(() => {});
  }

  res.writeHead(200, {
    "content-type": fetched.contentType,
    "content-length": fetched.buffer.length,
    "cache-control": "public, max-age=86400"
  });
  res.end(fetched.buffer);
}

async function checkModel(config) {
  if (config.model?.provider !== "ollama") {
    return {
      provider: config.model?.provider || "unknown",
      model: config.model?.model || "",
      available: Boolean(config.model?.baseUrl),
      message: "使用兼容模型接口，未做本地模型探测。"
    };
  }

  try {
    const response = await fetch(new URL("/api/tags", config.model.baseUrl));
    if (!response.ok) {
      return {
        provider: "ollama",
        model: config.model.model,
        available: false,
        message: `Ollama 返回 ${response.status}`
      };
    }
    const data = await response.json();
    const names = (data.models || []).map((item) => item.name);
    const installed = names.some((name) => name === config.model.model || name.startsWith(`${config.model.model}:`));
    return {
      provider: "ollama",
      model: config.model.model,
      available: installed,
      installedModels: names,
      message: installed ? "本地模型可用" : `Ollama 已启动，但未找到 ${config.model.model}，请运行 ollama pull ${config.model.model}`
    };
  } catch {
    return {
      provider: "ollama",
      model: config.model.model,
      available: false,
      message: `Ollama 未启动或无法连接：${config.model.baseUrl}`
    };
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const resolved = path.resolve(PUBLIC, `.${decodeURIComponent(pathname)}`);
  if (!resolved.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  fs.createReadStream(resolved).pipe(res);
}

function createApp({ rootDir = ROOT, config: injectedConfig, db: injectedDb } = {}) {
  ensureDirs();
  const loaded = injectedConfig ? { config: injectedConfig, loaded: true } : loadConfig(rootDir);
  const config = loaded.config;
  const db = injectedDb || openDatabase(rootDir);
  const clients = new Set();
  let onebotState = { connected: false, lastError: "", lastEventAt: "" };
  let onebotSocket = null;
  let actionSeq = 0;
  let cachedGroupMemberCount = null;
  const pendingActions = new Map();

  function broadcast(event, payload) {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(line);
  }

  function handleOneBotEvent(event) {
    const msg = normalizeOneBotEvent(event);
    if (!msg || !shouldAcceptGroup(config, msg.groupId)) return false;
    const inserted = insertMessage(db, msg);
    if (inserted) {
      cacheMessageMedia(rootDir, msg).catch(() => {});
      broadcast("message", msg);
    }
    return inserted;
  }

  function sendOneBotAction(action, params = {}, timeoutMs = 5000) {
    if (!onebotSocket || onebotSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OneBot 未连接"));
    }
    const echo = `action-${Date.now()}-${++actionSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingActions.delete(echo);
        reject(new Error("OneBot 响应超时"));
      }, timeoutMs);
      pendingActions.set(echo, { resolve, reject, timer });
      onebotSocket.send(JSON.stringify({ action, params, echo }));
    });
  }

  async function getGroupMemberCount(groupId = defaultGroupId(config)) {
    try {
      const response = await sendOneBotAction("get_group_info", {
        group_id: Number(groupId),
        no_cache: false
      });
      const count = Number(response?.data?.member_count);
      if (Number.isFinite(count) && count >= 0) cachedGroupMemberCount = count;
    } catch {
      // Keep the last successful member count when OneBot is unavailable.
    }
    return cachedGroupMemberCount;
  }

  async function pushSummaryToFeishu(summary, window, groupId) {
    const webhookUrl = config.feishu?.webhookUrl || "";
    if (!webhookUrl) throw new Error("未配置飞书机器人 webhookUrl");

    const text = [
      `QQ群日报 #${groupId}`,
      `日期：${window.label}`,
      "",
      summary.content || ""
    ].join("\n");
    const payload = {
      msg_type: "text",
      content: { text }
    };

    if (config.feishu?.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = crypto
        .createHmac("sha256", `${timestamp}\n${config.feishu.secret}`)
        .update("")
        .digest("base64");
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`飞书返回 ${response.status}`);
    const data = await response.json().catch(() => ({}));
    if (data.code && data.code !== 0) throw new Error(data.msg || `飞书返回 code ${data.code}`);
    return data;
  }

  async function generateAndSave(date, groupId = defaultGroupId(config)) {
    const targetGroupId = groupId === "all" ? defaultGroupId(config) : String(groupId || defaultGroupId(config));
    const window = reportWindowForDate(date);
    const messages = messagesForDay(db, window.date, targetGroupId);
    try {
      const content = await generateSummary({ config, date: window.label, groupId: targetGroupId, messages });
      saveSummary(db, { groupId: targetGroupId, date: window.date, content, status: "ok" });
      const summary = getSummary(db, window.date, targetGroupId);
      broadcast("summary", summary);
      return { ...summary, window };
    } catch (error) {
      saveSummary(db, {
        groupId: targetGroupId,
        date: window.date,
        content: error.fallbackContent || "",
        status: "error",
        error: `本地模型未启动、未安装或调用失败：${error.message}`
      });
      const summary = getSummary(db, window.date, targetGroupId);
      broadcast("summary", summary);
      return { ...summary, window };
    }
  }

  async function syncGroupHistory(groupId = defaultGroupId(config), count = 1000) {
    const targetGroupId = String(groupId || defaultGroupId(config));
    const response = await sendOneBotAction("get_group_msg_history", {
      group_id: Number(targetGroupId),
      count: Math.min(Number(count) || 1000, 1000)
    }, 15000);
    const messages = response?.data?.messages || [];
    let inserted = 0;
    for (const event of messages) {
      const msg = normalizeOneBotEvent(event);
      if (!msg || !shouldAcceptGroup(config, msg.groupId)) continue;
      if (insertMessage(db, msg)) {
        inserted += 1;
        cacheMessageMedia(rootDir, msg).catch(() => {});
      }
    }
    if (inserted) broadcast("message", { inserted });
    return { fetched: messages.length, inserted };
  }

  async function router(req, res) {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("event: ready\ndata: {}\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        stats: stats(db),
        onebot: onebotState,
        model: await checkModel(config),
        configLoaded: loaded.loaded,
        defaultGroupId: defaultGroupId(config),
        publicWarning: "当前站点未启用访问密码，请只在可信网络或受控公网入口使用。",
        today: localDateString()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/media") {
      await proxyMedia(rootDir, {
        url: url.searchParams.get("url") || "",
        file: url.searchParams.get("file") || ""
      }, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, {
        server: config.server,
        onebot: {
          wsUrl: config.onebot.wsUrl ? "(已配置)" : "",
          groupIds: config.onebot.groupIds
        },
        model: {
          provider: config.model.provider,
          baseUrl: config.model.baseUrl,
          model: config.model.model
        },
        summary: config.summary
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/messages") {
      const groupId = url.searchParams.get("group_id") || defaultGroupId(config);
      json(res, 200, {
        messages: listMessages(db, {
          date: url.searchParams.get("date") || "",
          groupId,
          q: url.searchParams.get("q") || "",
          limit: url.searchParams.get("limit") || 200
        })
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages/sync-history") {
      if (!requireAdmin(req, res, config)) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const result = await syncGroupHistory(body.groupId || defaultGroupId(config), body.count || 1000);
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        json(res, 502, { error: error.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const date = url.searchParams.get("date") || localDateString();
      const groupId = url.searchParams.get("group_id") || defaultGroupId(config);
      const window = reportWindowForDate(date);
      const messages = messagesForDay(db, window.date, groupId);
      json(res, 200, {
        date,
        groupId,
        window,
        groupMemberCount: await getGroupMemberCount(groupId),
        analysis: analyzeMessages(messages, config.summary?.keywords || []),
        latestMessages: listMessages(db, { groupId, limit: 5000 }),
        summary: getSummary(db, window.date, groupId)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/reports") {
      const groupId = url.searchParams.get("group_id") || defaultGroupId(config);
      json(res, 200, { reports: listSummaries(db, groupId, url.searchParams.get("limit") || 90) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      const date = url.searchParams.get("date") || localDateString();
      const groupId = url.searchParams.get("group_id") || defaultGroupId(config);
      const window = reportWindowForDate(date);
      json(res, 200, { summary: getSummary(db, window.date, groupId), window });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/summary/generate") {
      if (!requireAdmin(req, res, config)) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const summary = await generateAndSave(body.date || localDateString(), body.groupId || defaultGroupId(config));
      json(res, summary.status === "ok" ? 200 : 502, { summary });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/summary/push") {
      if (!requireAdmin(req, res, config)) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const groupId = String(body.groupId || defaultGroupId(config));
      const window = reportWindowForDate(body.date || localDateString());
      const summary = getSummary(db, window.date, groupId);
      if (!summary) {
        json(res, 404, { error: "当前日期还没有日报，请先生成日报" });
        return;
      }
      try {
        await pushSummaryToFeishu(summary, window, groupId);
        json(res, 200, { ok: true, summary, window });
      } catch (error) {
        json(res, 502, { error: error.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/onebot") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const inserted = handleOneBotEvent(body);
      json(res, 200, { ok: true, inserted });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "API 不存在" });
      return;
    }

    serveStatic(req, res);
  }

  function connectOneBot() {
    if (!config.onebot.wsUrl || typeof WebSocket === "undefined") return;
    const wsUrl = new URL(config.onebot.wsUrl);
    if (config.onebot.accessToken && !wsUrl.searchParams.has("access_token")) {
      wsUrl.searchParams.set("access_token", config.onebot.accessToken);
    }

    try {
      const ws = new WebSocket(wsUrl);
      onebotSocket = ws;
      ws.addEventListener("open", () => {
        onebotState = { ...onebotState, connected: true, lastError: "" };
      });
      ws.addEventListener("message", (event) => {
        onebotState.lastEventAt = new Date().toISOString();
        try {
          const payload = JSON.parse(event.data);
          if (payload.echo && pendingActions.has(payload.echo)) {
            const pending = pendingActions.get(payload.echo);
            clearTimeout(pending.timer);
            pendingActions.delete(payload.echo);
            pending.resolve(payload);
            return;
          }
          handleOneBotEvent(payload);
        } catch (error) {
          onebotState.lastError = error.message;
        }
      });
      ws.addEventListener("close", () => {
        onebotState = { ...onebotState, connected: false };
        if (onebotSocket === ws) onebotSocket = null;
        setTimeout(connectOneBot, 5000);
      });
      ws.addEventListener("error", () => {
        onebotState = { ...onebotState, connected: false, lastError: "OneBot WebSocket 连接失败" };
      });
    } catch (error) {
      onebotState = { ...onebotState, connected: false, lastError: error.message };
      setTimeout(connectOneBot, 5000);
    }
  }

  function scheduleDailySummary() {
    const [hh, mm] = String(config.summary.dailyTime || "10:00").split(":").map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 55, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      const date = localDateString();
      const reportDate = previousDateString();
      const window = reportWindowForDate(reportDate);
      const groups = groupIdsForDay(db, reportDate).filter((groupId) => shouldAcceptGroup(config, groupId));
      if (!groups.length) {
        const summary = await generateAndSave(reportDate, defaultGroupId(config));
        if (summary.status === "ok") await pushSummaryToFeishu(summary, summary.window, defaultGroupId(config)).catch(() => {});
      }
      for (const groupId of groups) {
        const summary = await generateAndSave(reportDate, groupId);
        if (summary.status === "ok") await pushSummaryToFeishu(summary, summary.window, groupId).catch(() => {});
      }
      scheduleDailySummary();
    }, next - now);
  }

  return { router, config, db, handleOneBotEvent, generateAndSave, syncGroupHistory, connectOneBot, scheduleDailySummary, reportWindowForDate };
}

if (require.main === module) {
  const app = createApp();
  const server = http.createServer((req, res) => {
    app.router(req, res).catch((error) => json(res, 500, { error: error.message }));
  });
  server.listen(app.config.server.port, app.config.server.host, () => {
    console.log(`日报网站已启动：http://${app.config.server.host}:${app.config.server.port}`);
  });
  app.connectOneBot();
  app.scheduleDailySummary();
}

module.exports = { createApp, todayLocal: localDateString, reportWindowForDate };
