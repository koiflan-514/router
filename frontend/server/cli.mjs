/**
 * 子进程封装：只对 `router.mjs`、`scripts/health.mjs` 与 `opencode` 发起调用。
 *
 * 硬性约束（07 §5）：一律**参数数组** spawn，显式 `shell: false`，
 * 可执行文件与脚本路径写死在代码里，绝不从 UI 或后端字符串构造路径。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ERROR_HTTP_STATUS = {
  BACKEND_UNAVAILABLE: 503,
  CONTRACT_INVALID: 502,
  UNSUPPORTED_VERSION: 409,
  ACTION_FAILED: 500,
  READ_ONLY: 403,
  DEMO_FORBIDDEN: 403,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
};

const RETRYABLE = new Set(['BACKEND_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT']);

/** 桥接层统一错误；由 index.mjs 转成 envelope 的错误结构。 */
export class BridgeError extends Error {
  constructor(code, message, { provider, retryable, http } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.provider = provider;
    this.retryable = retryable ?? RETRYABLE.has(code);
    this.http = http ?? ERROR_HTTP_STATUS[code] ?? 500;
  }

  toError() {
    const err = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.provider) err.provider = this.provider;
    return err;
  }
}

export function unavailable(message, extra = {}) {
  return new BridgeError('BACKEND_UNAVAILABLE', message, extra);
}

/** OpenCode CLI 程序解析：ROUTER_OPENCODE > Windows 官方 opencode.exe > PATH。 */
export function resolveOpencode(env = process.env) {
  const explicit = String(env.ROUTER_OPENCODE || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32' && env.APPDATA) {
    const candidate = path.join(
      env.APPDATA,
      'npm',
      'node_modules',
      '@opencode',
      'cli',
      'bin',
      'opencode.exe',
    );
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 用 PATH */
    }
  }
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

/**
 * @param {object} options
 * @param {string} options.root        router 仓库根（含 router.mjs）
 * @param {string} [options.nodeBin]   Node 可执行名/路径
 * @param {string} [options.opencode]  OpenCode CLI 程序
 * @param {number} [options.timeout]   只读默认超时
 */
export function createCli({ root, nodeBin = 'node', opencode, timeout = 15000 } = {}) {
  const routerMjs = path.join(root, 'router.mjs');
  const healthScript = path.join(root, 'scripts', 'health.mjs');
  const opencodeBin = opencode || resolveOpencode();

  function hasRouter() {
    try {
      return fs.statSync(routerMjs).isFile();
    } catch {
      return false;
    }
  }

  function hasHealth() {
    try {
      return fs.statSync(healthScript).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 参数数组 spawn 的通用实现。
   * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:Error|null, durationMs:number}>}
   */
  function run(program, args, { timeoutMs = timeout, killSignal = 'SIGTERM' } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let child;
      try {
        child = spawn(program, args, {
          cwd: root,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err, durationMs: 0 });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const MAX = 1024 * 1024;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill(killSignal);
              } catch {
                /* 已经退出 */
              }
            }, timeoutMs)
          : null;
      if (timer && typeof timer.unref === 'function') timer.unref();

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ...payload, timedOut, durationMs: Date.now() - startedAt });
      };

      child.stdout?.on('data', (buf) => {
        if (stdout.length < MAX) stdout += buf.toString('utf8');
      });
      child.stderr?.on('data', (buf) => {
        if (stderr.length < MAX) stderr += buf.toString('utf8');
      });
      child.on('error', (err) => finish({ code: null, stdout, stderr, spawnError: err }));
      child.on('close', (code) => finish({ code, stdout, stderr, spawnError: null }));
    });
  }

  return {
    root,
    nodeBin,
    routerMjs,
    healthScript,
    opencodeBin,
    hasRouter,
    hasHealth,

    hasOpencode() {
      if (opencode) return true;
      // 只判断可发现性：PATH 上的命令不额外探测，交给 spawn 的 ENOENT。
      return true;
    },

    /** `node router.mjs <args>` */
    runRouter(args, opts = {}) {
      if (!hasRouter()) {
        return Promise.resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: unavailable(`找不到 router.mjs（${root}）`),
          durationMs: 0,
        });
      }
      return run(nodeBin, [routerMjs, ...args], opts);
    },

    /** `node scripts/health.mjs <args>` */
    runHealth(args, opts = {}) {
      if (!hasHealth()) {
        return Promise.resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: unavailable(`找不到 scripts/health.mjs（${root}）`),
          durationMs: 0,
        });
      }
      return run(nodeBin, [healthScript, ...args], opts);
    },

    /** `opencode <args>`（只读用量统计） */
    runOpencode(args, opts = {}) {
      return run(opencodeBin, args, { timeoutMs: 90000, ...opts });
    },

    /** 供写任务流式读取的裸 spawn（仍然参数数组、shell:false）。 */
    spawnRaw(program, args) {
      return spawn(program, args, {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  };
}
