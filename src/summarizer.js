const RISK_WORDS = ["bug", "卡", "外挂", "退款", "充值", "掉线", "封号", "崩", "闪退", "投诉", "骂", "垃圾", "卸载", "无法", "失败"];
const NEGATIVE_WORDS = ["麻烦", "没时间", "不配", "暴打", "卡", "掉线", "崩", "闪退", "退款", "投诉", "垃圾", "难受", "打不过", "失败"];
const POSITIVE_WORDS = ["不错", "好玩", "舒服", "可以", "喜欢", "爽", "赢", "高", "活动", "奖励", "怀念"];
const REQUEST_WORDS = ["希望", "建议", "能不能", "为什么", "怎么", "需要", "什么时候", "修", "优化", "更新", "谁能懂"];

const SUMMARY_SECTIONS = [
  "一句话总结",
  "代表性发言 / 玩家反馈",
  "全群问题 / 风险",
  "舆论",
  "平衡性 / 夸大与失真",
  "建议关注动作"
];

function stripReportNoise(text) {
  return String(text || "")
    .replace(/\[回复[^\n]*?\]\]\s*/g, "")
    .replace(/\[回复[^\]]*\]\s*/g, "")
    .replace(/\[(?:at|reply|face)\]/gi, "")
    .replace(/\[\/?(?:image|sticker|emoji)[^\]]*\]/gi, "")
    .replace(/\[\u56fe\u7247[^\]]*\]/g, "")
    .replace(/\[\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u52a8\u753b\u8868\u60c5[^\]]*\]/g, "")
    .replace(/\[\u8d34\u7eb8[^\]]*\]/g, "")
    .replace(/\[(?:\u7728\u773c|\u8c03\u76ae|\u5927\u7b11|\u5fae\u7b11|\u6d41\u6cea|\u53d1\u5446|\u53ef\u7231|\u8272|\u5f97\u610f|\u95ed\u5634|\u7761|\u5c34\u5c2c|\u594b\u6597|\u8870|\u7591\u95ee|\u563f\u54c8|\u6342\u8138|\u9f13\u638c|\u5410|\u518d\u89c1|\u6d41\u6c57|\u53d1\u6296|\u5de6\u54fc\u54fc|\u53f3\u54fc\u54fc|\u62b1\u62f3|\u62e5\u62b1|\u5455\u5410|\u9634\u9669|\u4eb2\u4eb2|\u5413|\u53ef\u601c)[^\]]*\]/g, "")
    .replace(/\[\/?[\u4e00-\u9fff]{1,12}\]/g, "")
    .replace(/@[\w.\-\u4e00-\u9fff]{1,24}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMessageLine(msg) {
  const name = msg.nickname || msg.userId || "未知玩家";
  const time = String(msg.sentAt || "").slice(11, 16);
  const content = stripReportNoise(msg.content).slice(0, 90);
  if (!content) return "";
  return `${time} ${name}: ${content}`;
}

function buildPrompt({ date, groupId, messages, keywords }) {
  const lines = [];
  let totalLength = 0;
  for (const msg of messages) {
    const line = compactMessageLine(msg);
    if (!line) continue;
    totalLength += line.length + 1;
    if (totalLength > 9000) break;
    lines.push(line);
  }

  return `/no_think
你是资深游戏社群运营分析师。请根据 QQ 群 ${groupId} 在 ${date} 的玩家聊天记录，生成一份中文日报。
当天共记录 ${messages.length} 条消息。下面是按时间顺序压缩后的聊天记录，记录过长时只提供前半段代表性内容。

必须严格使用以下栏目，栏目名逐字一致，不要新增栏目：
QQ群玩家日报｜${date}
一句话总结
代表性发言 / 玩家反馈
全群问题 / 风险
舆论
平衡性 / 夸大与失真
建议关注动作

格式要求：
不要输出 Markdown。不要使用 #、##、**、-、*、1. 这类符号。
每个栏目下面写 1 到 3 行，每行使用“标题：内容”的形式。
代表性发言可以写“玩家名：原话或概括”，不要写成项目符号。
直接给运营判断，不要写“根据对话内容”“以下是整理”这类开场白。
不要编造不存在的玩家、官方回应或数据。
重点关注：${(keywords || []).join("、") || "下载、充值、匹配、故障、情绪、风险"}。

聊天记录：
${lines.join("\n")}`;
}

function stripThinking(text) {
  let output = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
  const danglingThinkEnd = output.lastIndexOf("</think>");
  if (danglingThinkEnd !== -1) output = output.slice(danglingThinkEnd + "</think>".length).trim();
  return output;
}

function cleanReportLine(line) {
  const cleaned = stripReportNoise(line)
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*_]{2,}|[-*]|[一二三四五六七八九十]+[、.．]|\d+[.)、])\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  return /^[^：:]{2,24}[：:]\s*$/.test(cleaned) ? "" : cleaned;
}

