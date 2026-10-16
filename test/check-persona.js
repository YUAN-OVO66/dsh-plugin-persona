// Static validation for the persona plugin: syntax-parse both halves and smoke-test
// the host store/runtime with mocked services. No child processes (sandbox blocks pipes).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本文件住在 <pkg>/test/ 下，lib/ 是它的兄弟目录：用相对本文件的 URL 定位，
// 这样从任何工作目录调用都能跑，不再依赖工作区根目录。
const ROOT = fileURLToPath(new URL('../lib/', import.meta.url));
let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const bad = (label, error) => {
  failures++;
  console.log(` FAIL ${label}: ${error?.stack ?? error}`);
};

// ── 1. client half: syntax + the frozen module-loader contract ────────────────
try {
  const source = readFileSync(`${ROOT}client.js`, 'utf8');
  let loaded = null;
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  };
  const fakeRequire = (specifier) => {
    if (specifier === 'react') {
      return {
        createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
        Fragment: Symbol('Fragment'),
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
      };
    }
    if (specifier === 'react/jsx-runtime') return {};
    throw new Error(`unexpected require: ${specifier}`);
  };
  new Function('window', source)(window);
  if (loaded === null) throw new Error('bundle did not call window.__ModuleLoader__.load');
  if (loaded.id !== 'dsh-plugin-persona') throw new Error(`wrong id: ${loaded.id}`);
  if (typeof loaded.factory !== 'function') throw new Error('entry.factory is not a function');
  const exported = loaded.factory(fakeRequire);
  if (typeof exported.apply !== 'function') throw new Error('exports.apply missing');
  if (!Array.isArray(exported.inject)) throw new Error('exports.inject must be an array');
  ok(`client.js registers id=${loaded.id}, apply + inject=[${exported.inject.join(', ')}]`);

  // 2. the client plugin must register exactly the slots we designed against.
  const registered = [];
  const injected = [];
  const ctx = {
    styles: { insert: () => () => {} },
    effect: (fn) => fn(),
    on: () => () => {},
    slots: {
      inject: (name, factory) => {
        injected.push(name);
        factory(); // the runtime calls this once the slot is available
        return () => {};
      },
      register: (declaration, component) => {
        registered.push({ declaration, component });
        return () => {};
      },
    },
  };
  exported.apply(ctx);
  ok(`client apply() ran; injects=[${injected.join(', ')}]`);
  for (const { declaration, component } of registered) {
    if (typeof declaration.order !== 'number') throw new Error(`slot ${declaration.id} has no numeric order`);
    if (declaration.children !== undefined && declaration.children['settings.general.item'] === undefined) {
      throw new Error(`slot ${declaration.id} declares unexpected children`);
    }
    const required = ['name', 'id'];
    for (const key of required) {
      if (typeof declaration[key] !== 'string') throw new Error(`slot ${JSON.stringify(declaration)} missing string ${key}`);
    }
    // `name` must be the SLOT id being filled (SlotCore.register looks up records by it),
    // `id` is this entry's own id within that slot's list.
    if (!injected.includes(declaration.name)) {
      throw new Error(`slot entry ${declaration.id} targets "${declaration.name}", which the plugin never injected`);
    }
    if (declaration.id.length === 0) throw new Error(`slot entry for ${declaration.name} has an empty id`);
    if (typeof component !== 'function') throw new Error(`slot ${declaration.id} has no component`);
  }
  const switcher = registered.find((r) => r.declaration.name === 'conversation.input.left');
  if (switcher.declaration.inject('session-abc').sessionId !== 'session-abc') {
    throw new Error('switcher inject() must accept a bare session id');
  }
  if (switcher.declaration.inject({ id: 'session-xyz' }).sessionId !== 'session-xyz') {
    throw new Error('switcher inject() must accept a session object');
  }
  ok(`slots: ${registered.map((r) => `${r.declaration.name}#${r.declaration.id}`).join(', ')}`);
} catch (error) {
  bad('client.js', error);
}

// ── 3. host half: syntax (parse only; imports are resolved by the runtime) ────
for (const file of ['index.js', 'store.js', 'runtime.js']) {
  try {
    const source = readFileSync(`${ROOT}${file}`, 'utf8');
    await import(`${pathToFileURL(`${ROOT}${file}`).href}?probe=${Date.now()}`);
    ok(`${file} imported`);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && file === 'index.js') {
      // expected in the workspace: @deepseek-ai/dsh-tools is only resolvable inside a profile
      try {
        const source = readFileSync(`${ROOT}${file}`, 'utf8');
        // parse-only check: wrap the ESM body so the parser still validates it
        new Function(`return async () => { ${source.replace(/^\s*(import|export)\s.*$/gm, '')} }`);
        ok(`${file} parsed (dependency unavailable outside a profile: ${error.message.slice(0, 60)}…)`);
      } catch (inner) {
        bad(`${file} parse`, inner);
      }
    } else {
      bad(file, error);
    }
  }
}

