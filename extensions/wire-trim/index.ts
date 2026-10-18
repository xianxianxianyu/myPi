/**
 * 出站 payload 精简（`before_provider_request` 接缝）。
 *
 * 发现的坑：pi 会把每条历史 assistant 的 thinking 全文塞回 `reasoning_content`。
 * 对 DeepSeek 系（官方 api.deepseek.com 与兼容网关都实测过）这是纯浪费：
 *
 * | 实验 | 结果 |
 * |---|---|
 * | 4.8 万字符 cot 塞进 assistant | `prompt_tokens` 40 → 40，**不计入** |
 * | 同样的字塞进 user 文本（对照） | 40 → 24041，计入 |
 * | 同一前缀 + 14 万字符 cot | `prompt_tokens` 不变，`cache_hit` 14848 不变 |
 * | 60 万字符 cot（3.6MB 请求体） | 官方 0.7s → 7.9s，forwd 1.7s → **17–23s** |
 *
 * 也就是：网关在**分词之前**就把输入侧 cot 丢了 —— 不计费、不占上下文、不破缓存，
 * 但请求体照样要上传。所以删掉它没有任何语义风险，只省传输。
 *
 * 为什么不用 `context` 钩子：那层是 pi 的消息模型（thinking/text/toolCall 块），
 * 改了会牵动 UI 统计、估算、压缩。这里只碰马上要发出去的那段 JSON。
 *
 * 为什么不改最新一条：留 `keepLast` 条的成本只有一轮的量，将来换成 Anthropic / OpenAI
 * （那边重放是硬要求）时行为不用改。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = join(getAgentDir(), "wire-trim.json");

/** 只对这些字段名下手。不同兼容网关叫法不同，但都在 chat-completions 形状里。 */
const REASONING_FIELDS = ["reasoning_content", "reasoning"] as const;

export interface WirePolicy {
  /** 关掉就完全不碰 payload。 */
  readonly enabled: boolean;
  /** 命中条件：模型 id 包含任一字符串（大小写不敏感）。空数组表示不按模型判断。 */
  readonly models: readonly string[];
  /** 命中条件：provider id 包含任一字符串。`models` 为空时才会用到。 */
  readonly providers: readonly string[];
  /** 保留最后 N 条 assistant 的 reasoning，其余删掉。 */
  readonly keepLast: number;
  /** 单个 session 里第一次省下超过这个量（字符）时提示一次。0 = 不提示。 */
  readonly notifyAboveChars: number;
}

export const DEFAULT_WIRE_POLICY: WirePolicy = {
  enabled: true,
  models: ["deepseek"],
  providers: [],
  keepLast: 1,
  notifyAboveChars: 200_000,
};

export interface TrimResult {
  readonly payload: unknown;
  /** 被删掉字段的消息条数 */
  readonly trimmedMessages: number;
  /** 被删掉的内容字符数（≈ 上传省下的量） */
  readonly savedChars: number;
  /** 请求里本来有多少 cot 字符（删之前的量） */
  readonly totalCotChars: number;
}

/**
 * 删掉历史 assistant 消息里的 reasoning 字段，保留最后 `keepLast` 条。
 *
 * 纯函数：不改入参，返回新对象；不满足条件时返回 undefined（调用方原样放行）。
 */
export function trimReasoningContent(payload: unknown, keepLast: number): TrimResult | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  const messages = body.messages;
  if (!Array.isArray(messages)) return undefined;

  const carriers: number[] = [];
  let totalCotChars = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    for (const field of REASONING_FIELDS) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        carriers.push(index);
        totalCotChars += value.length;
        break;
      }
    }
  }
  if (carriers.length === 0) return undefined;

  const keep = Math.max(0, Math.floor(keepLast));
  const strip = new Set(carriers.slice(0, Math.max(0, carriers.length - keep)));
  if (strip.size === 0) return undefined;

  let savedChars = 0;
  const nextMessages = messages.map((message, index) => {
    if (!strip.has(index)) return message;
    const copy = { ...(message as Record<string, unknown>) };
    for (const field of REASONING_FIELDS) {
      const value = copy[field];
      if (typeof value === "string" && value.length > 0) {
        savedChars += value.length;
        delete copy[field];
      }
    }
    return copy;
  });

  return {
    payload: { ...body, messages: nextMessages },
    trimmedMessages: strip.size,
    savedChars,
    totalCotChars,
  };
}

/** 这个 payload / 模型组合要不要动手。 */
export function shouldTrim(
  policy: WirePolicy,
  model: { readonly id?: string; readonly provider?: string; readonly api?: string } | undefined,
): boolean {
  if (!policy.enabled) return false;
  // 只有 chat-completions 形状才有 reasoning_content；Anthropic / Responses 的重放是硬要求
  if (model?.api !== "openai-completions") return false;
  const matches = (haystack: string | undefined, needles: readonly string[]): boolean => {
    if (!haystack) return false;
    const lower = haystack.toLowerCase();
    return needles.some((needle) => needle.length > 0 && lower.includes(needle.toLowerCase()));
  };
  if (policy.models.length > 0) return matches(model?.id, policy.models);
  if (policy.providers.length > 0) return matches(model?.provider, policy.providers);
  return false;
}

