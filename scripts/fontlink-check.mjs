#!/usr/bin/env node
/**
 * check-fontlink.mjs — 校验 Wine 的字体链接引用的文件是否都真的在。
 *
 * 为什么需要这一步：Wine 的 system.reg 里预置了 FontLink\SystemLink，
 * 里面写着「Segoe UI 找不到字时回退到 MSYH.TTC / SIMSUN.TTC」。
 * 如果那些文件不存在，回退链就断在半路——中文直接显示成方框，
 * 而且**注册表看起来完全正常**，很难查。
 *
 * 用法：node check-fontlink.mjs [wine prefix 路径]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX =
  process.argv[2] || path.join(os.homedir(), '.local/share/wineprefixes/lingxi');
const REG = path.join(PREFIX, 'system.reg');
const FONT_DIR = path.join(PREFIX, 'drive_c', 'windows', 'Fonts');

const text = fs.readFileSync(REG, 'utf8');
const have = new Set(
  fs.readdirSync(FONT_DIR).map((f) => f.toLowerCase()),
);

// 抓 str(7) 里的 "FILE.TTF,Family" 组合，\0 分隔
const refs = new Map(); // file -> Set(families)
for (const m of text.matchAll(/str\(7\):"([^"]+)"/g)) {
  for (const item of m[1].split('\\0')) {
    const [file, ...rest] = item.split(',');
    if (!file || !/\.(ttf|ttc|otf|fon)$/i.test(file.trim())) continue;
    const key = file.trim().toLowerCase();
    if (!refs.has(key)) refs.set(key, new Set());
    if (rest.length) refs.get(key).add(rest.join(',').trim());
  }
}

const missing = [];
const present = [];
for (const [file, families] of [...refs].sort()) {
  (have.has(file) ? present : missing).push({ file, families: [...families] });
}

console.log(`FontLink 引用 ${refs.size} 个字体文件`);
console.log(`  已存在 ${present.length}`);
console.log(`  缺失   ${missing.length}`);

if (missing.length) {
  console.log('\n缺失的文件（中文回退链会断在这里）：');
  for (const { file, families } of missing) {
    console.log(`  ${file}  ← ${families.join(' / ') || '(无族名)'}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n所有回退字体都在，中文显示不会因缺文件变方框。');
}
