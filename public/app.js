const GROUP_ID = "816998268";
const MESSAGE_PAGE_SIZE = 100;
const MESSAGE_SEARCH_LIMIT = 1000;
const FEED_INTERACTION_IDLE_MS = 1200;

const els = {
  status: document.querySelector("#status"),
  onebotState: document.querySelector("#onebotState"),
  modelState: document.querySelector("#modelState"),
  refreshBtn: document.querySelector("#refreshBtn"),
  reportDateState: document.querySelector("#reportDateState"),
  generateDateInput: document.querySelector("#generateDateInput"),
  searchInput: document.querySelector("#searchInput"),
  adminPassword: document.querySelector("#adminPassword"),
  adminActions: document.querySelector("#adminActions"),
  generateBtn: document.querySelector("#generateBtn"),
  testPushBtn: document.querySelector("#testPushBtn"),
  officialPushBtn: document.querySelector("#officialPushBtn"),
  syncHistoryBtn: document.querySelector("#syncHistoryBtn"),
  progressFill: document.querySelector("#progressFill"),
  progressText: document.querySelector("#progressText"),
  totalMessages: document.querySelector("#totalMessages"),
  activeUsers: document.querySelector("#activeUsers"),
  sentiment: document.querySelector("#sentiment"),
  riskLevel: document.querySelector("#riskLevel"),
  summaryState: document.querySelector("#summaryState"),
  summaryBox: document.querySelector("#summaryBox"),
  reportCount: document.querySelector("#reportCount"),
  reportList: document.querySelector("#reportList"),
  messageCount: document.querySelector("#messageCount"),
  feed: document.querySelector("#feed"),
  loadOlderBtn: document.querySelector("#loadOlderBtn"),
  jumpBottomBtn: document.querySelector("#jumpBottomBtn"),
  imageModal: document.querySelector("#imageModal"),
  imageModalClose: document.querySelector("#imageModalClose"),
  imageModalImg: document.querySelector("#imageModalImg")
};

let selectedReportDate = "";
let loadedMessages = [];
let hasOlderMessages = true;
let lastMessageQuery = "";
let cachedReports = [];
let summaryRequestId = 0;
let loadingMessages = false;
let feedInteractionTimer = null;
let feedInteractionActive = false;
let pendingMessageRefresh = false;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function query(extra = {}) {
  return new URLSearchParams({
    date: currentReportDate(),
    group_id: GROUP_ID,
    ...extra
  }).toString();
}

function currentReportDate() {
  return selectedReportDate || els.generateDateInput.value || today();
}

function setSelectedReportDate(date) {
  selectedReportDate = date || "";
  els.reportDateState.textContent = `当前日报：${currentReportDate()}`;
}

function setReportLoading() {
  els.summaryState.textContent = "读取中";
  els.summaryState.className = "warn";
}

function messageQuery(extra = {}) {
  return new URLSearchParams({
    group_id: GROUP_ID,
    ...extra
  }).toString();
}

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const hint = text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")
      ? "接口返回了网页内容，请确认服务器已 git pull 并重启，随后强刷页面。"
      : "接口返回了无法识别的内容。";
    throw new Error(hint);
  }
  if (!response.ok && !data.summary) throw new Error(data.error || "请求失败");
  return data;
}

function adminHeaders() {
  return {
    "content-type": "application/json",
    "x-admin-password": els.adminPassword.value
  };
}

function saveAdminPassword() {
  localStorage.setItem("qq-monitor-admin-password", els.adminPassword.value);
}

function setPill(node, text, state = "ok") {
  node.textContent = text;
  node.className = state;
}

function setProgress(percent, text, state = "") {
  els.progressFill.style.width = `${percent}%`;
  els.progressText.textContent = text;
  els.progressText.className = state;
}

function setActionBusy(busy) {
  els.generateBtn.disabled = busy;
  els.testPushBtn.disabled = busy;
  els.officialPushBtn.disabled = busy;
  els.syncHistoryBtn.disabled = busy;
  els.generateDateInput.disabled = busy;
}

function updateAdminActionsVisibility() {
  els.adminActions.classList.toggle("is-hidden", !els.adminPassword.value.trim());
}

function handleAdminPasswordInput() {
  saveAdminPassword();
  updateAdminActionsVisibility();
}

