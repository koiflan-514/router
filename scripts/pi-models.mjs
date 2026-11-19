#!/usr/bin/env node
/**
 * pi-models.mjs — 把 router 的全部上游写进 pi 的 `~/.pi/agent/models.json`。
 *
 * router.mjs 管 opencode.json（`router sync`），pi 侧靠这个脚本 + 网关/免费供应商
 * 那两个入口。三处共用 `scripts/lib/pi-sync.mjs` 落盘（写前备份、内容没变就不写）。
 *
 * 覆盖三层：
 *   1. 本机八家反代（trae-local / codearts / zcode / loomy / raccoon / qwenwork / dumate / lingxi）
 *      从各自 `/v1/models` 拉实时清单，连同鉴权 key 与 compat 一起写；
 *   2. `router-gateway`：一个 baseURL（:8785），模型名 `<供应商>/<模型>` + combo 虚拟模型；
 *   3. 免费供应商（18 家里有 key / 本机免账号的那些）：每家一个直连 provider。
 *
 *   node scripts/pi-models.mjs              # 全部（只写当前能连上 / 配好 key 的）
 *   node scripts/pi-models.mjs trae-local   # 只写一家本机反代
 *   node scripts/pi-models.mjs gateway      # 只写统一网关
 *   node scripts/pi-models.mjs free         # 只写免费供应商
 *   node scripts/pi-models.mjs openrouter   # 只写某家免费供应商
 *   node scripts/pi-models.mjs --dry-run    # 只打印，不落盘
 *
 * 四家不写进 models.json，交给 pi 扩展：
 *   `qoder` / `qoder-cn` → 扩展 pi-provider-qoder 直连（auth.json 里的 OAuth
 *     凭据优先于 models.json 的 apiKey，写了反而会报 “No API key found for qoder”）。
 *   `workbuddy` / `workbuddy-global` → 扩展 workbuddy.ts。
 *     反代的 /v1/models 是包作者猜的静态表，服务端会回 11102 service info not
 *     found；扩展读的是桌面端落盘的产品配置，那份才是真实可用集。
 * 剩下 `trae-local`、`codearts`、`zcode`、`loomy`、`raccoon`、`qwenwork`、`dumate`、`lingxi` 没有扩展，
 * 才走本脚本。
 *
 * 只读各家的 `/v1/models`，只写 pi 的 models.json（写前备份到 models.backups/）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PI_MODELS_FILE,
  mergePiProviders,
  gatewayPiProvider,
  gatewayCombos,
  freePiProviders,
} from './lib/pi-sync.mjs';
import { FREE_PROVIDERS } from '../gateway/free-providers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TRAE_ENV = path.join(ROOT, 'integrations', 'traework2api', '.env.local');
const CODEARTS_DATA = path.join(ROOT, 'integrations', 'codearts2api', 'codearts2api-data.json');

const C = {
  ok: '\x1b[1;32m✓\x1b[0m',
  bad: '\x1b[1;31m✗\x1b[0m',
  warn: '\x1b[1;33m!',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};
const say = (...a) => console.log(...a);

/** Trae 反代随包发了个随机 Bearer key，只在本机用。 */
function traeKey() {
  try {
    const txt = fs.readFileSync(TRAE_ENV, 'utf8');
    const line = txt.split(/\r?\n/).find((l) => l.startsWith('TW2A_API_KEY='));
    const v = line ? line.slice('TW2A_API_KEY='.length).trim() : '';
    return v && v !== 'changeme' ? v : null;
  } catch {
    return null;
  }
}

/** CodeArts 签发的 `sk-ca-...`，取第一个启用的。 */
function codeartsKey() {
  try {
    const data = JSON.parse(fs.readFileSync(CODEARTS_DATA, 'utf8'));
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const hit = keys.find((k) => k && k.enabled !== false && typeof k.key === 'string' && k.key.startsWith('sk-ca-'));
    return hit ? hit.key : null;
  } catch {
    return null;
  }
}

/**
 * 各家的接入参数。`apiKey` 是 pi 侧要带的 Bearer：
 * Qoder 代理不校验入站 key，WorkBuddy 反代也只当占位；Trae/CodeArts 真校验。
 */
