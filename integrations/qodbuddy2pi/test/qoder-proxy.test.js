#!/usr/bin/env node
/**
 * qoder-proxy.test.js — 代理里那些能离线验证的部分。
 *
 * 代理的核心难点是协议翻译（OpenAI ⇄ Qoder 的 COSY 网关）。这些纯函数出错时
 * 不会在开发机上显形：只有真发请求才会看到 403 / 500 / 工具调用断掉，而每一次
 * 试错都要烧一点额度。所以把能离线钉住的都钉在这里。
 *
 * 不测的部分：真实 HTTP 往返、凭证续期（要真凭证）、流式时序（要真网关）。
 *
 * 跑法：node --test test/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const proxy = require(path.join(__dirname, '..', 'assets', 'qoder-proxy.js'));

// ---------------------------------------------------------------- body 编码

/**
 * 编码是「base64 → 三段轮转 → 换字母表」。验证方式是把它与 pi 扩展里那份
 * 独立实现的输出对齐：两边对同一份输入必须得到同一串字节，否则同一份凭证
 * 在 pi 与 opencode 上会表现不一致。
 */
test('encodeQoderBody: 长度不变（轮转只换顺序不增删）', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'hello world', 'x'.repeat(300)]) {
    const out = proxy.encodeQoderBody(Buffer.from(text));
    const expectedLen = Buffer.from(text).toString('base64').length;
    assert.strictEqual(out.length, expectedLen, `输入 ${text.length} 字节时长度不对`);
  }
});

test('encodeQoderBody: 短输入（长度 < 3）不越界', () => {
  // 长度 1、2 时 floor(n/3) 是 0，三段轮转退化成整段；这里最容易写出越界
  assert.doesNotThrow(() => proxy.encodeQoderBody(Buffer.from('a')));
  assert.doesNotThrow(() => proxy.encodeQoderBody(Buffer.from('ab')));
  assert.strictEqual(proxy.encodeQoderBody(Buffer.from('a')).length, 4);
});

test('encodeQoderBody: base64 的 = 被换成 $（否则网关解出乱码）', () => {
  // 'ab' 只有 2 字节，base64 是 'YWI='，带一个 padding
  const out = proxy.encodeQoderBody(Buffer.from('ab')).toString();
  assert.ok(out.includes('$'), `应含 $，实际是 ${out}`);
  assert.ok(!out.includes('='), `不该再有 =，实际是 ${out}`);
});

test('encodeQoderBody: 同样的输入得到同样的输出（确定性）', () => {
  const a = proxy.encodeQoderBody(Buffer.from('stable payload')).toString();
  const b = proxy.encodeQoderBody(Buffer.from('stable payload')).toString();
  assert.strictEqual(a, b);
});

test('encodeQoderBody: 不同输入得到不同输出', () => {
  const a = proxy.encodeQoderBody(Buffer.from('one')).toString();
  const b = proxy.encodeQoderBody(Buffer.from('two')).toString();
  assert.notStrictEqual(a, b);
});

// ---------------------------------------------------------------- 签名路径

test('computeSigPath: 去掉 /algo 前缀', () => {
  assert.strictEqual(
    proxy.computeSigPath('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1'),
    '/api/v2/model/list',
  );
});

test('computeSigPath: 没有 /algo 时保留原 path', () => {
  assert.strictEqual(
    proxy.computeSigPath('https://openapi.qoder.com.cn/api/v1/userinfo'),
    '/api/v1/userinfo',
  );
});

test('computeSigPath: 只有 /algo 时得到空串', () => {
  assert.strictEqual(proxy.computeSigPath('https://gateway.qoder.com.cn/algo'), '');
});

// ---------------------------------------------------------------- 请求头

test('buildAuthHeaders: 缺 userID 或 token 时明确报错（而不是发一个必 403 的请求）', () => {
  assert.throws(() => proxy.buildAuthHeaders(null, 'https://x/algo/y', { authToken: 't' }), /user id/);
  assert.throws(() => proxy.buildAuthHeaders(null, 'https://x/algo/y', { userID: 'u' }), /auth token/);
});