const SUMMARY_SECTIONS = new Set([
  "一句话总结",
  "代表性发言 / 玩家反馈",
  "全群问题 / 风险",
  "舆论",
  "平衡性 / 夸大与失真",
  "建议关注动作"
]);

function appendInlineText(parent, text) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function appendParagraph(container, text) {
  const p = document.createElement("p");
  const match = String(text).match(/^([^：:]{2,18})([：:])(.+)$/);
  if (match) {
    const strong = document.createElement("strong");
    strong.textContent = `${match[1]}${match[2]}`;
    p.append(strong, document.createTextNode(match[3]));
  } else {
    appendInlineText(p, text);
  }
  container.appendChild(p);
}

function renderReportContent(text) {
  els.summaryBox.innerHTML = "";
  const lines = String(text || "").split(/\r?\n/);
  let list = null;

  const closeList = () => {
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,2})\s*(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length === 1 ? "h1" : "h2";
      const node = document.createElement(level);
      appendInlineText(node, heading[2]);
      els.summaryBox.appendChild(node);
      continue;
    }

    if (line.startsWith("QQ群玩家日报｜")) {
      closeList();
      const node = document.createElement("h1");
      node.textContent = line;
      els.summaryBox.appendChild(node);
      continue;
    }

    if (SUMMARY_SECTIONS.has(line)) {
      closeList();
      const node = document.createElement("h2");
      node.textContent = line;
      els.summaryBox.appendChild(node);
      continue;
    }

    const titledItem = line.match(/^([^：:]{2,24})([：:])(.+)$/);
    if (titledItem) {
      if (!list) {
        list = document.createElement("ul");
        list.className = "report-bullets";
        els.summaryBox.appendChild(list);
      }
      const item = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${titledItem[1]}${titledItem[2]}`;
      item.append(strong, document.createTextNode(titledItem[3]));
      list.appendChild(item);
      continue;
    }

    const listItem = line.match(/^(?:[-*]|\d+[.)、])\s*(.+)$/);
    if (listItem) {
      if (!list) {
        list = document.createElement("ul");
        list.className = "report-bullets";
        els.summaryBox.appendChild(list);
      }
      const item = document.createElement("li");
      appendInlineText(item, listItem[1]);
      list.appendChild(item);
      continue;
    }

    closeList();
    appendParagraph(els.summaryBox, line);
  }
}

function renderSummary(summary) {
  if (!summary) {
    els.summaryState.textContent = "未生成";
    els.summaryState.className = "";
    renderReportContent("当前日期还没有日报。点击右侧“生成日报”开始分析。");
    return;
  }

  els.summaryState.textContent = summary.status === "ok" ? "模型版" : "基础分析版";
  els.summaryState.className = summary.status === "ok" ? "ok" : "warn";
  renderReportContent(summary.error ? `${summary.content}\n\n提示：${summary.error}` : summary.content);
}

function isImageAttachment(attachment) {
  return attachment?.type === "image" && (attachment.url || attachment.file);
}

function proxiedMediaUrl(attachment) {
  const params = new URLSearchParams();
  if (attachment.file) params.set("file", attachment.file);
  if (attachment.url) params.set("url", attachment.url);
  return `/api/media?${params.toString()}`;
}

function openImageModal(src, alt) {
  els.imageModalImg.src = src;
  els.imageModalImg.alt = alt || "图片预览";
  els.imageModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeImageModal() {
  els.imageModal.hidden = true;
  els.imageModalImg.removeAttribute("src");
  document.body.classList.remove("modal-open");
}

function renderMessageText(content, parts) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-content";

  if (parts?.length) {
    const displayParts = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const next = parts[index + 1];
      if (part.type === "reply" && next?.type === "mention") {
        displayParts.push({ ...part, text: `回复 ${next.text}` });
        index += 1;
        continue;
      }
      displayParts.push(part);
    }

    for (const part of displayParts) {
      if (part.type === "mention" || part.type === "reply") {
        const chip = document.createElement("span");
        chip.className = `inline-chip ${part.type}`;
        chip.textContent = part.text;
        wrapper.appendChild(chip);
        continue;
      }
      wrapper.appendChild(document.createTextNode(part.text || ""));
    }
    return wrapper;
  }

  wrapper.textContent = content || "";
  return wrapper;
}

function renderReports(reports) {
  cachedReports = reports || [];
  els.reportCount.textContent = reports.length;
  els.reportList.innerHTML = "";

  if (!reports.length) {
    els.reportList.textContent = "暂无历史日报";
    els.reportList.className = "report-list muted-empty";
    return;
  }

  els.reportList.className = "report-list";
  for (const report of reports) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = report.summaryDate === currentReportDate() ? "report-item active" : "report-item";

    const date = document.createElement("span");
    date.textContent = report.summaryDate;
    const status = document.createElement("small");
    status.textContent = report.status === "ok" ? "模型版" : "基础版";

    button.append(date, status);
    button.addEventListener("click", () => {
      setSelectedReportDate(report.summaryDate);
      els.generateDateInput.value = report.summaryDate;
      renderReports(cachedReports);
      refreshReportView();
    });
    els.reportList.appendChild(button);
  }
}

function renderMessages(messages) {
  els.messageCount.textContent = `${messages.length} 条`;
  els.feed.innerHTML = "";
  els.loadOlderBtn.hidden = !messages.length || !hasOlderMessages || Boolean(els.searchInput.value.trim());

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "muted-empty";
    empty.textContent = "暂无消息";
    els.feed.appendChild(empty);
    return;
  }

  for (const msg of messages) {
    const card = document.createElement("article");
    card.className = "message";

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    const avatarText = (msg.nickname || msg.userId || "?").trim().slice(0, 1) || "?";
    if (msg.avatarUrl) {
      const avatarImg = document.createElement("img");
      avatarImg.src = msg.avatarUrl;
      avatarImg.alt = `${msg.nickname || msg.userId || "玩家"}头像`;
      avatarImg.loading = "lazy";
      avatarImg.addEventListener("error", () => {
        avatarImg.remove();
        avatar.textContent = avatarText;
        avatar.classList.add("fallback");
      }, { once: true });
      avatar.appendChild(avatarImg);
    } else {
      avatar.textContent = avatarText;
      avatar.classList.add("fallback");
    }

    const body = document.createElement("div");
    body.className = "message-body";

    const head = document.createElement("div");
    head.className = "message-head";

    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = msg.nickname || msg.userId;

    const time = document.createElement("span");
    time.textContent = new Date(msg.sentAt).toLocaleString();
    head.append(name, time);

    const images = (msg.attachments || []).filter(isImageAttachment);
    const cleanContent = String(msg.content || "").replace(/\[image\]/g, "").trim();
    const content = renderMessageText(cleanContent || (images.length ? "" : msg.content || ""), msg.parts);

    const media = document.createElement("div");
    media.className = "message-media";
    for (const image of images) {
      const link = document.createElement("a");
      const previewUrl = proxiedMediaUrl(image);
      link.href = previewUrl;

      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = image.file || "玩家图片";
      img.loading = "lazy";

      link.addEventListener("click", (event) => {
        event.preventDefault();
        openImageModal(previewUrl, img.alt);
      });

      link.appendChild(img);
      media.appendChild(link);
    }

    body.append(head);
    if (content.textContent) body.appendChild(content);
    if (images.length) body.appendChild(media);
    card.append(avatar, body);
    els.feed.appendChild(card);
  }
}

async function loadHealth() {
  const data = await api("/api/health");
  setPill(els.onebotState, data.onebot.connected ? "已连接" : "未连接", data.onebot.connected ? "ok" : "error");
  setPill(els.modelState, data.model?.available ? "可用" : "不可用", data.model?.available ? "ok" : "warn");

  const onebot = data.onebot.connected ? "OneBot 已连接" : "OneBot 未连接";
  const model = data.model?.available ? `${data.model.model} 可用` : data.model?.message || "模型状态未知";
  els.status.textContent = `${onebot}｜${model}`;
}

async function loadReports() {
  const data = await api(`/api/reports?group_id=${GROUP_ID}&limit=120`);
  if (!selectedReportDate && data.reports?.length) setSelectedReportDate(data.reports[0].summaryDate);
  renderReports(data.reports);
}

async function loadDashboard() {
  const requestedDate = currentReportDate();
  const data = await api(`/api/dashboard?${query()}`);
  if (requestedDate !== currentReportDate()) return;
  const analysis = data.analysis;
  els.totalMessages.textContent = analysis.totalMessages;
  els.activeUsers.textContent = data.groupMemberCount ?? "--";
  els.sentiment.textContent = analysis.sentiment;
  els.riskLevel.textContent = analysis.riskLevel;
  if (data.summary?.summaryDate === currentReportDate()) renderSummary(data.summary);
}

async function loadSummary() {
  const requestId = ++summaryRequestId;
  const data = await api(`/api/summary?${query()}`);
  if (requestId !== summaryRequestId) return;
  renderSummary(data.summary);
}

function isFeedNearBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 80;
}

function markFeedInteraction() {
  feedInteractionActive = true;
  clearTimeout(feedInteractionTimer);
  feedInteractionTimer = setTimeout(() => {
    feedInteractionActive = false;
  }, FEED_INTERACTION_IDLE_MS);
}

function shouldDeferMessageRefresh(force, q) {
  return !force && !q && feedInteractionActive && !isFeedNearBottom();
}

async function loadMessages({ stickToBottom = false, force = false } = {}) {
  if (loadingMessages) return;
  const q = els.searchInput.value.trim();
  if (shouldDeferMessageRefresh(force, q)) {
    pendingMessageRefresh = true;
    return;
  }

  loadingMessages = true;
  const scrollTop = els.feed.scrollTop;
  const wasNearBottom = isFeedNearBottom();
  try {
    const limit = q ? MESSAGE_SEARCH_LIMIT : MESSAGE_PAGE_SIZE;
    const data = await api(`/api/messages?${messageQuery({ q, limit })}`);
    loadedMessages = data.messages;
    hasOlderMessages = Boolean(data.hasMore) && !q;
    lastMessageQuery = q;
    pendingMessageRefresh = false;
    renderMessages(loadedMessages);
    if (q) {
      els.feed.scrollTop = 0;
    } else if (stickToBottom && (wasNearBottom || force)) {
      els.feed.scrollTop = els.feed.scrollHeight;
    } else {
      els.feed.scrollTop = scrollTop;
    }
  } finally {
    loadingMessages = false;
  }
}

async function loadOlderMessages() {
  if (!loadedMessages.length || !hasOlderMessages) return;
  const q = els.searchInput.value.trim();
  if (q || q !== lastMessageQuery) return;

  els.loadOlderBtn.disabled = true;
  els.loadOlderBtn.textContent = "加载中...";
  const previousHeight = els.feed.scrollHeight;
  try {
    const before = loadedMessages[0].sentAt;
    const data = await api(`/api/messages?${messageQuery({ before, limit: MESSAGE_PAGE_SIZE })}`);
    hasOlderMessages = Boolean(data.hasMore);
    const seen = new Set(loadedMessages.map((message) => message.platformMessageId || `${message.sentAt}-${message.userId}-${message.content}`));
    const older = data.messages.filter((message) => !seen.has(message.platformMessageId || `${message.sentAt}-${message.userId}-${message.content}`));
    loadedMessages = [...older, ...loadedMessages];
    renderMessages(loadedMessages);
    els.feed.scrollTop += els.feed.scrollHeight - previousHeight;
  } finally {
    els.loadOlderBtn.disabled = false;
    els.loadOlderBtn.textContent = "加载更早消息";
  }
}

async function jumpToMessageBottom() {
  if (pendingMessageRefresh || !isFeedNearBottom()) {
    await loadMessages({ stickToBottom: true, force: true });
  }
  els.feed.scrollTop = els.feed.scrollHeight;
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadReports()]);
  await Promise.all([loadSummary(), loadDashboard(), loadMessages()]);
}

async function refreshReportView() {
  setReportLoading();
  await loadSummary();
}

async function generateSummary() {
  saveAdminPassword();
  const date = els.generateDateInput.value || today();
  setActionBusy(true);
  els.generateBtn.textContent = "生成中...";
  setProgress(12, `校验权限：${date}`);
  const timers = [];
  try {
    timers.push(setTimeout(() => setProgress(32, "读取消息..."), 150));
    timers.push(setTimeout(() => setProgress(58, "调用模型..."), 450));
    const data = await api("/api/summary/generate", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ date, groupId: GROUP_ID })
    });
    setProgress(84, "保存日报...");
    renderSummary(data.summary);
    setSelectedReportDate(data.summary?.summaryDate || date);
    await refreshReportView();
    setProgress(100, "完成", "ok");
  } catch (error) {
    setProgress(100, error.message, "error");
  } finally {
    timers.forEach(clearTimeout);
    setActionBusy(false);
    els.generateBtn.textContent = "生成日报";
  }
}

async function pushSummary(target) {
  saveAdminPassword();
  const date = currentReportDate();
  setActionBusy(true);
  const button = target === "official" ? els.officialPushBtn : els.testPushBtn;
  const idleText = target === "official" ? "正式推送" : "测试推送";
  button.textContent = "推送中...";
  setProgress(20, `校验权限：${date}`);
  try {
    setProgress(55, target === "official" ? "正式推送到飞书..." : "测试推送到飞书...");
    await api("/api/summary/push", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ date, groupId: GROUP_ID, target })
    });
    setProgress(100, target === "official" ? "已正式推送到飞书" : "已测试推送到飞书", "ok");
  } catch (error) {
    setProgress(100, error.message, "error");
    throw error;
  } finally {
    setActionBusy(false);
    button.textContent = idleText;
  }
}

async function syncHistory() {
  saveAdminPassword();
  const untilDate = els.generateDateInput.value || currentReportDate();
  setActionBusy(true);
  els.syncHistoryBtn.textContent = "同步中...";
  setProgress(20, `校验权限：回补到 ${untilDate}`);
  try {
    setProgress(55, "从 NapCat 拉取历史...");
    const data = await api("/api/messages/sync-history", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ groupId: GROUP_ID, count: 100000, untilDate })
    });
    await refreshAll();
    const countData = await api(`/api/messages/day-count?${new URLSearchParams({ group_id: GROUP_ID, date: untilDate })}`);
    const suffix = data.reachedUntilDate ? "" : "，可能还没翻到目标日期";
    setProgress(100, `${untilDate} 当前 ${countData.count} 条；已新增 ${data.inserted} 条，读取 ${data.fetched} 条${suffix}`, data.reachedUntilDate ? "ok" : "error");
  } catch (error) {
    setProgress(100, error.message, "error");
  } finally {
    setActionBusy(false);
    els.syncHistoryBtn.textContent = "同步历史消息";
  }
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("message", () => {
    loadDashboard();
    loadMessages({ stickToBottom: true });
  });
  events.addEventListener("summary", () => refreshReportView());
  events.addEventListener("error", () => {
    loadHealth().catch(() => {});
  });
}

els.generateDateInput.value = today();
setSelectedReportDate("");
els.adminPassword.value = localStorage.getItem("qq-monitor-admin-password") || "";
updateAdminActionsVisibility();
els.refreshBtn.addEventListener("click", refreshAll);
els.adminPassword.addEventListener("input", handleAdminPasswordInput);
els.generateBtn.addEventListener("click", generateSummary);
els.testPushBtn.addEventListener("click", () => pushSummary("test").catch(() => {}));
els.officialPushBtn.addEventListener("click", () => pushSummary("official").catch(() => {}));
els.syncHistoryBtn.addEventListener("click", syncHistory);
els.loadOlderBtn.addEventListener("click", () => loadOlderMessages().catch(() => {}));
els.jumpBottomBtn.addEventListener("click", () => jumpToMessageBottom().catch(() => {}));
els.generateDateInput.addEventListener("change", () => {
  setSelectedReportDate(els.generateDateInput.value || "");
  renderReports(cachedReports);
  refreshReportView();
});
els.searchInput.addEventListener("input", () => setTimeout(loadMessages, 100));
els.feed.addEventListener("pointerdown", markFeedInteraction);
els.feed.addEventListener("wheel", markFeedInteraction, { passive: true });
els.feed.addEventListener("touchstart", markFeedInteraction, { passive: true });
els.feed.addEventListener("scroll", markFeedInteraction, { passive: true });
setInterval(() => {
  if (document.hidden) return;
  loadHealth().catch(() => {});
  loadDashboard().catch(() => {});
  loadMessages({ stickToBottom: true }).catch(() => {});
}, 10000);
els.imageModalClose.addEventListener("click", closeImageModal);
els.imageModal.addEventListener("click", (event) => {
  if (event.target === els.imageModal) closeImageModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.imageModal.hidden) closeImageModal();
});

connectEvents();
refreshAll().catch((error) => {
  els.status.textContent = error.message;
  els.status.className = "status error";
});
