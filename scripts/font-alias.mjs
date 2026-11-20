#!/usr/bin/env node
/**
 * font-alias.mjs — 生成「同名族」字体，解决 Chromium 里逐字回退导致的字体割裂。
 *
 * 问题：WPS 灵犀 的 CSS 写的是 `font-family: PingFang SC`（macOS 字体），
 * 没有回退栈。Linux/Wine 上找不到这个族，Chromium 就按字符逐个回退——
 * 一行里中文用宋体、数字用 Segoe、符号用别的，看起来「割裂」。
 *
 * 解法：复制一份中文字体，把 name 表里的族名改成应用要的那个（PingFang SC / MiSans），
 * 装进 Wine 的 Fonts 目录。这样 Chromium 能**直接命中原族名**，不再需要回退。
 *
 * 只改 name 表，不动字形数据，所以体积和渲染质量都跟源字体一致。
 * 用 simhei（单 face TTF）作源，避免 TTC 多字体的偏移重写。
 *
 * 用法：node font-alias.mjs <prefix 路径> [源字体]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = process.argv[2] || path.join(os.homedir(), '.local/share/wineprefixes/lingxi');
const SRC = process.argv[3] || path.join(PREFIX, 'drive_c/windows/Fonts/simhei.ttf');
const FONT_DIR = path.join(PREFIX, 'drive_c/windows/Fonts');

if (!fs.existsSync(SRC)) {
  console.error(`找不到源字体：${SRC}`);
  process.exit(1);
}

/** 要造出来的别名族。首个是英文名，后面的别名也会一并写入。 */
const ALIASES = [
  { family: 'PingFang SC', file: 'pingfangsc.ttf' },
  { family: 'MiSans', file: 'misans.ttf' },
  { family: 'Microsoft YaHei UI', file: null }, // 已有,跳过
];

const buf = fs.readFileSync(SRC);

// ---- 读表目录 ----
const numTables = buf.readUInt16BE(4);
const tables = {};
for (let i = 0; i < numTables; i += 1) {
  const off = 12 + i * 16;
  const tag = buf.toString('latin1', off, off + 4);
  tables[tag] = {
    offset: buf.readUInt32BE(off + 8),
    length: buf.readUInt32BE(off + 12),
  };
}

if (!tables.name) {
  console.error('源字体没有 name 表');
  process.exit(1);
}

/** name 表内部结构：format, count, stringOffset，然后 count 条记录。 */
function patchNameTable(nameTable, newFamily) {
  const t = Buffer.from(nameTable); // 拷贝，避免改到原缓冲
  const count = t.readUInt16BE(2);
  const stringOffset = t.readUInt16BE(4);
  const records = [];

  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 12;
    const platformID = t.readUInt16BE(base);
    const encodingID = t.readUInt16BE(base + 2);
    const languageID = t.readUInt16BE(base + 4);
    const nameID = t.readUInt16BE(base + 6);
    const length = t.readUInt16BE(base + 8);
    const offset = t.readUInt16BE(base + 10);
    records.push({ i, platformID, encodingID, languageID, nameID, length, offset });
  }

  // 需要替换的 nameID：1=族名 4=全名 6=PostScript 名 16=排版族名 17=排版子族
  const TARGET_IDS = new Set([1, 4, 6, 16]);
  const heads = [];
  const chunks = [];
  let cursor = 0;

  for (const r of records) {
    const start = stringOffset + r.offset;
    const raw = t.subarray(start, start + r.length);
    let replacement = null;

    if (TARGET_IDS.has(r.nameID)) {
      if (r.nameID === 6) {
        // PostScript 名不能有空格
        replacement = newFamily.replace(/\s+/g, '');
      } else {
        replacement = newFamily;
      }
    }

    if (replacement !== null) {
      // platformID 3（Windows）用 UTF-16BE；platformID 1（Mac）用 ASCII
      const encoded =
        r.platformID === 3
          ? Buffer.from(replacement, 'utf16le').swap16()
          : Buffer.from(replacement.replace(/[^\x20-\x7e]/g, ''), 'latin1');
      chunks.push(encoded);
      heads.push({ ...r, newLength: encoded.length, newOffset: cursor, remove: false });
      cursor += encoded.length;
    } else {
      chunks.push(raw);
      heads.push({ ...r, newLength: r.length, newOffset: cursor, remove: false });
      cursor += r.length;
    }
  }

  // 重建：header(6) + records(count*12) + strings
  const header = Buffer.alloc(6);
  t.copy(header, 0, 0, 6);
  header.writeUInt16BE(count, 2);
  header.writeUInt16BE(6 + count * 12, 4);

  const recBuf = Buffer.alloc(count * 12);
  for (let i = 0; i < heads.length; i += 1) {
    const r = heads[i];
    const base = i * 12;
    recBuf.writeUInt16BE(r.platformID, base);
    recBuf.writeUInt16BE(r.encodingID, base + 2);
    recBuf.writeUInt16BE(r.languageID, base + 4);
    recBuf.writeUInt16BE(r.nameID, base + 6);
    recBuf.writeUInt16BE(r.newLength, base + 8);
    recBuf.writeUInt16BE(r.newOffset, base + 10);
  }

  return Buffer.concat([header, recBuf, ...chunks]);
}

/**
 * 用新 name 表替换原字体并写出。
 *
 * TTF 的表按 4 字节对齐，替换后长度会变，所以要把 name 表挪到文件末尾，
 * 并同步更新表目录里的 offset/length。这样不用重排其它表，风险最小。
 */
function writeVariant(newFamily, outFile) {
  const nameTable = buf.subarray(tables.name.offset, tables.name.offset + tables.name.length);
  const patched = patchNameTable(nameTable, newFamily);

  // 去掉末尾 padding 的原始数据，再把新 name 表接在最后
  const head = buf.subarray(0, tables.name.offset);
  const pad = (4 - (head.length % 4)) % 4;
  const out = Buffer.concat([head, Buffer.alloc(pad), patched]);

  // 更新表目录中 name 的 offset/length
  for (let i = 0; i < numTables; i += 1) {
    const off = 12 + i * 16;
    if (buf.toString('latin1', off, off + 4) === 'name') {
      out.writeUInt32BE(head.length + pad, off + 8);
      out.writeUInt32BE(patched.length, off + 12);
      break;
    }
  }

  fs.writeFileSync(outFile, out);
  return out.length;
}

for (const a of ALIASES) {
  if (!a.file) continue;
  const out = path.join(FONT_DIR, a.file);
  const size = writeVariant(a.family, out);
  console.log(`  ${a.family.padEnd(18)} → ${a.file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

console.log('\n完成。接下来把生成的字体登记进注册表（fonts-register.mjs）。');