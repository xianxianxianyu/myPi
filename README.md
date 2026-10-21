# wire-trim

pi 扩展：**历史推理不再上传。**

挂在 `before_provider_request` 上，在请求发出前删掉历史 assistant 消息里的 reasoning 字段，
只保留最后 `keepLast` 条。不碰 session 文件、不碰 UI、不改消息顺序。

```json
{"role": "assistant", "content": "…", "reasoning_content": "这一轮 thinking 全文"}
```

---

## 先读这个：能不能删，取决于请求形态

历史推理在请求体里有三种身份，删掉的后果完全不同：

| 范式 | 代表 | 删掉的后果 |
|---|---|---|
| **可丢弃** | 无 `tools` 的 DeepSeek / 兼容网关 | 无事发生，纯省传输 |
| **必须重放** | DeepSeek + `tools`；Anthropic `thinking` | 丢连续性，或 `400` |
| **不透明凭证** | Responses `encrypted_content`；Gemini `thought_signature` | 校验失败 / 能力静默退化 |

本插件只做一件事：**按模型名命中后删字段**。它不判断请求是否带 `tools`，
也不区分你的 gateway 属于哪种范式 —— 那是配置和自测的责任，见
[三种范式](docs/paradigms.md) 与 [实验方法](docs/experiments.md)。

默认只覆盖 `deepseek`，且是在**本机网关实测为"可丢弃"**之后才放开的。
换网关、换模型、加上新的工具循环，都请重跑一次三行实验再开。

## 数字

400K 量级会话每轮多传约 **1.9 MB**；60 万字符 cot（3.6 MB 请求体）把网关从 1.7 s 拖到 **17–23 s**，
而 `prompt_tokens` 与 `cache_hit` 都不变。省的是传输，不是上下文。

## 装入

```bash
pi install /path/to/myPi-wire-trim
```

配置在 `~/.pi/agent/wire-trim.json`：

```json
{ "enabled": true, "models": ["deepseek"], "keepLast": 1, "notifyAboveChars": 200000 }
```

看效果用 `/wire`：开关状态、命中模型、当前模型会不会被精简、最近一次删了几条 / 少传多少 MB。

## 文档

| 文档 | 回答什么 |
|---|---|
| [docs/wire-trim.md](docs/wire-trim.md) | 插件的实测数据、三个闸、配置、边界、已知风险 |
| [docs/paradigms.md](docs/paradigms.md) | 三种范式怎么分、哪一行最容易翻车 |
| [docs/experiments.md](docs/experiments.md) | 三行最小实验、判据、本机数据 |
| [docs/payload.md](docs/payload.md) | 为什么下手点是 payload 层，代价是什么 |
| [docs/cache.md](docs/cache.md) | 删字段会不会伤缓存命中率 |

## 边界

- 只删字段：不重排消息、不删消息、不碰 system 与 tools
- 不碰 session 文件：会话记录里 thinking 原文都在，UI 里照常可见
- 不做上下文清理 / 外置 / 压缩
- 上游一旦提供 compat 声明（例如 `discardsInputReasoning: true`），本插件即应删除

## 开发

```bash
npm run check   # typecheck + 单元测试
```

## License

MIT
