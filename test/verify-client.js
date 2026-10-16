// Faithful-enough harness for the persona plugin's BROWSER half (lib/client.js).
//
// Why this exists: the first live attempt mounted nothing because the bundle used
// `ctx.styles`, which does not exist in the `window.__ModuleLoader__` bundle model
// (the factory only receives `require`), and it declared a child slot another
// settings entry already declares. Permissive stubs hide both classes of bug, so
// the stubs here mirror contracts read from the packed build:
//   * no `ctx.styles` — CSS must go through a raw <style> element,
//   * `slots.register` rejects an undeclared slot and an already-declared child key
//     (dsh-client-ui-slots SlotCore.register),
//   * a list entry needs `id`; its `name` must equal the slot key it fills,
//   * components really run, with hooks and click handlers exercised.
import { readFileSync } from 'node:fs';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const bad = (label, error) => {
  failures++;
  console.log(` FAIL ${label}: ${error?.stack ?? error}`);
};

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/** Source with `//` comments stripped, so guards test code rather than prose. */
const CODE = SOURCE.split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

// ── mini React: actually runs the component functions, with hook state ───────
function createMiniReact() {
  const stateByComponent = new Map();
  const pendingEffects = [];
  let cursor = 0;
  let current = null;

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const slots = stateByComponent.get(current);
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
    useEffect(effect, deps) {
      const slots = stateByComponent.get(current);
      const index = cursor++;
      const previous = slots[index];
      if (previous === undefined || deps === undefined || !deps.every((d, i) => d === previous.deps[i])) {
        slots[index] = { deps };
        pendingEffects.push(effect);
      }
    },
    useRef(initial) {
      const slots = stateByComponent.get(current);
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };

  const walk = (element, visit) => {
    if (element === null || element === undefined || typeof element === 'boolean') return;
    if (typeof element === 'string' || typeof element === 'number') return;
    if (Array.isArray(element)) {
      for (const child of element) walk(child, visit);
      return;
    }
    const { type, props, children } = element;
    if (type === React.Fragment) {
      walk(children, visit);
      return;
    }
    if (typeof type === 'function') {
      stateByComponent.set(type, stateByComponent.get(type) ?? []);
      const previous = current;
      current = type;
      cursor = 0;
      let output;
      try {
        output = type(props);
      } finally {
        current = previous;
      }
      walk(output, visit);
      return;
    }
    visit(element);
    walk(children, visit);
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const mount = async (Component, props, passes = 4) => {
    let tree = null;
    for (let pass = 0; pass < passes; pass++) {
      pendingEffects.length = 0;
      stateByComponent.set(Component, stateByComponent.get(Component) ?? []);
      current = null;
      cursor = 0;
      tree = React.createElement(Component, props ?? {});
      walk(tree, () => {});
      for (const effect of pendingEffects) {
        const cleanup = effect();
        if (typeof cleanup === 'function') cleanup();
      }
      await tick();
      await tick();
    }
    return tree;
  };

  /** Invoke up to `limit` click handlers found in a rendered tree. */
  const click = (tree, limit = 3) => {
    const handlers = [];
    walk(tree, (element) => {
      if (typeof element.props.onClick === 'function') handlers.push(element.props.onClick);
    });
    const errors = [];
    for (const handler of handlers.slice(0, limit)) {
      try {
        handler({ preventDefault() {}, stopPropagation() {}, target: {} });
      } catch (error) {
        errors.push(error);
      }
    }
    return { found: handlers.length, errors };
  };

  return { React, mount, click };
}

// ── slot registry mirroring SlotCore ────────────────────────────────────────
function createSlots(declarations) {
  const specs = new Map();
  const occupants = new Map();
  for (const [key, spec] of Object.entries(declarations)) {
    specs.set(key, spec);
    occupants.set(key, []);
  }
  return {
    occupants,
    inject(key, callback) {
      if (!specs.has(key)) return () => {};
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register(options, component) {
      const spec = specs.get(options.name);
      if (spec === undefined) {
        throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
      }
      if (spec.kind === 'list' && typeof options.id !== 'string') {
        throw new Error(`list slot "${options.name}" requires options.id`);
      }
      for (const childKey of Object.keys(options.children ?? {})) {
        if (specs.has(childKey)) {
          throw new Error(`slot "${childKey}" is already declared (by ${specs.get(childKey).declaredBy})`);
        }
      }
      if (occupants.get(options.name).some((entry) => entry.id === options.id)) {
        throw new Error(`slot "${options.name}" already has an entry with id "${options.id}"`);
      }
      occupants.get(options.name).push({ id: options.id, order: options.order, component });
      return () => {};
    },
  };
}

// ── stubs installed BEFORE the factory body runs (module scope touches DOM) ──
const insertedStyles = [];
/** document-level listeners installed by the plugin (outside-click handling). */
const listeners = [];
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild(node) { insertedStyles.push(node); } },
  body: { appendChild() {} },
  querySelectorAll: () => [],
  addEventListener(type, handler) { listeners.push({ type, handler }); },
  removeEventListener(type, handler) {
    const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
    if (index >= 0) listeners.splice(index, 1);
  },
};
globalThis.window = { confirm: () => false, prompt: () => '' };

const snapshot = {
  ok: true,
  personas: [
    { id: 'p1', name: '精简架构师', prefix: '你是精简架构师。', suffix: '', builtin: true },
    { id: 'p2', name: '严格评审员', prefix: '你是严格评审员。', suffix: '', builtin: true },
  ],
  defaultId: 'p1',
  binding: { personaId: 'p2', custom: '', mode: 'immediate' },
  bindingLabel: '严格评审员',
};
let fetchCalls = 0;
/** Every request the plugin made, so menu wiring can be asserted (not just "no throw"). */
const fetchLog = [];
globalThis.fetch = async (url, options) => {
  fetchCalls++;
  fetchLog.push({ url: String(url), body: options?.body ?? null });
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(snapshot); },
    async json() { return snapshot; },
  };
};