function sanitizeSummaryContent(content, date) {
  const cleaned = stripThinking(content)
    .split(/\r?\n/)
    .map(cleanReportLine)
    .filter(Boolean);
  const output = [];
  let hasTitle = false;

  for (const line of cleaned) {
    if (/^根据对话内容/.test(line) || /^以下是/.test(line) || /^总结建议/.test(line)) continue;
    if (/^-+$/.test(line)) continue;
    if (line.startsWith("QQ群玩家日报｜")) {
      if (!hasTitle) {
        output.push(`QQ群玩家日报｜${date}`);
        hasTitle = true;
      }
      continue;
    }
    output.push(line);
  }

  if (!hasTitle) output.unshift(`QQ群玩家日报｜${date}`);
  return output.join("\n");
}

function matchesRequiredStructure(content) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim());
  return SUMMARY_SECTIONS.filter((section) => lines.includes(section)).length >= 5;
}

async function callOllama(config, prompt) {
  const url = new URL("/api/generate", config.model.baseUrl);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model.model,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_ctx: 4096, num_predict: 1200 }
      })
    });
  } catch {
    throw new Error(`Ollama 未启动或无法连接：${config.model.baseUrl}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama 返回 ${response.status}，请确认已执行 ollama pull ${config.model.model}${text ? `：${text.slice(0, 120)}` : ""}`);
  }
  const data = await response.json();
  return data.response || "";
}