test('buildAuthHeaders: 该有的头一个不少', () => {
  const h = proxy.buildAuthHeaders(Buffer.from('{}'), 'https://gateway.qoder.com.cn/algo/api/v2/model/list', {
    userID: 'u1',
    authToken: 'tok',
    name: 'n',
    email: 'e',
    machineID: 'm1',
  });
  for (const key of [
    'Authorization',
    'Cosy-Key',
    'Cosy-User',
    'Cosy-Date',
    'Cosy-Version',
    'Cosy-Machineid',
    'Cosy-Bodyhash',
    'Cosy-Bodylength',
    'Cosy-Sigpath',
    'X-Request-Id',
  ]) {
    assert.ok(h[key], `缺少请求头 ${key}`);
  }
  assert.match(h.Authorization, /^Bearer COSY\./);
  assert.strictEqual(h['Cosy-Sigpath'], '/api/v2/model/list');
  assert.strictEqual(h['Cosy-Bodylength'], '2');
});

test('buildAuthHeaders: body 参与签名，所以换 body 必须换签名', () => {
  const base = { userID: 'u1', authToken: 'tok', machineID: 'm1' };
  const url = 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation';
  const a = proxy.buildAuthHeaders(Buffer.from('{"a":1}'), url, base);
  const b = proxy.buildAuthHeaders(Buffer.from('{"a":2}'), url, base);
  // Authorization 里塞了 payload 与签名；两者任一不同就说明 body 参与了签名
  assert.notStrictEqual(a.Authorization, b.Authorization);
  assert.notStrictEqual(a['Cosy-Bodyhash'], b['Cosy-Bodyhash']);
});

// ---------------------------------------------------------------- 消息转换

test('toQoderMessages: system 抽出来放在最前面（Qoder 忽略顶层 system 字段）', () => {
  const out = proxy.toQoderMessages([
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'be terse' },
  ]);
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[0].content, 'be terse');
  assert.strictEqual(out[1].role, 'user');
});

test('toQoderMessages: developer 角色也当 system 处理', () => {
  const out = proxy.toQoderMessages([{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }]);
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[0].content, 'rules');
});

test('toQoderMessages: 多个 system 合并，且不会挤掉对话', () => {
  const out = proxy.toQoderMessages([
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].content, 'a\n\nb');
});

test('toQoderMessages: assistant 的 tool_calls 保留（否则多轮工具调用会断）', () => {
  const out = proxy.toQoderMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
  ]);
  assert.strictEqual(out[0].role, 'assistant');
  assert.strictEqual(out[0].tool_calls.length, 1);
  assert.strictEqual(out[0].tool_calls[0].id, 'c1');
  assert.strictEqual(out[0].tool_calls[0].function.name, 'read');
  // content 空但有工具调用时给一个空格，否则网关会认为这一轮没有内容
  assert.strictEqual(out[0].content, ' ');
  assert.strictEqual(out[1].role, 'tool');
  assert.strictEqual(out[1].tool_call_id, 'c1');
});

test('toQoderMessages: 工具调用的 arguments 是对象时序列化成字符串', () => {
  const out = proxy.toQoderMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: { a: 1 } } }] },
  ]);
  assert.strictEqual(out[0].tool_calls[0].function.arguments, '{"a":1}');
});

test('toQoderMessages: 图片内容原样保留（Qoder 支持 VL）', () => {
  const out = proxy.toQoderMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    },
  ]);
  assert.strictEqual(out[0].content.length, 2);
  assert.strictEqual(out[0].content[1].type, 'image_url');
});

test('toQoderMessages: 空数组不炸，非法条目被跳过', () => {
  assert.deepStrictEqual(proxy.toQoderMessages([]), []);
  assert.deepStrictEqual(proxy.toQoderMessages(null), []);
  assert.deepStrictEqual(proxy.toQoderMessages([{ role: 'user' }, null, {}]), [{ role: 'user', content: '' }]);
});

