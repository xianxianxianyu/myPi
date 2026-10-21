# wire-trim 插件说明

`extensions/wire-trim/index.ts`。挂在 pi 的 `before_provider_request` 事件上，
请求发出前把历史 assistant 消息里的 reasoning 字段删掉，保留最后 `keepLast` 条。

为什么选这一层见 [payload](payload.md)；三范式见 [paradigms](paradigms.md)。

---

## 发现的问题

pi 每次请求都会把**每条**历史 assistant 的 thinking 全文塞回 `reasoning_content`：

```json
{"role": "assistant", "content": "…", "reasoning_content": "[这一轮 thinking 全文]"}
```

对一个 400K 量级的 session，这意味着每次 loop 多上传约 **1.9 MB**。

## 验证（受控实验）

| 实验 | 做法 | 结果 |
|---|---|---|
| 计不计 token | 4.8 万字符塞进 assistant 的 `reasoning_content` | `prompt_tokens` 40 → **40** |
| 对照 | 同样的字塞进 `user` 文本 | 40 → **24,041** |
| 破不破缓存 | 同前缀 + 14 万字符 cot | prompt 仍 15,037，`cache_hit` **14,848 不变** |
| 要不要时间 | 60 万字符（3.6 MB 请求体） | 官方 0.7 s → **7.9 s**；网关 1.7 s → **17–23 s** |
| 模型输出 | 删掉历史 cot 后再问 | 结论一致，无退化 |

结论：在这台机器上，该网关于**分词之前**就把输入侧 cot 丢掉，它不计费、不占上下文、不破缓存，**只占传输**。

## 前提：这张表测的是不带 tools 的请求

DeepSeek 官方文档对 `reasoning_content` 的说法是条件式的：

> 若请求携带 `tools` 参数：历史轮次的 `reasoning_content` 均应回传给 API，并会被拼接进上下文。
> 若请求未携带 `tools` 参数：无需回传；即使传入也会被忽略。

也就是同一家模型跨两种范式：

| 请求形态 | 范式 | 删历史 cot |
|---|---|---|
| 纯对话（无 `tools`） | 可丢弃 | 无副作用 |
| agent 循环（带 `tools`） | 必须重放 | 丢掉那段推理；某些版本/网关直接 `400 reasoning_content must be passed back` |

上表"零语义风险"的结论**只对第一行成立**。而 agent 会话永远是第二行 ——
本插件当前**不判断请求是否带 `tools`**，命中模型名就删。

这条差距是刻意的取舍，不是遗漏：

- 实测本机在带 `tools` 的多轮工具调用下删除后仍然跑通（`stripped=1`，无 400）；
- 但"某网关能过"不等于"所有版本都能过"，所以默认只放 `deepseek` 且必须自测；
- 若你的目标模型属于"必须重放"，请在配置里去掉它，或见文末「已知风险」。

## 为什么用这个接缝

| 方案 | 问题 |
|---|---|
| `context` 钩子重写消息 | 那是 pi 的消息模型（thinking/text/toolCall 块），改了会牵动 UI 统计、估算、压缩 |
| 自建 provider 包一层 stream | 要复制或委托 `streamSimple`，自己维护 usage、abort、tool 事件 |
| 上游加 compat 字段 | 最干净，但要等；而且不只 DeepSeek 一家这样 |
| **`before_provider_request` 改 payload** | 官方事件（类型定义原话 *"Can replace the payload"*），只碰马上要发出去的那段 JSON |

调用链与代价见 [payload](payload.md)。

## 命中条件

**这些是护栏，不是"什么时候才起作用"的开关。** 每个请求都会过一遍，过不了就是"不动"。

| 闸 | 条件 | 不过时 | 为什么 |
|---|---|---|---|
| ① 协议 | `ctx.model.api === "openai-completions"` | 原样放行 | Anthropic 的 thinking 带 signature 校验、Responses 用 `encrypted_content` 维持跨轮推理，删了会报错或丢连续性 |
| ② 模型 | 模型 id 含 `deepseek`，**或** provider 名命中（两者是「或」，可配） | 原样放行 | 默认只放已验证的模型 |
| ③ 内容 | 消息里确实有非空 reasoning 字段 | 原样放行 | 没东西可删 |

