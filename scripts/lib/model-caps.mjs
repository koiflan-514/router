/**
 * 模型能力推断：补上游菜单没写的 `reasoning` 位。
 *
 * 背景：Trae / CodeArts / ZCode / 百度搭子这些反代的 `/v1/models` 只给 id，
 * 不带 `capabilities.reasoning`。pi 只看这个布尔值决定要不要开放 thinking 档位，
 * 于是这些模型在 pi 里只能选 `off`——即使上游其实会吐 `reasoning_content`。
 *
 * 这里按模型族做保守匹配：只认比较明确的「会思考」型号，不把拿不准的
 * auto / default / code / lite 之类算进去。显式 `reasoning: true` 永远保留；
 * 显式 false 只在命中已知族时被改真（例如百度搭子的 deepseek-v4-pro）。
 */

const REASONING_FAMILIES = [
  // DeepSeek V3 / V4 / R1 系列
  /(?:^|[/_-])deepseek[-_ ]?v?[34](?:[._-]?\d+)?/i,
  /(?:^|[/_-])deepseek[-_ ]?r1/i,
  // 智谱 GLM 4.5 / 4.6 / 5.x
  /glm[-_ ]?[456](?:[._-]?\d+)?/i,
  // Kimi K2 / K3
  /kimi[-_ ]?k[23](?:[._-]?\d+)?/i,
  // 千问 3.5+ / 3.8 / 4.x（qwen2.5 不算）
  /qwen[-_ ]?3(?:[._-]?[5-9])/i,
  /qwen[-_ ]?[4-9](?:[._-]?\d+)?/i,
  // 豆包 Seed 2.x
  /doubao[-_ ]?seed[-_ ]?2/i,
  // MiniMax M2 / M3 / MiMo V2
  /minimax[-_ ]?m[23](?:[._-]?\d+)?/i,
  /mimo[-_ ]?v2/i,
  // Step 5
  /step[-_ ]?5/i,
  // GPT-5/6、Gemini 3、Grok 4
  /gpt[-_ ]?[56](?:[._-]?\d+)?/i,
  /gemini[-_ ]?3(?:[._-]?\d+)?/i,
  /grok[-_ ]?4(?:[._-]?\d+)?/i,
  // 华为盘古 2.x、百度文心 4.5、腾讯混元 / HY4
  /openpangu[-_ ]?2(?:[._-]?\d+)?/i,
  /ernie[-_ ]?[45](?:[._-]?\d+)?/i,
  /hunyuan|hy4/i,
];

/** 模型 id 是否属于已知会思考的型号族。 */
export function inferReasoning(modelId) {
  const id = String(modelId ?? "");
  if (!id) return false;
  return REASONING_FAMILIES.some((pattern) => pattern.test(id));
}

/** 给单个模型条目补 `reasoning`，其它字段原样保留。 */
export function withReasoning(model) {
  if (!model || typeof model !== "object") return model;
  if (model.reasoning === true) return model;
  if (!inferReasoning(model.id)) return model;
  return { ...model, reasoning: true };
}