test('toQoderTools: OpenAI 的 function 工具 → Qoder 的形态', () => {
  const out = proxy.toQoderTools([
    {
      type: 'function',
      function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
    },
  ]);
  assert.strictEqual(out[0].type, 'function');
  assert.strictEqual(out[0].function.name, 'read');
  assert.strictEqual(out[0].function.parameters.type, 'object');
});

test('toQoderTools: 没有参数定义时给一个合法的空 schema', () => {
  const out = proxy.toQoderTools([{ type: 'function', function: { name: 'noargs' } }]);
  assert.deepStrictEqual(out[0].function.parameters, { type: 'object', properties: {} });
});

test('toQoderTools: 非函数工具被过滤，空输入返回空数组', () => {
  assert.deepStrictEqual(proxy.toQoderTools([{ type: 'web_search' }]), []);
  assert.deepStrictEqual(proxy.toQoderTools([]), []);
  assert.deepStrictEqual(proxy.toQoderTools(undefined), []);
});

// ---------------------------------------------------------------- 思考开关

test('resolveThinking: 显式关闭时不发 effort', () => {
  const model = { reasoning: true, efforts: ['low'], defaultThinking: true };
  assert.deepStrictEqual(proxy.resolveThinking(model, { enable_thinking: false }), { enable: false, effort: null });
  assert.deepStrictEqual(proxy.resolveThinking(model, { reasoning_effort: 'none' }), { enable: false, effort: null });
});

test('resolveThinking: effort 只在该模型支持时才下发', () => {
  const model = { reasoning: true, efforts: ['low', 'high'], defaultThinking: true };
  assert.deepStrictEqual(proxy.resolveThinking(model, { reasoning_effort: 'high' }), { enable: true, effort: 'high' });
  // 不在白名单里就不发，让网关用它自己的默认值
  assert.deepStrictEqual(proxy.resolveThinking(model, { reasoning_effort: 'max' }), { enable: true, effort: null });
});

test('resolveThinking: 非思考模型即使用户要求也不开', () => {
  const model = { reasoning: false, thinkingSupported: false, efforts: [] };
  assert.deepStrictEqual(proxy.resolveThinking(model, { reasoning_effort: 'high' }), { enable: false, effort: null });
});

test('resolveThinking: 什么都没给时跟随模型的默认', () => {
  assert.deepStrictEqual(
    proxy.resolveThinking({ reasoning: true, efforts: [], defaultThinking: true }, {}),
    { enable: true, effort: null },
  );
  assert.deepStrictEqual(
    proxy.resolveThinking({ reasoning: false, efforts: [], defaultThinking: false }, {}),
    { enable: false, effort: null },
  );
});

// ---------------------------------------------------------------- 请求体

test('buildQoderRequest: max_tokens 被夹到上限内', () => {
  const model = { id: 'm', key: 'k', reasoning: false, efforts: [] };
  const req = proxy.buildQoderRequest({
    body: { max_tokens: 999999999 },
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });
  assert.ok(req.parameters.max_tokens <= 131072, 'max_tokens 没被夹住');
});

test('buildQoderRequest: 小一点的 max_tokens 原样保留', () => {
  const model = { id: 'm', key: 'k', reasoning: false, efforts: [] };
  const req = proxy.buildQoderRequest({
    body: { max_tokens: 512 },
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });
  assert.strictEqual(req.parameters.max_tokens, 512);
});

test('buildQoderRequest: 带上网关要求的那些字段', () => {
  const model = { id: 'm', key: 'k', reasoning: false, efforts: [] };
  const req = proxy.buildQoderRequest({
    body: {},
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });
  for (const key of ['request_id', 'session_id', 'chat_record_id', 'messages', 'parameters', 'business', 'chat_context']) {
    assert.ok(req[key], `请求体缺少 ${key}`);
  }
  assert.strictEqual(req.stream, true, '网关只支持流式，这里必须置 true');
  assert.strictEqual(req.model_config.key, 'k');
  assert.strictEqual(req.chat_context.extra.modelConfig.key, 'k');
});

