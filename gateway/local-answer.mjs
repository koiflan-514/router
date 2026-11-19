/**
 * 本地应答：五个不花额度的固定问题。
 *
 * 移植自 dsh-our-free-model 的 `src/local-optimize.js`（MIT）。Claude Code 每一轮
 * 都会发一批**答案已经写在请求体里**的固定问题：
 *
 *   - 额度探测（`max_tokens:1` + "quota"）
 *   - 权限提示背后的命令前缀（`<policy_spec>` + `Command:`）
 *   - 会话标题生成
 *   - 建议模式（`[SUGGESTION MODE:`）
 *   - 从 `Command:`/`Output:` 里提取文件路径
 *
 * 把这些问题转发到上游，等于用订阅额度换一个只有一个正确答案的问题，还多花一次
 * 往返。每个检测器只读请求形状、返回固定答案；不匹配的请求原样放过。
 *
 * 三条纪律（都是原实现刻意保留的）：
 *   - 只读请求，不改请求——不匹配就 `null`，绝不「猜一个」；
 *   - 顺序固定（便宜且高频的在前），配额探测一个整数加一次子串就能短路；
 *   - 答案里的 token 数非零但很小——为零会被某些客户端读成空响应。
 */

import { randomUUID } from 'node:crypto';

/** 求值顺序：最便宜、最高频的在前。 */
export const OPTIMIZATIONS = ['quota', 'prefix', 'title', 'suggestion', 'filepath'];

/** 第二个词才是操作的命令，前缀要取两个词。 */
const TWO_WORD_COMMANDS = new Set(['git', 'npm', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'yarn', 'pnpm', 'bun']);

/** 只列名字、不读内容的命令：没有路径可提取。 */
const LISTING_COMMANDS = new Set(['ls', 'dir', 'find', 'tree', 'pwd', 'cd', 'mkdir', 'rmdir', 'rm']);

/** 读内容的命令：非 flag 参数就是路径。 */
const READING_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type']);

/** 会吃掉后一个参数的 grep flag。 */
const GREP_FLAGS_WITH_ARGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C']);

/** shell 风格的 `NAME=value`，出现在命令之前。 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/;

const EMPTY_FILEPATHS = '<filepaths>\n</filepaths>';

/** 拼接消息体或 system 块的文本。块之间不加分隔符：检测器做子串匹配，插入分隔符会切断跨块的短语。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block?.text === 'string' && block.text !== '') text += block.text;
  }
  return text;
}

/** 顶层 system 文本加上所有内联 system 消息。 */
function systemText(request) {
  const parts = [];
  const top = textOf(request?.system);
  if (top !== '') parts.push(top);
  for (const message of request?.messages ?? []) {
    if (message?.role !== 'system') continue;
    const text = textOf(message.content);
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 唯一的对话 user 轮次，忽略 system。
 * 有两个 user 轮次、有 assistant、有工具答案时返回 undefined——形状不对就不猜。
 */
function singleUserTurn(request) {
  let turn;
  for (const message of request?.messages ?? []) {
    if (message?.role === 'system') continue;
    if (message?.role !== 'user' || turn !== undefined) return undefined;
    turn = message;
  }
  return turn;
}

/** 请求有没有声明工具——标题/路径这类问题永远不带工具。 */
function hasTools(request) {
  const tools = request?.tools;
  return Array.isArray(tools) ? tools.length > 0 : Boolean(tools);
}

/** 反斜杠在引号外能转义的字符；其它位置的反斜杠是路径分隔符。 */
const ESCAPABLE = new Set([' ', '\t', '\n', '\r', '\f', '\v', "'", '"']);

/**
 * 把命令行拆成 shell words，但不执行任何东西。
 *
 * 只建模权限提示会出现的形状：空白分隔、单双引号（去掉，所以带引号的路径还原成路径）、
 * 反斜杠转义。反斜杠只在空白或引号前才是转义——其它位置是字面量，于是
 * `type C:\notes\todo.md` 这种 Windows 路径不会被 POSIX 语义吃掉 `\n`。
 * 引号不配对时抛错，让调用方走它自己的朴素切分兜底（shell 本身也会拒绝这一行）。
 */
function shellWords(command) {
  const words = [];
  let word = null;
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = '';
        continue;
      }
      if (char === '\\') {
        const next = command[index + 1];
        // 双引号内 shell 只剥掉有意义的字符前的反斜杠
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          word += next;
          index += 1;
        } else word += '\\';
        continue;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (word === null) word = '';
      continue;
    }
    if (char === '\\' && ESCAPABLE.has(command[index + 1])) {
      if (word === null) word = '';
      word += command[index + 1];
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (word !== null) {
        words.push(word);
        word = null;
      }
      continue;
    }
    if (word === null) word = '';
    word += char;
  }
  if (quote !== '') throw new Error('no closing quotation');
  if (word !== null) words.push(word);
  return words;
}

