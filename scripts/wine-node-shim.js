/**
 * wine-node-shim.js — 在 Wine 下运行 Windows 版 Node 应用时预加载的补丁。
 *
 * 解决的问题（实测复现）：
 *   Wine 对「SQLite WAL 的 -shm 共享内存文件」调用 chmod 时，必定返回
 *   `EBUSY: resource busy or locked`。而 Node 在 Windows 上把 fs.chmod 映射到
 *   SetFileAttributes，Wine 再映射到 chmod(2)，对已 mmap 的文件就报 EBUSY。
 *
 *   影响：像 openclaw 这类「打开数据库 → 收紧权限（chmod 0600）」的应用会在
 *   启动阶段直接失败：
 *     Config health-state write failed: EBUSY ... chmod '...openclaw.sqlite-shm'
 *     Could not start the CLI. Reason: EBUSY ...
 *
 * 为什么可以安全地忽略：
 *   - 它只影响权限位。Wine 下的 mode 位本来就不真正生效（实测 chmod 0600 之后
 *     仍是 0666），所以这步在这个环境里是「形式主义」；
 *   - 只吞 EBUSY，其余错误（ENOENT/EACCES/EPERM…）照常抛，不会掩盖真实故障。
 *
 * 用法（由 scripts/wine-run-app.sh 自动设置）：
 *   NODE_OPTIONS="--require C:\router-shims\wine-node-shim.js"
 *
 * 注意必须用 `--require` 预加载：ESM 的具名导入（`import { chmodSync } from
 * 'node:fs'`）在模块链接时取函数引用，跑起来之后再改就来不及了。
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');

function swallowSync(name, target) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function patched(p, mode, ...rest) {
    try {
      return orig.call(this, p, mode, ...rest);
    } catch (err) {
      if (err && err.code === 'EBUSY') return undefined;
      throw err;
    }
  };
}

function swallowAsync(name, target) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = async function patched(p, mode, ...rest) {
    try {
      return await orig.call(this, p, mode, ...rest);
    } catch (err) {
      if (err && err.code === 'EBUSY') return undefined;
      throw err;
    }
  };
}

for (const n of ['chmod', 'chmodSync', 'lchmod', 'lchmodSync', 'fchmod', 'fchmodSync']) {
  swallowSync(n, fs);
}
for (const n of ['chmod', 'lchmod']) {
  swallowAsync(n, fsp);
}