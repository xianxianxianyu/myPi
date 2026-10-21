# 实验：判断 provider 把输入 cot 当什么

一个变量、三行请求。目的是回答：**历史 `reasoning_content` 进不进上下文。**

## 准备

同一个模型、同一个前缀，只改中间那条 assistant 的消息。填充物用 4.8 万字符的可辨识文本
（例如重复的 `cot `），便于在日志里确认它确实发出去了。

## 三行

```python
import openai

client = openai.OpenAI(api_key="<KEY>", base_url="<BASE_URL>")
MODEL = "<MODEL>"
FILLER = "cot " * 16_000          # 4.8 万字符

def probe(messages, **kw):
    r = client.chat.completions.create(model=MODEL, messages=messages, **kw)
    return r.usage.prompt_tokens

base = [
    {"role": "user", "content": "1+1=?"},
    {"role": "assistant", "content": "ok"},
    {"role": "user", "content": "continue"},
]

# A 基线
a = probe(base)

# B 历史 cot（被观察的字段）
b = probe([base[0], {**base[1], "reasoning_content": FILLER}, base[2]])

# C 对照：同样的字，但放在 user 文本里
c = probe([{**base[0], "content": base[0]["content"] + FILLER}, base[1], base[2]])
```

字段名按 provider 实际返回的来：`reasoning_content` / `reasoning` / `reasoning_text`。

## 读结果

| 观测 | 结论 | 删历史 cot 的性质 |
|---|---|---|
| `b == a` 且 `c >> a` | 输入 cot 被丢弃 → [可丢弃](paradigms.md#可丢弃) | **no-op**，只省传输 |
| `b ≈ c` | 输入 cot 进上下文 → [必须重放](paradigms.md#必须重放) | **改语义**，省的是真 token 与 prefill |
| `b` 介于两者之间 | 部分计入，或按段计费 | 需要再切一刀定位 |
| 字段是密文 | [不透明凭证](paradigms.md#不透明凭证) | 不能自己构造，只可原样搬 |

## 必须再跑一遍的形态

**带上线上真实的参数重测。** 至少两组：

```python
# 无 tools
probe(base)
# 带 tools —— agent 会话永远是这一行
probe(base, tools=[{"type": "function", "function": {
    "name": "noop", "description": "no-op",
    "parameters": {"type": "object", "properties": {}}}}])
```

DeepSeek 的 `reasoning_content` 是否回传由 `tools` 决定，两组结果会完全不同。
见 [同一家模型跨两种范式](paradigms.md#同一家模型跨两种范式最容易翻车的地方)。

## 三条纪律

1. **带上线上真实参数**（`tools`、thinking 开关、`stream`）。
2. **一次只改一处**。cot 与对照必须同长度、同位置。
3. **记录 provider 与网关**。同一个模型名走官方与走兼容网关，行为可能不同。

## 顺带该记的三个数

| 指标 | 怎么看 | 意义 |
|---|---|---|
| `cache_hit` / `cached_tokens` | 加长 cot 后是否不变 | 会不会破缓存（见 [缓存](cache.md)） |
| 端到端耗时 | 60 万字符 cot 前后对比 | 传输本身的成本 |
| 请求体大小 | `len(json.dumps(payload))` | 换算成 MB，才知道值不值得改 |

## 本机实测（2026-10，deepseek-flash）

| 实验 | 结果 |
|---|---|
| 4.8 万字符塞进 assistant `reasoning_content` | `prompt_tokens` 40 → 40 |
| 同样的字塞进 `user` 文本（对照） | 40 → 24,041 |
| 同一前缀 + 14 万字符 cot | prompt 15,037、`cache_hit` 14,848，均不变 |
| 60 万字符（3.6 MB 请求体） | 官方 0.7 s → 7.9 s；网关 1.7 s → 17–23 s |
| zai/glm 同款实验 | 22 → 24,022（真计入）；删历史 cot 后 96,022 → 22 tok，prefill 2.56 s → 0.90 s |

前四行是**无 tools** 请求形态。带上 tools 后 DeepSeek 属于"必须重放"，这些数字不适用。
