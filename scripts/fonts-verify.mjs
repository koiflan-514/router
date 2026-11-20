#!/usr/bin/env node
/**
 * verify-fonts.mjs — 用 Wine 的 `+font` trace 验证字体是否真被加载。
 *
 * 为什么不用 PowerShell 枚举族名：Wine 里 `powershell.exe` 是个 stub
 * （`fixme:powershell:wmain stub`），只会返回空，用它验证什么都得不到。
 *
 * `+font` trace 是 Wine 真正加载字体时打的日志，出现
 *   insert_face_in_family_list Adding face L"<族名>" in family L"<族名>"
 * 就说明这个族的某个字重已经进 GDI 的族表——这正是应用选择字体时查的表。
 *
 * 用法：node verify-fonts.mjs
 */

import { spawnSync } from 'node:child_process';

/** 期望能被应用选到的族（中文为核心，英数用来确认基础字体也在）。 */
const WANT = [
  ['Microsoft YaHei', '微软雅黑'],
  ['Microsoft YaHei UI'],
  // 应用 CSS 直接写死这两个族（无回退栈），缺了就会逐字回退 → 字体割裂
  ['PingFang SC'],
  ['MiSans'],
  ['SimSun', '宋体'],
  ['NSimSun', '新宋体'],
  ['SimHei', '黑体'],
  ['KaiTi', '楷体'],
  ['FangSong', '仿宋'],
  ['DengXian', '等线'],
  ['Arial'],
  ['Tahoma'],
  ['Segoe UI'],
  ['Consolas'],
  ['Noto Sans CJK SC'],
  ['Noto Sans CJK JP'],
  ['Noto Sans CJK KR'],
];

const run = spawnSync(
  'wine',
  ['notepad', 'C:\\windows\\win.ini'],
  {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, WINEDEBUG: '+font' },
  },
);

const log = `${run.stdout || ''}${run.stderr || ''}`;

// 抓 "Adding face L"XXX" in family L"YYY""
const families = new Set();
for (const m of log.matchAll(/Adding face L"[^"]*" in family L"([^"]*)"/g)) {
  // Wine 把非 ASCII 打成 \xxxx 形式，转回来才能比对中文名
  let name = m[1];
  if (/\\[0-9a-f]{4}/i.test(name)) {
    name = name.replace(/\\[0-9a-f]{4}/gi, (s) =>
      String.fromCharCode(parseInt(s.slice(1), 16)),
    );
  }
  families.add(name);
}

console.log(`Wine 加载到 ${families.size} 个字体族`);

let missing = 0;
for (const aliases of WANT) {
  const found = aliases.find((a) =>
    [...families].some((f) => f.toLowerCase() === a.toLowerCase()),
  );
  if (!found) missing += 1;
  console.log(`  ${found ? '✓' : '✗'} ${aliases[0]}`);
}

if (families.size === 0) {
  console.log('\n没抓到任何字体加载记录，可能 trace 没生效。原始输出尾部：');
  console.log(log.split('\n').slice(-10).join('\n'));
}

console.log(
  missing === 0
    ? '\n全部到位：中文族已进 GDI 族表，应用能选到。'
    : `\n缺 ${missing} 个族。`,
);
process.exitCode = missing ? 1 : 0;