// End-to-end harness for the persona plugin's HOST half: loads lib/index.js with mocked
// services, then drives the real HTTP route and the real model tools.
//
// Why: the first live run registered NO model tools, because the host half imported
// `@deepseek-ai/dsh-tools` — a package only resolvable from inside app.asar, never from a
// workspace-installed third-party plugin. The schemas are now plain JSON Schema, so this
// harness also asserts that no terse `required: true` flag survived anywhere (the registry
// would reject such a schema with assertSupportedJsonSchema).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const STORE = join(tmpdir(), `persona-host-${process.pid}.json`);
process.env.DSH_PERSONA_STORE = STORE;

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const bad = (label, error) => {
  failures++;
  console.log(` FAIL ${label}: ${error?.stack ?? error}`);
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

const JSON_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'const',
  'oneOf', 'description', 'title', 'default', 'examples',
]);

/** Mirror `assertSupportedJsonSchema` + the terse-flag trap it exists to catch. */
function checkSchema(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path}: not a JSON Schema object`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!JSON_SCHEMA_KEYS.has(key)) throw new Error(`${path}: unsupported keyword "${key}"`);
    if (key === 'required') {
      if (!Array.isArray(value)) throw new Error(`${path}.required must be an array; got ${JSON.stringify(value)}`);
      for (const name of value) if (typeof name !== 'string') throw new Error(`${path}.required entries must be strings`);
    }
    if (key === 'properties') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}.properties must be an object`);
      for (const [name, sub] of Object.entries(value)) checkSchema(sub, `${path}.properties.${name}`);
    }
    if (key === 'items') checkSchema(value, `${path}.items`);
    if (key === 'oneOf') {
      if (!Array.isArray(value)) throw new Error(`${path}.oneOf must be an array`);
      value.forEach((sub, index) => checkSchema(sub, `${path}.oneOf[${index}]`));
    }
    if (key === 'type' && typeof value !== 'string') throw new Error(`${path}.type must be a string`);
    if (key === 'additionalProperties' && typeof value !== 'boolean') throw new Error(`${path}.additionalProperties must be a boolean`);
  }
  if (schema.type === 'object' && schema.required !== undefined) {
    for (const name of schema.required) {
      if (schema.properties === undefined || !(name in schema.properties)) {
        throw new Error(`${path}: required "${name}" is not declared in properties`);
      }
    }
  }
}

/** Validate a produced value against the subset of JSON Schema the plugin declares. */
function checkValue(schema, value, path = 'value') {
  if (schema === undefined) return;
  if (schema.type === 'object') {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: expected object, got ${JSON.stringify(value)}`);
    for (const name of schema.required ?? []) {
      assert(value[name] !== undefined, `${path}: missing required property "${name}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert(schema.properties?.[key] !== undefined, `${path}: undeclared property "${key}"`);
      }
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (value[name] !== undefined) checkValue(sub, value[name], `${path}.${name}`);
    }
    return;
  }
  if (schema.type === 'array') {
    assert(Array.isArray(value), `${path}: expected array, got ${JSON.stringify(value)}`);
    for (const [index, item] of value.entries()) checkValue(schema.items, item, `${path}[${index}]`);
    return;
  }
  if (schema.type === 'string') assert(typeof value === 'string', `${path}: expected string, got ${JSON.stringify(value)}`);
  if (schema.type === 'boolean') assert(typeof value === 'boolean', `${path}: expected boolean, got ${JSON.stringify(value)}`);
  if (schema.type === 'integer') assert(Number.isInteger(value), `${path}: expected integer, got ${JSON.stringify(value)}`);
  if (schema.oneOf !== undefined) {
    const failuresForValue = [];
    for (const candidate of schema.oneOf) {
      try {
        checkValue(candidate, value, path);
        return;
      } catch (error) {
        failuresForValue.push(error.message);
      }
    }
    throw new Error(`${path}: matched no oneOf branch (${failuresForValue.join(' | ')})`);
  }
}