function sources() {
  return [
    {
      id: 'qoder-cn',
      port: 8789,
      name: 'Qoder 国内版',
      apiKey: 'qoder-local',
      map: mapQoder,
      // pi 走扩展直连，不走反代（见文件头注释）
      nativeExtension: 'pi-provider-qoder',
    },
    {
      id: 'qoder',
      port: 8790,
      name: 'Qoder 国际版',
      apiKey: 'qoder-local',
      map: mapQoder,
      nativeExtension: 'pi-provider-qoder',
    },
    {
      id: 'trae-local',
      port: 7863,
      name: 'Trae',
      apiKey: traeKey(),
      map: mapTrae,
      // Trae 的 /v1/models 把内部子代理也列出来了（summary、*_subagent 之类），
      // 这些不是聊天模型，选中就报错。按 id 形状剔掉。
      skip: (id) => /^custom_model|_(sub)?agent(_v\d)?$|^summary$|^computer_use|^browser_use|^file_search/.test(id),
    },
    {
      id: 'codearts',
      port: 10087,
      name: 'CodeArts Agent（华为云）',
      apiKey: codeartsKey(),
      map: mapCodeArts,
      // CodeArts 上游不认 OpenAI 的 developer 角色（docs/02-pitfalls.md P18）
      compat: { supportsDeveloperRole: false },
    },
    {
      id: 'workbuddy',
      port: 8787,
      name: 'WorkBuddy 国内版',
      apiKey: 'workbuddy-local',
      map: mapWorkBuddy,
      // 模型表只能来自扩展（扩展读桌面端落盘的产品配置）；反代 /v1/models 是猜的
      nativeExtension: 'workbuddy.ts',
    },
    {
      id: 'workbuddy-global',
      port: 8788,
      name: 'WorkBuddy 国际版',
      apiKey: 'workbuddy-local',
      map: mapWorkBuddy,
      nativeExtension: 'workbuddy.ts',
    },
    {
      id: 'zcode',
      port: 20131,
      name: 'ZCode（Z.ai）',
      apiKey: 'zcode-local',
      map: mapZcode,
    },
    {
      id: 'loomy',
      port: 8791,
      name: 'Loomy（讯飞）',
      // 反代不校验入站 key，但 pi 的 OpenAI 兼容层要求非空
      apiKey: 'loomy-local',
      map: mapLoomy,
      // 上游 /models 也列生图模型；这些不能走 chat/completions
      modelsPath: '/models?type=chat',
    },
    {
      id: 'raccoon',
      port: 8793,
      name: '商汤小浣熊',
      // 反代不校验入站 key，但 pi 的 OpenAI 兼容层要求非空
      apiKey: 'raccoon-local',
      map: mapRaccoon,
    },
    {
      id: 'qwenwork',
      port: 8794,
      name: '千问办公',
      apiKey: 'qwenwork-local',
      map: mapQwenwork,
    },
    {
      id: 'dumate',
      port: 8795,
      name: '百度搭子',
      // 反代不校验入站 key，但 pi 的 OpenAI 兼容层要求非空
      apiKey: 'dumate-local',
      map: mapDumate,
    },
    {
      id: 'lingxi',
      port: 8796,
      name: 'WPS 灵犀',
      // 反代不校验入站 key，但 pi 的 OpenAI 兼容层要求非空
      apiKey: 'lingxi-local',
      map: mapLingxi,
    },
  ];
}

function modelEntry(id, name, extra) {
  const m = { id };
  if (name && name !== id) m.name = name;
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined && v !== null && !(typeof v === 'number' && v <= 0)) m[k] = v;
  }
  return m;
}

const POSITIVE = (n) => (Number.isFinite(n) && n > 0 ? n : undefined);

function mapQoder(raw) {
  const caps = raw.capabilities || {};
  const limit = raw.limit || {};
  const input = ['text'];
  if (caps.vision) input.push('image');
  return modelEntry(raw.id, raw.name || raw.id, {
    input,
    reasoning: caps.reasoning === true ? true : undefined,
    contextWindow: POSITIVE(limit.context),
    maxTokens: POSITIVE(limit.output),
  });
}

function mapWorkBuddy(raw) {
  const id = raw.id || raw.slug;
  const mods = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
  const input = ['text'];
  if (mods.includes('image')) input.push('image');
  const ctx = POSITIVE(raw.context_window);
  const out = POSITIVE(raw.max_context_window);
  return modelEntry(id, raw.display_name || id, {
    input,
    contextWindow: ctx,
    // 反代把输出上限放在 max_context_window 里（比 context_window 小才是输出）
    maxTokens: out && ctx && out < ctx ? out : undefined,
  });
}

function mapCodeArts(raw) {
  const meta = raw.codearts || {};
  return modelEntry(raw.id, meta.name || raw.id, {
    contextWindow: POSITIVE(meta.context),
    maxTokens: POSITIVE(meta.max_output),
  });
}

function mapTrae(raw) {
  return modelEntry(raw.id, raw.id, {
    contextWindow: POSITIVE(raw.context_length),
  });
}

