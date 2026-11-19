#!/usr/bin/env node
/**
 * opencode-config.js — 把本机反代注册成 opencode 的 provider。
 *
 * 为什么要单独一个模块：Qoder、Trae、WorkBuddy 三家都要往同一份 opencode 配置里
 * 写 provider，各写一份的话必然漂移（这一版就漂了一次：Trae 的配置在测试时被整体
 * 移走，谁也没发现）。收在一处之后，「读—合并—写回—备份」只有一种实现。
 *
 * 关键约束：
 *   - opencode 会合并 opencode.json 与 opencode.jsonc，所以这里只碰 opencode.json
 *   - 只改 provider 里自己那几个键，别的 provider 与顶层设置（model/plugin/agent…）原样保留
 *   - 每次改写前备份，用户能回到上一版
 *   - 反代不校验 key，但 openai-compatible 要求 options.apiKey 非空才发请求
 *
 * 零依赖，只用 node: 内建模块。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  : path.join(HOME, '.config', 'opencode');
const CONFIG_JSON = path.join(CONFIG_DIR, 'opencode.json');

/**
 * opencode 会同时读 opencode.json 与 opencode.jsonc（都按 JSONC 解析）。
 * 本项目只写 .json，但**读**的时候要把两处都看，否则「用户已经在 .jsonc 里配了
 * Trae」这件事就看不见，同步时就会误判成「没配」而去重复添加或错误删除。
 */
function configPaths() {
  const override = process.env.QODBUDDY_OPENCODE_CONFIG;
  if (override) return [override];
  return [CONFIG_JSON, path.join(CONFIG_DIR, 'opencode.jsonc')];
}

/** 家目录之外的写入目标（测试用）。 */
function configPath() {
  return process.env.QODBUDDY_OPENCODE_CONFIG || CONFIG_JSON;
}

