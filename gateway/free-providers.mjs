/**
 * 免费供应商注册表。
 *
 * 数据来自 dsh-our-free-model 的 `src/providers/registry.json`（MIT），但**只保留
 * 有免费额度的那些**，并做了三处取舍：
 *
 *   1. **只收有免费额度的**。那 76 家里 61 家是纯付费 API-Key 直连，把它们的
 *      key 填进来只是换一种计费方式，不属于本项目「把订阅额度榨干」的定位。
 *      留下的判据是：分类为 `free-tier`，或声明了 `freeModelsHint`（有免费模型）。
 *   2. **保留本机免账号的三家**（Ollama / LM Studio / llama.cpp）。它们不需要
 *      key，只要本机装了就可用——这是唯一「真的不用钱」的一类。
 *   3. **不搬 `notes` 原文**。那些注释是 dsh 自己的实现细节（FCC 的 profile、
 *      9router 的登记方式），照抄过来会让人以为本项目也那样实现。只留一条
 *      人话说明「免费额度是什么」。
 *
 * 和 router 现有 9 家的区别，是这个文件存在的理由：
 *
 *   router 的 9 家   本机进程（router spawn 它、管它的 PID 和日志）
 *   这里的 15 家     云端 HTTP 端点（没有进程可管，只有 baseUrl + key）
 *   这里的 3 家      本机进程（但不是 router 拉起的，是用户自己装的）
 *
 * 所以它们**不进 PROVIDERS**（那张表是「spawn 什么」），而是由网关直接当作上游。
 */

/**
 * 每条记录的字段：
 *   id          网关里的供应商名，会出现在 `<id>/<model>` 里
 *   name        给人看的名字
 *   baseUrl     上游根地址（到 /v1 为止）
 *   format      线协议：openai-chat / anthropic-messages / openai-responses
 *   env         存放 key 的环境变量名（本机服务为 null）
 *   keyUrl      申请 key 的页面（本机服务为 null）
 *   local       是否本机服务（不需要 key）
 *   free        免费额度的性质，一句话
 *   models      静态模型表（可能为空，靠 /models 动态发现）
 *   modelsUrl   模型列表端点（没有就只认静态表）
 *   freeModels  明确的免费模型 id（空数组表示「整家都有免费额度」）
 *   headers     需要额外请求头时（极少数上游要）
 *   baseUrlEnv  允许用环境变量覆盖 baseUrl（本机服务常用）
 *   needs       baseUrl 里有占位符时，说明要替换什么
 */
