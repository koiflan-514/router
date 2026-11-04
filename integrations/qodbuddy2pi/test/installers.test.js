#!/usr/bin/env node
/**
 * installers.test.js — 两份安装脚本的一致性检查。
 *
 * 安装逻辑本身不测（那要真实机器与环境，写出来的多半是假的），但有一类
 * 错误完全可以在离线时抓住：两份脚本对同一份文件清单的描述不一致。
 * 这正是「四份脚本各写一遍」时代的病根，所以在这里钉住。
 *
 * 跑法：node --test test/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 归一化行尾再解析：Windows 检出时 install.ps1 是 CRLF（见 .gitattributes），
// 而下面那批按 ^ 与 \n 写的正则遇到 \r 会失配，测试会在 Windows 上假红。
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const SH = read('install.sh');
const PS1 = read('install.ps1');

/** 从 install.sh 的 OPS_FILES 数组里取出文件名（去掉 :mode）。 */
function shFileList() {
  const m = SH.match(/^OPS_FILES=\(\n([\s\S]*?)^\)/m);
  assert.ok(m, 'install.sh 里找不到 OPS_FILES 数组');
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => l.replace(/^"/, '').replace(/"$/, '').split(':')[0]);
}

/** 从 install.ps1 的 $OPS_FILES 数组里取出文件名（一行可能放两个）。 */
function ps1FileList() {
  const m = PS1.match(/^\$OPS_FILES = @\(\n([\s\S]*?)^\)/m);
  assert.ok(m, 'install.ps1 里找不到 $OPS_FILES 数组');
  return m[1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    // 一行可能是 "a", "b"，所以逐个抽引号里的内容
    .flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

test('两份安装脚本部署同一组文件', () => {
  const sh = shFileList().sort();
  const ps1 = ps1FileList().sort();
  assert.deepStrictEqual(
    sh,
    ps1,
    `install.sh 与 install.ps1 的文件清单不一致\n  sh : ${sh.join(', ')}\n  ps1: ${ps1.join(', ')}`,
  );
});

test('清单里的每个文件都真实存在', () => {
  for (const name of shFileList()) {
    const p = path.join(ROOT, 'assets', name);
    assert.ok(fs.existsSync(p), `清单里列了 ${name}，但 assets/ 下没有它`);
  }
});

test('清单里不再包含已删除的 workbuddy2pi-global', () => {
  const all = [...shFileList(), ...ps1FileList()];
  assert.ok(
    !all.some((f) => f.includes('workbuddy2pi-global')),
    'workbuddy2pi-global 已并入总控的页签，两份脚本都该清理它而不是部署它',
  );
});

test('两份脚本都会清理旧的 workbuddy2pi-global', () => {
  assert.match(SH, /workbuddy2pi-global/, 'install.sh 应清理旧命令');
  assert.match(PS1, /workbuddy2pi-global/, 'install.ps1 应清理旧命令');
});

test('两份脚本都调用 qodbuddy2pi probe 做探测（而不是各写一套）', () => {
  assert.match(SH, /qodbuddy2pi"?\s*probe|probe_state/, 'install.sh 应调 probe');
  assert.match(PS1, /probe/, 'install.ps1 应调 probe');
});

test('两份脚本都用 pi 的官方安装方式，而不是自己装 Node', () => {
  assert.match(SH, /https:\/\/pi\.dev\/install\.sh/, 'install.sh 应用官方安装方式');
  assert.match(PS1, /https:\/\/pi\.dev\/install\.ps1/, 'install.ps1 应用官方安装方式');
  // 自己装 Node 的逻辑（brew install node / winget NodeJS）应该已经删掉
  assert.ok(!/brew install node/.test(SH), 'install.sh 不该再自己 brew 装 Node');
  assert.ok(
    !/winget install[^\n]*NodeJS/i.test(PS1),
    'install.ps1 不该再自己 winget 装 Node',
  );
});

test('$var 紧跟中文标点的写法会踩 bash 的坑，install.sh 里不能有', () => {
  // bash 会把中文字符当成变量名的一部分（$name，→ 变量名 "name，"），
  // 于是 set -u 下报 unbound variable。必须写成 ${name}。
  const lines = SH.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (line.trim().startsWith('#')) return;
    // 简单 $var 形式（不是 ${...}）后面紧接非 ASCII
    const re = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      offenders.push(`  第 ${i + 1} 行: $${m[1]} 紧跟中文 → ${line.trim().slice(0, 70)}`);
    }
  });
  assert.strictEqual(
    offenders.length,
    0,
    `install.sh 里有 $var 紧跟中文的写法，会解析成别的变量名:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------- 三种安装入口

/**
 * npm 与 release 两条路都靠 `qodbuddy2pi install` 把包内的安装器调起来。
 * 这条链路断在哪一环都不会在开发机上显形（开发时都是直接跑 ./install.sh），
 * 所以在这里钉住：子命令在、安装器找得到、npm 的 files 白名单把它带上了。
 */
test('qodbuddy2pi 有 install 子命令，且指向包内的同一个安装器', () => {
  const entry = read('assets/qodbuddy2pi');
  assert.match(entry, /cmd === 'install'/, '入口应识别 install 子命令');
  assert.match(entry, /runInstaller/, '入口应有 runInstaller 实现');
  // 必须去找 install.sh / install.ps1，而不是另写一套安装逻辑
  assert.match(entry, /install\.sh/, 'runInstaller 应调 install.sh');
  assert.match(entry, /install\.ps1/, 'runInstaller 应调 install.ps1');
});

test('npm 的 files 白名单带上了安装器与 vendored 依赖', () => {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.files || [];
  for (const need of ['install.sh', 'install.ps1']) {
    assert.ok(files.includes(need), `package.json 的 files 应包含 ${need}`);
  }
  assert.ok(
    files.some((f) => f.startsWith('assets/vendor')),
    'package.json 的 files 应包含 assets/vendor（扩展副本与反代 wheel）',
  );
  // bin 指向的入口也要被打包，否则 npm i -g 装出四个断链的命令
  for (const target of Object.values(pkg.bin || {})) {
    assert.ok(files.includes(target), `files 应包含 bin 入口 ${target}`);
  }
});

test('release 包的 start.sh / start.cmd 调的是同一个安装器', () => {
  const rel = read('make-release.sh');
  assert.match(rel, /install\.sh/, 'start.sh 应调 install.sh');
  assert.match(rel, /install\.ps1/, 'start.cmd 应调 install.ps1');
  // 压缩包内容必须来自 npm pack，两边才不会漂移
  assert.match(rel, /npm pack/, 'release 内容应来自 npm pack');
});

test('qoder 扩展装的是稳定副本，不是仓库或解压目录', () => {
  // pi install 记录的是路径引用；指向仓库 / 临时解压目录的话，
  // 仓库挪走或 release 包被删之后 provider 就失效了。
  assert.match(SH, /\.qoder2pi\/vendor/, 'install.sh 应把扩展复制到 ~/.qoder2pi/vendor');
  assert.match(PS1, /\\.qoder2pi\\vendor/, 'install.ps1 应把扩展复制到 ~/.qoder2pi/vendor');
  // 两份脚本都不该把 vendorQoder 直接指到 $Here / $Res 下的源目录
  assert.ok(
    !/\"vendorQoder\": \"\$vendor\"/.test(SH),
    'install.sh 的 vendorQoder 不该直接指向仓库里的源目录',
  );
});

test('发布流程：打 tag 时同时出 npm 包与四个平台的压缩包', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /tags:/, 'workflow 应监听 tag');
  assert.match(wf, /npm test/, '发布前应跑测试');
  assert.match(wf, /npm publish/, '应发布到 npm');
  assert.match(wf, /make-release\.sh/, '应生成压缩包');
  assert.match(wf, /SHA256SUMS/, '应产出校验值文件');
  // 压缩包内容必须来自 npm pack，两条路径才不会漂移
  const rel = read('make-release.sh');
  assert.match(rel, /npm pack/, 'make-release.sh 内容应来自 npm pack');
});

test('一行流：没有 assets/ 时自己下载 release 再 exec 真正的安装器', () => {
  // curl … | sh 时 stdin 被脚本占着，必须先下载再拿回终端，见 ADR 0006。
  assert.match(SH, /BOOTSTRAPPED/, 'install.sh 应有一行流引导层（带哨兵变量防止递归）');
  assert.match(SH, /releases\/latest\/download/, '引导层应下载 latest release');
  assert.match(SH, /dev\/tty/, '引导层应把终端接回来，否则提问读不到输入');
  assert.match(SH, /--non-interactive/, '没有终端时应退成全自动，不能挂住');

  assert.match(PS1, /BOOTSTRAPPED/, 'install.ps1 应有一行流引导层');
  assert.match(PS1, /releases\/latest\/download/, 'install.ps1 引导层应下载 latest release');
  assert.match(PS1, /Expand-Archive/, 'install.ps1 引导层应解压后执行');
});

test('release 同时产出固定文件名，一行流的 URL 才能长期有效', () => {
  const rel = read('make-release.sh');
  // .../releases/latest/download/qodbuddy2pi.tar.gz 这种 URL 要求文件名不带版本号
  assert.match(rel, /OUT\/qodbuddy2pi\.tar\.gz/, 'make-release.sh 应产出固定名 tar.gz');
  assert.match(rel, /OUT\/qodbuddy2pi\.zip/, 'make-release.sh 应产出固定名 zip');
  assert.match(rel, /\$NAME\.tar\.gz/, 'make-release.sh 应另留一份带版本号的');
  // CI 里要确认这些固定名真的在，否则一行流 404
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /固定文件名/, 'workflow 应校验固定文件名存在');
  assert.match(wf, /qodbuddy2pi\.tar\.gz/, 'workflow 校验的应是固定名');
});

test('README 首页给出一行安装命令（不必先克隆仓库）', () => {
  const readme = read('README.md');
  assert.match(readme, /curl -fsSL \S+install\.sh \| sh/, 'README 应有 curl|sh 一行安装');
  assert.match(readme, /irm \S+install\.ps1 \| iex/, 'README 应有 irm|iex 一行安装');
  assert.match(readme, /npm i -g/, 'README 应有 npm 安装');
});

test('release 只出平台无关的包（不做无意义的分平台）', () => {
  const rel = read('make-release.sh');
  // 产物全部是文本（JS/TS/JSON）加一个 py3-none-any 的 wheel，没有编译产物，
  // 所以不该再按 darwin/linux/win32 各打一份——那四份解出来逐字节相同。
  assert.ok(
    !/TARGETS=\s*\(\s*darwin/.test(rel),
    'make-release.sh 不该再按平台分四个包（内容完全相同）',
  );
  assert.match(rel, /qodbuddy2pi\.tar\.gz/, '应产出固定名 tar.gz 供一行流下载');
  assert.match(rel, /qodbuddy2pi\.zip/, '应产出 zip 供 Windows 用');

  // vendored wheel 必须是平台无关的 py3-none-any
  const wheels = fs.readdirSync(path.join(ROOT, 'assets', 'vendor'))
    .filter((f) => f.endsWith('.whl'));
  assert.ok(wheels.length > 0, 'assets/vendor 下应有 wheel');
  for (const w of wheels) {
    assert.match(w, /py3-none-any\.whl$/, `${w} 不是平台无关的 wheel，那就真需要分平台了`);
  }
});

test('两份 README 互为语言切换入口（默认中文）', () => {
  const zh = read('README.md');
  const en = read('README.en.md');
  assert.match(zh, /href="\.\/README\.en\.md"/, '中文版应链到英文版');
  assert.match(en, /href="\.\/README\.md"/, '英文版应链回中文版');
  assert.match(zh, /<strong>简<\/strong>/, '中文版应把自己标成当前语言');
  assert.match(en, /<strong>EN<\/strong>/, '英文版应把自己标成当前语言');
  // 默认是中文：README.md 不该是英文正文
  assert.ok(!/^## What is this$/m.test(zh), 'README.md 应是中文（默认）');
});

test('README 头部有平台徽章与下载量', () => {
  const zh = read('README.md');
  for (const [re, what] of [
    [/badge\/Windows/, 'Windows 徽章'],
    [/badge\/macOS/, 'macOS 徽章'],
    [/badge\/Linux/, 'Linux 徽章'],
    [/github\/downloads/, '下载量徽章'],
  ]) {
    assert.match(zh, re, `README 应有${what}`);
  }
});

// ---------------------------------------------------------------- opencode 接入

/**
 * opencode 侧的接入靠三样东西串起来：代理脚本（assets/qoder-proxy.js）、
 * 运维命令的 opencode/proxy 子命令、以及安装器把它部署到 ~/.qoder2pi/vendor。
 * 任何一环断了都不会在开发机上显形（开发时都是手工跑），所以在这里钉住。
 */
test('两份安装脚本都部署 qoder-proxy.js', () => {
  assert.ok(shFileList().includes('qoder-proxy.js'), 'install.sh 的清单应包含 qoder-proxy.js');
  assert.ok(ps1FileList().includes('qoder-proxy.js'), 'install.ps1 的清单应包含 qoder-proxy.js');
  assert.match(SH, /qoder-proxy\.js/, 'install.sh 应把代理复制到 ~/.qoder2pi/vendor');
  assert.match(PS1, /qoder-proxy\.js/, 'install.ps1 应把代理复制到 ~/.qoder2pi/vendor');
});

test('npm 打包带上代理脚本', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok((pkg.files || []).includes('assets/qoder-proxy.js'), 'files 应包含 assets/qoder-proxy.js');
});

test('qoder2pi 有 opencode 与 proxy 子命令', () => {
  const entry = read('assets/qoder2pi');
  assert.match(entry, /case 'proxy'/, '应识别 proxy 子命令');
  assert.match(entry, /case 'opencode'/, '应识别 opencode 子命令');
  assert.match(entry, /function cmdProxy/, '应有 cmdProxy 实现');
  assert.match(entry, /function cmdOpencode/, '应有 cmdOpencode 实现');
});

test('opencode 配置写入是合并而不是覆盖（不弄丢用户已有的 provider）', () => {
  // 合并逻辑收在共享模块里之后，三家共用同一份实现，所以检查那里
  const mod = read('assets/opencode-config.js');
  assert.match(mod, /\.\.\.\(existing\.provider \|\| \{\}\)/, '写配置时应展开已有的 provider');
  assert.match(mod, /\.\.\.existing/, '顶层设置原样保留');
  assert.match(mod, /bak-/, '改写前应备份原配置');
  // 两家的运维命令都必须走这个共享模块，不能各写一套
  for (const f of ['assets/qoder2pi', 'assets/workbuddy2pi']) {
    assert.match(read(f), /opencode-config\.js/, `${f} 应复用 opencode-config.js`);
  }
});

test('代理是常驻服务，三个平台都有实现', () => {
  const entry = read('assets/qoder2pi');
  assert.match(entry, /launchctl/, 'macOS 应用 launchd');
  assert.match(entry, /systemctl/, 'Linux 应用 systemd --user');
  assert.match(entry, /schtasks/, 'Windows 应用计划任务');
  // Windows 上 /End 不会带走 .cmd 循环拉起的 node，必须按端口收
  assert.match(entry, /taskkill/, 'Windows 上应按端口结束子进程');
});

test('代理的两个区域端口与服务名互相独立', () => {
  const entry = read('assets/qoder2pi');
  assert.match(entry, /8789/, '国内版代理应在 8789');
  assert.match(entry, /8790/, '国际版代理应在 8790');
  assert.match(entry, /qoder2pi-proxy/, '应有独立服务名');
});

test('README 与文档提到 opencode 接入', () => {
  assert.match(read('README.md'), /opencode/, 'README 应说明 opencode 接入');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'opencode.md')), '应有 docs/opencode.md');
});

test('两份安装脚本都会在装了 Qoder 且找到 opencode 时自动接入', () => {
  assert.match(SH, /opencode install/, 'install.sh 应调 qoder2pi opencode install');
  assert.match(PS1, /opencode.*install/s, 'install.ps1 应调 qoder2pi opencode install');
});

// ---------------------------------------------------------------- 积分/签到扩展

/**
 * 积分扩展的部署形态有两个硬约束，任何一条破了都会静默失效：
 *   1. pi 只认目录里的 index.ts / index.js 作入口，credits.ts 必须装成 index.ts
 *   2. 扩展用 createRequire 去 require 同目录的 quota.js，两者必须同目录
 * 所以在这里钉住。
 */
test('两份安装脚本都把 credits.ts 装成 index.ts，并与 quota.js 同目录', () => {
  assert.match(SH, /credits\.ts.*index\.ts/s, 'install.sh 应把 credits.ts 装成 index.ts');
  assert.match(PS1, /credits\.ts.*index\.ts/s, 'install.ps1 应把 credits.ts 装成 index.ts');
  assert.match(SH, /extensions\/qodbuddy2pi/, 'install.sh 应部署到 extensions/qodbuddy2pi');
  assert.match(PS1, /extensions\\qodbuddy2pi/, 'install.ps1 应部署到 extensions\qodbuddy2pi');
  // quota.js 必须一起装到同一目录，否则扩展 require 不到
  assert.match(SH, /quota\.js.*EXT_DIR|EXT_DIR.*quota\.js/s, 'install.sh 应把 quota.js 装到扩展目录');
  assert.match(PS1, /quota\.js.*ExtDir|ExtDir.*quota\.js/s, 'install.ps1 应把 quota.js 装到扩展目录');
});

test('积分扩展用 createRequire 加载同目录的 quota.js（不是 ESM import）', () => {
  const ext = read('assets/credits.ts');
  assert.match(ext, /createRequire/, 'quota.js 是 CommonJS，必须用 createRequire');
  assert.match(ext, /import\.meta\.dirname/, '应相对于扩展自身目录解析，而不是写死路径');
  assert.match(ext, /quota\.js/, '应 require quota.js');
});

test('积分扩展注册了 /credits 命令与 credits 工具', () => {
  const ext = read('assets/credits.ts');
  assert.match(ext, /registerCommand\("credits"/, '应有 /credits 命令');
  assert.match(ext, /registerTool\(creditsTool\)/, '应注册 credits 工具');
  assert.match(ext, /name:\s*"credits"/, '工具名应为 credits');
});

test('npm 打包带上积分数据层与扩展', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const need of ['assets/quota.js', 'assets/credits.ts']) {
    assert.ok((pkg.files || []).includes(need), `files 应包含 ${need}`);
  }
});

test('qoder2pi 有 credits 子命令，并与扩展共用同一个数据层', () => {
  const entry = read('assets/qoder2pi');
  assert.match(entry, /case 'credits'/, '应识别 credits 子命令');
  assert.match(entry, /function cmdCredits/, '应有 cmdCredits 实现');
  // 不能另写一套取数逻辑，否则 /credits 与 qoder2pi credits 会给出不同数字
  assert.match(entry, /loadQuota/, '应通过 loadQuota 复用 quota.js');
});

test('积分插件不伪造设备身份（不内联 Trae 的签到上游调用）', () => {
  const q = read('assets/quota.js');
  // Trae 签到需要设备指纹；我们明确不做，只读本机反代
  assert.match(q, /unsupported: true/, 'Trae 签到应显式标记为不支持');
  assert.ok(!/trae\.cn\/api|api\.trae\.cn/.test(q), '不该直接打 Trae 官方接口');
});

test('README 与文档提到积分/签到', () => {
  assert.match(read('README.md'), /credits/, 'README 应说明积分/签到');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'credits.md')), '应有 docs/credits.md');
});

// ---------------------------------------------------------------- WorkBuddy → opencode

test('workbuddy2pi 有 opencode 子命令，并复用共享配置模块', () => {
  const entry = read('assets/workbuddy2pi');
  assert.match(entry, /case 'opencode'/, '应识别 opencode 子命令');
  assert.match(entry, /function cmdOpencode/, '应有 cmdOpencode 实现');
  assert.match(entry, /opencode-config\.js/, '应复用 opencode-config.js');
});

test('opencode-config.js 同时认反代与 qoder-proxy 的模型结构', () => {
  const mod = read('assets/opencode-config.js');
  // WorkBuddy 反代是 {id, display_name, context_window}；qoder-proxy 是 {id, name, limit{context,output}}
  assert.match(mod, /display_name/, '应认 WorkBuddy 的 display_name');
  assert.match(mod, /context_window/, '应认 WorkBuddy 的 context_window');
  assert.match(mod, /limit\.context/, '应认 qoder-proxy 的 limit.context');
});

test('opencode-config.js 支持 XDG 与测试用的路径覆盖', () => {
  const mod = read('assets/opencode-config.js');
  assert.match(mod, /XDG_CONFIG_HOME/, '应尊重 XDG_CONFIG_HOME');
  assert.match(mod, /QODBUDDY_OPENCODE_CONFIG/, '应允许覆盖路径（便于测试）');
});

// ---------------------------------------------------------------- WorkBuddy 国际版

/**
 * 国际站从 2026-10-16 起强制校验 X-Conversation-* 头族与「首条是 system prompt」，
 * 反代 2.0.7 才补上；而它的注入条件是 URL 里含 "codebuddy.ai"。端点一旦写回
 * workbuddy.ai，头就不注入、每个请求都 400/11128，报错信息与「版本没升级」一模一样。
 * 这个坑排查了两轮，钉住它。
 */
test('国际版端点必须是 codebuddy.ai（否则 2.0.7 的头注入不生效）', () => {
  const entry = read('assets/workbuddy2pi');
  const globalBlock = entry.slice(entry.indexOf("key: 'global'"), entry.indexOf("key: 'global'") + 1200);
  assert.match(globalBlock, /https:\/\/www\.codebuddy\.ai/, '国际版 endpoint 应为 www.codebuddy.ai');
  assert.ok(
    !/endpoint:\s*'https:\/\/www\.workbuddy\.ai'/.test(globalBlock),
    '不能把 endpoint 写成 workbuddy.ai，那会让 X-Conversation-* 头不注入',
  );
});

test('vendored 反代是 2.0.7 或更新', () => {
  const wheels = fs
    .readdirSync(path.join(ROOT, 'assets', 'vendor'))
    .filter((n) => /^workbuddy2api-\d+\.\d+\.\d+-.*\.whl$/.test(n))
    .sort();
  assert.ok(wheels.length > 0, 'assets/vendor 下应有 workbuddy2api wheel');
  const latest = wheels[wheels.length - 1];
  // 文件名形如 workbuddy2api-2.0.7-py3-none-any.whl，先剥掉包名与后缀再比版本
  const [major, minor, patch] = latest
    .replace(/^workbuddy2api-/, '')
    .split('-')[0]
    .split('.')
    .map(Number);
  const atLeast207 = major > 2 || (major === 2 && (minor > 0 || patch >= 7));
  assert.ok(atLeast207, `反代需 >= 2.0.7（国际站渠道校验），当前是 ${latest}`);
});

test('workbuddy2pi 会提示「服务在跑旧 wheel」', () => {
  const entry = read('assets/workbuddy2pi');
  assert.match(entry, /staleServiceWheel/, '应有旧 wheel 检测');
  // 服务定义里写死的是 wheel 绝对路径，升级 wheel 后必须重装服务才生效
  assert.match(entry, /install-service/, '应提示重装服务');
});

test('opencode 的 WorkBuddy 模型列表优先取自 pi', () => {
  const entry = read('assets/workbuddy2pi');
  assert.match(entry, /opencodeModelsFromPi/, '应优先用 pi 的模型清单');
  // 反代的静态表与服务端真实可用集对不上，只能兜底
  assert.match(entry, /退回反代的模型表/, 'pi 不可用时应说明退回了反代的表');
});
