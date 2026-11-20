#!/usr/bin/env node
/**
 * sync-homes.mjs — 让多个 Windows 用户目录共用同一套 provider 账号与配置。
 *
 * 背景：双系统（例如 C:\Users\Administrator 与 D:\Users\demo）各自有一份
 * ~/.pi/agent/auth.json、~/.codebuddy-session.json、~/.workbuddy2api/sessions。
 * 同一个 E:\router 在两套系统里跑，登录/换号却只改当前系统，另一边会漂移。
 *
 * 做法：在仓库下建 .shared-home 作为共享库（已被 .gitignore 忽略）：
 *   - 账号池按 uid 合并，保留所有账号，不因同步丢号；
 *   - Qoder 每个区域只能有一条凭证，首次同步以当前系统为准，之后只接受
 *     同一 userID 的续期，避免在另一套系统启动时把账号换掉；
 *   - WorkBuddy 的“当前账号”按 live 文件的修改时间做 last-write-wins，
 *     首次同步固定为当前系统正在用的那个；
 *   - opencode / pi models / Qoder 模型缓存放共享库，并写回每个 home。
 *
 * 每次 router.mjs 启动和结束都会静默跑一次；也可以手动：
 *   node scripts/sync-homes.mjs
 *   node scripts/sync-homes.mjs --status
 *   node scripts/sync-homes.mjs --homes "C:\Users\Administrator;D:\Users\demo"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const SHARED_DIR = process.env.ROUTER_SHARED_HOME || path.join(ROOT, '.shared-home');
const STATE_FILE = path.join(SHARED_DIR, 'state.json');
const SHARED = {
  auth: path.join(SHARED_DIR, 'pi-auth.json'),
  models: path.join(SHARED_DIR, 'pi-models.json'),
  opencode: path.join(SHARED_DIR, 'opencode', 'opencode.json'),
  opencodeJsonc: path.join(SHARED_DIR, 'opencode', 'opencode.jsonc'),
  opencodePlugins: path.join(SHARED_DIR, 'opencode', 'plugins'),
  wbSessions: path.join(SHARED_DIR, 'workbuddy', 'sessions'),
  wbGlobalSessions: path.join(SHARED_DIR, 'workbuddy', 'sessions-global'),
  qoderModels: path.join(SHARED_DIR, 'qoder2pi'),
};

const WB = {
  workbuddy: {
    live: '.codebuddy-session.json',
    slots: path.join('.workbuddy2api', 'sessions'),
  },
  'workbuddy-global': {
    live: '.codebuddy-global-session.json',
    slots: path.join('.workbuddy2api', 'sessions-global'),
  },
};

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const nowStamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
const exists = (file) => {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 写之前留一份同目录备份；内容没变就不写，避免无谓地刷新 mtime。 */
function backup(file) {
  if (!exists(file)) return null;
  const dest = `${file}.bak-sync-${nowStamp()}`;
  if (exists(dest)) return dest;
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

function writeText(file, text, { keepMtimeIfSame = true, backupFile = true } = {}) {
  if (keepMtimeIfSame && readText(file) === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backupFile) backup(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, text);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  return true;
}

function writeJson(file, data, opts) {
  return writeText(file, `${JSON.stringify(data, null, 2)}\n`, opts);
}

function loadState() {
  const state = readJson(STATE_FILE);
  if (!state || !Array.isArray(state.homes)) return null;
  state.homes = state.homes.filter((h) => typeof h === 'string' && h.trim());
  return state;
}

function normalizeHome(home) {
  try {
    return path.resolve(home);
  } catch {
    return home;
  }
}

function uniqueHomes(homes) {
  const out = [];
  for (const home of homes) {
    if (!home) continue;
    const n = normalizeHome(home);
    if (!out.some((h) => samePath(h, n))) out.push(n);
  }
  return out;
}

function saveState(state) {
  writeJson(STATE_FILE, state, { keepMtimeIfSame: false, backupFile: false });
}

function homePath(home, rel) {
  return path.join(home, rel);
}

function recordScore(rec) {
  const auth = (rec && rec.data && rec.data.auth) || {};
  return [Number(auth.expiresAt || 0), Number(auth.lastRefreshTime || 0), Number((rec && rec.mtime) || 0)];
}

function betterRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const sa = recordScore(a);
  const sb = recordScore(b);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return sa[i] > sb[i] ? a : b;
  }
  return a;
}