async function callOpenAICompatible(config, prompt) {
  const url = new URL("/v1/chat/completions", config.model.baseUrl);
  const headers = { "content-type": "application/json" };
  if (config.model.apiKey) headers.authorization = `Bearer ${config.model.apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });
  if (!response.ok) throw new Error(`兼容模型接口返回 ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function countHits(messages, words) {
  const hits = new Map();
  for (const msg of messages) {
    const content = String(msg.content || "").toLowerCase();
    for (const word of words) {
      if (word && content.includes(String(word).toLowerCase())) {
        hits.set(word, (hits.get(word) || 0) + 1);
      }
    }
  }
  return Array.from(hits.entries()).sort((a, b) => b[1] - a[1]);
}

function analyzeMessages(messages, keywords = []) {
  const users = new Map();
  let textCount = 0;
  let mediaCount = 0;
  const representative = [];

  for (const msg of messages) {
    const name = msg.nickname || msg.userId || "未知玩家";
    users.set(name, (users.get(name) || 0) + 1);
    if (msg.messageType === "text" || msg.content?.trim()) textCount += 1;
    if (msg.messageType !== "text") mediaCount += 1;
    if (msg.content && msg.content !== `[${msg.messageType}]`) representative.push({ name, content: msg.content });
  }

  const riskHits = countHits(messages, RISK_WORDS);
  const keywordHits = countHits(messages, [...new Set([...(keywords || []), ...RISK_WORDS, ...REQUEST_WORDS])]);
  const negativeHits = countHits(messages, NEGATIVE_WORDS);
  const positiveHits = countHits(messages, POSITIVE_WORDS);
  const requestHits = countHits(messages, REQUEST_WORDS);
  const topUsers = Array.from(users.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const negativeScore = negativeHits.reduce((sum, [, count]) => sum + count, 0);
  const positiveScore = positiveHits.reduce((sum, [, count]) => sum + count, 0);
  const riskScore = riskHits.reduce((sum, [, count]) => sum + count, 0);
  const sentiment =
    negativeScore > positiveScore + 1 ? "偏负面" :
    positiveScore > negativeScore + 1 ? "偏正面" :
    negativeScore || positiveScore ? "中性偏波动" : "样本不足";
  const riskLevel = riskScore >= 4 ? "高" : riskScore >= 2 ? "中" : riskScore >= 1 ? "低" : "观察";

  return {
    totalMessages: messages.length,
    activeUsers: users.size,
    textCount,
    mediaCount,
    topUsers,
    keywordHits: keywordHits.slice(0, 8),
    riskHits: riskHits.slice(0, 8),
    negativeHits: negativeHits.slice(0, 8),
    positiveHits: positiveHits.slice(0, 8),
    requestHits: requestHits.slice(0, 8),
    sentiment,
    riskLevel,
    representative: representative.slice(-8)
  };
}

function hitText(hits, empty) {
  return hits.length ? hits.map(([word, count]) => `${word} ${count} 次`).join("、") : empty;
}

function quoteLines(items) {
  if (!items.length) return ["要点：暂无可引用原文。"];
  return items.slice(0, 3).map((item) => `${item.name}：${String(item.content || "").slice(0, 90)}`);
}

function localExtractiveSummary({ date, groupId, messages, keywords }) {
  const a = analyzeMessages(messages, keywords);
  const sampleNote = a.totalMessages < 20 ? "样本较少，以下判断按现有聊天做保守解读。" : "样本量可用于基础运营判断。";
  const riskText = a.riskHits.length
    ? `风险词命中 ${hitText(a.riskHits, "")}，需要结合原文确认是否为真实问题。`
    : "暂未发现 bug、退款、外挂、掉线等高风险集中反馈。";
  const topicText = hitText(a.keywordHits, "暂无明显高频关键词");
  const activeText = a.topUsers.length
    ? a.topUsers.map(([name, count]) => `${name} ${count} 条`).join("、")
    : "暂无明显活跃玩家";

  return [
    `QQ群玩家日报｜${date}`,
    "一句话总结",
    `概况：${sampleNote} 今日群 ${groupId || "816998268"} 共 ${a.totalMessages} 条消息、${a.activeUsers} 位活跃玩家，整体情绪为“${a.sentiment}”，风险等级为“${a.riskLevel}”。`,
    `主题：${topicText}。`,
    "代表性发言 / 玩家反馈",
    ...quoteLines(a.representative),
    "全群问题 / 风险",
    `风险：${riskText}`,
    "舆论",
    `情绪：整体舆论为“${a.sentiment}”。负向信号：${hitText(a.negativeHits, "未发现明显负向词")}；正向信号：${hitText(a.positiveHits, "未发现明显正向词")}。`,
    `活跃：${activeText}。`,
    "平衡性 / 夸大与失真",
    "判断：当前样本不足以判断真实平衡性问题，涉及匹配、杯数、对局难度的表达更像体验描述或情绪化反馈。",
    "建议关注动作",
    "FAQ：将下载、加速器、充值、匹配等常见问题整理为群内 FAQ。",
    "追问：对连续反馈的活跃玩家做轻量追问，确认是否存在可复现问题。",
    "升级：如后续 bug、退款、外挂、掉线等词集中增加，优先升级为运营或客服跟进事项。"
  ].join("\n");
}

async function generateSummary({ config, date, groupId, messages }) {
  if (!messages.length) {
    return localExtractiveSummary({ date, groupId, messages, keywords: config.summary?.keywords || [] });
  }

  const prompt = buildPrompt({ date, groupId, messages, keywords: config.summary?.keywords || [] });
  try {
    const content = config.model.provider === "openai-compatible"
      ? await callOpenAICompatible(config, prompt)
      : await callOllama(config, prompt);
    const sanitized = sanitizeSummaryContent(content, date);
    if (!matchesRequiredStructure(sanitized)) {
      return localExtractiveSummary({ date, groupId, messages, keywords: config.summary?.keywords || [] });
    }
    return sanitized;
  } catch (error) {
    error.fallbackContent = localExtractiveSummary({
      date,
      groupId,
      messages,
      keywords: config.summary?.keywords || []
    });
    throw error;
  }
}

module.exports = {
  buildPrompt,
  generateSummary,
  localExtractiveSummary,
  analyzeMessages,
  sanitizeSummaryContent
};
