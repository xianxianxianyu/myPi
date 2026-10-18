import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WIRE_POLICY, shouldTrim, trimReasoningContent } from "./index.ts";

const payload = (messages: unknown[]): unknown => ({ model: "deepseek-flash", messages, stream: true });

const assistant = (text: string, cot: string): Record<string, unknown> => ({
  role: "assistant",
  content: text,
  reasoning_content: cot,
});

test("删掉除最后 keepLast 条以外的 reasoning_content", () => {
  const input = payload([{ role: "user", content: "hi" }, assistant("a", "1".repeat(100)), assistant("b", "2".repeat(200))]);
  const result = trimReasoningContent(input, 1);
  assert.ok(result);
  assert.equal(result.trimmedMessages, 1);
  assert.equal(result.savedChars, 100);
  assert.equal(result.totalCotChars, 300);
  const messages = (result.payload as { messages: Record<string, unknown>[] }).messages;
  assert.equal(messages[1]?.reasoning_content, undefined);
  assert.equal(messages[2]?.reasoning_content, "2".repeat(200));
});

test("不改入参（纯函数）", () => {
  const first = assistant("a", "x".repeat(10));
  const input = payload([first, assistant("b", "y".repeat(10))]);
  trimReasoningContent(input, 0);
  assert.equal(first.reasoning_content, "x".repeat(10), "原对象必须保持不变");
});

test("没有 cot 时返回 undefined（调用方原样放行）", () => {
  assert.equal(trimReasoningContent(payload([{ role: "user", content: "hi" }]), 1), undefined);
  assert.equal(trimReasoningContent(undefined, 1), undefined);
  assert.equal(trimReasoningContent({ messages: "nope" }, 1), undefined);
  assert.equal(trimReasoningContent({}, 1), undefined);
});

test("keepLast 大于实际条数时不动", () => {
  const result = trimReasoningContent(payload([assistant("a", "1".repeat(5))]), 3);
  assert.equal(result, undefined);
});

test("keepLast = 0 时全删", () => {
  const result = trimReasoningContent(payload([assistant("a", "1".repeat(5)), assistant("b", "2".repeat(7))]), 0);
  assert.ok(result);
  assert.equal(result.trimmedMessages, 2);
  assert.equal(result.savedChars, 12);
});

test("reasoning 字段名也认（部分兼容网关）", () => {
  const input = payload([{ role: "assistant", content: "a", reasoning: "r".repeat(9) }, assistant("b", "c".repeat(9))]);
  const result = trimReasoningContent(input, 1);
  assert.ok(result);
  assert.equal(result.trimmedMessages, 1);
  assert.equal(result.savedChars, 9);
});

test("空串不算 cot（不算删掉、不计入总量）", () => {
  assert.equal(trimReasoningContent(payload([{ role: "assistant", content: "a", reasoning_content: "" }]), 0), undefined);
});

test("只对命中模型的 chat-completions 动手", () => {
  const policy = DEFAULT_WIRE_POLICY;
  assert.equal(shouldTrim(policy, { id: "deepseek-flash", provider: "forwd", api: "openai-completions" }), true);
  assert.equal(shouldTrim(policy, { id: "deepseek-chat", provider: "deepseek", api: "openai-completions" }), true);
  // Anthropic / Responses 的重放是硬要求，绝不能碰
  assert.equal(shouldTrim(policy, { id: "deepseek-x", provider: "x", api: "anthropic-messages" }), false);
  assert.equal(shouldTrim(policy, { id: "deepseek-x", provider: "x", api: "openai-responses" }), false);
  // 别的模型不碰
  assert.equal(shouldTrim(policy, { id: "claude-sonnet-5", provider: "anthropic", api: "openai-completions" }), false);
  // 关掉就完全不动
  assert.equal(shouldTrim({ ...policy, enabled: false }, { id: "deepseek-flash", api: "openai-completions" }), false);
  // 未知模型 / 未命中
  assert.equal(shouldTrim(policy, undefined), false);
});