// ── 4. store + runtime behaviour with a temp store and a fake agent ───────────
try {
  const store = await import(`${pathToFileURL(`${ROOT}store.js`).href}?t=${Date.now()}`);
  const runtime = await import(`${pathToFileURL(`${ROOT}runtime.js`).href}?t=${Date.now()}`);
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  process.env.DSH_PERSONA_STORE = join(tmpdir(), `persona-probe-${process.pid}.json`);

  const handle = store.createStore(() => {});
  await handle.mutate((draft) => {
    draft.personas.push(store.normalizePersona({ id: 'a', name: 'A', prefix: 'PA' }));
    draft.personas.push(store.normalizePersona({ name: 'B', prefix: 'PB' }));
    draft.defaultId = 'a';
    return draft;
  });
  const reloaded = store.createStore(() => {});
  const persisted = reloaded.state();
  console.log('  debug persisted =', JSON.stringify(persisted));
  if (persisted.personas.length !== 2) throw new Error('persisted personas not reloaded');
  if (persisted.defaultId !== 'a') throw new Error('defaultId not persisted');
  ok(`store persists (${reloaded.path()})`);

  const base = { ...store.normalizeState(undefined), personas: persisted.personas, defaultId: 'a' };
  const fallback = runtime.resolvePersona(base, 's2');
  if (fallback?.source !== 'default' || fallback.personaId !== 'a') {
    throw new Error(`unbound session must follow the default persona, got ${JSON.stringify(fallback)}`);
  }
  const bound = runtime.resolvePersona({ ...base, bindings: { s2: { personaId: 'persona-1' } } }, 's2');
  if (bound.source !== 'session' || bound.prefix !== 'PB') throw new Error(`session binding lost: ${JSON.stringify(bound)}`);
  const custom = runtime.resolvePersona({ ...base, bindings: { s3: { personaId: 'persona-1', custom: '  ' } } }, 's3');
  if (custom.source !== 'session') throw new Error(`blank custom must not win: ${JSON.stringify(custom)}`);
  const realCustom = runtime.resolvePersona({ ...base, bindings: { s4: { personaId: 'persona-1', custom: 'PC' } } }, 's4');
  if (realCustom.source !== 'custom' || realCustom.prefix !== 'PC') throw new Error(`custom text must win: ${JSON.stringify(realCustom)}`);
  const orphaned = runtime.resolvePersona({ ...base, bindings: { s5: { personaId: 'deleted' } } }, 's5');
  if (orphaned?.source !== 'default') throw new Error('a binding to a deleted persona must fall back to the default');
  ok('resolvePersona: unbound → default, binding wins, blank custom ignored, custom wins, orphan falls back');

  // The load-bearing invariant: every registration goes to `agent.ctx` and is released before re-registering.
  const sections = [];
  const fakeAgent = (id) => {
    const registered = new Map();
    return {
      id,
      ctx: {
        get: () => ({
          getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200),
          suppressRuntimeContext: () => () => {},
          section: (section) => {
            if (registered.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`);
            registered.set(section.name, section);
            sections.push({ id, name: section.name, text: section.text, order: section.order, complete: section.complete });
            return () => registered.delete(section.name);
          },
        }),
        effect: (fn) => fn(),
      },
    };
  };
  const engine = runtime.createRuntime({ log: () => {} });
  const agent = fakeAgent('s1');
  engine.applyStored(agent, base);
  if (sections.length !== 1 || sections[0].text !== 'PA') throw new Error(`default persona not injected: ${JSON.stringify(sections)}`);
  engine.apply(agent, { personaId: 'x', prefix: 'PX', suffix: '', source: 'session' });
  if (sections.filter((s) => s.id === 's1').length !== 2) throw new Error('re-injection did not release the previous section');
  if (sections[sections.length - 1].text !== 'PX') throw new Error('new persona did not replace the old one');
  engine.clear(agent);
  if (engine.active().length !== 0) throw new Error('clear() left an active entry');
  ok('runtime: shadow-register, release-before-replace, clear()');

  const suffixOnly = fakeAgent('s9');
  engine.apply(suffixOnly, { personaId: 'z', prefix: '', suffix: 'SZ', source: 'session' });
  const suffixSection = sections.find((s) => s.id === 's9');
  if (suffixSection?.name !== 'deployment:persona-suffix' || suffixSection.order !== 10200) {
    throw new Error(`suffix-only injection wrong: ${JSON.stringify(suffixSection)}`);
  }
  ok('runtime: suffix-only persona registers the 10200 section');
} catch (error) {
  bad('store/runtime', error);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
