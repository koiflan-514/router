#!/usr/bin/env node
/**
 * img-proxy.js — Trae 通道图片自动识别转换代理（零依赖）
 *
 * 位置：tw2api(7864) 之前，监听 7863。
 * 作用：请求里如果有 OpenAI 格式的 image_url（data:image/...;base64），
 *       自动用云端千问（百炼 qwen3-vl）识别成文字，替换后转发 tw2api。
 *       纯文本请求直接透传，零延迟。
 *
 * 环境变量：
 *   UPSTREAM  默认 http://127.0.0.1:7864（tw2api）
 *   LISTEN    默认 127.0.0.1:7863
 *   DASHSCOPE_API_KEY / BAILIAN_MODEL 从 ~/.config/see/config.env 读取（可被环境变量覆盖）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:7864';
const LISTEN = process.env.LISTEN || '127.0.0.1:7863';

// 读取 see 配置（百炼 key + 视觉模型）
function loadSeeConfig() {
  const cfg = {};
  const p = path.join(os.homedir(), '.config', 'see', 'config.env');
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {}
  return cfg;
}
const SEE = loadSeeConfig();
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || SEE.DASHSCOPE_API_KEY || '';
const VISION_MODEL = process.env.BAILIAN_MODEL || SEE.BAILIAN_MODEL || 'qwen3-vl-flash';

/** 调百炼 qwen3-vl 识别图片（OpenAI 兼容）；失败返回 null 由调用方降级 */
function recognizeImage(base64Data, mimeType) {
  return new Promise((resolve) => {
    const payload = {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64Data}` } },
          { type: 'text', text: '请详细描述这张图片的全部内容：包括所有可见的文字（务必完整准确地转录）、物体、场景、布局、颜色和关键信息。用中文回答。' },
        ],
      }],
      max_tokens: 1024,
    };
    const body = JSON.stringify(payload);
    const req = https.request('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.choices && j.choices[0] && j.choices[0].message) {
            resolve(String(j.choices[0].message.content || '').trim());
          } else {
            console.error('[img-proxy] qwen 识别失败: ' + data.slice(0, 200));
            resolve(null);
          }
        } catch (e) { console.error('[img-proxy] qwen 解析失败: ' + data.slice(0, 200)); resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[img-proxy] qwen 请求失败: ' + e.message); resolve(null); });
    req.setTimeout(90000, () => { req.destroy(new Error('qwen timeout')); resolve(null); });
    req.end(body);
  });
}

/** 限流：最多 3 个识别请求并发 */
const recognizeQueue = (() => {
  let active = 0;
  const waiters = [];
  function acquire() {
    if (active < 3) { active++; return Promise.resolve(); }
    return new Promise((r) => waiters.push(r));
  }
  function release() {
    active--;
    const w = waiters.shift();
    if (w) { active++; w(); }
  }
  return async (fn) => {
    await acquire();
    try { return await fn(); } finally { release(); }
  };
})();

/** 递归扫描 content，把 image_url 块换成识别后的 text 块（多图顺序识别，单图失败降级为占位符） */
async function rewriteContent(content) {
  if (Array.isArray(content)) {
    const out = [];
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'image_url') {
        const url = (block.image_url && block.image_url.url) || '';
        const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
        if (m) {
          const kb = Math.round((m[2].length * 3) / 4 / 1024);
          console.log(`[img-proxy] 识别图片 ${m[1]} ${kb}KB ...`);
          const text = await recognizeQueue(() => recognizeImage(m[2], m[1]));
          if (text) {
            out.push({ type: 'text', text: `[用户上传的图片（${m[1]}，${kb}KB），已用云端视觉模型识别]\n${text}` });
          } else {
            out.push({ type: 'text', text: `[用户上传的图片附件（${m[1]}，${kb}KB），识别失败，请提示用户重新发送或提供文字描述]` });
          }
          continue;
        }
        out.push(block);
      } else if (block && typeof block === 'object' && Array.isArray(block.content)) {
        out.push(Object.assign({}, block, { content: await rewriteContent(block.content) }));
      } else {
        out.push(block);
      }
    }
    return out;
  }
  return content;
}

function proxyRequest(method, pathName, headers, body, res) {
  const u = new URL(UPSTREAM + pathName);
  const transport = u.protocol === 'https:' ? https : http;
  const req = transport.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers: {
    ...(headers.authorization ? { authorization: headers.authorization } : {}),
    ...(headers['content-type'] ? { 'content-type': headers['content-type'] } : {}),
    ...(body !== null && body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
  } }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  req.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream error: ' + e.message, type: 'api_error' } }));
  });
  if (body) req.write(body);
  req.end();
}

const server = http.createServer(async (req, res) => {
  const pathName = req.url || '/';
  if (req.method === 'POST' && pathName.startsWith('/v1/chat/completions')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 6e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        let rewritten = false;
        if (Array.isArray(body.messages)) {
          for (const m of body.messages) {
            if (m && m.content && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image_url')) {
              m.content = await rewriteContent(m.content);
              rewritten = true;
            }
          }
        }
        if (rewritten) {
          raw = JSON.stringify(body);
          console.log('[img-proxy] 图片已转文字，转发上游');
        }
        proxyRequest(req.method, pathName, req.headers, raw, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'img-proxy: ' + e.message, type: 'api_error' } }));
      }
    });
    return;
  }
  // 其他请求（/v1/models 等）直接透传
  proxyRequest(req.method, pathName, req.headers, null, res);
});

server.listen(parseInt(LISTEN.split(':')[1], 10), LISTEN.split(':')[0], () => {
  console.log(`img-proxy listening on http://${LISTEN} → ${UPSTREAM} (vision=${VISION_MODEL}${DASHSCOPE_KEY ? '' : ' MISSING KEY'})`);
});
