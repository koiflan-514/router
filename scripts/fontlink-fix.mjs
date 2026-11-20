#!/usr/bin/env node
/**
 * fix-fontlink.mjs — 把 FontLink 里指向「本机没有的字体文件」的条目改指向 Noto CJK。
 *
 * 背景：Wine 预置的 FontLink\SystemLink 是按 Windows 完整安装写的，会引用
 * BATANG.TTC（韩）、MEIRYO.TTC / MEIRYOB.TTC（日）、MSMINCHO.TTC（日）。
 * 这些在 Windows Server 上默认就没装，于是「回退链」走到这几条就断了：
 * 中文字体本身没问题，但日韩文（以及某些把日文字体挂在链首的应用）会显示方框。
 *
 * 做法：把每条 `文件,族名` 换成 Noto 对应字重。只改 system.reg，不改逻辑，
 * 改前备份；wineserver 必须先停，否则改动会被内存里的注册表覆盖回去。
 *
 * 用法：node fix-fontlink.mjs [wine prefix 路径]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX =
  process.argv[2] || path.join(os.homedir(), '.local/share/wineprefixes/lingxi');
const REG = path.join(PREFIX, 'system.reg');

/** 缺失文件 → 用它顶上。族名要跟 Noto 真实声明的对上（大小写不敏感）。 */
const REPLACEMENTS = [
  { file: 'BATANG.TTC', family: 'Batang', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK KR'] },
  { file: 'BATANG.TTC', family: 'BatangChe', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK KR'] },
  { file: 'MEIRYO.TTC', family: 'Meiryo', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK JP'] },
  { file: 'MEIRYO.TTC', family: 'Meiryo UI', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK JP'] },
  { file: 'MEIRYOB.TTC', family: 'Meiryo Bold', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK JP'] },
  { file: 'MEIRYOB.TTC', family: 'Meiryo UI Bold', to: ['NOTOSANSCJK.TTC', 'Noto Sans CJK JP'] },
  { file: 'MSMINCHO.TTC', family: 'MS Mincho', to: ['NOTOSERIFCJK.TTC', 'Noto Serif CJK JP'] },
  { file: 'MSMINCHO.TTC', family: 'MS PMincho', to: ['NOTOSERIFCJK.TTC', 'Noto Serif CJK JP'] },
];

// 1) 停 wineserver，避免编辑被覆盖
const stop = spawnSync(
  'wineserver',
  ['-k'],
  { encoding: 'utf8' },
);
if (stop.status !== 0 && stop.status !== null) {
  console.warn(`wineserver -k 返回 ${stop.status}（继续，通常没在跑）`);
}

// 2) 备份
const backup = `${REG}.bak-fontlink-${Date.now()}`;
fs.copyFileSync(REG, backup);
console.log(`备份：${backup}`);

// 3) 替换 str(7) 里的 "FILE,Family" 组合
let text = fs.readFileSync(REG, 'utf8');
let replaced = 0;

text = text.replace(/str\(7\):"([^"]*)"/g, (whole, value) => {
  const items = value.split('\\0');
  let touched = false;
  const next = items.map((item) => {
    const [file, ...rest] = item.split(',');
    const family = rest.join(',').trim();
    const hit = REPLACEMENTS.find(
      (r) =>
        file.trim().toUpperCase() === r.file.toUpperCase() &&
        family.toLowerCase() === r.family.toLowerCase(),
    );
    if (!hit) return item;
    touched = true;
    replaced += 1;
    return `${hit.to[0]},${hit.to[1]}`;
  });
  return touched ? `str(7):"${next.join('\\0')}"` : whole;
});

fs.writeFileSync(REG, text, 'utf8');
console.log(`改写 FontLink 条目 ${replaced} 条`);