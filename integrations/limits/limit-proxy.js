#!/usr/bin/env node
/**
 * limit-proxy.js — 给不带本机限流器的反代加一层透明前置代理。
 *
 * 用于 WorkBuddy / ZCode 这类第三方进程：对客户端仍暴露原端口，真正的反代
 * 挪到内部端口；所有对话请求先过 integrations/limits/limiter.js，再原样转发。
 * 并发位一直占到响应流结束，避免「响应头一到就释放」的假限流。
 *
 * 用法：
 *   node limit-proxy.js --provider workbuddy --listen 8787 --upstream 18787
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const { createLimiterFor, LimiterBusy } = require('./limiter.js');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const provider = arg('--provider', process.env.LIMIT_PROVIDER);
const listenPort = Number(arg('--listen', process.env.LIMIT_LISTEN));
const upstreamPort = Number(arg('--upstream', process.env.LIMIT_UPSTREAM));
const host = arg('--host', '127.0.0.1');
const upstreamHost = arg('--upstream-host', '127.0.0.1');

if (!provider || !Number.isInteger(listenPort) || !Number.isInteger(upstreamPort)) {
  console.error('用法：node limit-proxy.js --provider <id> --listen <port> --upstream <port>');
  process.exit(2);
}
if (listenPort === upstreamPort) {
  console.error('listen 与 upstream 不能是同一个端口');
  process.exit(2);
}

const enabled = String(process.env[`${provider.toUpperCase().replace(/-/g, '_')}_LIMITS`] || '').toLowerCase() !== 'off';
const limiter = enabled ? createLimiterFor(provider) : null;

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 模型与积分查询不占对话执行位；其它 /v1 写请求都可能是推理。 */
function needsLimit(req, pathname) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method || '')) return false;
  if (/^\/(?:v1\/)?(?:models|quota|credits|health|checkin)\/?$/.test(pathname)) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const pathname = String(req.url || '/').split('?', 1)[0].replace(/\/+$/, '') || '/';
  if ((pathname === '/health' || pathname === '/v1/health') && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'limit-proxy',
      provider,
      upstream: `http://${upstreamHost}:${upstreamPort}`,
      limits: limiter ? limiter.snapshot() : null,
    });
  }
  let release = null;

  if (limiter && needsLimit(req, pathname)) {
    try {
      release = await limiter.acquire({ maxWaitMs: 5000 });
    } catch (err) {
      if (err instanceof LimiterBusy) {
        const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
        return sendJson(
          res,
          429,
          {
            error: {
              message: `本地限流：${seconds} 秒后重试（${limiter.limits.rpm}/分钟，并发 ${limiter.limits.concurrency}）`,
              type: `${provider.replace(/-/g, '_')}_rate_limited`,
              code: 429,
            },
          },
          { 'Retry-After': String(seconds) },
        );
      }
      throw err;
    }
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    if (release) release();
  };
  res.on('finish', releaseOnce);
  res.on('close', releaseOnce);

  const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `限流代理上游连接失败：${err.message}`, type: 'limit_proxy_upstream', code: 502 },
      });
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
    releaseOnce();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;
server.on('error', (err) => {
  console.error(`[limit-proxy:${provider}] ${err.message}`);
  process.exit(1);
});
server.listen(listenPort, host, () => {
  console.log(
    `[limit-proxy:${provider}] http://${host}:${listenPort} → http://${upstreamHost}:${upstreamPort} ` +
      (limiter ? `并发 ${limiter.limits.concurrency}、${limiter.limits.rpm}/分钟、间隔 ${limiter.limits.minIntervalMs}ms` : '已关闭'),
  );
});