test('buildQoderRequest: 同一段对话前缀得到同一个 chat_record_id（命中缓存）', () => {
  const model = { id: 'm', key: 'k', reasoning: false, efforts: [] };
  const messages = [{ role: 'user', content: 'same' }];
  const a = proxy.buildQoderRequest({ body: {}, model, messages, tools: [] });
  const b = proxy.buildQoderRequest({ body: {}, model, messages, tools: [] });
  assert.strictEqual(a.chat_record_id, b.chat_record_id);
});

test('buildQoderRequest: 换了对话内容 chat_record_id 就变', () => {
  const model = { id: 'm', key: 'k', reasoning: false, efforts: [] };
  const a = proxy.buildQoderRequest({ body: {}, model, messages: [{ role: 'user', content: 'a' }], tools: [] });
  const b = proxy.buildQoderRequest({ body: {}, model, messages: [{ role: 'user', content: 'b' }], tools: [] });
  assert.notStrictEqual(a.chat_record_id, b.chat_record_id);
});

// ---------------------------------------------------------------- SSE 解析

test('parseQoderSseLine: 拆掉外层信封，只留内层 chunk', () => {
  const line = `data:${JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    statusCodeValue: 200,
  })}`;
  const parsed = proxy.parseQoderSseLine(line);
  assert.ok(parsed.chunk);
  assert.strictEqual(parsed.chunk.choices[0].delta.content, 'hi');
});

test('parseQoderSseLine: [DONE] 在内外两层都能认', () => {
  assert.deepStrictEqual(proxy.parseQoderSseLine('data: [DONE]'), { done: true });
  const inner = `data:${JSON.stringify({ body: '[DONE]', statusCodeValue: 200 })}`;
  assert.deepStrictEqual(proxy.parseQoderSseLine(inner), { done: true });
});

test('parseQoderSseLine: 非 200 的上游状态变成错误（而不是空回复）', () => {
  const line = `data:${JSON.stringify({ statusCodeValue: 500, body: 'boom' })}`;
  const parsed = proxy.parseQoderSseLine(line);
  assert.match(parsed.error, /500/);
});

test('parseQoderSseLine: 非 data 行、空行、坏 JSON 都返回 null（不中断流）', () => {
  assert.strictEqual(proxy.parseQoderSseLine('event:finish'), null);
  assert.strictEqual(proxy.parseQoderSseLine(''), null);
  assert.strictEqual(proxy.parseQoderSseLine('data: {bad json'), null);
  assert.strictEqual(proxy.parseQoderSseLine('data:'), null);
});

// ---------------------------------------------------------------- 思考标签剥离

test('ThinkingTagSplitter: 把 <thinking> 内容分到 thinking 一路', () => {
  const s = new proxy.ThinkingTagSplitter();
  const a = s.push('<thinking>reason</thinking>answer');
  assert.strictEqual(a.thinking, 'reason');
  assert.strictEqual(a.text, 'answer');
});

test('ThinkingTagSplitter: 跨块时先扣住半个标签（否则用户会看到 "<thi"）', () => {
  const s = new proxy.ThinkingTagSplitter();
  const a = s.push('<thi');
  assert.strictEqual(a.text, '', '半个标签不该被当成正文发出去');
  const b = s.push('nking>abc</thinking>done');
  assert.strictEqual(b.thinking, 'abc');
  assert.strictEqual(b.text, 'done');
});

test('ThinkingTagSplitter: 多种标签写法都认', () => {
  for (const open of ['<thinking>', '<think>', '<reasoning>', '<thought>']) {
    const close = `</${open.slice(1)}`;
    const s = new proxy.ThinkingTagSplitter();
    const out = s.push(`${open}x${close}ok`);
    assert.strictEqual(out.thinking, 'x', `${open} 没被识别`);
    assert.strictEqual(out.text, 'ok');
  }
});