function readSlots(home, region) {
  const dir = homePath(home, WB[region].slots);
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    const data = readJson(full);
    const uid = data && data.account && data.account.uid;
    if (!uid) continue;
    out.set(String(uid), {
      key: file.replace(/\.json$/i, ''),
      data,
      mtime: mtime(full),
      home,
    });
  }
  return out;
}

function readSharedSlots(region) {
  const dir = region === 'workbuddy' ? SHARED.wbSessions : SHARED.wbGlobalSessions;
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    const data = readJson(full);
    const uid = data && data.account && data.account.uid;
    if (!uid) continue;
    out.set(String(uid), { key: file.replace(/\.json$/i, ''), data, mtime: mtime(full), home: null });
  }
  return out;
}

function readLive(home, region) {
  const file = homePath(home, WB[region].live);
  const data = readJson(file);
  const uid = data && data.account && data.account.uid;
  return { file, data: data || null, uid: uid ? String(uid) : null, mtime: mtime(file) };
}

// ---------------------------------------------------------------- 删除墓碑
//
// 账号池是「按 uid 求并集」合并的，删掉一个 slot 后下一轮同步又会从
// 共享库或另一套系统里把它捞回来——删除等于没删。所以删除时登记一条墓碑，
// 合并阶段先按墓碑剔掉；用户显式恢复（或重新登录同一个 uid）时再解除。

function tombFile() {
  return path.join(SHARED_DIR, 'tombstones.json');
}

function readTombs(region) {
  const all = readJson(tombFile(), {}) || {};
  const list = all[region];
  return Array.isArray(list) ? list.map(String) : [];
}

function writeTombs(region, uids) {
  const all = readJson(tombFile(), {}) || {};
  all[region] = [...new Set(uids.map(String))];
  writeJson(tombFile(), all);
}

/** 登记「这个账号是用户主动删的」，并把它从共享库副本里去掉。 */
export function markAccountDeleted(region, uid) {
  if (!uid) return;
  const list = readTombs(region);
  if (!list.includes(String(uid))) list.push(String(uid));
  writeTombs(region, list);
  // 共享库里的副本也删掉，否则别处同步仍会把它带回来
  const dir = region === 'workbuddy' ? SHARED.wbSessions : SHARED.wbGlobalSessions;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f));
  } catch {}
  for (const file of files) {
    const full = path.join(dir, file);
    const data = readJson(full);
    if (data && data.account && String(data.account.uid) === String(uid)) {
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  }
}

/** 恢复时解除墓碑，允许它重新参与合并。 */
export function clearAccountDeleted(region, uid) {
  writeTombs(
    region,
    readTombs(region).filter((x) => x !== String(uid)),
  );
}

export function listDeletedAccounts(region) {
  return readTombs(region);
}

function livePath(home, region) {
  return homePath(home, WB[region].live);
}

function nextKey(used) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const ch of letters) if (!used.has(ch)) return ch;
  for (let i = 2; ; i += 1) {
    for (const ch of letters) {
      const key = `${ch}${i}`;
      if (!used.has(key)) return key;
    }
  }
}