function isEnvAssignment(part) {
  return ENV_ASSIGNMENT.test(part);
}

function stripEnvAssignments(parts) {
  let start = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break;
    start = index + 1;
  }
  return parts.slice(start);
}

/**
 * 权限提示问的命令前缀：`git`、`git commit`、`npm install`。
 *
 * 带命令替换（反引号 / `$(`）的整行会被执行第二条命令，所以如实报告
 * `command_injection_detected` 而不是去解析它。
 */
export function extractCommandPrefix(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.includes('`') || text.includes('$(')) return 'command_injection_detected';

  let parts;
  try {
    parts = shellWords(text);
  } catch {
    // shell 本身会拒绝这一行；用空白切分回答，而不是去猜引号
    const fallback = stripEnvAssignments(text.split(/\s+/).filter((part) => part !== ''));
    return fallback.length > 0 ? fallback[0] : 'none';
  }
  if (parts.length === 0) return 'none';

  const env = [];
  let start = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break;
    env.push(parts[index]);
    start = index + 1;
  }
  if (start >= parts.length) return 'none';

  const commandParts = parts.slice(start);
  const first = commandParts[0];
  if (TWO_WORD_COMMANDS.has(first) && commandParts.length > 1) {
    const second = commandParts[1];
    if (!second.startsWith('-')) return `${first} ${second}`;
    return first;
  }
  // 单字命令保留 env 前缀（`FOO=1 ls`），双字命令丢掉（`FOO=1 git status` 答 `git status`）。
  // 两者都只是对话框里的标签，不是要执行的命令。
  return env.length === 0 ? first : `${env.join(' ')} ${first}`;
}

/** 命令读的路径，放在 Claude Code 解析的 `<filepaths>` 块里。 */
export function extractFilepathsFromCommand(command) {
  const text = typeof command === 'string' ? command : '';
  let parts;
  try {
    parts = shellWords(text);
  } catch {
    return EMPTY_FILEPATHS;
  }
  const commandParts = stripEnvAssignments(parts);
  if (commandParts.length === 0) return EMPTY_FILEPATHS;

  const base = commandParts[0].split('/').pop().split('\\').pop().toLowerCase();
  if (LISTING_COMMANDS.has(base)) return EMPTY_FILEPATHS;
  if (READING_COMMANDS.has(base)) {
    return filepathBlock(commandParts.slice(1).filter((part) => !part.startsWith('-')));
  }
  if (base !== 'grep') return EMPTY_FILEPATHS;

  // `-e pattern` / `--regexp pattern` 已经给了 pattern，剩下的位置参数全是路径；
  // 否则第一个位置参数是 pattern，其余是路径。
  let patternViaFlag = false;
  const positional = [];
  let skipNext = false;
  for (const part of commandParts.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!part.startsWith('-')) {
      positional.push(part);
      continue;
    }
    if (part === '-e' || part === '-f' || part === '--regexp') {
      patternViaFlag = true;
      skipNext = true;
    } else if (part.startsWith('--regexp=')) {
      patternViaFlag = true;
    } else if (GREP_FLAGS_WITH_ARGS.has(part)) {
      skipNext = true;
    }
  }
  return filepathBlock(patternViaFlag ? positional : positional.slice(1));
}

function filepathBlock(paths) {
  return paths.length === 0 ? EMPTY_FILEPATHS : `<filepaths>\n${paths.join('\n')}\n</filepaths>`;
}

/** `Output:` 段到第一个标签或空行为止（Claude Code 的提示会在其后追加自己的标记）。 */
function truncateOutput(output) {
  let text = output;
  for (const marker of ['<', '\n\n']) {
    if (text.includes(marker)) text = text.split(marker)[0].trim();
  }
  return text;
}

/** `max_tokens:1` 加一个只说 "quota" 的 user 轮次 = 额度探测。 */
function quotaAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined) return null;
  const maxTokens = request?.max_tokens;
  // 线上可能传字符串形式的数字
  if (!(maxTokens === 1 || maxTokens === '1')) return null;
  if (!textOf(message.content).toLowerCase().includes('quota')) return null;
  return { text: 'Quota check passed.', usage: { input: 10, output: 5 } };
}

