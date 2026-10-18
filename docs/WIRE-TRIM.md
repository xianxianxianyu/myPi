# WIRE-TRIM：历史 cot 不再上传

`extensions/wire-trim/index.ts`（`myPi` 里唯一的插件）。挂在 pi 的 `before_provider_request` 事件上，
在请求发出前把历史 assistant 消息里的 `reasoning_content` 删掉（保留最后 1 条）。

## 发现的问题

pi 每次请求都会把**每条**历史 assistant 的 thinking 全文塞回 `reasoning_content`：

```json
{"role":"assistant", "content":"…", "reasoning_content":"[这一轮 thinking 全文]"}
```

对一个 400K 量级的 session，这意味着每次 loop 都要多上传约 **1.9MB**。
但 DeepSeek 系（官方 + 兼容网关）在**分词之前**就把输入侧 cot 丢掉了。

## 验证（受控实验，官方 / forwd 结果一致）

| 实验 | 做法 | 结果 |
|---|---|---|
| 计不计 token | 4.8 万字符塞进 assistant 的 `reasoning_content` | `prompt_tokens` 40 → **40**，不计入 |
| 对照 | 同样的字塞进 `user` 文本 | 40 → **24041**，计入 |
| 破不破缓存 | 同前缀 + 14 万字符 cot | prompt 仍 15037，`cache_hit` **14848 不变** |
| 要不要时间 | 60 万字符（3.6MB 请求体） | 官方 0.7s → **7.9s**；forwd 1.7s → **17–23s** |
| 模型输出 | 删掉历史 cot 后再问 | 结论一致，无退化 |

结论：cot 不计费、不占上下文、不破缓存，**只占传输**。所以删它零语义风险。

顺带一个反直觉的数字：`used` 里的 token 从来不含 cot——面板上"存量 cot 占 ctx x%"
指的是它占 session 文件的比例，不是占 prompt 的比例。

## 为什么用这个接缝

| 方案 | 问题 |
|---|---|
| `context` 钩子重写消息 | 那是 pi 的消息模型（thinking/text/toolCall 块），改了会牵动 UI 统计、估算、压缩 |
| 自建 provider 包一层 stream | 要复制或委托 `streamSimple`，自己维护 usage、abort、tool 事件 |
| 上游加 compat 字段 | 最干净，但要等；而且不只 DeepSeek 一家这样 |
| **`before_provider_request` 改 payload** | 官方事件（类型定义原话 *"Can replace the payload"*），只碰马上要发出去的那段 JSON |

pi 的接线（`dist/bundle` 里可见）：

```js
const transformProviderPayload = async (payload) => {
  const runner = extensionRunnerRef.current;
  return runner?.hasHandlers("before_provider_request")
    ? runner.emitBeforeProviderRequest(payload)
    : payload;
};
agent = new Agent({ ..., onPayload: transformProviderPayload, ... });
```

pi-ai 侧（`api/openai-completions.js:187`）：

```js
let params = buildParams(model, normalizedContext, options, compat, ...);
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) params = nextParams;   // 返回值直接替换
```

所以扩展看到的是**协议形状**（`messages[].reasoning_content`），不是 pi 的内部结构。

## 命中条件

**这些是护栏，不是"什么时候才起作用"的开关。** 每个请求都会过一遍，过不了就是"不动"。

| 闸 | 条件 | 不过时 | 为什么 |
|---|---|---|---|
| ① 协议 | `model.api === "openai-completions"` | 原样放行 | Anthropic 的 thinking 带 signature 校验、Responses 用 `encrypted_content` 维持跨轮推理，删了会报错或丢连续性 |
| ② 模型 | 模型 id 含 `deepseek`，**或** provider 名命中（两者是「或」，可配） | 原样放行 | **有实测证据**：zai 的 glm-5.3-flash 会把输入的 `reasoning_content` **计入**（22 → 24022 token），DeepSeek 不计（40 → 40）。删 zai 的 cot 是真的改动它的 prompt，不能碰 |
| ③ 内容 | 消息里确实有非空 reasoning 字段 | 原样放行 | 没东西可删 |

三个字段名都认：`reasoning_content` / `reasoning` / `reasoning_text`
（抄 pi-ai 自己的白名单 `OPENAI_COMPLETIONS_REASONING_FIELDS`，它写哪个我们就删哪个）。

**多轮不是条件。** 第一个请求里只有 1 条 cot，而 `keepLast: 1` 要留一条，所以看起来"没动"；
一旦进入第二轮，第 1 条的 cot 就成了历史，立刻被删。

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
| `models` | `["deepseek"]` | 模型 id 包含任一字符串即命中（大小写不敏感）；空数组则按 `providers` 判断 |
| `providers` | `[]` | provider id 包含任一字符串；`models` 非空时不用它 |
| `keepLast` | `1` | 保留最后 N 条 cot。留 1 条是为了将来换 Anthropic 时行为不用改 |
| `notifyAboveChars` | `200000` | 每 session 第一次省下超过这个字符数时提示一次；`0` = 不提示 |

## 看效果

```
/wire
```

输出：开关状态、命中的模型、当前模型会不会被精简、最近一次删了几条 / 少传多少 MB、
本 session 累计。数字不靠感觉。

## 边界

- **不碰 session 文件**：pi 的会话记录里 thinking 原文都还在，UI 里照常能看到、能折叠。
- **不碰最后一条**：留一条的成本只有一轮的量。
- **不改顺序、不删消息**：只删一个字段。
- **将来上游加了 compat 字段**（比如 `discardsInputReasoning: true`），把这个文件删掉即可，
  别的地方不用改。
