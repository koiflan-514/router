/**
 * wine-paths.js — 找到 Wine prefix 里各桌面端的 AppData 目录。
 *
 * 背景：灵犀与有道龙虾官方只发 Windows 版，在 Linux 上只能用 Wine 跑。
 * 它们登录后会把凭证写在自己的 Windows 用户目录里：
 *
 *   <prefix>/drive_c/users/<user>/AppData/Roaming/<产品名>/
 *
 * 而反代、router、health 默认只找原生 Linux 路径（~/.config/<产品名>）。
 * 不补这一层，Wine 里登录完了，宿主侧仍然报「未登录」。
 *
 * 零依赖，只用 node: 内建模块；被 4 处共用，避免各写一份慢慢漂移。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

/**
 * 已知的 Wine prefix 位置，按优先级排。
 *
 * - WINEPREFIX 是 Wine 自己的约定，用户显式指定时优先
 * - `~/.local/share/wineprefixes/lingxi` 是 router 给这些 Windows-only 桌面端
 *   建的专用 prefix（不污染默认 prefix，也便于整目录备份）
 * - `~/.local/share/wineprefixes` 下其它 prefix 一并纳入
 * - `~/.wine` 是 wine 命令的默认前缀，放最后
 */
function prefixCandidates() {
  const out = [];
  const explicit = String(process.env.WINEPREFIX || '').trim();
  if (explicit) out.push(explicit);
  out.push(path.join(HOME, '.local/share/wineprefixes/lingxi'));
  try {
    const base = path.join(HOME, '.local/share/wineprefixes');
    for (const name of fs.readdirSync(base)) {
      if (name === 'lingxi') continue;
      out.push(path.join(base, name));
    }
  } catch {}
  out.push(path.join(HOME, '.wine'));
  return out;
}

/** prefix 里所有 Windows 用户目录（通常是单个，但前缀可以带多个）。 */
function userDirs(prefix) {
  const base = path.join(prefix, 'drive_c', 'users');
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'Public')
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.map((n) => path.join(base, n));
}

/**
 * 在 Wine prefix 里找某产品名的目录。
 *
 * 返回 { dir, kind } 数组；kind 标明是 Roaming 还是 Local。
 * 只看 AppData\Roaming 与 AppData\Local 两层，不递归——避免命中缓存里
 * 同名目录（例如某扩展把自己的资源解包到 Local）。
 */
function findAppData(explicitEnv, productNames) {
  const explicit = explicitEnv ? String(process.env[explicitEnv] || '').trim() : '';
  if (explicit) return [{ dir: explicit, kind: 'env' }];

  const wanted = Array.isArray(productNames) ? productNames : [productNames];
  const found = [];
  for (const prefix of prefixCandidates()) {
    for (const userDir of userDirs(prefix)) {
      for (const layer of ['Roaming', 'Local']) {
        for (const name of wanted) {
          const dir = path.join(userDir, 'AppData', layer, name);
          try {
            if (fs.statSync(dir).isDirectory()) {
              // 去重：同一物理目录可能在多个候选清单里出现
              if (!found.some((f) => path.resolve(f.dir) === path.resolve(dir))) {
                found.push({ dir, kind: `wine:${layer}` });
              }
            }
          } catch {}
        }
      }
    }
  }
  return found;
}

/**
 * 宿主原生路径 + Wine 路径合起来，按优先级返回。
 *
 * 原生优先：Wine 只是「官方没发 Linux 包」时的退路，不能反过来抢原生安装。
 * 每一项带 exists，调用方自己决定要文件还是目录。
 */
function candidateDirs({ explicitEnv, nativeDir, productNames }) {
  const out = [{ dir: nativeDir, kind: 'native' }];
  for (const hit of findAppData(explicitEnv, productNames)) out.push(hit);
  return out;
}

/** 第一个真实存在的候选目录；都不存在返回 null。 */
function firstExistingDir(dirs) {
  for (const { dir, kind } of dirs) {
    try {
      if (fs.statSync(dir).isDirectory()) return { dir, kind };
    } catch {}
  }
  return null;
}

module.exports = { prefixCandidates, userDirs, findAppData, candidateDirs, firstExistingDir };