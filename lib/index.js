/**
 * DSH 人格管理器 —— Host 半。
 *
 * 这个插件做四件事：
 *  1. **人格库**：可增删改查的多套人设（`lib/store.js` 持久化到磁盘）。
 *  2. **默认人格**：新会话（未单独指定者）自动采用的人格。
 *  3. **会话级切换**：把某会话的人格提示词按作用域遮蔽（shadow）到 `agent.ctx` 上
 *     （`lib/runtime.js`），因此同一进程里不同会话可以各用各的人格。
 *  4. **模型工具**：让模型自己也能列人格、切人格、建人格。
 *
 * 为什么用 HTTP 路由而不是别的方式：浏览器半是动态 `dsh.client` 包，它是普通页面 JS
 * （有 `fetch`），而本包的 Host 半运行在进程内；两者之间的桥就是 `ctx.webServer` 上的
 * 一条前缀路由。这与 `dsh-plugin-wallpaper-engine` 的做法一致。
 *
 * @module dsh-plugin-persona
 */
import { createStore, normalizeState, MAX_PERSONAS } from './store.js';
import { createRuntime, resolvePersona } from './runtime.js';

/** 必须等 HTTP 服务器就绪后才能挂路由（与 Loader 的依赖顺序一致）。 */
export const inject = ['webServer'];

export const name = 'persona-manager';

/** 路由前缀。事件名、路径都带 `persona` 以免与其他插件相撞。 */
const API_PREFIX = '/dsh-persona/api';

/** 首次运行播种的示例人格 —— 让用户一打开设置页就有可切换的东西。 */
function seedPersonas() {
  const now = new Date().toISOString();
  const make = (id, emoji, personaName, description, prefix) => ({
    id,
    name: personaName,
    description,
    emoji,
    prefix,
    suffix: '',
    complete: false,
    suppressRuntimeContext: false,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  });
  return [
    make(
      'concise-architect',
      '🧱',
      '精简架构师',
      '先给结论，再给最少的必要细节；主动指出风险与取舍。',
      '回答时先给结论，再给支撑它的最少必要细节。主动指出你不确定的地方、以及这样做的代价。不要复述已经说过的内容。',
    ),
    make(
      'code-reviewer',
      '🔍',
      '严格评审员',
      '只报可复现、可定位、值得改的问题；按严重程度排序。',
      '像一位严格的资深评审员那样工作：只报告可复现、可定位、确实值得改的问题，按严重程度从高到低排列。每条问题给出证据（文件:行号或命令输出），不要给泛泛的风格意见。没有问题就直说没有问题。',
    ),
    make(
      'patient-teacher',
      '📚',
      '耐心的讲解者',
      '用类比和最小例子解释概念，先确认前提再深入。',
      '用中文耐心讲解。先用一个贴切的类比和一个最小可运行的例子建立直觉，再逐步深入细节；每讲一步都确认它建立在前一步之上。术语第一次出现时给出一句话定义。',
    ),
  ];
}

/** 播种只发生一次：文件里一个人格都没有、且默认也没设过。 */
function ensureSeeded(store) {
  const current = store.state();
  if (current.personas.length > 0 || current.defaultId !== null) return;
  return store.mutate((draft) => {
    if (draft.personas.length > 0 || draft.defaultId !== null) return draft;
    draft.personas = seedPersonas();
    return draft;
  });
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1 << 20; // 1 MiB：人格文本上限 64 KiB，留足余量。

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}

function textOf(value, max) {
  return typeof value === 'string' ? (value.length > max ? value.slice(0, max) : value) : '';
}

function newId(name, existing) {
  const base =
    textOf(name, 64)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'persona';
  const slug = /^[a-z0-9-]{1,24}$/.test(base) ? base : `p-${Date.now().toString(36)}`;
  let id = slug;
  let n = 1;
  while (existing.has(id)) id = `${slug}-${n++}`;
  return id;
}