// ── mocked Cordis context ───────────────────────────────────────────────────
/** The bits of `systemPrompt` the runtime touches, with the real scope's duplicate rule. */
function createPromptRecorder() {
  const sections = new Map();
  return {
    sections,
    section(section) {
      if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`);
      sections.set(section.name, section);
      return () => sections.delete(section.name);
    },
    getSectionOrder: () => 0,
    suppressRuntimeContext: () => () => {},
  };
}

function createContext() {
  const routes = [];
  const tools = new Map();
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const prompt = createPromptRecorder();
  // one live agent whose id matches the `exec.agent` stubs, so `commit()` really re-injects
  const liveAgent = { id: 'session-1', ctx: { get: (name) => (name === 'systemPrompt' ? prompt : undefined) } };

  const toolsService = {
    register(definition) {
      // the real registry's contract: output { schema, render }, supported JSON Schema
      if (definition.output === undefined || typeof definition.output !== 'object' || typeof definition.output.render !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
      }
      checkSchema(definition.output.schema, `tool "${definition.name}" output.schema`);
      checkSchema(definition.parameters, `tool "${definition.name}" parameters`);
      if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    schemas: () => [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    get: (name) => tools.get(name),
  };

  const ctx = {
    logger: { info: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    log: (...args) => logs.push(args.join(' ')),
    get: (name) => (name === 'agents' ? { list: () => [liveAgent] } : undefined),
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => {};
    },
    emit: (name, payload) => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
    effect: (callback, label) => {
      const dispose = callback();
      effects.push({ label, dispose });
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // Cordis 4: ctx.inject(deps, callback) forks a fiber whose body receives the forked ctx
    inject: (deps, callback) => {
      const forked = { ...ctx, tools: toolsService };
      const fiber = callback(forked);
      return fiber;
    },
    webServer: {
      register: (route) => {
        if (routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        routes.push(route);
        return () => {};
      },
    },
    tools: toolsService,
  };
  return { ctx, routes, tools, listeners, effects, logs, prompt };
}

/** Drive one HTTP request through the registered route. */
async function request(routes, { method, url, body }) {
  const [pathname, search = ''] = url.split('?');
  const route = routes.find((candidate) => (candidate.kind === 'exact' ? candidate.path === pathname : pathname.startsWith(candidate.path)));
  assert(route !== undefined, `no route matched ${url}`);
  const req = {
    method,
    url,
    headers: {},
    destroy() {},
    // the route reads the body with `req.on('data'|'end'|'error')`, so schedule the
    // events after the handler has subscribed.
    on(event, listener) {
      if (event === 'data' && body !== undefined) setImmediate(() => listener(Buffer.from(JSON.stringify(body), 'utf8')));
      if (event === 'end') setImmediate(() => setImmediate(() => listener()));
      return req;
    },
  };
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk);
      return this;
    },
  };
  await route.handler(req, res);
  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch {
    throw new Error(`route returned non-JSON: ${res.body.slice(0, 200)}`);
  }
  return { status: res.statusCode, payload };
}

async function main() {
  const module = await import(`${new URL('../lib/index.js', import.meta.url).href}?t=${Date.now()}`);
  assert(typeof module.apply === 'function', 'lib/index.js must export apply');
  assert(Array.isArray(module.inject), 'lib/index.js must export inject');
  assert(!module.inject.includes('tools'), 'inject must stay hard-required only on webServer; tools is optional');

  const { ctx, routes, tools, logs, prompt } = createContext();
  module.apply(ctx, {});
  // `ensureSeeded` is a deliberately swallowed async step, so let it settle first.
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok(`apply() ran; inject=[${module.inject.join(', ')}]`);

  // ── model tools ───────────────────────────────────────────────────────────
  const names = [...tools.keys()].sort();
  assert(names.length === 3, `expected 3 tools, got ${JSON.stringify(names)}`);
  assert(names.join(',') === 'persona_create,persona_list,persona_switch', `unexpected tool names: ${names.join(', ')}`);
  for (const [name, definition] of tools) {
    assert(typeof definition.execute === 'function', `${name} has no execute`);
    assert(typeof definition.description === 'string' && definition.description.length > 20, `${name} needs a real description`);
    checkSchema(definition.parameters, `${name}.parameters`);
    checkSchema(definition.output.schema, `${name}.output.schema`);
  }
  ok(`3 model tools registered with plain JSON Schema: ${names.join(', ')}`);

  const list = tools.get('persona_list');
  const listed = await list.execute({}, { agent: { id: 'session-1' } });
  checkValue(list.output.schema, listed, 'persona_list value');
  assert(listed.personas.length >= 1, 'seeded personas should be listed');
  ok(`persona_list returns ${listed.personas.length} personas (${listed.personas.map((p) => p.id).join(', ')})`);

  const create = tools.get('persona_create');
  const created = await create.execute({ name: '测试人格', prefix: '你是测试人格。', description: 'harness' }, { agent: { id: 'session-1' } });
  checkValue(create.output.schema, created, 'persona_create value');
  ok(`persona_create returns {id: ${created.id}, name: ${created.name}}`);

  const switchTool = tools.get('persona_switch');
  const PREFIX = 'deployment:persona-prefix';
  assert(prompt.sections.get(PREFIX) === undefined, 'no persona section must exist before the first switch');
  const switched = await switchTool.execute({ id: created.id }, { agent: { id: 'session-1' } });
  checkValue(switchTool.output.schema, switched, 'persona_switch value');
  assert(
    prompt.sections.get(PREFIX)?.text === '你是测试人格。',
    `immediate switch must reach the live prompt, got ${JSON.stringify(prompt.sections.get(PREFIX)?.text)}`,
  );
  ok('persona_switch (immediate) injects the persona into the live session prompt');

  // deferred: the choice is recorded, but the live prompt must stay EXACTLY as it was
  const beforeDeferred = prompt.sections.get(PREFIX)?.text;
  const deferredResult = await switchTool.execute({ custom: '一次性人格', deferred: true }, { agent: { id: 'session-1' } });
  checkValue(switchTool.output.schema, deferredResult, 'persona_switch deferred value');
  assert(
    prompt.sections.get(PREFIX)?.text === beforeDeferred,
    `deferred switch must not touch the live prompt (was ${beforeDeferred}, now ${prompt.sections.get(PREFIX)?.text})`,
  );
  ok('persona_switch accepts id, custom text and deferred mode');

  // ── the HTTP bridge the browser half uses ─────────────────────────────────
  const state = await request(routes, { method: 'GET', url: '/dsh-persona/api/state?sessionId=session-1' });
  assert(state.status === 200, `GET state returned ${state.status}: ${state.payload.error ?? ''}`);
  assert(state.payload.ok === true, 'state payload must be ok');
  assert(Array.isArray(state.payload.personas), 'state must carry personas');
  assert(state.payload.tools !== undefined, 'state must report model-tool status for the settings page');
  assert(state.payload.tools.registered.length === 3, `tools.registered should list 3 tools, got ${JSON.stringify(state.payload.tools)}`);
  assert(
    state.payload.session.binding.custom === '一次性人格',
    `the deferred choice must still be recorded in the store, got ${JSON.stringify(state.payload.session.binding)}`,
  );
  ok(`GET /state → ${state.payload.personas.length} personas, tools=${state.payload.tools.registered.join(',')}`);

  const called = await request(routes, { method: 'POST', url: '/dsh-persona/api/call', body: { method: 'state', params: { sessionId: 'session-2' } } });
  assert(called.status === 200 && called.payload.ok === true, `POST /call failed: ${JSON.stringify(called.payload)}`);
  ok('POST /call dispatches by method name');

  const bad = await request(routes, { method: 'POST', url: '/dsh-persona/api/call', body: { method: 'nope', params: {} } });
  assert(bad.status === 404, `unknown method must 404, got ${bad.status}`);
  ok('unknown method answers 404');

  const removed = await request(routes, { method: 'POST', url: '/dsh-persona/api/call', body: { method: 'remove', params: { id: created.id } } });
  assert(removed.status === 200 && removed.payload.ok === true, `remove failed: ${JSON.stringify(removed.payload)}`);
  ok('remove works through the JSON bridge');

  if (logs.length > 0) console.log(`  note  host log: ${logs.join(' | ')}`);
}

main()
  .then(() => {
    rmSync(STORE, { force: true });
    console.log(failures === 0 ? '\nHOST CHECKS PASSED' : `\n${failures} HOST CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((error) => {
    rmSync(STORE, { force: true });
    bad('host half', error);
    console.log(`\n${failures} HOST CHECK(S) FAILED`);
    process.exitCode = 1;
  });
