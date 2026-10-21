# 为什么下手点在 payload 层

结论先给：**删历史推理是"改报文"，不是"改对话"，所以位置得在协议已编码、尚未发送的那一层。**

以下以 pi 的扩展接缝为例，其他 harness 请对照自己的等价层。

---

## 四个接缝

| 层 | 事件 | 看到什么 | 能改什么 |
|---|---|---|---|
| 语义 | `context` | `AgentMessage[]`，**已剔除 system** | 返回新消息数组 |
| 语义+ | `context_with_system` | 完整 transcript | 同上，但要自己保住 index 0 的 system |
| **传输** | **`before_provider_request`** | **`payload: unknown`，adapter 已组装好的请求体** | **返回什么就发什么** |
| 传输 | `before_provider_headers` | headers | 原地改，`null` 删头 |

类型定义原话（`BeforeProviderRequestEvent`）：

> Fired before a provider request is sent. **Can replace the payload.**

## 调用链

```
extension handler                       ← 返回 undefined 表示不改；抛错只记日志，请求照发
  ↑ runner.emitBeforeProviderRequest(payload)
  ↑ onPayload: transformProviderPayload (dist/core/sdk.js)
  ↑ Agent 构造参数 onPayload
  ↑ adapter: buildParams() 之后、HTTP 之前
        const next = await options?.onPayload?.(params, model)
        if (next !== undefined) params = next     // 返回值直接替换请求体
  → fetch
```

位置精度：**协议已编码，尚未发送**。所以看到的是 `messages[].reasoning_content`
（或 `contents[].parts[].thoughtSignature`、`input[].encrypted_content`），
而不是 agent 的内部结构。

## 为什么不下沉到 `context`

| | `context` | `before_provider_request` |
|---|---|---|
| 单位 | pi 的消息 / 内容块 | 协议字段 |
| 覆盖面 | 一次改写，所有 provider 通用 | 必须按 `model.api` 各自分支 |
| 副作用 | 改了会牵动 UI 统计、token 估算、压缩判定 | 只影响这一次请求 |
| 能力边界 | 碰不到 system 与 tools（pi 帮你保住） | 什么都能改，包括不该改的 |
| 出错代价 | 抛错即忽略 | 返回坏结构 = provider 400 |

一句话：`context` 是"改对话"，`before_provider_request` 是"改报文"。

---

## 代价（也就是全部风险）

- **没有 provider 抽象**：`messages[]` / `input[]` / `contents[]` 三种形状，自己分支。
- **改错就是 400**：这一层没有 schema 兜底。
- **必须幂等**：每个请求都会过一遍，同样的输入必须产出同样的输出，
  否则前缀抖动 = 掉缓存（见 [缓存](cache.md)）。
- **缓存责任自负**：在这层改到 `cache_control` / `prompt_cache_key` 之类字段，
  伤的是命中率，而不是"少传字节"。

## 一个实际会踩的坑：event 里没有 model

`BeforeProviderRequestEvent` 只有 `{ type, payload }`。provider / model / `api`
得从 handler 的第二个参数取：`ctx.model`。

所以"按协议分流"在代码里实际长这样：

```ts
pi.on("before_provider_request", (event, ctx) => {
  if (ctx.model?.api !== "openai-completions") return; // 别的协议不动
  ...
});
```

而不是去猜 payload 形状 —— 猜形状永远会漏掉一种网关。

---

## 什么时候这一层应当被删掉

上游一旦提供 compat 声明（例如 `discardsInputReasoning: true`），
协议知识就属于 adapter，不属于扩展。届时这段接缝代码应当整体消失。

这也是判断一个"payload 拦截器"是否合理的标准：
**它在替 adapter 补一条本该由 adapter 表达的协议事实，而 adapter 一旦学会，它就该退场。**