async function main() {
  let loaded = null;
  new Function('window', SOURCE)({ __ModuleLoader__: { load(registration) { loaded = registration; } } });
  if (loaded === null) throw new Error('bundle did not call window.__ModuleLoader__.load');
  if (loaded.id !== 'dsh-plugin-persona') throw new Error(`wrong bundle id: ${loaded.id}`);
  if (/ctx\.styles/.test(CODE)) throw new Error('client.js still calls ctx.styles — absent from the bundle model');
  if (!/document\.createElement\("style"\)/.test(CODE)) throw new Error('no raw <style> injection; CSS would never apply');
  // Regression guard for the live bug "menus in the composer are not clickable": a full-viewport
  // backdrop layer paints ABOVE the popover and swallows every click inside it.
  if (/dsh-persona-pop-backdrop/.test(CODE)) {
    throw new Error('the full-viewport backdrop is back: it covers the menu and makes every item unclickable');
  }
  if (!/\.dsh-persona-pop\s*\{[^}]*z-index:/.test(CODE)) {
    throw new Error('.dsh-persona-pop has no z-index; the menu can end up behind composer chrome');
  }
  if (!/addEventListener\("pointerdown"/.test(CODE)) {
    throw new Error('outside clicks are no longer handled: use a document-level pointerdown listener, not a backdrop');
  }
  ok('bundle id, no ctx.styles, raw <style> injection, popover above composer chrome, no click-swallowing backdrop');

  const mini = createMiniReact();
  const reactStub = {
    createElement: mini.React.createElement,
    Fragment: mini.React.Fragment,
    useState: mini.React.useState,
    useEffect: mini.React.useEffect,
    useRef: mini.React.useRef,
  };
  const exports = loaded.factory((specifier) => {
    if (specifier === 'react') return reactStub;
    if (specifier === 'react/jsx-runtime') return {};
    throw new Error(`unexpected require("${specifier}")`);
  });
  if (typeof exports.apply !== 'function') throw new Error('exports.apply is missing');
  if (insertedStyles.length !== 1) throw new Error(`expected exactly one injected <style>, got ${insertedStyles.length}`);
  if (typeof insertedStyles[0].textContent !== 'string' || insertedStyles[0].textContent.length < 100) {
    throw new Error('injected <style> has no CSS text');
  }
  ok(`factory ran; inject=[${(exports.inject ?? []).join(', ')}]; <style> claimed (${insertedStyles[0].textContent.length} chars)`);

  const slots = createSlots({
    'settings.section': { kind: 'list', scope: 'root', declaredBy: 'sidebar.settings' },
    'settings.general.item': { kind: 'list', scope: 'root', declaredBy: 'an entry in "settings.section" (general)' },
    'conversation.input.left': { kind: 'list', scope: 'session', declaredBy: 'conversation.composer.bar' },
  });
  const ctx = {
    slots,
    effect: (fn) => {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on: () => () => {},
    get: () => undefined,
  };

  exports.apply(ctx);
  const settingsEntry = slots.occupants.get('settings.section').find((entry) => entry.id === 'persona-manager');
  const switcherEntry = slots.occupants.get('conversation.input.left').find((entry) => entry.id === 'persona-manager.switcher');
  if (settingsEntry === undefined) throw new Error('settings.section has no persona-manager entry');
  if (switcherEntry === undefined) throw new Error('conversation.input.left has no persona-manager.switcher entry');
  if (settingsEntry.component.length > 0) throw new Error('settings component must tolerate being called with no props');
  ok(`apply() registered settings.section#${settingsEntry.id} (order ${settingsEntry.order}) and conversation.input.left#${switcherEntry.id} (order ${switcherEntry.order})`);

  // ── render both components, then click through their interactive elements ──
  const settingsTree = await mini.mount(settingsEntry.component, {});
  const settingsClicks = mini.click(settingsTree, 4);
  await mini.mount(settingsEntry.component, {});
  if (settingsClicks.errors.length > 0) throw settingsClicks.errors[0];
  ok(`settings page renders and ${settingsClicks.found} click handler(s) ran without throwing`);

  const switcherTree = await mini.mount(switcherEntry.component, { sessionId: 'session-123' });
  const switcherClicks = mini.click(switcherTree, 1);
  const reopened = await mini.mount(switcherEntry.component, { sessionId: 'session-123' });
  const menuClicks = mini.click(reopened, 4);
  if (switcherClicks.errors.length > 0) throw switcherClicks.errors[0];
  if (menuClicks.errors.length > 0) throw menuClicks.errors[0];
  ok(`composer switcher renders with session scope and ${switcherClicks.found + menuClicks.found} click handler(s) ran without throwing`);

  // The live bug was "menu items cannot be operated": assert the popover's items are really wired
  // to the host API, not merely non-throwing.
  const switchCalls = fetchLog.filter((entry) => typeof entry.body === 'string' && entry.body.includes('"switch"'));
  if (switchCalls.length === 0) throw new Error('clicking a persona in the popover never called the host "switch" method');
  ok(`popover items are wired to the host (${switchCalls.length} switch call(s), e.g. ${switchCalls[0].body.slice(0, 72)}…)`);

  if (fetchCalls === 0) throw new Error('the plugin never called the host API');
  ok(`host API exercised (${fetchCalls} fetch calls through ${'/dsh-persona/api'})`);
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nCLIENT CHECKS PASSED' : `\n${failures} CLIENT CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    bad('client bundle', error);
    console.log(`\n${failures} CLIENT CHECK(S) FAILED`);
    process.exitCode = 1;
  });
