function normalizeMessageContent(message) {
  if (typeof message === "string") {
    return {
      type: "text",
      content: message.replace(/\[CQ:face,[^\]]+\]/g, "").trim()
    };
  }
  if (!Array.isArray(message)) return { type: "unknown", content: "" };

  const parts = [];
  const nonText = new Set();
  for (const segment of message) {
    if (segment.type === "text") {
      parts.push(segment.data?.text || "");
    } else if (segment.type === "face") {
      continue;
    } else {
      nonText.add(segment.type || "unknown");
      parts.push(`[${segment.type || "unknown"}]`);
    }
  }
  return {
    type: nonText.size ? Array.from(nonText).join(",") : "text",
    content: parts.join("").trim()
  };
}

function normalizeOneBotEvent(event) {
  if (!event || event.post_type !== "message" || event.message_type !== "group") {
    return null;
  }
  const content = normalizeMessageContent(event.message);
  if (!content.content && (!content.type || content.type === "text")) return null;
  const ts = Number(event.time || 0) > 0 ? new Date(Number(event.time) * 1000) : new Date();
  return {
    platform: "onebot",
    platformMessageId: event.message_id ?? `${event.group_id}-${event.user_id}-${ts.getTime()}`,
    groupId: event.group_id,
    userId: event.user_id,
    nickname: event.sender?.card || event.sender?.nickname || "",
    messageType: content.type,
    content: content.content,
    sentAt: ts.toISOString(),
    raw: event
  };
}

function shouldAcceptGroup(config, groupId) {
  const groupIds = config.onebot?.groupIds || [];
  if (!groupIds.length) return true;
  return groupIds.map(String).includes(String(groupId));
}

module.exports = { normalizeOneBotEvent, shouldAcceptGroup };