/**
 * zcode-bridge 的 /v1/models 是标准 OpenAI 形状，只带 id；
 * 上下文长度它不返回，交给 pi 的默认值。
 */
function mapZcode(raw) {
  return modelEntry(raw.id || raw.slug, raw.id || raw.slug, {});
}

/** Loomy 的 /models 是扩展 OpenAI 形状：context_length / max_output_tokens / capabilities。 */
function mapLoomy(raw) {
  const caps = raw.capabilities || {};
  const input = Array.isArray(caps.input_modalities) ? caps.input_modalities : ['text'];
  // pi 的 models.json schema 目前只接受 text / image；audio / video 会让整份配置校验失败。
  const modalities = [...new Set(['text', ...input.filter((m) => m === 'image')])];
  return modelEntry(raw.id, raw.name || raw.id, {
    input: modalities,
    reasoning: caps.reasoning === true ? true : undefined,
    contextWindow: POSITIVE(raw.context_length),
    maxTokens: POSITIVE(raw.max_output_tokens),
  });
}

/**
 * 千问办公的 /v1/models 与上面的扩展形状一致（context_window / max_output_tokens /
 * capabilities），另外带 `promotion`（限时折扣标签）。
 */
function mapQwenwork(raw) {
  const caps = raw.capabilities || {};
  const input = ['text'];
  if (caps.vision === true) input.push('image');
  return modelEntry(raw.id, raw.name || raw.id, {
    input,
    reasoning: caps.reasoning === true ? true : undefined,
    contextWindow: POSITIVE(raw.context_window),
    maxTokens: POSITIVE(raw.max_output_tokens),
  });
}

/**
 * 百度搭子的 /v1/models 与 Loomy 同形状：
 * context_length / max_output_tokens / capabilities{vision,input_modalities}。
 * 代理已经滤掉内部模型，并且只保留 text/image 两种输入模态。
 */
function mapDumate(raw) {
  return mapLoomy(raw);
}

/**
 * 小浣熊的 /v1/models 是 OpenAI 形状加一组扩展字段：
 * context_window / max_output_tokens / capabilities{vision,reasoning}。
 * 它自己的模型名（Raccoon-Work、GLM-5-3…）比 id 好认，优先用 name。
 */
function mapRaccoon(raw) {
  const caps = raw.capabilities || {};
  const input = ['text'];
  if (caps.vision === true) input.push('image');
  return modelEntry(raw.id, raw.name || raw.id, {
    input,
    reasoning: caps.reasoning === true ? true : undefined,
    contextWindow: POSITIVE(raw.context_window),
    maxTokens: POSITIVE(raw.max_output_tokens),
  });
}

/**
 * WPS 灵犀的 /v1/models 是 OpenAI 形状加扩展字段：
 * context_window / max_output_tokens / capabilities{vision,reasoning,tool_call}。
 * 注意：灵犀是完整 agent，不吐 OpenAI tool_calls（tool_call:false）。pi 的
 * models.json schema 没有工具能力位，这里只写标准字段；拿它当对话模型用，
 * 不要选它驱动编码 agent（见 integrations/lingxi2api/README.md）。
 */
function mapLingxi(raw) {
  const caps = raw.capabilities || {};
  const input = ['text'];
  if (caps.vision === true) input.push('image');
  return modelEntry(raw.id, raw.name || raw.id, {
    input,
    reasoning: caps.reasoning === true ? true : undefined,
    contextWindow: POSITIVE(raw.context_window),
    maxTokens: POSITIVE(raw.max_output_tokens),
  });
}

async function fetchModels(src, timeout = 8000) {
  const headers = src.apiKey ? { Authorization: `Bearer ${src.apiKey}` } : {};
  try {
    const res = await fetch(`http://127.0.0.1:${src.port}/v1${src.modelsPath || '/models'}`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, hint: res.status === 401 ? '缺少鉴权 key' : null };
    const j = await res.json();
    const arr = Array.isArray(j) ? j : j.data || j.models || [];
    return arr.length ? { models: arr } : { error: '模型清单为空' };
  } catch (e) {
    return { error: e.code || e.message, hint: '反代没起？node router.mjs up' };
  }
}