/** policy spec 加 `Command:` 段 = 权限前缀询问。 */
function prefixAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined) return null;
  const content = textOf(message.content);
  if (!content.includes('<policy_spec>') || !content.includes('Command:')) return null;
  // 最后一个标记优先：上面的 policy spec 本身可能引用了这个词
  const start = content.lastIndexOf('Command:') + 'Command:'.length;
  return { text: extractCommandPrefix(content.slice(start).trim()), usage: { input: 100, output: 5 } };
}

/** 标题提示靠 system 文本识别，且永远不带工具。 */
function titleAnswer(request) {
  if (hasTools(request)) return null;
  const system = systemText(request).toLowerCase();
  if (!system.includes('title')) return null;
  const sentenceCase = system.includes('sentence-case title');
  const jsonField =
    system.includes('return json') &&
    system.includes('field') &&
    (system.includes('coding session') || system.includes('this session'));
  if (!sentenceCase && !jsonField) return null;
  return { text: 'Conversation', usage: { input: 100, output: 5 } };
}

/** 建议模式的标记可能在任何 user 消息里；答案是空字符串。 */
function suggestionAnswer(request) {
  for (const message of request?.messages ?? []) {
    if (message?.role !== 'user') continue;
    if (textOf(message.content).includes('[SUGGESTION MODE:')) {
      return { text: '', usage: { input: 100, output: 1 } };
    }
  }
  return null;
}

/** `Command:`/`Output:` 组合在问文件路径，且没有工具参与。 */
function filepathAnswer(request) {
  const message = singleUserTurn(request);
  if (message === undefined || hasTools(request)) return null;
  const content = textOf(message.content);
  if (!content.includes('Command:') || !content.includes('Output:')) return null;

  const lower = content.toLowerCase();
  const userNamesFilepaths = lower.includes('filepaths') || lower.includes('<filepaths>');
  const system = systemText(request).toLowerCase();
  const systemAsksForPaths =
    system.includes('extract any file paths') || system.includes('file paths that this command');
  if (!userNamesFilepaths && !systemAsksForPaths) return null;

  const start = content.indexOf('Command:') + 'Command:'.length;
  const marker = content.indexOf('Output:', start);
  if (marker === -1) return null;
  const command = content.slice(start, marker).trim();
  const output = truncateOutput(content.slice(marker + 'Output:'.length).trim());
  void output; // 路径来自命令本身，不看输出
  return { text: extractFilepathsFromCommand(command), usage: { input: 100, output: 10 } };
}

const DETECTORS = {
  quota: quotaAnswer,
  prefix: prefixAnswer,
  title: titleAnswer,
  suggestion: suggestionAnswer,
  filepath: filepathAnswer,
};

function firstAnswer(request, enabled) {
  for (const kind of OPTIMIZATIONS) {
    if (enabled?.[kind] === false) continue;
    const answer = DETECTORS[kind](request);
    if (answer !== null) return { kind, ...answer };
  }
  return null;
}

/** 这个请求会被哪个优化本地应答（不真答，用于诊断）。 */
export function detectOptimization(request, enabled) {
  return firstAnswer(request, enabled)?.kind ?? null;
}

/**
 * 本地应答这个请求，或者返回 null 表示要转发上游。
 *
 * @param {object} request Anthropic Messages 形状的请求体
 * @param {object} [options]
 * @param {object} [options.enabled] 五项各自开关；省略 = 开，false = 关
 * @param {string} [options.model] 答案归属的模型名
 */
export function tryOptimizations(request, options = {}) {
  const answer = firstAnswer(request, options?.enabled);
  if (answer === null) return null;
  const model = options?.model ?? request?.model;
  return { kind: answer.kind, text: answer.text, usage: answer.usage, model: typeof model === 'string' ? model : '' };
}

/** 把本地答案包成 Anthropic Messages 响应。 */
export function toMessagesResponse(result, { model, id } = {}) {
  return {
    id: typeof id === 'string' && id !== '' ? id : `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: model ?? result?.model ?? '',
    content: [{ type: 'text', text: result?.text ?? '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: result?.usage?.input ?? 0,
      output_tokens: result?.usage?.output ?? 0,
    },
  };
}

/** 把本地答案包成 OpenAI chat.completion 响应（给 /v1/chat/completions 用）。 */
export function toChatResponse(result, { model } = {}) {
  const prompt = result?.usage?.input ?? 0;
  const completion = result?.usage?.output ?? 0;
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? result?.model ?? '',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result?.text ?? '' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}