function mergeSlots({ homes, region, currentHome }) {
  const sharedSlots = readSharedSlots(region);
  const tombs = new Set(readTombs(region));
  const perHome = new Map();
  for (const home of homes) perHome.set(home, readSlots(home, region));

  // 用账号最多的那个 home 作为命名参考，避免 C 只有一个 a 时把 D 的 a/b/c 全改名。
  let masterHome = currentHome;
  let masterCount = (perHome.get(currentHome) || new Map()).size;
  for (const home of homes) {
    const count = (perHome.get(home) || new Map()).size;
    if (count > masterCount) {
      masterHome = home;
      masterCount = count;
    }
  }

  const merged = new Map();
  for (const slots of perHome.values()) {
    for (const [uid, rec] of slots) {
      merged.set(uid, betterRecord(merged.get(uid), rec));
    }
  }
  for (const [uid, rec] of sharedSlots) {
    merged.set(uid, betterRecord(merged.get(uid), rec));
  }
  // 用户明确删掉的账号记在墓碑里：共享库/其它 home 里还留着它的旧副本也不能复活。
  for (const uid of tombs) merged.delete(uid);

  const used = new Set();
  const keyByUid = new Map();
  // 先保留共享库已经用过的名字，保证重复同步时文件名稳定。
  for (const [uid, rec] of sharedSlots) {
    if (!merged.has(uid)) continue;
    if (used.has(rec.key)) continue;
    used.add(rec.key);
    keyByUid.set(uid, rec.key);
  }
  const masterSlots = perHome.get(masterHome) || new Map();
  for (const [uid] of merged) {
    if (keyByUid.has(uid)) continue;
    const rec = masterSlots.get(uid);
    const key = rec && !used.has(rec.key) ? rec.key : null;
    if (key) {
      used.add(key);
      keyByUid.set(uid, key);
    }
  }
  for (const home of homes) {
    const slots = perHome.get(home) || new Map();
    for (const [uid] of merged) {
      if (keyByUid.has(uid)) continue;
      const rec = slots.get(uid);
      if (!rec || used.has(rec.key)) continue;
      used.add(rec.key);
      keyByUid.set(uid, rec.key);
    }
  }
  for (const [uid] of merged) {
    if (keyByUid.has(uid)) continue;
    const key = nextKey(used);
    used.add(key);
    keyByUid.set(uid, key);
  }

  const records = new Map();
  for (const [uid, rec] of merged) {
    records.set(uid, { key: keyByUid.get(uid), data: rec.data, mtime: rec.mtime });
  }
  return { records, perHome };
}

function writeSlots(dir, records, { shared = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const desired = new Map();
  for (const [uid, rec] of records) desired.set(`${rec.key}.json`, rec.data);
  for (const [file, data] of desired) writeJson(path.join(dir, file), data);
  // 多余文件不直接删，挪到 removed-<时间>/，账号可以恢复。
  const archive = path.join(dir, `removed-${nowStamp()}`);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f));
  } catch {}
  for (const file of files) {
    if (desired.has(file)) continue;
    try {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(dir, file), path.join(archive, file));
    } catch {}
  }
  return desired.size;
}

function chooseActive({ region, records, homeLives, currentHome, state }) {
  const key = region === 'workbuddy' ? 'workbuddy' : 'workbuddy-global';
  const activeState = (state.active && state.active[key]) || null;
  let uid = activeState && records.has(String(activeState)) ? String(activeState) : null;
  let activeAt = Date.parse((state.active && state.active.updatedAt) || '') || 0;

  if (!uid) {
    const currentLive = homeLives.find((l) => samePath(l.home, currentHome) && l.uid && records.has(l.uid));
    const anyLive = homeLives.find((l) => l.uid && records.has(l.uid));
    uid = (currentLive || anyLive || {}).uid || records.keys().next().value || null;
    // 首次初始化：把更早的 live mtime 全部忽略，固定用当前系统正在用的账号。
    activeAt = Date.now() + 5000;
  } else {
    for (const live of homeLives) {
      if (!live.uid || !records.has(live.uid)) continue;
      if (String(live.uid) === uid) continue;
      if (live.mtime > activeAt) {
        uid = live.uid;
        activeAt = live.mtime;
      }
    }
  }
  if (!uid) return { uid: null, activeAt };
  if (process.env.ROUTER_SYNC_DEBUG) {
    console.error(
      `[sync] ${region} active=${uid} at=${new Date(activeAt).toISOString()} ` +
        `lives=${homeLives.map((l) => `${l.home}:${l.uid}@${new Date(l.mtime).toISOString()}`).join(', ')}`,
    );
  }

  // live 文件里可能有比账号池更新的续期 token，先回写 slot。
  for (const live of homeLives) {
    if (!live.uid || String(live.uid) !== uid || !live.data) continue;
    const rec = records.get(uid);
    const next = betterRecord({ data: live.data, mtime: live.mtime }, { data: rec.data, mtime: rec.mtime });
    if (next.data === live.data) {
      rec.data = live.data;
      rec.mtime = live.mtime;
    }
  }
  return { uid, activeAt };
}