async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const wanted = argv.filter((a) => !a.startsWith('--'));
  const freeIds = FREE_PROVIDERS.map((p) => p.id);

  const local = sources();
  let picked = local;
  let wantGateway = true;
  let wantFree = true;
  let freeWanted = null;

  if (wanted.length) {
    picked = [];
    wantGateway = false;
    wantFree = false;
    freeWanted = [];
    const unknown = [];
    for (const arg of wanted) {
      if (arg === 'gateway' || arg === 'router-gateway') {
        wantGateway = true;
        continue;
      }
      if (arg === 'free' || arg === 'providers') {
        wantFree = true;
        continue;
      }
      const hits = local.filter((s) => s.id === arg || s.id.startsWith(arg));
      if (hits.length) {
        picked.push(...hits);
        continue;
      }
      const freeHits = freeIds.filter((id) => id === arg || id.startsWith(arg));
      if (freeHits.length) {
        freeWanted.push(...freeHits);
        continue;
      }
      unknown.push(arg);
    }
    if (unknown.length) {
      say(`${C.bad} 未知供应商：${unknown.join('、')}`);
      say(`${C.dim}  可选：${local.map((s) => s.id).join('、')}、gateway、free、${freeIds.join('、')}${C.reset}`);
      process.exit(1);
    }
  }

  const providers = [];
  const failed = [];

  for (const src of picked) {
    if (src.nativeExtension && !wanted.includes(src.id)) {
      say(`${C.dim}· ${src.name} ${src.id} 跳过：pi 由扩展 ${src.nativeExtension} 直连${C.reset}`);
      continue;
    }
    if (src.nativeExtension) {
      say(`${C.warn} ${src.id} 有扩展 ${src.nativeExtension} 在管，写进 models.json 会和 auth.json 里的 OAuth 凭据冲突${C.reset}`);
      failed.push({ src, error: '跳过（会让 pi 报 No API key found）' });
      continue;
    }
    const got = await fetchModels(src);
    if (got.error) {
      failed.push({ src, ...got });
      continue;
    }
    const models = got.models
      .map((raw) => ({ raw, id: raw.id || raw.slug }))
      .filter(({ id }) => id && !(src.skip && src.skip(id)))
      .map(({ raw }) => src.map(raw));

    const provider = {
      baseUrl: `http://127.0.0.1:${src.port}/v1`,
      name: src.name,
      api: 'openai-completions',
      ...(src.compat ? { compat: src.compat } : {}),
      models,
    };
    if (src.apiKey) provider.apiKey = src.apiKey;
    providers.push({ id: src.id, ...provider });
    say(`${C.ok} ${src.name} ${C.dim}${src.id}${C.reset} ${models.length} 个模型 → ${provider.baseUrl}`);
  }

  if (wantGateway) {
    const combos = await gatewayCombos();
    const provider = await gatewayPiProvider({ combos });
    if (!provider.models.length) {
      failed.push({ src: { name: '统一网关', id: 'router-gateway' }, error: '十二家与免费供应商都没在跑' });
    } else {
      providers.push(provider);
      const note = combos.length ? `，含 ${combos.length} 条 combo` : '';
      say(`${C.ok} 统一网关 ${C.dim}${provider.id}${C.reset} ${provider.models.length} 个模型${note} → ${provider.baseUrl}`);
    }
  }

  if (wantFree || (freeWanted && freeWanted.length)) {
    const ids = freeWanted && freeWanted.length ? freeWanted : undefined;
    const { providers: free, skipped } = await freePiProviders({ ids });
    for (const p of free) {
      providers.push(p);
      say(`${C.ok} ${p.name} ${C.dim}${p.id}${C.reset} ${p.models.length} 个模型 → ${p.baseUrl}`);
    }
    for (const s of skipped) failed.push({ src: { name: s.id, id: s.id }, error: s.reason });
  }

  for (const f of failed) {
    say(`${C.warn} ${f.src.name} ${C.dim}${f.src.id}${C.reset} 跳过：${f.error}${f.hint ? `（${f.hint}）` : ''}`);
  }

  if (!providers.length) {
    say(`${C.bad} 一家都没写成，models.json 保持原样`);
    process.exit(1);
  }

  if (dryRun) {
    say(`${C.dim}--dry-run：没有写文件（将写 ${providers.map((p) => p.id).join('、')}）${C.reset}`);
    return;
  }

  const result = mergePiProviders(providers);
  if (!result.added.length) {
    say(`${C.dim}${PI_MODELS_FILE} 已是最新（${providers.length} 个 provider 内容没变）${C.reset}`);
  } else {
    say(`${C.ok} 已写 ${PI_MODELS_FILE}${C.dim}（改动 ${result.added.map((a) => `${a.id}:${a.models}`).join('、')}）${C.reset}`);
  }
  if (result.backup) say(`${C.dim}备份：${result.backup}${C.reset}`);
}

main().catch((e) => {
  say(`${C.bad} ${e.stack || e.message}`);
  process.exit(1);
});