export const FREE_PROVIDERS = [
  // ---------------------------------------------------------------- 本机免账号
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    format: 'openai-chat',
    env: null,
    keyUrl: null,
    local: true,
    free: '本机推理，不花钱；装了什么模型就有什么',
    models: [],
    modelsUrl: 'http://127.0.0.1:11434/v1/models',
    freeModels: [],
    baseUrlEnv: 'OLLAMA_BASE_URL',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本机）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    format: 'openai-chat',
    env: null,
    keyUrl: null,
    local: true,
    free: '本机推理，不花钱；要在 LM Studio 里先开本地服务器',
    models: [],
    modelsUrl: 'http://127.0.0.1:1234/v1/models',
    freeModels: [],
    baseUrlEnv: 'LM_STUDIO_BASE_URL',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp（本机）',
    baseUrl: 'http://127.0.0.1:8080/v1',
    format: 'openai-chat',
    env: null,
    keyUrl: null,
    local: true,
    free: '本机推理，不花钱；llama-server 默认监听 8080',
    models: [],
    modelsUrl: 'http://127.0.0.1:8080/v1/models',
    freeModels: [],
    baseUrlEnv: 'LLAMACPP_BASE_URL',
  },

  // ---------------------------------------------------------------- 有免费额度（要 key）
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    format: 'openai-chat',
    env: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    free: '免费模型约 27 个，不用信用卡，约 200 请求/天',
    models: [{ id: 'openrouter/free', name: 'OpenRouter Free' }],
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    freeModels: ['openrouter/free'],
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    format: 'openai-chat',
    env: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/auth',
    free: '快车道上有一批 -free 模型，其余按量计费',
    models: [],
    modelsUrl: 'https://opencode.ai/zen/v1/models',
    freeModels: [
      'deepseek-v4-flash-free',
      'mimo-v2.6-flash-free',
      'mimo-v2.5-free',
      'ling-3.0-flash-fin-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'muse-spark-1.3-contributor-free',
      'muse-spark-1.2-contributor-free',
      'jev-1.13-free',
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini（AI Studio）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    format: 'openai-chat',
    env: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: 'AI Studio 的免费额度，有每分钟/每天上限',
    models: [],
    modelsUrl: null, // Google 的 OpenAI 兼容层不提供 /models，只认静态表
    freeModels: [],
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    format: 'openai-chat',
    env: 'NVIDIA_NIM_API_KEY',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    free: '开发者计划成员可免费用于原型与测试',
    models: [],
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    freeModels: [],
  },
  {
    id: 'kilo',
    name: 'Kilo.ai',
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
    format: 'openai-chat',
    env: 'KILO_API_KEY',
    keyUrl: 'https://app.kilo.ai',
    free: '有一条免费池（kilo-auto/free 等）',
    models: [],
    modelsUrl: 'https://ai-gateway.kilo.ai/api/v1/models',
    freeModels: [
      'kilo-auto/free',
      'nvidia/nemotron-3.5-super-vl:free',
      'reflection/beam-free',
      'stealth/glyph-cluster',
      'stealth/crouton-alpha',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3.5-lightning:free',
      'cohere/north-mini-code:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'openrouter/free',
    ],
  },
  {
    id: 'bazaarlink',
    name: 'BazaarLink',
    baseUrl: 'https://bazaarlink.ai/api/v1',
    format: 'openai-chat',
    env: 'BAZAARLINK_API_KEY',
    keyUrl: 'https://bazaarlink.ai',
    free: '多厂商网关，有 auto:free 这个免费档',
    models: [],
    modelsUrl: 'https://bazaarlink.ai/api/v1/models',
    freeModels: ['auto:free'],
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    format: 'openai-chat',
    env: 'OLLAMA_API_KEY',
    keyUrl: 'https://ollama.com/settings/keys',
    free: '免费档：轻度使用，一次一个云端模型',
    models: [],
    modelsUrl: 'https://ollama.com/v1/models',
    freeModels: [],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    format: 'openai-chat',
    env: 'CLOUDFLARE_API_TOKEN',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    free: 'Workers AI 有免费配额',
    models: [],
    modelsUrl: null,
    freeModels: [],
    // 账号级 URL：必须替换 {account_id}
    needs: '把 baseUrl 里的 {account_id} 换成你的 Cloudflare 账号 ID',
  },
  {
    id: 'byteplus',
    name: 'BytePlus Ark',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    format: 'openai-chat',
    env: 'BYTEPLUS_API_KEY',
    keyUrl: 'https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey',
    free: '新账号有免费额度',
    models: [],
    modelsUrl: null,
    freeModels: [],
  },
  {
    id: 'kimchi',
    name: 'Kimchi',
    baseUrl: 'https://llm.kimchi.dev/openai/v1',
    format: 'openai-chat',
    env: 'KIMCHI_API_KEY',
    keyUrl: 'https://app.kimchi.dev',
    free: '注册即发凭据，有免费档',
    models: [],
    modelsUrl: null,
    freeModels: [],
    headers: { 'user-agent': 'kimchi/0.1.50' },
  },
  {
    id: 'tokenrouter',
    name: 'TokenRouter',
    baseUrl: 'https://api.tokenrouter.com/v1',
    format: 'openai-chat',
    env: 'TOKENROUTER_API_KEY',
    keyUrl: 'https://api.tokenrouter.com',
    free: '有 -free 后缀的免费模型',
    models: [],
    modelsUrl: 'https://api.tokenrouter.com/v1/models',
    freeModels: ['moonshotai/kimi-k3-free', 'z-ai/glm-5.3-free'],
  },
  {
    id: 'nararoute',
    name: 'NaraRoute',
    baseUrl: 'https://router.bynara.id/v1',
    format: 'openai-chat',
    env: 'NARAROUTE_API_KEY',
    keyUrl: 'https://router.bynara.id',
    free: '有 kimi-k3-free 免费模型',
    models: [],
    modelsUrl: 'https://router.bynara.id/v1/models',
    freeModels: ['kimi-k3-free'],
  },
  {
    id: 'orcarouter',
    name: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai/v1',
    format: 'openai-chat',
    env: 'ORCAROUTER_API_KEY',
    keyUrl: 'https://api.orcarouter.ai',
    free: '有 deepseek-v4-flash-free 免费模型',
    models: [],
    modelsUrl: 'https://api.orcarouter.ai/v1/models',
    freeModels: ['deepseek/deepseek-v4-flash-free'],
  },
  {
    id: 'zenmux',
    name: 'ZenMux',
    baseUrl: 'https://zenmux.ai/api/v1',
    format: 'openai-chat',
    env: 'ZENMUX_API_KEY',
    keyUrl: 'https://zenmux.ai',
    free: '有 deepseek-v4-flash-free 免费模型',
    models: [],
    modelsUrl: null,
    freeModels: ['deepseek/deepseek-v4-flash-free'],
  },
  {
    id: 'xkiro',
    name: 'xKiro',
    baseUrl: 'https://api.xkiro.com/v1',
    format: 'openai-chat',
    env: 'XKIRO_API_KEY',
    keyUrl: 'https://api.xkiro.com',
    free: '有 qwen3.7-flash:free 免费模型',
    models: [],
    modelsUrl: null,
    freeModels: ['qwen/qwen3.7-flash:free'],
  },
];

export const BY_ID = new Map(FREE_PROVIDERS.map((p) => [p.id, p]));

/** 本机免账号的那几家（不需要 key）。 */
export const LOCAL_IDS = FREE_PROVIDERS.filter((p) => p.local).map((p) => p.id);

/** 需要 key 的那几家。 */
export const KEYED_IDS = FREE_PROVIDERS.filter((p) => !p.local).map((p) => p.id);

export function providerOf(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * 这条记录的 key 从哪来：环境变量优先，其次网关自己的凭据文件。
 *
 * 顺序是刻意的——环境变量是「这个 shell 里临时用一下」，凭据文件是「长期配置」。
 * 两者都没有时返回 null，调用方据此报「没配 key」而不是拿空串去请求。
 */
export function keyEnvName(provider) {
  return provider?.env ?? null;
}

/** baseUrl 是否还有未替换的占位符。 */
export function needsSubstitution(provider) {
  return Boolean(provider?.baseUrl && provider.baseUrl.includes('{'));
}

/** 解析出实际 baseUrl：环境变量覆盖 > 配置覆盖 > 内置。 */
export function resolveBaseUrl(provider, overrides = {}, env = process.env) {
  if (!provider) return null;
  const override = overrides[provider.id]?.baseUrl;
  if (override) return String(override).replace(/\/+$/, '');
  if (provider.baseUrlEnv && env[provider.baseUrlEnv]) {
    return String(env[provider.baseUrlEnv]).replace(/\/+$/, '');
  }
  return provider.baseUrl;
}