test('ThinkingTagSplitter: 没有标签时全是正文', () => {
  const s = new proxy.ThinkingTagSplitter();
  assert.strictEqual(s.push('plain text').text, 'plain text');
});

test('ThinkingTagSplitter: flush 吐出被扣住的半个结束标签', () => {
  const s = new proxy.ThinkingTagSplitter();
  s.push('<thinking>abc</thi');
  // 'abc' 已经随 push 发出去了，缓冲区里只剩被扣住的 '</thi'
  const out = s.flush();
  assert.strictEqual(out.thinking, '</thi');
  assert.strictEqual(s.buffer, '', 'flush 之后缓冲区应清空');
});

test('ThinkingTagSplitter: 标签后的空行被吃掉（否则正文开头会多空行）', () => {
  const s = new proxy.ThinkingTagSplitter();
  const out = s.push('<thinking>x</thinking>\n\ntext');
  assert.strictEqual(out.text, 'text');
});

// ---------------------------------------------------------------- 模型目录

test('modelIdFromDisplay: 去掉空白，与 pi 侧的 id 一致', () => {
  assert.strictEqual(proxy.modelIdFromDisplay('Qwen3.8 Max'), 'Qwen3.8Max');
  assert.strictEqual(proxy.modelIdFromDisplay('GLM-5.3'), 'GLM-5.3');
  // 只有空白时与 pi 的实现一致：剥完就是空串（调用方靠 enable/display_name 先过滤）
  assert.strictEqual(proxy.modelIdFromDisplay('  '), '');
  assert.strictEqual(proxy.modelIdFromDisplay(undefined), 'QoderModel');
});

test('normalizeCatalogEntry: 目录条目 → 内部模型描述', () => {
  const m = proxy.normalizeCatalogEntry({
    key: 'qmodel',
    display_name: 'Qwen3.8-Max',
    enable: true,
    is_reasoning: true,
    is_vl: true,
    context_config: { '1M': { token_count: 1000000 }, '200K': { token_count: 200000 } },
    thinking_config: { enabled: { efforts: { low: {}, high: {} } }, disabled: {} },
  });
  assert.strictEqual(m.id, 'Qwen3.8-Max');
  assert.strictEqual(m.key, 'qmodel');
  assert.strictEqual(m.contextWindow, 1000000, '取目录里最大的上下文档位');
  assert.strictEqual(m.reasoning, true);
  assert.deepStrictEqual(m.efforts, ['low', 'high']);
});

test('normalizeCatalogEntry: 关掉的、缺字段的条目被丢掉', () => {
  assert.strictEqual(proxy.normalizeCatalogEntry({ key: 'x', display_name: 'X', enable: false }), null);
  assert.strictEqual(proxy.normalizeCatalogEntry({ key: 'x', enable: true }), null);
  assert.strictEqual(proxy.normalizeCatalogEntry(null), null);
});

test('normalizeCatalogEntry: 没有 context_config 时用默认上下文', () => {
  const m = proxy.normalizeCatalogEntry({ key: 'k', display_name: 'X', enable: true });
  assert.strictEqual(m.contextWindow, 1000000);
});

test('openAiModelEntry: 带上 opencode 要读的 limit 与 capabilities', () => {
  const entry = proxy.openAiModelEntry({
    id: 'X',
    name: 'X',
    contextWindow: 1000000,
    maxTokens: 131072,
    vision: true,
    reasoning: true,
  });
  assert.strictEqual(entry.object, 'model');
  assert.deepStrictEqual(entry.limit, { context: 1000000, output: 131072 });
  assert.deepStrictEqual(entry.capabilities, { vision: true, reasoning: true });
});

