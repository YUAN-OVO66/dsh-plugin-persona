/**
 * 人格（Persona）持久化存储。
 *
 * 为什么单独成模块：这里是本插件**唯一**的持久状态面 —— 人格库、默认人格、以及每个会话
 * 的人格绑定全都写在这一份 JSON 里。把它从 `index.js` 里拆出来，是为了让「路径怎么推导」
 * 与「写入纪律」各自可读可测。
 *
 * 不变量：
 *  1. **原子发布**：先写 `<file>.tmp<pid><序号>` + `fsync` 再 `rename`（跨设备/被占用的兜底
 *     是最朴素的覆盖写）。崩溃/断电只会留下旧文件或新文件，绝不留下截断的半份。
 *  2. **临时名每次调用唯一**：同一目标文件的并发写者不共用同一个 `.tmp`（共用会互相 rename
 *     对方的半截内容）。
 *  3. **所有读-改-写过 `mutate()`**：写入是「读快照 → 改 → 整份写」三步，并发时后写者基于旧
 *     快照会吞掉先写者的改动。用一条 promise 链排队，让每次读-改-写完整跑完再开始下一次。
 *  4. **读永不抛**：坏 JSON / 缺字段一律回落到默认值，调用方不必 try/catch。
 *  5. 落盘位置可用 `DSH_PERSONA_STORE` 整体覆盖（自检脚本靠它隔离，绝不写真目录）。
 *
 * @module dsh-plugin-persona/lib/store
 */
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 存储格式版本。升级时靠 `migrate()` 把旧形状补成新形状。 */
export const STORE_VERSION = 1;

/** 人格名长度上限（防止把整段提示词塞进 id）。 */
export const MAX_NAME_LENGTH = 64;
/** 单个人格 prefix/suffix 的字节上限。 */
export const MAX_TEXT_BYTES = 64 * 1024;
/** 人格库容量上限 —— 超出会让设置页与选择器都失去可用性。 */
export const MAX_PERSONAS = 200;

/**
 * 存储文件路径。默认落在 `$DSH_HOME/persona/personas.json`（`DSH_HOME` 默认 `~/.dsh`），
 * 与其它插件的数据目录同级；`DSH_PERSONA_STORE` 可整体覆盖。
 * @returns 绝对路径。
 */
export function storePath() {
  const override = process.env.DSH_PERSONA_STORE;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'persona', 'personas.json');
}

/** 一条人格定义。`prefix`/`suffix` 是实际注入系统提示词的模板文本。 */
function blankState() {
  return { version: STORE_VERSION, defaultId: null, personas: [], bindings: {} };
}

/** 只接受纯对象（数组也是 typeof 'object'，放进来会让后续赋值静默丢失）。 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function asText(value, max = MAX_TEXT_BYTES) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 把一条任意输入规整成合法人格；不合法返回 `undefined`。
 * @param raw - 待规整的值。
 * @param index - 缺 id 时用来兜底生成。
 */
export function normalizePersona(raw, index = 0) {
  const o = asObject(raw);
  if (o === undefined) return undefined;
  const name = asText(o.name, MAX_NAME_LENGTH).trim();
  if (name.length === 0) return undefined;
  const id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : `persona-${index + 1}`;
  const persona = {
    id,
    name,
    description: asText(o.description, 512),
    emoji: asText(o.emoji, 8),
    prefix: asText(o.prefix),
    suffix: asText(o.suffix),
    complete: o.complete === true,
    suppressRuntimeContext: o.suppressRuntimeContext === true,
    builtin: o.builtin === true,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date().toISOString(),
  };
  return persona;
}

/** 规整一份可能来自旧版本或手改的文件。永不抛。 */
export function normalizeState(raw) {
  const o = asObject(raw);
  if (o === undefined) return blankState();
  const seen = new Set();
  const personas = [];
  const list = Array.isArray(o.personas) ? o.personas : [];
  for (let i = 0; i < list.length && personas.length < MAX_PERSONAS; i++) {
    const persona = normalizePersona(list[i], i);
    if (persona === undefined) continue;
    let id = persona.id;
    let n = 1;
    while (seen.has(id)) id = `${persona.id}-${n++}`;
    seen.add(id);
    personas.push({ ...persona, id });
  }
  const ids = new Set(personas.map((p) => p.id));
  const defaultId = typeof o.defaultId === 'string' && ids.has(o.defaultId) ? o.defaultId : null;
  const bindings = {};
  const rawBindings = asObject(o.bindings);
  if (rawBindings !== undefined) {
    for (const [sessionId, value] of Object.entries(rawBindings)) {
      const entry = asObject(value);
      if (entry === undefined) continue;
      const personaId = typeof entry.personaId === 'string' && ids.has(entry.personaId) ? entry.personaId : null;
      const custom = asText(entry.custom);
      if (personaId === null && custom.length === 0) continue;
      bindings[sessionId] = {
        ...(personaId === null ? {} : { personaId }),
        ...(custom.length === 0 ? {} : { custom }),
        ...(typeof entry.mode === 'string' ? { mode: entry.mode } : {}),
        ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
      };
    }
  }
  return { version: STORE_VERSION, defaultId, personas, bindings };
}

/** 创建存储句柄。`ctx` 只用于日志，可为空。 */
export function createStore(log = () => {}) {
  let cache;

  function read() {
    const path = storePath();
    try {
      cache = normalizeState(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`persona: 读取 ${path} 失败，改用空库：${String(error?.message ?? error)}`);
      cache = cache ?? blankState();
    }
    return cache;
  }

  /** 当前内存快照（必要时从磁盘装载）。 */
  function state() {
    return cache ?? read();
  }

  function atomicWrite(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp${process.pid}${String(Date.now() % 1e6).padStart(6, '0')}`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, data);
    }
  }

  // 读-改-写排队：队列本身永不 reject，一次失败只影响它自己的调用方。
  let queue = Promise.resolve();
  function mutate(fn) {
    const run = async () => {
      const current = read();
      const next = normalizeState(fn(structuredClone(current)) ?? current);
      atomicWrite(storePath(), `${JSON.stringify(next, null, 2)}\n`);
      cache = next;
      return next;
    };
    const p = queue.then(run, run);
    queue = p.then(() => {}, () => {});
    return p;
  }

  return {
    path: storePath,
    state,
    reload: read,
    mutate,
    /** 只读地观察一次状态（不写盘）。 */
    peek: () => structuredClone(state()),
  };
}