function readAllHomes(homes) {
  return homes.map((home) => ({
    home,
    auth: { data: readJson(homePath(home, path.join('.pi', 'agent', 'auth.json')), {}), mtime: mtime(homePath(home, path.join('.pi', 'agent', 'auth.json'))) },
    models: { data: readJson(homePath(home, path.join('.pi', 'agent', 'models.json')), null), mtime: mtime(homePath(home, path.join('.pi', 'agent', 'models.json'))) },
    opencode: {
      file: homePath(home, path.join('.config', 'opencode', 'opencode.json')),
      jsoncFile: homePath(home, path.join('.config', 'opencode', 'opencode.jsonc')),
      data: readJson(homePath(home, path.join('.config', 'opencode', 'opencode.json')), null),
      mtime: mtime(homePath(home, path.join('.config', 'opencode', 'opencode.json'))),
      jsonc: readText(homePath(home, path.join('.config', 'opencode', 'opencode.jsonc'))),
      jsoncMtime: mtime(homePath(home, path.join('.config', 'opencode', 'opencode.jsonc'))),
    },
  }));
}

function pickQoder(entries, preferredHome) {
  const valid = entries.filter((e) => e && e.entry && e.entry.access);
  if (!valid.length) return null;
  const preferred = valid.find((e) => samePath(e.home, preferredHome));
  const base = preferred || valid[0];
  let best = { entry: base.entry, mtime: base.mtime };
  for (const e of valid) {
    if (String(e.entry.userID || '') !== String(best.entry.userID || '')) continue;
    const ee = Number(e.entry.expires || 0);
    const be = Number(best.entry.expires || 0);
    if (ee > be || (ee === be && e.mtime > best.mtime)) best = { entry: e.entry, mtime: e.mtime };
  }
  return best.entry;
}

