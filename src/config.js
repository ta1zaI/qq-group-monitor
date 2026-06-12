const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  server: { host: "127.0.0.1", port: 8787 },
  admin: { password: "20018001" },
  onebot: { wsUrl: "", accessToken: "", groupIds: [] },
  feishu: { webhookUrl: "", testWebhookUrl: "", officialWebhookUrl: "", secret: "" },
  model: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:7b",
    apiKey: ""
  },
  summary: {
    autoGenerate: true,
    autoPush: false,
    dailyTime: "10:00",
    keywords: ["bug", "卡", "外挂", "退款", "充值", "掉线", "封号", "活动"]
  }
};

function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMerge(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function loadConfig(rootDir) {
  const configPath = path.join(rootDir, "config.json");
  if (!fs.existsSync(configPath)) {
    return { config: DEFAULT_CONFIG, configPath, loaded: false };
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    config: deepMerge(DEFAULT_CONFIG, parsed),
    configPath,
    loaded: true
  };
}

module.exports = { DEFAULT_CONFIG, loadConfig };
