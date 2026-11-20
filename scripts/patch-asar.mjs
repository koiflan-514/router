#!/usr/bin/env node
// 在 asar 里做「等长原地替换」—— 不改变 header 偏移，所以无需 repack。
// 用法: node patch-asar.mjs <asar> <old> <new> [--restore]
//   --restore 把 new 换回 old
//
// 注意：必须按 **字节** 查找。asar 里的 JS 常含中文，按 utf8 解码后的
// 字符串索引与字节偏移不一致，会写坏文件（踩过）。
import fs from 'node:fs';

const [file, a, b, flag] = process.argv.slice(2);
if (!file || a === undefined || b === undefined) {
  console.error('用法: node patch-asar.mjs <asar> <old> <new> [--restore]');
  process.exit(1);
}
if (a.length !== b.length) {
  console.error(`必须等长：old=${a.length} new=${b.length}`);
  process.exit(1);
}
const oldStr = flag === '--restore' ? b : a;
const newStr = flag === '--restore' ? a : b;

const fd = fs.openSync(file, 'r+');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const hb = Buffer.alloc(headerSize);
fs.readSync(fd, hb, 0, headerSize, 16);
const header = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
const dataStart = 16 + headerSize;

const hits = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) { walk(v, p); continue; }
    if (Number(v.size) < oldStr.length || v.unpacked) continue;
    const buf = Buffer.alloc(Number(v.size));
    fs.readSync(fd, buf, 0, Number(v.size), dataStart + Number(v.offset));
    const needle = Buffer.from(oldStr, 'utf8');
    let idx = buf.indexOf(needle);
    while (idx !== -1) {
      hits.push({ path: p, fileOffset: Number(v.offset) + idx, idx });
      idx = buf.indexOf(needle, idx + 1);
    }
  }
};
walk(header, '');

if (!hits.length) {
  console.log('没有找到目标字符串（可能已经打过补丁）');
  process.exit(0);
}
for (const h of hits) {
  fs.writeSync(fd, Buffer.from(newStr, 'utf8'), 0, newStr.length, dataStart + h.fileOffset);
  console.log(`已替换 ${h.path} @ ${h.fileOffset}: "${oldStr}" -> "${newStr}"`);
}
fs.closeSync(fd);