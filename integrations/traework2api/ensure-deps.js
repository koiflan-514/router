#!/usr/bin/env node
/**
 * ensure-deps.js — 检查并补装 pi-ai 所需的 openai 包。
 *
 * 背景：DeepSeek Harness 部署时裁剪了 pi-ai 的部分运行时依赖，
 * openai-completions 协议需要 `openai` SDK，缺失时 trae-local 调用会以
 * PI_AI_ERROR 失败。App 升级会覆盖 node_modules，本脚本用于升级后自愈。
 *
 * 用法: node ensure-deps.js
 * 幂等：已安装且 package.json 可读则直接跳过。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const PI_AI_DIR = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/host/node_modules/@earendil-works/pi-ai';
const TARGET = path.join(PI_AI_DIR, 'node_modules');
const TMP = '/tmp/dsh-ensure-deps';
const tar = '/usr/bin/tar';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dsh-ensure-deps' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function fetchJson(url) {
  const buf = await get(url);
  return JSON.parse(buf.toString('utf8'));
}

async function installPkg(name, version, visited, queue) {
  if (visited.has(name)) return;
  visited.add(name);
  const dir = path.join(TARGET, name);
  const pkgJson = path.join(dir, 'package.json');
  // 已安装且可读 → 跳过（幂等）
  if (fs.existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      if (pkg.name === name) {
        for (const [dep, range] of Object.entries(pkg.dependencies || {})) {
          queue.push([dep, range]);
        }
        console.log('exists', name, pkg.version);
        return;
      }
    } catch (_) { /* 破损，重新安装 */ }
  }
  fs.mkdirSync(TMP, { recursive: true });
  const tarballPath = path.join(TMP, name.replace(/\//g, '_') + '-' + version + '.tgz');
  if (!fs.existsSync(tarballPath)) {
    const info = await fetchJson(`${REGISTRY}/${encodeURIComponent(name)}/${version}`);
    const buf = await get(info.dist.tarball);
    fs.writeFileSync(tarballPath, buf);
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(tar, ['-xzf', tarballPath, '-C', dir, '--strip-components=1']);
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  for (const [dep, range] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) {
    let depVersion = range;
    try {
      const latest = await fetchJson(`${REGISTRY}/${encodeURIComponent(dep)}/latest`);
      depVersion = latest.version;
    } catch (_) { depVersion = range.replace(/[^0-9.]/g, ''); }
    queue.push([dep, depVersion]);
  }
  console.log('installed', name, version);
}

async function main() {
  if (!fs.existsSync(PI_AI_DIR)) {
    console.error('pi-ai 目录不存在: ' + PI_AI_DIR);
    process.exit(1);
  }
  const queue = [['openai', 'latest']];
  const visited = new Set();
  while (queue.length > 0) {
    const [name, version] = queue.shift();
    await installPkg(name, version, visited, queue);
  }
  // 最终校验
  const check = path.join(TARGET, 'openai', 'package.json');
  if (!fs.existsSync(check)) {
    console.error('openai 安装失败');
    process.exit(1);
  }
  const ver = JSON.parse(fs.readFileSync(check, 'utf8')).version;
  console.log('DONE openai@' + ver);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