function mergeAuth({ homesData, sharedAuth, currentHome, warnings }) {
  const out = { ...(sharedAuth || {}) };
  const authEntries = (key) => homesData.map((h) => ({ home: h.home, entry: h.auth.data && h.auth.data[key], mtime: h.auth.mtime }));

  // Qoder 每个区域只有一条凭证：已有共享条目时只接受同一 userID 的续期。
  const sharedAuthMtime = mtime(SHARED.auth);
  for (const key of ['qoder-cn', 'qoder']) {
    const current = out[key];
    const entries = authEntries(key).filter((e) => e.entry && e.entry.access);
    if (!current || !current.access) {
      const picked = pickQoder(entries, currentHome);
      if (picked) out[key] = picked;
      continue;
    }
    // 明确的重新登录（auth.json 比共享库新）可以换账号；旧备份/另一套系统
    // 里遗留的旧账号不会因为 mtime 较早而把共享库改回去。先看“不同 userID”，
    // 因为另一套系统可能还留着旧账号，不能让它挡住新登录。
    const different = entries
      .filter((e) => String(e.entry.userID || '') !== String(current.userID || ''))
      .filter((e) => e.mtime > sharedAuthMtime && (!Number(e.entry.expires || 0) || Number(e.entry.expires) > Date.now()))
      .sort((a, b) => b.mtime - a.mtime);
    if (different.length) {
      const other = different[0];
      out[key] = other.entry;
      warnings.push(`采用新登录的 ${key} 账号 ${other.entry.name || other.entry.userID || ''}`.trim());
      continue;
    }
    const same = entries.filter((e) => String(e.entry.userID || '') === String(current.userID || ''));
    if (!same.length) {
      if (entries.length) {
        const old = entries[0].entry;
        warnings.push(`保留共享库的 ${key} 账号 ${current.name || current.userID}，忽略另一个账号 ${old.name || old.userID}`);
      }
      continue;
    }
    // 共享库自己也作为候选，避免用较旧的 home 文件把刚续期的 token 覆盖回去。
    let best = { entry: current, mtime: sharedAuthMtime };
    for (const e of same) {
      const ee = Number(e.entry.expires || 0);
      const be = Number(best.entry.expires || 0);
      if (ee > be || (ee === be && e.mtime > best.mtime)) best = e;
    }
    out[key] = best.entry;
  }

  // WorkBuddy 的 key 只是本机反代的占位 key，两边本来就相同；优先保留共享库。
  for (const key of ['workbuddy', 'workbuddy-global']) {
    if (out[key]) continue;
    const preferred = homesData.find((h) => samePath(h.home, currentHome));
    const picked = (preferred && preferred.auth.data && preferred.auth.data[key]) || homesData.map((h) => h.auth.data && h.auth.data[key]).find(Boolean);
    if (picked) out[key] = picked;
  }

  // 其它 provider（siliconflow/scf 等）做并集，不因同步丢失。
  for (const h of homesData) {
    for (const [key, entry] of Object.entries(h.auth.data || {})) {
      if (!out[key] && entry) out[key] = entry;
    }
  }
  return out;
}

function mergeModels({ homesData, sharedModels, warnings }) {
  const outProviders = {};
  const sourceAt = new Map();
  const sharedProviders = (sharedModels && sharedModels.providers) || {};
  for (const [id, data] of Object.entries(sharedProviders)) {
    outProviders[id] = data;
    sourceAt.set(id, 0);
  }
  const sorted = [...homesData].sort((a, b) => a.models.mtime - b.models.mtime);
  for (const h of sorted) {
    const providers = (h.models.data && h.models.data.providers) || {};
    for (const [id, data] of Object.entries(providers)) {
      const prev = sourceAt.get(id) || 0;
      if (h.models.mtime >= prev) {
        outProviders[id] = data;
        sourceAt.set(id, h.models.mtime);
      }
    }
  }
  if (!Object.keys(outProviders).length) return null;
  const base = sorted.length && sorted[sorted.length - 1].models.data ? sorted[sorted.length - 1].models.data : sharedModels || {};
  const out = { ...base, providers: outProviders };
  return out;
}

function mergeOpencode({ homesData, sharedJson, currentHome, warnings }) {
  // 整份 provider 以最新修改的那份为准：这样 router off 掉某家时，删除也会同步过去。
  const candidates = [];
  if (sharedJson && sharedJson.provider) candidates.push({ data: sharedJson, mtime: 0 });
  for (const h of homesData) {
    if (h.opencode.data && h.opencode.data.provider) candidates.push({ data: h.opencode.data, mtime: h.opencode.mtime });
  }
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const c of candidates) if (c.mtime > best.mtime) best = c;
  if (!best.data || !best.data.provider) return null;
  return { ...best.data, provider: best.data.provider };
}

function writeOpencodeToHome(home, source, sharedDir) {
  const file = homePath(home, path.join('.config', 'opencode', 'opencode.json'));
  const existing = readJson(file, null);
  const out = existing ? { ...existing } : { $schema: 'https://opencode.ai/config.json' };
  out.provider = source.provider;
  writeJson(file, out);
}

