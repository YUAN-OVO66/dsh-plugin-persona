/**
 * 会话级人格注入。
 *
 * 机制（由 Harness 源码确定，不是猜测）：
 *  - 系统提示词的 persona 槽位叫 `deployment:persona-prefix`（order 0）与
 *    `deployment:persona-suffix`（order 10200），部署级注册必然存在。
 *  - `systemPrompt.section()` 注册到**调用上下文所在的作用域**；同一作用域内重名会抛错，
 *    但作用域沿父子链**由近及远**合并，最近的层赢得同名条目 —— 所以「按会话换人格」=
 *    在 `agent.ctx` 上注册同名 section 去遮蔽（shadow）部署级那一份。
 *  - `agent.ctx` 是每个 agent 自己的作用域，agent 释放时其注册随之失效；因此对同一 agent
 *    的重复注册必须先释放上一次（`dispose()`），否则会抛「already registered in this scope」。
 *
 * 不变量：
 *  1. 每个 agent id 至多持有一份活跃注册；`apply()` 先释放旧的再注册新的。
 *  2. 注册只发生在 `agent.ctx`，绝不在插件自己的 ctx 上 —— 那会撞上部署级注册直接抛错。
 *  3. `clear()` 只是释放注册，于是该会话回落到（agent preset 或部署的）原始人格。
 *
 * @module dsh-plugin-persona/lib/runtime
 */

/** persona section 名（与 `@deepseek-ai/dsh-system-prompt` 的导出常量一致）。 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix';

/**
 * 计算某会话当前生效的人格文本。
 *
 * 解析优先级（自上而下，先命中先赢）：
 *  1. 该会话绑定的自定义文本（`bindings[id].custom`）—— 临时覆盖，优先级最高。
 *  2. 该会话绑定的人格。
 *  3. 全局默认人格。
 *  4. 都没有 → `undefined`，表示「跟随当前 agent preset」，不做任何注册。
 *
 * @param state - 存储快照。
 * @param sessionId - 会话 id。
 * @returns `{ personaId, prefix, suffix, complete, suppressRuntimeContext, source }` 或 `undefined`。
 */
export function resolvePersona(state, sessionId) {
  const byId = new Map(state.personas.map((p) => [p.id, p]));
  const binding = sessionId === undefined ? undefined : state.bindings?.[sessionId];
  if (binding !== undefined) {
    if (typeof binding.custom === 'string' && binding.custom.trim().length > 0) {
      return {
        personaId: binding.personaId ?? null,
        prefix: binding.custom,
        suffix: '',
        complete: false,
        suppressRuntimeContext: false,
        source: 'custom',
      };
    }
    if (typeof binding.personaId === 'string') {
      const persona = byId.get(binding.personaId);
      if (persona !== undefined) return { ...view(persona), source: 'session' };
    }
  }
  if (typeof state.defaultId === 'string') {
    const persona = byId.get(state.defaultId);
    if (persona !== undefined) return { ...view(persona), source: 'default' };
  }
  return undefined;
}

function view(persona) {
  return {
    personaId: persona.id,
    prefix: persona.prefix ?? '',
    suffix: persona.suffix ?? '',
    complete: persona.complete === true,
    suppressRuntimeContext: persona.suppressRuntimeContext === true,
  };
}

/**
 * 创建会话级注入器。
 * @param options.log - 诊断日志（(message: string) => void）。
 * @returns 注入器：`apply(agent, persona)` / `clear(agent)` / `applyStored(agent)` / `disposeAll()` / `active()`。
 */
export function createRuntime({ log = () => {} } = {}) {
  /** @type {Map<string, { disposers: Array<() => void>, personaId: string | null, active: boolean }>} */
  const entries = new Map();

  function release(sessionId) {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    entries.delete(sessionId);
    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        log(`persona: 释放会话 ${sessionId} 的人格注册失败：${String(error?.message ?? error)}`);
      }
    }
  }

  /**
   * 把一份人格文本注册到该 agent 的作用域。同一 agent 的旧注册先释放。
   * @param agent - 目标 agent（需要 `id` 与 `ctx`）。
   * @param persona - `resolvePersona()` 的返回值；`undefined` 等价于 `clear()`。
   */
  function apply(agent, persona) {
    const sessionId = String(agent.id);
    if (persona === undefined || (persona.prefix.trim().length === 0 && persona.suffix.trim().length === 0)) {
      release(sessionId);
      return;
    }
    const systemPrompt = agent.ctx.get('systemPrompt');
    if (systemPrompt === undefined) {
      log(`persona: 会话 ${sessionId} 上没有 systemPrompt 服务，跳过注入`);
      return;
    }
    // 先释放旧注册：同一作用域重名会抛「already registered in this scope」。
    release(sessionId);
    const disposers = [];
    try {
      if (persona.suppressRuntimeContext === true) {
        disposers.push(agent.ctx.effect(() => systemPrompt.suppressRuntimeContext(), 'persona.suppressRuntimeContext'));
      }
      if (persona.prefix.trim().length > 0) {
        disposers.push(
          systemPrompt.section({
            name: PERSONA_PREFIX_SECTION,
            order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: persona.prefix,
            ...(persona.complete === true ? { complete: true } : {}),
          }),
        );
      }
      if (persona.suffix.trim().length > 0) {
        disposers.push(
          systemPrompt.section({
            name: PERSONA_SUFFIX_SECTION,
            order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
            text: persona.suffix,
          }),
        );
      }
    } catch (error) {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      log(`persona: 会话 ${sessionId} 注入失败：${String(error?.message ?? error)}`);
      return;
    }
    entries.set(sessionId, { disposers, personaId: persona.personaId ?? null, active: true });
  }

  /** 释放该 agent 的注册，让它回落到 preset / 部署人格。 */
  function clear(agent) {
    release(String(agent.id));
  }

  /**
   * 按存储解析该 agent 应有的人格并注入。
   * @param agent - 目标 agent 或 `{ id, ctx }`。
   * @param state - 存储快照。
   */
  function applyStored(agent, state) {
    apply(agent, resolvePersona(state, String(agent.id)));
  }

  /** 释放全部注册（插件卸载时调用）。 */
  function disposeAll() {
    for (const sessionId of [...entries.keys()]) release(sessionId);
  }

  /** 只读观察当前活跃注入。 */
  function active() {
    return [...entries.entries()].map(([sessionId, entry]) => ({ sessionId, personaId: entry.personaId }));
  }

  return { apply, clear, applyStored, disposeAll, active };
}