test('FALLBACK_MODELS: 两个区域都有兜底表，且 id 不重复', () => {
  for (const key of ['cn', 'global']) {
    const models = proxy.FALLBACK_MODELS[key];
    assert.ok(models.length > 0, `${key} 的兜底表是空的`);
    const ids = models.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${key} 的兜底表里有重复 id`);
    for (const m of models) assert.ok(m.key, `${m.id} 缺少上游 key`);
  }
});

// ---------------------------------------------------------------- 区域

test('两个区域都指向 Qoder 自己的网关与 openapi', () => {
  assert.strictEqual(proxy.REGIONS.cn.provider, 'qoder-cn');
  assert.strictEqual(proxy.REGIONS.global.provider, 'qoder');
  assert.match(proxy.REGIONS.cn.baseUrl, /qoder\.com\.cn/);
  assert.match(proxy.REGIONS.global.baseUrl, /qoder\.sh/);
});

test('区域别名与 pi 的 provider 名对得上', () => {
  assert.strictEqual(proxy.REGION_ALIASES['qoder-cn'], 'cn');
  assert.strictEqual(proxy.REGION_ALIASES.qoder, 'global');
  assert.strictEqual(proxy.REGION_ALIASES.cn, 'cn');
});

// ---------------------------------------------------------------- 排队限流识别

/**
 * 免费账号并发受限时，上游返回 HTTP 403 + 业务码 10605 + isQueued。
 * 这**不是权限问题**：等 retryAfterSeconds 重试就能成功。
 *
 * 早期实现把它当普通 403 透给客户端，后果是：
 *   - 流式：立刻断连，客户端只看到「上游 403」
 *   - 非流式：等整条流读完才判断，排队时上游不吐字节 → 客户端 60 秒后静默超时
 *     （表现为 curl 返回 000 / 连接被重置，用户完全不知道发生了什么）
 * 所以这里钉住「识别成 429 + 可重试 + 带 retryAfter」。
 */
test('upstreamError: 排队（10605/isQueued）识别成 429 且可重试', () => {
  const body = JSON.stringify({
    code: '403',
    message: JSON.stringify({ code: '10605', isQueued: true, retryAfterSeconds: 30, serviceAvailable: false }),
  });
  const info = proxy.upstreamError(403, body);
  assert.strictEqual(info.status, 429, '排队应给 429（客户端会据此重试）');
  assert.strictEqual(info.retryable, true);
  assert.strictEqual(info.retryAfter, 30, '应照抄上游的 retryAfterSeconds');
  assert.match(info.message, /排队/);
  assert.match(info.message, /不是权限问题/, '必须说清楚，否则用户会去改配置');
});

test('upstreamError: 没有 retryAfterSeconds 时给一个默认等待时间', () => {
  const info = proxy.upstreamError(403, JSON.stringify({ code: '10605', isQueued: true }));
  assert.strictEqual(info.status, 429);
  assert.strictEqual(info.retryAfter, 30, '缺省 30 秒');
});

test('upstreamError: 真正的 403（Request discarded）保持 403 且不可重试', () => {
  const info = proxy.upstreamError(403, 'Request discarded');
  assert.strictEqual(info.status, 403);
  assert.strictEqual(info.retryable, false, '签名/格式错误重试没用');
});

test('upstreamError: 500 保持 500 且不可重试', () => {
  const info = proxy.upstreamError(500, '{"success":false,"msgInfo":"Internal Server Error"}');
  assert.strictEqual(info.status, 500);
  assert.strictEqual(info.retryable, false);
  assert.match(info.message, /Internal Server Error/);
});

test('parseQoderSseLine: 信封里的排队错误也识别成 429', () => {
  // 关键点：HTTP 状态是 200，错误藏在信封的 statusCodeValue 里。
  // 只看 response.ok 是发现不了的。
  const line = `data:${JSON.stringify({
    statusCodeValue: 403,
    body: JSON.stringify({ code: '403', message: JSON.stringify({ code: '10605', isQueued: true }) }),
  })}`;
  const parsed = proxy.parseQoderSseLine(line);
  assert.ok(parsed.error, '应报错而不是当成空回复');
  assert.strictEqual(parsed.businessStatus, 429);
  assert.strictEqual(parsed.retryable, true);
});
