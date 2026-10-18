# myPi

我自己的 pi 定制。**只有一个插件**：出站 payload 精简。

```
extensions/wire-trim/   历史 cot 不再上传（挂在 before_provider_request 接缝）
docs/WIRE-TRIM.md       发现的坑、验证数据、配置、边界
```

## 装入

```bash
pi install /Users/moyu/Desktop/project/myPi
```

配置在 `~/.pi/agent/wire-trim.json`，看效果用 `/wire`。

默认覆盖的两个模型族，性质不同但都可以删：

| 模型 | provider 怎么处理输入 cot | 删掉省什么 |
|---|---|---|
| `deepseek`（官方 / forwd） | 分词前丢弃 | 只有带宽 |
| `glm`（zai） | 真的读进上下文 | 带宽 + 真 token + prefill（实测 96,022 → 22 tok，2.56s → 0.90s） |

实测 GLM 删掉历史 cot 后，需要记住前几步结果的 4 步工具任务仍然正确
（`A×100+B×10+C = 124`）。

## 为什么只有这一个

pi 会把每条历史 assistant 的 thinking 全文塞回 `reasoning_content` 重发，
而 DeepSeek 系在分词前就把它丢掉了 —— 不计 token、不占上下文、不破缓存，**只占传输**。
400K 量级的会话每次请求因此多传约 1.9MB，实测网关处理大请求体很慢（3.6MB → 17–23s）。

删掉它，请求体少一半左右，零语义风险。细节见 [docs/WIRE-TRIM.md](docs/WIRE-TRIM.md)。

## 不做什么

- 不改 pi 的消息模型、不碰 session 文件、不碰 UI
- 不做上下文清理 / 阈值 / 外置（实测慢主要来自字节量，而 pi 自己的压缩已经把体量框住了）
- 不 vendor、不 fork 上游插件

## 开发

```bash
npm run check   # typecheck + 8 个单元测试
```