/**
 * 宽松解析 JSONC：去掉行注释、块注释与尾逗号。
 *
 * 不引第三方库（本项目零依赖），也刻意不追求完整 JSONC 语义——只要能读懂
 * 用户手写的那种配置就够了。字符串里的 // 与 ,} 会误伤，所以扫描时要跟踪字符串状态。
 */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // 整段字符串原样拷贝，内部的 // 与 /* 不是注释
      out += ch;
      i += 1;
      while (i < n) {
        const c = text[i];
        out += c;
        i += 1;
        if (c === '\\') {
          if (i < n) {
            out += text[i];
            i += 1;
          }
          continue;
        }
        if (c === '"') break;
        if (c === '\n') break; // 未闭合字符串：收尾，交给 JSON.parse 报错
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // 尾逗号：,} 与 ,] 都去掉
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 读某个文件里的 provider 键集合；不存在或解析失败返回空集合。 */
function providerIdsIn(file) {
  try {
    const cfg = JSON.parse(parseJsonc(fs.readFileSync(file, 'utf8')));
    return new Set(Object.keys((cfg && cfg.provider) || {}));
  } catch {
    return new Set();
  }
}

/**
 * 在所有 opencode 配置文件里找某个 provider。返回 { found, files }。
 *
 * 用来回答「用户到底配没配这一家」——只看 .json 会漏掉 .jsonc 里的。
 */
function locateProvider(id) {
  const files = [];
  for (const file of configPaths()) {
    if (fs.existsSync(file) && providerIdsIn(file).has(id)) files.push(file);
  }
  return { found: files.length > 0, files };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * OpenAI 的 /v1/models 条目 → opencode 的 provider.models 条目。
 *
 * 吃两种形状：本项目的 qoder-proxy（{id, name, limit:{context,output}, capabilities}）
 * 与 WorkBuddy 反代（{id, display_name, context_window}）。
 */
function toOpencodeModel(entry, { defaultContext = 1000000, defaultOutput = 131072 } = {}) {
  const limit = entry.limit || {};
  const context = limit.context || entry.context_window || entry.context_length || defaultContext;
  const output = limit.output || entry.max_output_tokens || defaultOutput;
  const model = {
    name: entry.name || entry.display_name || entry.id,
    limit: { context, output },
  };
  // 让 opencode 知道这个模型能读图、会思考，界面上才会给对应开关
  if (entry.capabilities) {
    model.reasoning = !!entry.capabilities.reasoning;
    model.attachment = !!entry.capabilities.vision;
  } else if (entry.supports_reasoning_summary_parameter !== undefined || entry.default_reasoning_level) {
    model.reasoning = true;
  }
  // 默认支持工具调用；但有些上游（如 WPS 灵犀的 agent）不吐 OpenAI tool_calls，
  // 显式标 false 时如实告知 opencode，免得它把这类模型当编码 agent 驱动。
  const noTools = entry.tool_call === false || (entry.capabilities && entry.capabilities.tool_call === false);
  model.tool_call = !noTools;
  return model;
}

function toOpencodeModels(entries, opts) {
  const out = {};
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    out[entry.id] = toOpencodeModel(entry, opts);
  }
  return out;
}

/**
 * 合并写入。providers 是一组 {id, name, baseURL, apiKey, models, npm?}。
 *
 * 返回 { written, path, added, skipped }。写失败会抛（调用方要能看见）。
 */
function mergeProviders(providers, { dryRun = false } = {}) {
  const file = configPath();
  const existing = readJson(file) || {};
  const cfg = { ...existing };
  if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
  cfg.provider = { ...(existing.provider || {}) };

  const added = [];
  const skipped = [];
  for (const p of providers) {
    if (!p || !p.id) continue;
    if (!p.models || Object.keys(p.models).length === 0) {
      skipped.push({ id: p.id, reason: p.reason || '没有模型可写' });
      continue;
    }
    cfg.provider[p.id] = {
      // opencode 2.x 内部把它归一成 aisdk:@ai-sdk/openai-compatible，两种写法都认
      npm: p.npm || '@ai-sdk/openai-compatible',
      name: p.name || p.id,
      options: {
        baseURL: p.baseURL,
        // 本机反代不校验，但这一项为空时 openai-compatible 不发请求
        apiKey: p.apiKey || 'local-proxy',
      },
      models: p.models,
    };
    added.push({ id: p.id, name: p.name || p.id, models: Object.keys(p.models).length });
  }

  if (dryRun) return { written: false, path: file, added, skipped, config: cfg };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${stamp()}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { written: true, path: file, backup, added, skipped };
}

/**
 * 从配置里移除指定 provider。返回 { removed, path }。
 *
 * 与 mergeProviders 成对使用：停掉某个转接时，opencode 里也不该再留着指向死端口的
 * provider，否则模型选择器里会出现一堆点了就报错的条目。
 */
/**
 * 从配置里移除指定 provider。
 *
 * 只写 opencode.json（本项目的目标文件），**不写 opencode.jsonc**：
 *   - .jsonc 通常是用户手写的，带注释；用 JSON 写回会把注释全丢掉
 *   - 而且用户可能在 .jsonc 里精心调过某些字段，程序重排会破坏它
 *
 * 如果目标 provider 只在 .jsonc 里，本函数不会删它，而是把它报在
 * `onlyInJsonc` 里，由调用方提示用户自己处理。
 */
function removeProviders(ids, { dryRun = false } = {}) {
  const target = configPath();
  const removed = [];
  const onlyInJsonc = [];
  let backup = null;

  // 先看 .jsonc 里有没有——那些我们不能动
  const jsonc = path.join(CONFIG_DIR, 'opencode.jsonc');
  const jsoncIds = fs.existsSync(jsonc) ? providerIdsIn(jsonc) : new Set();

  if (fs.existsSync(target)) {
    let cfg = null;
    try {
      cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      cfg = null;
    }
    if (cfg && cfg.provider) {
      for (const id of ids) {
        if (cfg.provider[id]) {
          delete cfg.provider[id];
          removed.push(id);
        } else if (jsoncIds.has(id)) {
          onlyInJsonc.push(id);
        }
      }
      if (removed.length && !dryRun) {
        backup = `${target}.bak-${stamp()}`;
        fs.copyFileSync(target, backup);
        fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}
`);
      }
    }
  }

  // .json 里没有、但 .jsonc 里有的，也记下来让调用方提示
  for (const id of ids) {
    if (!removed.includes(id) && jsoncIds.has(id) && !onlyInJsonc.includes(id)) {
      onlyInJsonc.push(id);
    }
  }

  return {
    removed,
    onlyInJsonc,
    written: !dryRun && removed.length > 0,
    backup,
    path: target,
  };
}

/**
 * 读回某个 provider 的模型数；没配置过返回 null。
 *
 * 先在写入目标（.json）里找，再在 .jsonc 里找——Trae 就只在 .jsonc 里。
 */
function providerModelCount(id) {
  for (const file of configPaths()) {
    try {
      const cfg = JSON.parse(parseJsonc(fs.readFileSync(file, 'utf8')));
      const p = cfg && cfg.provider && cfg.provider[id];
      if (p && p.models) return Object.keys(p.models).length;
    } catch {
      // 试下一个文件
    }
  }
  return null;
}

/** 列出所有 opencode 配置文件里注册了哪些 provider（.json 与 .jsonc 取并集）。 */
function listProviders() {
  const ids = new Set();
  for (const file of configPaths()) {
    if (!fs.existsSync(file)) continue;
    for (const id of providerIdsIn(file)) ids.add(id);
  }
  return [...ids];
}

/** 从本机反代拉 /v1/models。失败返回 null（不抛）。 */
async function fetchProxyModels(baseURL, { headers = {}, timeout = 6000, shape = 'auto' } = {}) {
  try {
    const res = await fetch(`${String(baseURL).replace(/\/v1\/?$/, '')}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.models)) return data.models;
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  CONFIG_DIR,
  CONFIG_JSON,
  configPath,
  configPaths,
  parseJsonc,
  locateProvider,
  listProviders,
  readJson,
  mergeProviders,
  removeProviders,
  providerModelCount,
  toOpencodeModel,
  toOpencodeModels,
  fetchProxyModels,
};