function syncJsonc({ homesData, currentHome, warnings }) {
  const candidates = [];
  const sharedText = readText(SHARED.opencodeJsonc);
  if (sharedText) candidates.push({ text: sharedText, mtime: mtime(SHARED.opencodeJsonc) });
  for (const h of homesData) {
    if (h.opencode.jsonc) candidates.push({ text: h.opencode.jsonc, mtime: h.opencode.jsoncMtime });
  }
  if (!candidates.length) return false;
  let best = candidates[0];
  for (const c of candidates) if (c.mtime > best.mtime) best = c;
  writeText(SHARED.opencodeJsonc, best.text);
  for (const h of homesData) {
    const file = h.opencode.jsoncFile;
    if (readText(file) === best.text) continue;
    writeText(file, best.text);
  }
  return true;
}

/**
 * opencode 插件目录（provider-credits 等）。
 *
 * 插件是**代码**，不能像账号文件那样按 mtime 做 last-write-wins——一台上的旧副本
 * 会把新版覆盖回去。所以这里只做首次安装：目标 home 里还没有这份插件时，从共享库
 * 拷一份过去；已经有了就完全不动，避免把用户正在改的版本覆盖掉。
 *
 * `~/.config/opencode/plugins/<名字>/` 会被 opencode 自动加载（实测日志里
 * `loading plugin id=.../plugins/model-groups`），不需要往 opencode.jsonc 的
 * `plugins` 数组里登记，也就不必去改用户手写的带注释配置。
 */
const PLUGIN_NAMES = ['provider-credits'];

function syncPlugins({ homesData }) {
  let installed = 0;
  for (const name of PLUGIN_NAMES) {
    const sharedDir = path.join(SHARED.opencodePlugins, name);
    // 共享库里还没有这份插件时，从最先找到的 home 收上来（首次初始化）
    if (!exists(sharedDir)) {
      for (const h of homesData) {
        const src = homePath(h.home, path.join('.config', 'opencode', 'plugins', name));
        if (exists(path.join(src, 'index.ts'))) {
          copyDir(src, sharedDir);
          break;
        }
      }
    }
    if (!exists(sharedDir)) continue;
    for (const h of homesData) {
      const dest = homePath(h.home, path.join('.config', 'opencode', 'plugins', name));
      if (exists(dest)) continue; // 不覆盖：用户可能正在改这一份
      if (copyDir(sharedDir, dest)) installed += 1;
    }
  }
  return installed;
}

