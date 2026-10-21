# 三种范式

同一个"历史推理"字段，在不同 provider 眼里是三种完全不同的东西。判断错了，代价从"白忙"到"请求 400"不等。

| 范式 | 代表 | 历史 cot 的身份 | 删掉的后果 |
|---|---|---|---|
| [可丢弃](#可丢弃) | 无 `tools` 的 DeepSeek / 兼容网关 | 纯展示文本，服务端忽略 | 无事发生，纯省传输 |
| [必须重放](#必须重放) | DeepSeek + `tools`；Anthropic `thinking` | 上下文的一部分 | 丢推理连续性，或直接 400 |
| [不透明凭证](#不透明凭证) | Responses `encrypted_content`；Gemini `thought_signature` | 密文，不可读但要原样搬 | 校验失败 / 多步能力静默退化 |

判别方法见 [实验](experiments.md)。

---

## 可丢弃

字段是给人看的。服务端收到就扔，不参与分词、不参与缓存计算。

判别依据只能靠实验：加长这段文本后 `prompt_tokens` **完全没变**。

这一范式下删除是纯粹的传输优化，语义上等价于没删。

## 必须重放

字段进了上下文，或者带签名校验。

- **DeepSeek + `tools`**：官方文档明确写 `reasoning_content` 是否回传取决于请求是否携带 `tools`
  —— 带 tools 时必须回传，并会被拼进上下文。
- **Anthropic**：thinking 块带 `signature`。同一轮工具循环内必须原样传回，改一个字符就报错；
  跨轮传回是否生效由模型的 preserved thinking 规则决定。

这一范式下，"删"不是优化，是改语义。收益仍然可能很大（真 token + prefill 时间），
但要按"策略变更"对待：先小范围试，看长链路任务有没有退化。

## 不透明凭证

字段是加密串，模型能解、你读不懂。

- **OpenAI Responses**：`store: false`（或 ZDR）时，推理项以 `encrypted_content` 返回，
  要维持跨轮推理就得原样回放（连同 `id`、`summary`）。
- **Gemini 3**：`thought_signature`，function calling 场景校验更严。

删掉不一定报错，但会静默丢掉它买来的东西 —— 这类最危险，因为排查时看不出异常。

---

## 同一家模型跨两种范式（最容易翻车的地方）

DeepSeek 官方文档的意思：**带 `tools` 时历史 `reasoning_content` 必须回传、并会被拼进上下文；
不带 `tools` 时会被忽略。**

| 请求形态 | 范式 | 删历史 cot |
|---|---|---|
| 纯对话（无 `tools`） | 可丢弃 | 无副作用 |
| agent 循环（带 `tools`） | 必须重放 | 丢连续性；缺失时 `400 reasoning_content must be passed back` |

而 agent 会话**总是**带 tools。

这就是"拿一个 no-tools 实验的结论去优化线上 agent，然后把请求跑挂"的完整路径。
主仓库 README 里那组"不计 token、不破缓存"的数字，测的是左边那行。

**由此得出一条纪律**：任何 provider 结论都必须标注请求形态。不带 `tools` 测出来的数字，
不能直接用来决定带 `tools` 的请求怎么处理。

---

## 参考

- DeepSeek 思考模式（含 `tools` 决定是否回传）：<https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- Anthropic extended thinking：<https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- Anthropic preserved thinking（signature 校验）：<https://platform.claude.com/docs/en/build-with-claude/preserved-thinking>
- OpenAI reasoning items / `encrypted_content`：<https://developers.openai.com/api/docs/guides/reasoning>
- Gemini thought signatures：<https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>
