# dsh-plugin-persona — DSH 人格管理器

给当前 DSH 客户端提供一套「模型人格（人设 / 人格提示词）」的完整管理：多套自定义人设、**每个会话独立绑定**、默认人格、随时切换（可选择立即生效或下个会话生效），并把同一套能力作为工具暴露给模型自己调用。

- Host 半（`lib/index.js`）：在会话自己的 agent scope 里覆盖 `deployment:persona-prefix` / `deployment:persona-suffix`，注册 HTTP JSON 桥，注册 3 个模型工具。
- Web 客户端半（`lib/client.js`）：设置页「模型人格」+ 输入框左侧的人设切换芯片。

## 功能

**设置页（设置 → 模型人格，`settings.section#persona-manager`，order 25）**

- 人设库：新建 / 编辑（名称、emoji、描述、前缀、后缀）/ 删除，`complete`（独占整个 system prompt）与 `suppressRuntimeContext`（抑制运行时上下文）两个开关。
- 设为默认 / 取消默认（默认人格只决定「没有绑定的会话」用什么）。
- 导入 / 导出 JSON；显示存储路径；显示模型工具注册状态（Host 半如果注册失败，这里会直接给出错误文本）。

**输入框芯片（`conversation.input.left#persona-manager.switcher`，order 120）**

- 一眼看到当前会话生效的人格（emoji + 名字，`跟随默认` / `临时文本` 也会显示出来）。
- 下拉即可切换：跟随默认、任选人设、`临时文本…`（只作用于本会话的一次性人格）、`仅对下一个会话生效`（只记账、不重注入，因此不动当前 KV 前缀）、`立即重注入`。

**模型工具（Host 半注册，模型可自行调用）**

- `persona_list` — 列出所有人设，并说明本会话当前生效的是哪个。
- `persona_switch` — 切换本会话人格；参数 `id` / `custom`（临时文本）/ `deferred`（true = 下次会话生效）。
- `persona_create` — 新建并保存一个可复用的人设。

**HTTP JSON 桥（客户端半使用，也可以脚本直接调）**

- `GET /dsh-persona/api/state?sessionId=<id>` → 完整视图（人设库、默认、本会话绑定、生效结果、`active`、`tools` 注册状态、`storePath`）。
- `POST /dsh-persona/api/call`，body `{"method": "...", "params": {...}}`，方法：`state` `create` `update` `remove` `setDefault` `switch` `activate` `import` `export`。失败返回 4xx + `{"ok":false,"error":"..."}`。

## 安装

推荐走 DSH 插件管理（需要 danger-full-access 或逐次批准）：

```
plugin_manager  action: install_bundle  target: <本目录的绝对路径>
```

它会 `pnpm link` 进 profile 并把包名写进 profile `package.json` 的 `dsh.profile.bundles`，同时激活 `cordis.patch.yml` 里的 Loader 行 `persona-manager`。

也可以手动安装：把本目录放进（或链接到）profile 的 `node_modules/dsh-plugin-persona`，再在 `dsh.profile.bundles` 里加入 `"dsh-plugin-persona"`。

## 生效时机与 KV 缓存（重要）

- **只绑定 / 立即生效**：`switch` 默认只写绑定（下个会话或下个 agent 才生效）；`activate` 或界面上的「立即重注入」才会改写当前会话正在用的提示词。
- DSH 的 system prompt 走 `systemPromptUpdate: 'in-history'`：提示词变化会**追加在已缓存历史之后**，所以「立即生效」不会破坏已有前缀的缓存复用；代价是旧人格文本会留在历史里，直到 compaction 把它压掉。
- **重新加载**：客户端半（`lib/client.js`）的改动由 client-hmr 轮询自动热更新，刷新页面即可看到；Host 半（`lib/index.js` 等）的改动**必须重启 DSH 进程**（Node ESM 缓存，加载器不带 cache-busting 查询串）。

## 数据

- 默认 `$DSH_HOME/persona/personas.json`，可用环境变量 `DSH_PERSONA_STORE` 覆盖。
- 结构：`{version: 1, defaultId: string|null, personas: Persona[], bindings: {[sessionId]: {personaId?: string, custom?: string}}}`。
- 上限：200 条人设、名称 64 字符、单段文本 64 KiB、请求体 1 MiB。
- 写入是原子的（临时文件 + fsync + rename），读取永不抛（坏文件/缺失都当空库处理）。
- 首次运行会种入 3 个内置人设：精简架构师 / 严格评审员 / 耐心的讲解者。

## 实现要点（为什么这样做）

- DSH 的 `systemPrompt` **没有「改文本」接口**，只有 `section()` / `context()` 注册，而且注册是 per-context 的分层覆盖（`ScopedLayers`）。因此插件把人格注册进**该会话自己的 `agent.ctx`**，用它覆盖 preset 带来的人格 section；同一 scope 内重复注册同名 section 会抛错，所以每次切换都**先 dispose 旧的再注册新的**。
- **不能全局注册** persona section：会与 prompt registry 自带的全局 section 冲突并直接报错。
- `agent id === session id`，所以会话绑定直接用 sessionId 当键；新会话在 `agent/created` 时套用（绑定 → 默认 → 什么都不做，跟随 preset），插件被重新加载时也会给已存在的会话补注入一次。
- 不用自定义 session 事件（`SessionEventMap` 是仓库自有的，未知类型在读取时会被拒），也不依赖存储服务，插件自带原子 JSON 存储。
- 客户端半是**手写的 lazy-CJS bundle**（`window.__ModuleLoader__.load`），只 `require` 平台 seed 表里的 `react` / `react/jsx-runtime`；bundle 模型里没有 `ctx.styles` 之类的服务，CSS 用原始 `<style>` 元素在 factory 阶段插入（由 client-modules 的 `claimStyles` 认领，HMR 时能正确回收）。
- 模型工具**不 import `@deepseek-ai/dsh-tools`**（第三方插件解析不到 app.asar 里的包，会静默失败），改为手写等价对象：标准 JSON Schema 的 `parameters` + `output: {schema, render}`。

## 开发与测试

```bash
node test/check-persona.js    # 语法 + store/runtime 语义（原子写、resolvePersona 优先级、覆盖注册、释放、后缀 order 10200）
node test/verify-host.js      # 驱动真实 HTTP 路由 + 三个模型工具（含 deferred 不改写当前提示词的回归断言）
node test/verify-client.js    # 在假 window/document 里加载 bundle，真的渲染并点按钮，断言发出 switch 调用
npm test                      # 三个一起跑
```

三个 harness 都是纯 Node、无子进程（当前沙箱禁止管道），失败会打印 `FAIL …` 并以非 0 退出。

## 目录

```
lib/index.js        Host 半：HTTP 路由 + 3 个模型工具 + agent 生命周期 + 视图
lib/store.js        原子 JSON 存储、规范化与限额
lib/runtime.js      在 agent scope 内注入/释放 persona section
lib/client.js       Web 客户端半：设置页 + 输入框芯片（手写 bundle）
cordis.patch.yml    注入 Loader 行 persona-manager
test/               check-persona.js / verify-host.js / verify-client.js
```
