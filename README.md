# QQ群社群日报网站

本项目固定监控 QQ 群 `816998268`，接收 NapCat/OneBot 消息，保存到本机 SQLite，并每天生成一份可回看的社群日报。

## 本机使用

1. NapCat 开启 WebSocket 服务端：

```text
ws://127.0.0.1:3001
```

2. 启动日报网站：

```powershell
npm.cmd start
```

3. 打开：

```text
http://127.0.0.1:8787
```

## 历史日报

日报保存在 SQLite 的 `summaries` 表里。每天每个群保存一份，重新生成当天日报会覆盖当天版本。

页面左侧会显示历史日报列表，也可以直接调用：

```text
GET /api/reports?group_id=816998268
```

## 本地模型

默认使用免费的 Ollama 本地模型：

```powershell
ollama pull qwen3:8b
ollama serve
```

如果 Ollama 未启动或模型未安装，系统会生成基础分析版日报，并在页面里显示提示。

## 服务器部署

服务器需要 Node.js 24+。

1. 上传整个项目目录，包含 `data/qq-monitor.sqlite`。
2. 如果希望公网或局域网访问，把 `config.json` 改成：

```json
"server": {
  "host": "0.0.0.0",
  "port": 8787
}
```

3. 服务器启动：

```bash
node --no-warnings src/server.js
```

长期运行建议使用 `pm2`：

```bash
pm2 start src/server.js --name qq-daily-report --node-args="--no-warnings"
pm2 save
```

4. NapCat 在本机运行时，推荐新增 HTTP 客户端，把事件上报到服务器：

```text
http://你的服务器地址:8787/onebot
```

如果你使用 Nginx 或域名，把上报地址改为：

```text
https://你的域名/onebot
```

## 公网提醒

当前项目按你的要求不加登录密码。公网部署后，知道链接的人都能查看日报和消息摘要。请只把链接发给可信同事。

## 测试

```powershell
npm.cmd test
```