三个字段名都认：`reasoning_content` / `reasoning` / `reasoning_text`
（抄 pi-ai 自己的白名单 `OPENAI_COMPLETIONS_REASONING_FIELDS`，它写哪个就删哪个）。

**多轮不是条件。** 第一个请求里只有 1 条 cot，而 `keepLast: 1` 要留一条，所以看起来"没动"；
进入第二轮后，第 1 条的 cot 成了历史，立刻被删。

## 哪些模型能删（实测，别猜）

同一个测试：4.8 万字符塞进历史 `reasoning_content`，看 `prompt_tokens` 变不变。

| provider / 模型 | 输入 cot 计入 prompt？ | 删掉它的性质 | 默认 |
|---|---|---|---|
| DeepSeek 官方（**无 tools**） | ❌ 40 → **40** | **no-op** | ✅ 开 |
| forwd / deepseek-flash（**无 tools**） | ❌ 40 → **40** | 同上 | ✅ 开 |
| DeepSeek 官方（**带 tools**） | ✅ 计入，且要求回传 | **真实改动**：删 = 改语义 | ⚠️ 本机实测可跑通，但要自测 |
| zai / glm-5.3-flash | ✅ 22 → **24,022** | **真实改动** | ⬜ 默认关，可加 |

GLM 那行不是"不能"，是"代价性质不同"：

| | DeepSeek（无 tools） | GLM |
|---|---|---|
| 删掉省什么 | 只有带宽 | 带宽 **+ 真 token**（96,022 → 22）**+ prefill**（2.56 s → 0.90 s） |
| 语义风险 | 零（网关本来就不看） | 有：模型少了一段它本来能读到的推理 |
| 实测表现 | — | 4 次工具调用的多步任务跑通（`A×100+B×10+C = 124`） |

**GLM 上收益更大**（真计费、真占上下文），想开就在配置里加 `"glm"`。
唯一顾虑是"模型会不会靠上一轮推理维持连贯"，行业惯例是**不重放**（Claude Code、Codex 都不重放），实测也无异常。

### 新增 provider 怎么判断

改配置之前，先用一次最小请求看它认不认，**并带上线上真实的 `tools` 参数**：
见 [experiments](experiments.md)。

- `B == A` 且 `C >> A` → 网关丢弃输入 cot → **no-op，放心删**
- `B ≈ C` → 网关真的读 → **删是策略选择**，先小范围试

## 配置

`~/.pi/agent/wire-trim.json`：

```json
{
  "enabled": true,
  "models": ["deepseek"],
  "providers": [],
  "keepLast": 1,
  "notifyAboveChars": 200000
}
```

（也认外面包一层 `"wire": { ... }` 的写法。）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不碰 payload |
| `models` | `["deepseek"]` | 模型 id 包含任一字符串即命中（大小写不敏感）。`models` 与 `providers` 是「或」 |
| `providers` | `[]` | provider id 包含任一字符串；`models` 非空时不用它 |
| `keepLast` | `1` | 保留最后 N 条 cot。留 1 条是为了将来换 Anthropic 时行为不用改 |
| `notifyAboveChars` | `200000` | 每 session 第一次省下超过这个字符数时提示一次；`0` = 不提示 |

## 看效果

```
/wire
```

输出：开关状态、命中的模型、当前模型会不会被精简、最近一次删了几条 / 少传多少 MB、本 session 累计。

## 边界

- **不碰 session 文件**：pi 的会话记录里 thinking 原文都在，UI 里照常能看到、能折叠
- **不碰最后一条**：留一条的成本只有一轮的量
- **不改顺序、不删消息**：只删一个字段
- **将来上游加了 compat 字段**（比如 `discardsInputReasoning: true`），把这个文件删掉即可

## 已知风险

1. **不判断 `tools`**：见上文「前提」。请求带 tools 且网关属"必须重放"时，删除可能丢推理连续性或触发 400。
   缓解：只对实测过的模型开启；或改用 `keepLast` 调大；或等上游 compat 字段。
2. **只按模型名判断协议**：`model.api` 之外不做形状探测，绕过 pi 的 adapter 直接换网关时需自行确认。
3. **缓存**：`keepLast` 会让删除边界每轮前移一条，稳定损失约一轮的缓存量，不会整段不命中。详见 [cache](cache.md)。