/** 把请求里的字段规整进一条人格（id 由调用方决定）。 */
function personaFromInput(input, id, previous) {
  const now = new Date().toISOString();
  return {
    id,
    name: textOf(input.name, 64).trim() || previous?.name || id,
    description: textOf(input.description, 512).trim(),
    emoji: textOf(input.emoji, 8).trim(),
    prefix: textOf(input.prefix, 64 * 1024),
    suffix: textOf(input.suffix, 64 * 1024),
    complete: input.complete === true,
    suppressRuntimeContext: input.suppressRuntimeContext === true,
    builtin: previous?.builtin === true && input.builtin !== false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

// ── 插件本体 ──────────────────────────────────────────────────────────────────

/**
 * Host 半入口。
 * @param ctx - 插件上下文（`webServer` 由 `inject` 保证存在）。
 * @param config - 该行的配置（当前无字段，保留以便后续扩展）。
 */
export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* ignore */
    }
  };
  const store = createStore((message) => ctx.logger?.warn?.(message));
  const runtime = createRuntime({ log });

  // 播种是异步的（要落盘），但路由必须立刻可注册；两者互不阻塞。
  const ready = Promise.resolve(ensureSeeded(store)).catch((error) => {
    log(`persona: 播种示例人格失败：${String(error?.message ?? error)}`);
  });

  // 每个新 agent 一创建就把存储里的人格注入到它的作用域。
  ctx.effect(() =>
    ctx.on('agent/created', ({ agent }) => {
      void ready.then(() => {
        try {
          runtime.applyStored(agent, store.state());
        } catch (error) {
          log(`persona: 注入新会话 ${agent?.id} 失败：${String(error?.message ?? error)}`);
        }
      });
    }),
  );
  // agent 释放时清掉我们持有的注册（agent.ctx 会自己失效，但 Map 要一起收）。
  ctx.effect(() =>
    ctx.on('agent/disposed', (agent) => {
      const id = typeof agent === 'string' ? agent : agent?.id;
      if (id !== undefined) runtime.clear({ id, ctx: undefined });
    }),
  );
  ctx.effect(() => () => runtime.disposeAll());

  // 插件被重新加载（HMR / 重新启用）时，已经在跑的会话不会再收到 `agent/created`，
  // 而上次加载注册进去的人格会随之释放 —— 所以这里主动给已有 agent 补一遍。
  // 与 UI 的承诺一致：单独绑定过人格的会话继续用自己的，没绑定的回落到默认人格。
  void ready.then(() => {
    for (const agent of safeAgents()) {
      try {
        runtime.applyStored(agent, store.state());
      } catch (error) {
        log(`persona: 为已有会话 ${String(agent?.id)} 补注入失败：${String(error?.message ?? error)}`);
      }
    }
  });

  /**
   * 让一次存储变更加上「立刻重注入所有活跃会话」。
   * @param mutate - 对草稿的修改。
   * @param options - `reinject: false` 表示这次变更**不**触碰在线提示词
   *   （「下一个会话才生效」的切换必须走这条路：只落盘绑定，当前提示词保持原样）。
   * @returns 变更后的状态。
   */
  async function commit(mutate, options = {}) {
    const next = await store.mutate(mutate);
    if (options.reinject === false) return next;
    for (const agent of safeAgents()) {
      try {
        runtime.applyStored(agent, next);
      } catch (error) {
        log(`persona: 重注入 ${agent?.id} 失败：${String(error?.message ?? error)}`);
      }
    }
    return next;
  }

  function safeAgents() {
    try {
      const agents = ctx.get('agents');
      return agents?.list?.() ?? [];
    } catch {
      return [];
    }
  }

  /** 模型工具的注册状态：设置页会显示它，用来确认 Host 半的工具这一路真的活着。 */
  const toolStatus = { registered: [], error: null };

  /** 视图：给浏览器半的完整快照。 */
  function view(sessionId) {
    const state = store.state();
    const sessionBinding = sessionId === undefined ? undefined : state.bindings?.[sessionId];
    const effective = resolvePersona(state, sessionId);
    return {
      ok: true,
      defaultId: state.defaultId,
      personas: state.personas.map((persona) => ({
        id: persona.id,
        name: persona.name,
        description: persona.description,
        emoji: persona.emoji,
        prefix: persona.prefix,
        suffix: persona.suffix,
        complete: persona.complete === true,
        suppressRuntimeContext: persona.suppressRuntimeContext === true,
        builtin: persona.builtin === true,
        updatedAt: persona.updatedAt,
      })),
      session: sessionId === undefined ? null : { id: sessionId, binding: sessionBinding ?? null },
      effective: effective ?? null,
      storePath: store.path(),
      active: runtime.active(),
      limit: MAX_PERSONAS,
      tools: { registered: [...toolStatus.registered], error: toolStatus.error },
    };
  }

  /**
   * 一次调用的方法表。浏览器半只调 `POST {API_PREFIX}/call`，方法名与参数走 body，
   * 这样新增方法不必新增路由。
   */
  const methods = {
    state: (params) => view(typeof params.sessionId === 'string' ? params.sessionId : undefined),

    create: async (params) => {
      const input = params.persona ?? params;
      if (textOf(input.name, 64).trim().length === 0 && textOf(input.prefix, 64 * 1024).trim().length === 0) {
        throw new Error('新建人格至少要有名称或人格文本');
      }
      let created;
      await commit((draft) => {
        if (draft.personas.length >= MAX_PERSONAS) throw new Error(`人格数量已达上限（${MAX_PERSONAS}）`);
        const id = newId(input.name ?? '', new Set(draft.personas.map((p) => p.id)));
        created = personaFromInput(input, id, undefined);
        draft.personas.push(created);
        if (draft.defaultId === null && input.makeDefault === true) draft.defaultId = id;
        return draft;
      });
      return { ok: true, created };
    },

    update: async (params) => {
      const id = textOf(params.id, 64);
      let updated;
      await commit((draft) => {
        const index = draft.personas.findIndex((p) => p.id === id);
        if (index < 0) throw new Error(`没有 id 为 ${id} 的人格`);
        updated = personaFromInput({ ...params.persona, ...params }, id, draft.personas[index]);
        draft.personas[index] = updated;
        return draft;
      });
      return { ok: true, updated };
    },

    remove: async (params) => {
      const id = textOf(params.id, 64);
      await commit((draft) => {
        const index = draft.personas.findIndex((p) => p.id === id);
        if (index < 0) throw new Error(`没有 id 为 ${id} 的人格`);
        draft.personas.splice(index, 1);
        if (draft.defaultId === id) draft.defaultId = null;
        for (const [sessionId, binding] of Object.entries(draft.bindings ?? {})) {
          if (binding?.personaId === id) {
            const { personaId, ...rest } = binding;
            if (rest.custom === undefined) delete draft.bindings[sessionId];
            else draft.bindings[sessionId] = rest;
          }
        }
        return draft;
      });
      return { ok: true };
    },

    /** 设默认人格；`id: null` 表示「不设默认，跟随 preset」。 */
    setDefault: async (params) => {
      const id = params.id === null ? null : textOf(params.id, 64);
      await commit((draft) => {
        if (id !== null && !draft.personas.some((p) => p.id === id)) throw new Error(`没有 id 为 ${id} 的人格`);
        draft.defaultId = id;
        return draft;
      });
      return { ok: true, defaultId: id };
    },

    /**
     * 切换某会话的人格。
     *  - `personaId: null` + 无 `custom` → 清除该会话绑定，回落默认/preset。
     *  - `custom` → 该会话使用临时人格文本（优先级最高）。
     *  - `activate: false`（默认）→ 只记录绑定，下个会话生效；
     *    `activate: true` → 立刻重注入（下一次模型请求就用新人格，KV 前缀自首个变化的 token 起失效）。
     */
    switch: async (params) => {
      const sessionId = textOf(params.sessionId, 200);
      if (sessionId.length === 0) throw new Error('缺少 sessionId');
      const personaId =
        params.personaId === null || params.personaId === undefined ? null : textOf(params.personaId, 64);
      const custom = textOf(params.custom, 64 * 1024);
      const activate = params.activate === true;
      // 切换本身只落盘绑定：延迟切换完全不注入，立即切换只重注入这一个会话。
      await commit(
        (draft) => {
          if (personaId !== null && !draft.personas.some((p) => p.id === personaId)) {
            throw new Error(`没有 id 为 ${personaId} 的人格`);
          }
          draft.bindings ??= {};
          if (personaId === null && custom.trim().length === 0) delete draft.bindings[sessionId];
          else {
            draft.bindings[sessionId] = {
              ...(personaId === null ? {} : { personaId }),
              ...(custom.trim().length === 0 ? {} : { custom }),
              updatedAt: new Date().toISOString(),
            };
          }
          return draft;
        },
        { reinject: false },
      );
      if (activate) {
        const agent = safeAgents().find((candidate) => String(candidate.id) === sessionId);
        if (agent !== undefined) runtime.applyStored(agent, store.state());
      }
      return { ok: true, ...view(sessionId) };
    },

    /** 只重注入某会话（浏览器半在「立即生效」路径上调用）。 */
    activate: async (params) => {
      const sessionId = textOf(params.sessionId, 200);
      const agent = safeAgents().find((candidate) => String(candidate.id) === sessionId);
      if (agent === undefined) return { ok: true, applied: false, reason: '该会话当前没有活跃 agent' };
      runtime.applyStored(agent, store.state());
      return { ok: true, applied: true, ...view(sessionId) };
    },

    /** 整体导入（覆盖人格库，保留会话绑定中仍然有效者）。 */
    import: async (params) => {
      const incoming = normalizeState(params.data);
      await commit((draft) => {
        draft.personas = incoming.personas.slice(0, MAX_PERSONAS);
        draft.defaultId = incoming.defaultId;
        const ids = new Set(draft.personas.map((p) => p.id));
        draft.bindings = Object.fromEntries(
          Object.entries(incoming.bindings).filter(
            ([, binding]) => binding?.personaId === undefined || ids.has(binding.personaId),
          ),
        );
        return draft;
      });
      return { ok: true };
    },

    /** 导出（供备份/迁移）。 */
    export: () => ({ ok: true, data: store.peek() }),
  };

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '') || 'state';
          if (req.method === 'GET' && route === 'state') {
            await ready;
            sendJson(res, 200, view(url.searchParams.get('sessionId') ?? undefined));
            return;
          }
          if (req.method !== 'POST') {
            sendError(res, 405, `不支持的方法 ${req.method ?? '?'}`);
            return;
          }
          const body = await readJsonBody(req);
          const method = route === 'call' ? textOf(body.method, 64) : route;
          const fn = methods[method];
          if (typeof fn !== 'function') {
            sendError(res, 404, `未知操作 ${method}`);
            return;
          }
          await ready;
          const params = body.params !== null && typeof body.params === 'object' ? body.params : body;
          sendJson(res, 200, await fn(params));
        } catch (error) {
          sendError(res, 400, String(error?.message ?? error));
        }
      },
    }),
  );

  // ── 模型工具 ────────────────────────────────────────────────────────────────
  // 第三方插件 import 不到 `@deepseek-ai/dsh-tools`：它只存在于 app.asar 的解析图里，
  // 工作区里的包 import 它会 ERR_MODULE_NOT_FOUND（实测）。所以这里不依赖它的
  // defineTool，直接用标准 JSON Schema 注册 —— 与 defineTool 编译后的形状等价。
  const currentAgentId = (exec) => (exec?.agent?.id === undefined ? undefined : String(exec.agent.id));

  const definePersonaTool = ({ name, description, parameters, outputSchema, render, execute, presentCall }) => ({
    name,
    description,
    parameters,
    output: { schema: outputSchema, render },
    execute,
    ...(presentCall === undefined ? {} : { presentCall }),
  });

  const registerPersonaTools = (toolsCtx) => {
    const disposers = [];
    const define = (spec) => disposers.push(toolsCtx.tools.register(definePersonaTool(spec)));
    try {
      define({
          name: 'persona_list',
          description:
            'List the saved model personas (人设/人格) and show which one is effective for this session. Use it before persona_switch when you do not know the available ids.',
          parameters: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['personas'],
            properties: {
              personas: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'description'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              current: { type: 'string' },
              currentSource: { type: 'string' },
              defaultId: { type: 'string' },
            },
          },
          render: (_args, value) => [
              {
                type: 'text',
                text:
                  `可用人格（${value.personas.length}）：` +
                  value.personas.map((p) => `${p.id}${p.id === value.current ? ' ←当前' : ''}${p.id === value.defaultId ? '（默认）' : ''}${p.description ? `：${p.description}` : ''}`).join('；') +
                  (value.current === undefined ? '。当前会话未指定人格，跟随默认/预设。' : '。'),
              },
          ],
          execute: async (_args, exec) => {
            const state = store.state();
            const sessionId = currentAgentId(exec);
            const effective = resolvePersona(state, sessionId);
            return {
              personas: state.personas.map((p) => ({ id: p.id, name: p.name, description: typeof p.description === 'string' ? p.description : '' })),
              ...(effective?.personaId == null ? {} : { current: effective.personaId }),
              ...(effective === undefined ? {} : { currentSource: effective.source }),
              ...(state.defaultId === null ? {} : { defaultId: state.defaultId }),
            };
          },
          presentCall: () => ({ card: 'generic', title: '列出人格', kind: 'other' }),
      });

      define({
          name: 'persona_switch',
          description:
            'Switch the persona (人格提示词) for the CURRENT session. The new persona replaces the persona prompt from the next model request onward, or from the next session when deferred. Use persona_list to discover ids, or pass `custom` for a one-off persona text.',
          parameters: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Persona id from persona_list. Omit it together with a non-empty `custom` to use custom text only.',
              },
              custom: {
                type: 'string',
                description: 'One-off persona prompt text for this session, taking precedence over `id`.',
              },
              deferred: {
                type: 'boolean',
                description: 'true: record the choice but apply it only to the next session (keeps the current prompt intact). Default false: apply immediately.',
              },
            },
          },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'applied'],
            properties: {
              ok: { type: 'boolean' },
              applied: { type: 'string' },
              source: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.applied }],
          execute: async (args, exec) => {
            const sessionId = currentAgentId(exec);
            if (sessionId === undefined) throw new Error('persona_switch 需要一个所属的 agent 会话');
            const id = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : null;
            const custom = typeof args.custom === 'string' ? args.custom : '';
            if (id === null && custom.trim().length === 0) throw new Error('请给出 `id` 或非空的 `custom`');
            await commit((draft) => {
              if (id !== null && !draft.personas.some((p) => p.id === id)) {
                throw new Error(`没有 id 为 ${id} 的人格，请先用 persona_list 查看`);
              }
              draft.bindings ??= {};
              draft.bindings[sessionId] = {
                ...(id === null ? {} : { personaId: id }),
                ...(custom.trim().length === 0 ? {} : { custom }),
                updatedAt: new Date().toISOString(),
              };
              return draft;
            }, { reinject: false });
            const effective = resolvePersona(store.state(), sessionId);
            const label = effective?.personaId ?? effective?.source ?? '自定义';
            if (args.deferred === true) {
              return { ok: true, applied: `已记录：下次会话起使用人格「${label}」（当前提示词保持不变）。`, ...(effective === undefined ? {} : { source: effective.source }) };
            }
            const agent = safeAgents().find((candidate) => String(candidate.id) === sessionId);
            if (agent !== undefined) runtime.apply(agent, effective);
            return { ok: true, applied: `已切换：本会话从下一次模型请求起使用人格「${label}」。`, ...(effective === undefined ? {} : { source: effective.source }) };
          },
          presentCall: (args) => ({ card: 'generic', title: '切换人格', kind: 'other', rawInput: args.custom ?? args.id ?? '' }),
      });

      define({
          name: 'persona_create',
          description:
            'Create and save a new reusable persona (人格) in the persona library. Prefer this over persona_switch with custom text when the persona should be reusable in later sessions.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short display name for the persona.' },
              prefix: { type: 'string', description: 'The persona prompt text, placed at the very start of the system prompt.' },
              description: { type: 'string', description: 'One line describing when to use it.' },
              emoji: { type: 'string', description: 'A single emoji used as its icon.' },
              suffix: { type: 'string', description: 'Optional extra text placed at the end of the system prompt.' },
              makeDefault: { type: 'boolean', description: 'Also make it the default persona for new sessions.' },
            },
            required: ['name', 'prefix'],
          },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `已保存人格「${value.name}」（id: ${value.id}）。` }],
          execute: async (args) => {
            let created;
            await commit((draft) => {
              if (draft.personas.length >= MAX_PERSONAS) throw new Error(`人格数量已达上限（${MAX_PERSONAS}）`);
              const id = newId(args.name ?? '', new Set(draft.personas.map((p) => p.id)));
              created = personaFromInput(args, id, undefined);
              draft.personas.push(created);
              if (args.makeDefault === true) draft.defaultId = id;
              return draft;
            });
            return { id: created.id, name: created.name };
          },
          presentCall: (args) => ({ card: 'generic', title: '保存人格', kind: 'other', rawInput: args.name ?? '' }),
      });
      toolStatus.registered = ['persona_list', 'persona_switch', 'persona_create'];
      toolStatus.error = null;
    } catch (error) {
      // 任一注册失败就把已经挂上的摘掉，并记下原因（设置页会把它显示出来）。
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 释放失败不值得再抛
        }
      }
      toolStatus.registered = [];
      toolStatus.error = String(error?.message ?? error);
      log(`persona: 注册模型工具失败：${toolStatus.error}`);
    }
    if (disposers.length > 0) {
      // 注册发生在 toolsCtx 上，但所有权留在本插件的 effect 里：插件卸载即摘掉工具。
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              // 同上
            }
          }
        },
        'persona.tools',
      );
    }
  };

  // `tools` 可能晚于本插件就绪，用 ctx.inject 等它就位，而不是在 apply 那一刻判空返回。
  try {
    ctx.inject(['tools'], (toolsCtx) => registerPersonaTools(toolsCtx));
  } catch (error) {
    toolStatus.error = String(error?.message ?? error);
    log(`persona: 注册模型工具失败：${toolStatus.error}`);
  }
}