/** 递归复制目录（覆盖同名文件）。插件目录只有几个文件，不追求增量。 */function copyDir(src, dest) {
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDir(from, to);
      else if (entry.isFile()) {
        // 内容一样就别写，避免每轮同步都刷新 mtime、触发 opencode 重载
        if (exists(to) && readText(to) === readText(from)) continue;
        fs.copyFileSync(from, to);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function syncQoderModels({ homesData }) {
  const names = ['models-cn.json', 'models-global.json'];
  let changed = 0;
  for (const name of names) {
    const candidates = [];
    const sharedFile = path.join(SHARED.qoderModels, name);
    if (exists(sharedFile)) candidates.push({ file: sharedFile, mtime: mtime(sharedFile) });
    for (const h of homesData) {
      const file = homePath(h.home, path.join('.qoder2pi', name));
      if (exists(file)) candidates.push({ file, mtime: mtime(file) });
    }
    if (!candidates.length) continue;
    let best = candidates[0];
    for (const c of candidates) if (c.mtime > best.mtime) best = c;
    const text = readText(best.file);
    if (!text) continue;
    if (writeText(sharedFile, text)) changed += 1;
    for (const h of homesData) {
      const file = homePath(h.home, path.join('.qoder2pi', name));
      if (writeText(file, text)) changed += 1;
    }
  }
  return changed;
}

function ensureDirs() {
  for (const dir of [SHARED_DIR, path.dirname(SHARED.auth), SHARED.wbSessions, SHARED.wbGlobalSessions, path.dirname(SHARED.opencode), SHARED.opencodePlugins, SHARED.qoderModels]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function syncHomes({ homes = null, quiet = false } = {}) {
  const warnings = [];
  const currentHome = normalizeHome(os.homedir());
  let state = loadState();

  if (!state) {
    if (!homes || !homes.length) return { skipped: true, reason: '共享库还没初始化，先运行 --homes <目录1;目录2>' };
    const list = uniqueHomes([currentHome, ...homes]).filter((h) => exists(h));
    state = {
      version: 1,
      homes: list,
      active: {},
      createdAt: new Date().toISOString(),
    };
  } else if (homes && homes.length) {
    state.homes = uniqueHomes([...state.homes, ...homes]);
  }
  state.homes = uniqueHomes(state.homes);
  if (!state.homes.some((h) => samePath(h, currentHome))) state.homes.push(currentHome);
  // 配置里保留找不到的目录（例如双系统时另一块盘暂时没挂载），
  // 等它出现后下一轮继续同步；本轮只操作实际存在的 home。
  const activeHomes = state.homes.filter((h) => exists(h));
  if (!activeHomes.length) return { skipped: true, reason: '没有可用的 home 目录' };

  ensureDirs();
  const homesData = readAllHomes(activeHomes);
  const sharedAuth = readJson(SHARED.auth, null);
  const sharedModels = readJson(SHARED.models, null);
  const sharedJson = readJson(SHARED.opencode, null);

  // 1) pi auth
  const auth = mergeAuth({ homesData, sharedAuth, currentHome, warnings });
  if (Object.keys(auth).length) writeJson(SHARED.auth, auth);

  // 2) pi models
  const models = mergeModels({ homesData, sharedModels, warnings });
  if (models) writeJson(SHARED.models, models);

  // 3) WorkBuddy 账号池 + 当前账号
  const mergedSlots = {};
  for (const region of ['workbuddy', 'workbuddy-global']) {
    const { records } = mergeSlots({ homes: activeHomes, region, currentHome });
    const lives = activeHomes.map((home) => ({ home, ...readLive(home, region) }));
    const active = chooseActive({ region, records, homeLives: lives, currentHome, state });
    if (!state.active) state.active = {};
    state.active[region] = active.uid;
    mergedSlots[region] = records;

    const sharedDir = region === 'workbuddy' ? SHARED.wbSessions : SHARED.wbGlobalSessions;
    writeSlots(sharedDir, records);
    for (const home of activeHomes) {
      writeSlots(homePath(home, WB[region].slots), records);
      if (active.uid && records.has(active.uid)) {
        writeJson(livePath(home, region), records.get(active.uid).data);
      }
    }
  }
  // 用刚写入的 live 文件 mtime 作为基准，下一轮不会把自己写的当成“换号”。
  let liveAt = 0;
  for (const home of activeHomes) {
    for (const region of ['workbuddy', 'workbuddy-global']) {
      liveAt = Math.max(liveAt, mtime(livePath(home, region)));
    }
  }
  state.active.updatedAt = new Date(Math.max(liveAt + 1, Date.now())).toISOString();

  // 4) opencode provider
  const opencode = mergeOpencode({ homesData, sharedJson, currentHome, warnings });
  if (opencode) {
    writeJson(SHARED.opencode, opencode);
    for (const home of activeHomes) writeOpencodeToHome(home, opencode, SHARED_DIR);
  }
  syncJsonc({ homesData, currentHome, warnings });

  // 5) Qoder 模型缓存
  syncQoderModels({ homesData });

  // 5b) opencode 插件（代码，单向分发：共享库 → 每个 home）
  syncPlugins({ homesData, warnings });

  // 6) 所有 home 写同一份 auth/models
  for (const home of activeHomes) {
    writeJson(homePath(home, path.join('.pi', 'agent', 'auth.json')), auth);
    if (models) writeJson(homePath(home, path.join('.pi', 'agent', 'models.json')), models);
  }

  state.lastSync = new Date().toISOString();
  saveState(state);

  if (!quiet) {
    const activeName = (region) => {
      const uid = state.active && state.active[region];
      const rec = uid && mergedSlots[region] && mergedSlots[region].get(String(uid));
      return rec && rec.data && rec.data.account ? rec.data.account.nickname || uid : uid || '未设置';
    };
    console.log(`共享库  ${SHARED_DIR}`);
    console.log(`同步目录  ${state.homes.join('  ·  ')}`);
    console.log(`Qoder 国内版  ${auth['qoder-cn'] ? auth['qoder-cn'].name || auth['qoder-cn'].userID : '未登录'}`);
    console.log(`WorkBuddy 国内版  账号 ${mergedSlots.workbuddy.size} 个，当前 ${activeName('workbuddy')}`);
    console.log(`WorkBuddy 国际版  账号 ${mergedSlots['workbuddy-global'].size} 个，当前 ${activeName('workbuddy-global')}`);
    if (warnings.length) for (const w of warnings) console.log(`! ${w}`);
  }
  return { ok: true, homes: state.homes, warnings };
}

/**
 * router 切号时显式写入共享库的“当前账号”。
 * 只靠 live 文件 mtime 判断会遇到「切号紧跟在启动同步之后」的毫秒级竞态，
 * 所以 router 切完账号后直接调用这里，下一轮同步就不会把新账号改回去。
 */
export function setActiveWorkbuddy(region, uid) {
  if (!uid) return;
  const state = loadState();
  if (!state) return;
  if (!state.active) state.active = {};
  state.active[region] = String(uid);
  state.active.updatedAt = new Date().toISOString();
  saveState(state);
}

export function printStatus() {
  const state = loadState();
  if (!state) {
    console.log('共享库尚未初始化。');
    console.log(`示例：node scripts/sync-homes.mjs --homes "C:\\Users\\Administrator;D:\\Users\\demo"`);
    return;
  }
  const auth = readJson(SHARED.auth, {}) || {};
  const models = readJson(SHARED.models, null);
  const oc = readJson(SHARED.opencode, null);
  console.log(`共享库  ${SHARED_DIR}`);
  console.log(`同步目录  ${state.homes.join('  ·  ')}`);
  console.log(`最后同步  ${state.lastSync || state.createdAt || '从未'}`);
  console.log(`Qoder 国内版  ${auth['qoder-cn'] ? `${auth['qoder-cn'].name || ''} ${auth['qoder-cn'].userID || ''}`.trim() : '未登录'}`);
  console.log(`Qoder 国际版  ${auth.qoder ? `${auth.qoder.name || ''} ${auth.qoder.userID || ''}`.trim() : '未登录'}`);
  const wb = readSharedSlots('workbuddy');
  const wbg = readSharedSlots('workbuddy-global');
  const nameOf = (slots, uid) => {
    const rec = uid && slots.get(String(uid));
    return rec && rec.data.account ? rec.data.account.nickname || rec.data.account.uid : uid || '未设置';
  };
  console.log(`WorkBuddy 国内版  ${wb.size} 个账号，当前 ${nameOf(wb, state.active && state.active.workbuddy)}`);
  console.log(`WorkBuddy 国际版  ${wbg.size} 个账号，当前 ${nameOf(wbg, state.active && state.active['workbuddy-global'])}`);
  if (models && models.providers) {
    const summary = Object.entries(models.providers).map(([id, p]) => `${id}:${Object.keys((p && p.models) || {}).length}`).join('  ');
    console.log(`pi models  ${summary}`);
  }
  if (oc && oc.provider) {
    const summary = Object.entries(oc.provider).map(([id, p]) => `${id}:${Object.keys((p && p.models) || {}).length}`).join('  ');
    console.log(`opencode  ${summary}`);
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    printStatus();
    process.exit(0);
  }
  const homesArg = argValue(args, '--homes');
  const homes = homesArg ? homesArg.split(';').map((s) => s.trim()).filter(Boolean) : null;
  const quiet = args.includes('--quiet');
  syncHomes({ homes, quiet })
    .then((result) => {
      if (result.skipped) {
        if (!quiet) console.log(result.reason);
        process.exit(0);
      }
      if (!quiet) console.log('同步完成。');
      process.exit(0);
    })
    .catch((err) => {
      console.error(`同步失败：${err.message}`);
      process.exit(1);
    });
}
