#!/usr/bin/env node
/**
 * 开发编排：同时拉起 `node server/index.mjs --dev` 与 `vite`，转发输出，Ctrl+C 一起退出。
 *
 * 桥接以 `--dev` 启动：回环免 token，Vite 的 `/api` 代理（changeOrigin:false）可直接打通。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(__dirname, 'index.mjs');
const VITE_BIN = path.join(FRONTEND_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const passthrough = process.argv.slice(2);
const children = [];
let exiting = false;

function prefixStream(stream, label, color) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    process.stdout.write(`${color}[${label}]\x1b[0m ${line}\n`);
  });
}

function launch(label, program, args, color) {
  const child = spawn(program, args, {
    cwd: FRONTEND_ROOT,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child._label = label;
  children.push(child);
  child.stdout?.on('data', (buf) => process.stdout.write(`${color}[${label}]\x1b[0m ${buf.toString('utf8')}`));
  child.stderr?.on('data', (buf) => process.stderr.write(`${color}[${label}]\x1b[0m ${buf.toString('utf8')}`));
  child.on('error', (err) => {
    process.stderr.write(`${color}[${label}]\x1b[0m 启动失败：${err.message}\n`);
    shutdown(1);
  });
  child.on('close', (code) => {
    if (exiting) return;
    process.stderr.write(`${color}[${label}]\x1b[0m 已退出（code=${code}），停止其它进程。\n`);
    shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] 启动桥接（--dev）与 Vite…');
launch('bridge', process.execPath, [INDEX, '--dev', ...passthrough], '\x1b[36m');

if (fs.existsSync(VITE_BIN)) {
  launch('vite', process.execPath, [VITE_BIN], '\x1b[35m');
} else {
  process.stderr.write('[dev] 未找到本地 vite（node_modules/vite）。请先 npm install；仅启动桥接。\n');
}
