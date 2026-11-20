#!/usr/bin/env node
/**
 * register-fonts.mjs — 把复制进 Wine prefix 的字体逐条注册到注册表。
 *
 * 为什么不能只把文件拷进 C:\windows\Fonts：
 *   Wine 不像 Windows 会自动扫描字体目录。只有注册表
 *   HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts 里登记过的字体，
 *   GDI/DirectWrite 才会枚举到。不登记的字体在某些应用里「文件名在、但选不到」。
 *
 * 族名不靠文件名猜：用 fc-scan 读字体自带的 family，TTC（一个文件多个字体）
 * 会返回多个，全部登记。登记名用 Windows 的传统写法 `族名 (TrueType)`。
 *
 * 用法：node register-fonts.mjs [drive_c 路径]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRIVE_C =
  process.argv[2] ||
  path.join(os.homedir(), '.local/share/wineprefixes/lingxi/drive_c');
const FONT_DIR = path.join(DRIVE_C, 'windows', 'Fonts');

/** 读出字体里声明的族名 + 样式（TTC 可能有多个字体）。 */
function fontInfo(file) {
  try {
    const out = execFileSync('fc-scan', ['--format', '%{family}\t%{style}\n', file], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const rows = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [familyPart, stylePart = ''] = line.split('\t');
      // family 用逗号分隔多语言别名，第一个通常是英文名
      const families = String(familyPart || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // style 也是逗号分隔的多语言别名，第一个是英文
      const style = String(stylePart || '').split(',')[0].trim();
      if (families.length) rows.push({ families, style });
    }
    return rows;
  } catch {
    return [];
  }
}

const files = fs
  .readdirSync(FONT_DIR)
  .filter((f) => /\.(ttf|ttc|otf|fon)$/i.test(f))
  .sort();

/**
 * 生成注册表键名。
 *
 * Windows 的写法是「族名 + 样式」，但常规体不加样式：
 *   Arial        → "Arial (TrueType)"
 *   Arial Bold   → "Arial Bold (TrueType)"
 * 只写族名的话，同一族的 Regular/Bold/Italic 会互相覆盖——这正是第一版
 * 165 条看着「够用」其实只留下最后一个样式的原因。
 */
function regKey(family, style) {
  const s = String(style || '').toLowerCase();
  const regular = !s || s === 'regular' || s === 'normal' || /^(常规|標準)$/.test(style);
  return regular ? `${family} (TrueType)` : `${family} ${style} (TrueType)`;
}

const entries = [];
for (const file of files) {
  // .fon 是位图字体（8514*、vgaoem 等），fc-scan 读不出族名
  if (/\.fon$/i.test(file)) continue;
  for (const { families: names, style } of fontInfo(path.join(FONT_DIR, file))) {
    // 英文名优先（Wine 的字体替换表按英文名匹配），中文别名也一并登记
    for (const name of names.slice(0, 2)) {
      entries.push({ key: regKey(name, style), file });
    }
  }
}

console.log(`扫描 ${files.length} 个文件，得到 ${entries.length} 条字体登记`);

// 生成一个 .reg 文件，一次导入；比逐条调 wine reg 快一个数量级
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const lines = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]',
];
const seen = new Set();
for (const { key, file } of entries) {
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push(`"${esc(key)}"="${esc(file)}"`);
}
lines.push('');

const regFile = path.join(DRIVE_C, 'router-installers', 'fonts.reg');
fs.mkdirSync(path.dirname(regFile), { recursive: true });
fs.writeFileSync(regFile, lines.join('\r\n'), 'utf8');

console.log(`写出 ${regFile}（${seen.size} 条）`);
console.log('下一步：WINEPREFIX=<prefix> wine regedit /S C:\\router-installers\\fonts.reg');
