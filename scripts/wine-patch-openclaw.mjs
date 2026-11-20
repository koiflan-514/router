#!/usr/bin/env node
/**
 * wine-patch-openclaw.mjs — 给「有道龙虾」的 openclaw 网关打一个 Wine 兼容补丁。
 *
 * 背景（实测复现）：
 *   Wine 对 SQLite WAL 的 `-shm` 文件做 chmod 必返回 EBUSY（共享内存已被 mmap）。
 *   openclaw 在启动流程里「打开数据库 → chmod 0600」这一步没有吞异常，
 *   于是网关起不来：
 *
 *     Config health-state write failed: EBUSY ... openclaw.sqlite-shm
 *     [openclaw] Could not start the CLI. Reason: EBUSY ...
 *
 * 为什么不能只设 `NODE_OPTIONS=--require`：
 *   龙虾用 Electron 的 `ELECTRON_RUN_AS_NODE` 模式跑网关，而 Electron **忽略**
 *   `NODE_OPTIONS`（实测 process.execArgv 里没有 --require）。
 *   又因为 ESM 的具名导入在「链接时」就固定了函数引用，运行起来之后改
 *   `fs.chmod` 也不生效（实测无效）。
 *
 * 做法：把原 bundle 改名为 `gateway-bundle.impl.mjs`，再用一个极小的 wrapper
 * 顶替 `gateway-bundle.mjs`。wrapper 先打补丁，再**动态 import** 真正的 bundle——
 * 动态 import 发生在补丁之后，新模块链接时拿到的就是打过补丁的函数。
 *
 * 安全性：只吞 EBUSY，且只影响权限位设置（Wine 下权限位本就不生效）。
 *
 * 用法：node scripts/wine-patch-openclaw.mjs [prefix] [--force]
 *   --force  刷新已有 wrapper（改了 wrapper 逻辑后重跑用）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX =
  process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) ||
  path.join(os.homedir(), '.local/share/wineprefixes/lingxi');
const FORCE = process.argv.includes('--force');
const BUNDLE = path.join(
  PREFIX,
  'drive_c/users',
  os.userInfo().username,
  'AppData/Local/Programs/LobsterAI/resources/cfmind/gateway-bundle.mjs',
);

const MARK = '/* wine-chmod-shim wrapper */';
const IMPL = BUNDLE.replace(/\.mjs$/, '.impl.mjs');

const WRAPPER = `${MARK}
// 由 router 的 scripts/wine-patch-openclaw.mjs 生成。
// 作用：Wine 下 SQLite -shm 的 chmod 必返回 EBUSY，这里把它降级为无操作。
import { createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
const __req = createRequire(import.meta.url);
const __fs = __req('node:fs');
const __fsp = __req('node:fs/promises');

function __wrap(target, name, isSync) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = isSync
    ? function (p, mode, ...rest) {
        try {
          return orig.call(this, p, mode, ...rest);
        } catch (err) {
          if (err && err.code === 'EBUSY') return undefined;
          throw err;
        }
      }
    : async function (p, mode, ...rest) {
        try {
          return await orig.call(this, p, mode, ...rest);
        } catch (err) {
          if (err && err.code === 'EBUSY') return undefined;
          throw err;
        }
      };
}

for (const n of ['chmod', 'chmodSync', 'lchmod', 'lchmodSync', 'fchmod', 'fchmodSync']) {
  __wrap(__fs, n, true);
}
for (const n of ['chmod', 'lchmod']) {
  __wrap(__fsp, n, false);
}

// 原 bundle 用 argv[1] / import.meta.url 判断自己是不是主入口。launcher 在
// import 前把 argv[1] 设成了 gateway-bundle.mjs（本 wrapper），所以这里要把
// argv[1] 指回 impl，否则模块能加载成功、但 CLI 主体不会启动。
const __implUrl = new URL('./gateway-bundle.impl.mjs', import.meta.url);
process.argv[1] = __fileURLToPath(__implUrl);
await import(__implUrl.href);
`;

if (!fs.existsSync(BUNDLE)) {
  console.error(`找不到 openclaw bundle：\n  ${BUNDLE}`);
  console.error('先把有道龙虾装好（跑一次安装器）。');
  process.exit(1);
}

const head = fs.readFileSync(BUNDLE, 'utf8').slice(0, 200);
if (head.includes(MARK)) {
  if (!FORCE) {
    console.log('已经是打过补丁的 wrapper，跳过（要刷新 wrapper 就加 --force）。');
    process.exit(0);
  }
  fs.writeFileSync(BUNDLE, WRAPPER, 'utf8');
  console.log('已用 --force 刷新 wrapper。');
  process.exit(0);
}

if (fs.existsSync(IMPL)) {
  console.log(`已存在 ${path.basename(IMPL)}，说明原 bundle 已改名（wrapper 被还原了？）。`);
  if (!FORCE) {
    console.log('要重打：加 --force，或删掉 impl 后重跑本脚本。');
    process.exit(0);
  }
  fs.writeFileSync(BUNDLE, WRAPPER, 'utf8');
  console.log('已用 --force 重新写回 wrapper。');
  process.exit(0);
}

fs.renameSync(BUNDLE, IMPL);
fs.writeFileSync(BUNDLE, WRAPPER, 'utf8');

console.log(`已打补丁：`);
console.log(`  原 bundle → ${path.basename(IMPL)}`);
console.log(`  新入口   → ${path.basename(BUNDLE)}（先打 chmod 补丁再 import 原 bundle）`);
console.log(`\n重装龙虾会覆盖这个补丁，重跑一次本脚本即可。`);