/**
 * 配置文件 `~/.pi/agent/wire-trim.json`。
 *
 * 两种写法都认：直接写字段，或者包一层 `wire`（从 myPi 配置里搬过来时不用改文件）。
 */
type WireConfig = Partial<WirePolicy> & { readonly wire?: Partial<WirePolicy> };

let cache: { mtime: number; policy: WirePolicy } | undefined;

export function loadWirePolicy(): WirePolicy {
  let mtime = 0;
  try {
    mtime = statSync(CONFIG_FILE).mtimeMs;
  } catch {
    return DEFAULT_WIRE_POLICY;
  }
  if (cache && cache.mtime === mtime) return cache.policy;
  let policy = DEFAULT_WIRE_POLICY;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as WireConfig;
    const raw: Partial<WirePolicy> | undefined = parsed.wire && typeof parsed.wire === "object" ? parsed.wire : parsed;
    if (raw && typeof raw === "object") {
      policy = {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_WIRE_POLICY.enabled,
        models: Array.isArray(raw.models) ? raw.models.filter((x): x is string => typeof x === "string") : DEFAULT_WIRE_POLICY.models,
        providers: Array.isArray(raw.providers) ? raw.providers.filter((x): x is string => typeof x === "string") : DEFAULT_WIRE_POLICY.providers,
        keepLast: Number.isFinite(raw.keepLast) ? Math.max(0, Number(raw.keepLast)) : DEFAULT_WIRE_POLICY.keepLast,
        notifyAboveChars: Number.isFinite(raw.notifyAboveChars)
          ? Math.max(0, Number(raw.notifyAboveChars))
          : DEFAULT_WIRE_POLICY.notifyAboveChars,
      };
    }
  } catch {
    policy = DEFAULT_WIRE_POLICY;
  }
  cache = { mtime, policy };
  return policy;
}

export interface WireStats {
  /** 最近一次请求的统计 */
  last?: { trimmedMessages: number; savedChars: number; totalCotChars: number };
  /** 本 session 累计省下的字符 */
  savedChars: number;
  /** 本 session 被精简过的请求数 */
  requests: number;
}

/**
 * 挂接到 pi。
 *
 * 返回一个只读状态查询，给 `/wire` 命令用 —— 效果要能被看见，不靠感觉。
 */
export function installWireTrim(pi: ExtensionAPI): { stats: () => WireStats } {
  const stats: WireStats = { savedChars: 0, requests: 0 };
  let notified = false;

  pi.on("session_start", () => {
    stats.last = undefined;
    stats.savedChars = 0;
    stats.requests = 0;
    notified = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const policy = loadWirePolicy();
    if (!shouldTrim(policy, ctx.model)) return;
    const result = trimReasoningContent(event.payload, policy.keepLast);
    if (!result) return;

    stats.requests += 1;
    stats.savedChars += result.savedChars;
    stats.last = {
      trimmedMessages: result.trimmedMessages,
      savedChars: result.savedChars,
      totalCotChars: result.totalCotChars,
    };

    // 每个 session 只在第一次超过阈值时提示一遍，免得每次都弹
    if (!notified && policy.notifyAboveChars > 0 && result.savedChars >= policy.notifyAboveChars) {
      notified = true;
      const mb = result.savedChars / 1_000_000;
      ctx.ui.notify(`wire：本次少传 ${mb.toFixed(1)}MB（历史 cot 不再上传）`, "info");
    }

    return result.payload;
  });

  pi.registerCommand("wire", {
    description: "出站 payload 精简：配置 / 最近一次省了多少 / 怎么关",
    handler: async (_args, ctx) => {
      const policy = loadWirePolicy();
      const model = ctx.model;
      const lines = [
        `开关 ${policy.enabled ? "开" : "关"} · 命中模型 ${policy.models.length ? policy.models.join(", ") : "（按 provider）"} · 保留最后 ${policy.keepLast} 条`,
        `当前模型 ${model ? `${model.provider}/${model.id} (${model.api})` : "未知"} · ${shouldTrim(policy, model) ? "会精简" : "不动"}`,
      ];
      if (stats.last) {
        lines.push(
          `最近一次：删 ${stats.last.trimmedMessages} 条历史 cot，少传 ${(stats.last.savedChars / 1_000_000).toFixed(2)}MB` +
            `（原本 ${(stats.last.totalCotChars / 1_000_000).toFixed(2)}MB）`,
        );
      } else {
        lines.push("最近一次：没有可精简的内容");
      }
      lines.push(`本 session：${stats.requests} 次请求共少传 ${(stats.savedChars / 1_000_000).toFixed(2)}MB`);
      lines.push(`配置：${CONFIG_FILE}（enabled / models / providers / keepLast / notifyAboveChars）`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  return { stats: () => ({ ...stats }) };
}

/** pi 扩展入口：工厂函数必须默认导出，pi 在加载时调用它。 */
export default function wireTrimExtension(pi: ExtensionAPI): void {
  installWireTrim(pi);
}
