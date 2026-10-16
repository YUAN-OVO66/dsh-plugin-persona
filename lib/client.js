window.__ModuleLoader__.load({
  id: "dsh-plugin-persona",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    /**
     * DSH 人格管理器 —— 浏览器半。
     *
     * 浏览器半只做两件事：把 Host 半的 HTTP 快照渲染成人能用的界面，以及把用户操作回传。
     * 所有真正的人格逻辑（存储、按会话遮蔽注入）都在 Host 半，这里不复制一份。
     *
     * 两个挂载点：
     *  1. `settings.section` —— 人格库：增删改、设默认、导入导出。
     *  2. `conversation.input.left` —— 输入框旁的会话级切换器：即时/下次生效可选。
     *
     * @module dsh-plugin-persona/client
     */

    /** 与 `lib/index.js` 的 API_PREFIX 必须一致。 */
    const API = "/dsh-persona/api";
    const NS = "persona-manager";

    // ── 共享状态：设置页与切换器看同一份快照，任一处改动另一处立刻刷新 ──────────────

    const store = {
      snapshot: null,
      error: null,
      loading: false,
      listeners: new Set(),
    };

    function notify() {
      for (const listener of [...store.listeners]) {
        try {
          listener();
        } catch (error) {
          console.error("[persona-manager] subscriber failed", error);
        }
      }
    }

    function useSnapshot() {
      const [, bump] = useState(0);
      useEffect(() => {
        const listener = () => bump((n) => n + 1);
        store.listeners.add(listener);
        return () => {
          store.listeners.delete(listener);
        };
      }, []);
      return store;
    }

    async function call(method, params) {
      const response = await fetch(`${API}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: params ?? {} }),
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (payload === null || typeof payload !== "object") throw new Error("服务返回了非对象响应");
      if (payload.ok === false || payload.error !== undefined) throw new Error(String(payload.error ?? "未知错误"));
      return payload;
    }

    async function refresh(sessionId) {
      store.loading = true;
      notify();
      try {
        const response = await fetch(
          `${API}/state${sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`}`,
        );
        const payload = await response.json();
        if (payload?.ok === false) throw new Error(String(payload.error));
        store.snapshot = payload;
        store.error = null;
      } catch (error) {
        store.error = String(error?.message ?? error);
      } finally {
        store.loading = false;
        notify();
      }
    }

    /** 包一层「先调用、再刷新」：失败时把错误留在 store 上给 UI 显示。 */
    function mutate(sessionId, method, params) {
      return (async () => {
        try {
          const result = await call(method, params);
          await refresh(sessionId);
          return result;
        } catch (error) {
          store.error = String(error?.message ?? error);
          notify();
          throw error;
        }
      })();
    }

    // ── 样式：只用 `currentColor` 与透明度，因此深色/浅色主题都不需要额外适配 ────────

    const css = `
      .dsh-persona-root {
        display: flex;
        flex-direction: column;
        gap: 14px;
        color: inherit;
        font-size: 13px;
        line-height: 1.6;
      }
      .dsh-persona-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .dsh-persona-title { margin: 0; font-size: 15px; font-weight: 600; }
      .dsh-persona-muted { opacity: 0.6; font-size: 12px; }
      .dsh-persona-error {
        padding: 8px 10px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, #ff6b6b 60%, transparent);
        background: color-mix(in srgb, #ff6b6b 14%, transparent);
        white-space: pre-wrap; word-break: break-word;
      }
      .dsh-persona-btn {
        appearance: none; cursor: pointer; color: inherit; font: inherit;
        padding: 4px 10px; border-radius: 6px; background: transparent;
        border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
      }
      .dsh-persona-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .dsh-persona-btn:disabled { opacity: 0.4; cursor: default; }
      .dsh-persona-btn[data-kind="primary"] {
        border-color: color-mix(in srgb, currentColor 45%, transparent);
        background: color-mix(in srgb, currentColor 14%, transparent);
      }
      .dsh-persona-btn[data-kind="danger"] { border-color: color-mix(in srgb, #ff6b6b 55%, transparent); }
      .dsh-persona-cols { display: flex; gap: 16px; align-items: flex-start; }
      .dsh-persona-list { flex: 0 0 190px; display: flex; flex-direction: column; gap: 4px; max-height: 420px; overflow: auto; }
      .dsh-persona-item {
        display: flex; align-items: center; gap: 6px; cursor: pointer; text-align: left;
        padding: 6px 8px; border-radius: 6px; background: transparent; color: inherit; font: inherit;
        border: 1px solid transparent;
      }
      .dsh-persona-item:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
      .dsh-persona-item[data-active="true"] {
        border-color: color-mix(in srgb, currentColor 32%, transparent);
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      .dsh-persona-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-persona-tag {
        font-size: 10px; padding: 1px 5px; border-radius: 999px;
        border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
      }
      .dsh-persona-editor { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      .dsh-persona-field { display: flex; flex-direction: column; gap: 4px; }
      .dsh-persona-field > span { font-size: 12px; opacity: 0.7; }
      .dsh-persona-input, .dsh-persona-textarea {
        width: 100%; box-sizing: border-box; color: inherit; font: inherit;
        background: color-mix(in srgb, currentColor 6%, transparent);
        border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
        border-radius: 6px; padding: 6px 8px; resize: vertical;
      }
      .dsh-persona-textarea { min-height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .dsh-persona-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .dsh-persona-check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .dsh-persona-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .dsh-persona-divider { height: 1px; background: color-mix(in srgb, currentColor 14%, transparent); margin: 2px 0; }
      .dsh-persona-limit { display: flex; align-items: center; gap: 8px; }
      .dsh-persona-bar { flex: 1; height: 4px; border-radius: 999px; background: color-mix(in srgb, currentColor 18%, transparent); overflow: hidden; }
      .dsh-persona-bar > i { display: block; height: 100%; background: color-mix(in srgb, currentColor 55%, transparent); }

      /* 输入框旁的会话切换器 */
      .dsh-persona-chip {
        display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: inherit; font: inherit;
        font-size: 12px; padding: 2px 8px; border-radius: 999px; max-width: 200px;
        background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
      }
      .dsh-persona-chip:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .dsh-persona-chip[data-custom="true"] { border-style: dashed; }
      .dsh-persona-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* 绝不用「全屏 backdrop 层」接收外部点击：它会盖在菜单之上，菜单里每一项都点不动
         （点击落在 backdrop 上，直接就把菜单关掉了）。改为 popover 自身高 z-index +
         document 级 pointerdown 判断外部点击。 */
      .dsh-persona-pop {
        position: absolute; bottom: 100%; left: 0; z-index: 2147483600;
        margin-bottom: 8px; width: 330px; max-width: 84vw;
        padding: 10px; border-radius: 10px; color: inherit; font-size: 13px;
        background: var(--dsh-popover-bg, color-mix(in srgb, currentColor 12%, Canvas));
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(6px);
      }
      .dsh-persona-pop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      .dsh-persona-pop-list { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow: auto; }
      .dsh-persona-pop-item {
        display: flex; align-items: center; gap: 7px; cursor: pointer; text-align: left; width: 100%;
        padding: 6px 8px; border-radius: 6px; color: inherit; font: inherit; background: transparent; border: 1px solid transparent;
      }
      .dsh-persona-pop-item:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .dsh-persona-pop-item[data-active="true"] {
        border-color: color-mix(in srgb, currentColor 32%, transparent);
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      .dsh-persona-pop-foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
      .dsh-persona-hint { font-size: 11px; opacity: 0.55; margin-top: 4px; }
    `;

    // 样式标签必须在「模块体」里注入：客户端模块系统在 factory 物化之后立刻调用
    // claimStyles()，把还没有 data-plugin 的 <style> 认领给本插件，并在卸载/热替换时清理。
    // 注意：bundle 模型下没有 `styles` 服务（factory 只拿到 require），ctx.styles 是
    // Cordis-Remote「动态半」才有的 builtin，在 __ModuleLoader__ 里是 undefined。
    if (typeof document !== "undefined" && document.head) {
      const styleTag = document.createElement("style");
      styleTag.textContent = css;
      document.head.appendChild(styleTag);
    }

    // ── 通用小部件 ────────────────────────────────────────────────────────────────

    function Field(props) {
      return h(
        "label",
        { className: "dsh-persona-field" },
        h("span", null, props.label),
        props.multiline
          ? h("textarea", {
              className: "dsh-persona-textarea",
              value: props.value,
              placeholder: props.placeholder,
              onChange: (event) => props.onChange(event.target.value),
            })
          : h("input", {
              className: "dsh-persona-input",
              value: props.value,
              placeholder: props.placeholder,
              onChange: (event) => props.onChange(event.target.value),
            }),
      );
    }

    function ErrorBanner(props) {
      if (props.error === null || props.error === undefined) return null;
      return h(
        "div",
        { className: "dsh-persona-error" },
        props.error,
        h(
          "div",
          { style: { marginTop: "6px" } },
          h(
            "button",
            { className: "dsh-persona-btn", type: "button", onClick: props.onDismiss },
            "知道了",
          ),
        ),
      );
    }

    /** 无依赖的 JSON 下载：把导出结果落成文件，用户不必手动复制。 */
    function download(name, text) {
      try {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch (error) {
        console.error("[persona-manager] download failed", error);
      }
    }

    // ── 设置页：人格库 ────────────────────────────────────────────────────────────

    function PersonaSettings() {
      const snapshot = useSnapshot();
      const [selectedId, setSelectedId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [mode, setMode] = useState("edit"); // "edit" | "create" | "io"
      const [ioText, setIoText] = useState("");
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        void refresh();
      }, []);

      const data = snapshot.snapshot;
      const personas = data?.personas ?? [];
      const current = personas.find((persona) => persona.id === selectedId) ?? null;

      // 选中的 id 消失（被删了）时，退回到第一项，避免编辑面板空转。
      useEffect(() => {
        if (mode === "create" || mode === "io") return;
        if (personas.length === 0) {
          if (selectedId !== null) setSelectedId(null);
          return;
        }
        if (current === null) setSelectedId(personas[0].id);
      }, [data, mode]);

      // 把选中的人格加载进草稿；切换选中项或外部改动（updatedAt 变了）时重载。
      useEffect(() => {
        if (mode !== "edit" || current === null) return;
        setDraft({
          name: current.name,
          emoji: current.emoji,
          description: current.description,
          prefix: current.prefix,
          suffix: current.suffix,
          complete: current.complete === true,
          suppressRuntimeContext: current.suppressRuntimeContext === true,
        });
      }, [selectedId, current?.updatedAt, mode]);

      const run = (task) => {
        setBusy(true);
        void task().finally(() => setBusy(false));
      };

      const startCreate = () => {
        setMode("create");
        setDraft({
          name: "",
          emoji: "🙂",
          description: "",
          prefix: "",
          suffix: "",
          complete: false,
          suppressRuntimeContext: false,
        });
      };

      const save = () => {
        if (draft === null) return;
        run(async () => {
          if (mode === "create") {
            const result = await mutate(undefined, "create", { persona: draft });
            setMode("edit");
            if (result?.created?.id !== undefined) setSelectedId(result.created.id);
          } else if (current !== null) {
            await mutate(undefined, "update", { id: current.id, persona: draft });
          }
        });
      };

      const remove = (persona) => {
        if (!window.confirm(`删除人格「${persona.name}」？使用它的会话会回落到默认人格。`)) return;
        run(() => mutate(undefined, "remove", { id: persona.id }));
      };

      const setDefault = (persona) => {
        run(() => mutate(undefined, "setDefault", { id: persona.id }));
      };

      if (data === null) {
        return h(
          "div",
          { className: "dsh-persona-root" },
          h("div", { className: "dsh-persona-title" }, "模型人格"),
          h("div", { className: "dsh-persona-muted" }, snapshot.error ?? "正在载入人格库…"),
          h(ErrorBanner, { error: null }),
        );
      }

      const limit = data.limit ?? 200;
      const ratio = Math.min(1, personas.length / Math.max(1, limit));

      return h(
        "div",
        { className: "dsh-persona-root" },
        h(
          "div",
          { className: "dsh-persona-header" },
          h(
            "div",
            null,
            h("h3", { className: "dsh-persona-title" }, "模型人格"),
            h(
              "div",
              { className: "dsh-persona-muted" },
              `共 ${personas.length} 套 · 默认：${
                data.defaultId === null
                  ? "未设置（跟随 preset）"
                  : personas.find((persona) => persona.id === data.defaultId)?.name ?? data.defaultId
              }`,
            ),
          ),
          h(
            "div",
            { className: "dsh-persona-actions" },
            h(
              "button",
              { className: "dsh-persona-btn", type: "button", onClick: startCreate, disabled: busy },
              "新建人格",
            ),
            h(
              "button",
              {
                className: "dsh-persona-btn",
                type: "button",
                onClick: () => {
                  setMode("io");
                  void call("export").then((result) => setIoText(JSON.stringify(result.data, null, 2)));
                },
              },
              "导入/导出",
            ),
          ),
        ),

        h(ErrorBanner, {
          error: snapshot.error,
          onDismiss: () => {
            store.error = null;
            notify();
          },
        }),

        h(
          "div",
          { className: "dsh-persona-limit" },
          h("span", { className: "dsh-persona-muted" }, `${personas.length}/${limit}`),
          h("span", { className: "dsh-persona-bar" }, h("i", { style: { width: `${ratio * 100}%` } })),
        ),

        mode === "io"
          ? h(
              "div",
              { className: "dsh-persona-editor" },
              h("div", { className: "dsh-persona-muted" }, "导出（可直接复制备份）或粘贴导入内容后点「导入覆盖」。"),
              h("textarea", {
                className: "dsh-persona-textarea",
                style: { minHeight: "200px" },
                value: ioText,
                onChange: (event) => setIoText(event.target.value),
              }),
              h(
                "div",
                { className: "dsh-persona-actions" },
                h(
                  "button",
                  {
                    className: "dsh-persona-btn",
                    type: "button",
                    onClick: () => download("dsh-personas.json", ioText),
                  },
                  "下载备份",
                ),
                h(
                  "button",
                  {
                    className: "dsh-persona-btn",
                    type: "button",
                    onClick: () => {
                      setIoText("");
                      void call("export").then((result) => setIoText(JSON.stringify(result.data, null, 2)));
                    },
                  },
                  "重新导出",
                ),
                h(
                  "button",
                  {
                    className: "dsh-persona-btn",
                    type: "button",
                    "data-kind": "danger",
                    disabled: busy || ioText.trim().length === 0,
                    onClick: () => {
                      let parsed;
                      try {
                        parsed = JSON.parse(ioText);
                      } catch (error) {
                        store.error = `导入内容不是合法 JSON：${String(error?.message ?? error)}`;
                        notify();
                        return;
                      }
                      if (!window.confirm("导入会覆盖当前人格库（会话绑定中仍有效者保留）。继续？")) return;
                      run(() => mutate(undefined, "import", { data: parsed }));
                    },
                  },
                  "导入覆盖",
                ),
                h(
                  "button",
                  { className: "dsh-persona-btn", type: "button", onClick: () => setMode("edit") },
                  "返回",
                ),
              ),
              h("div", { className: "dsh-persona-hint" }, `存储文件：${data.storePath ?? "?"}`),
            )
          : h(
              "div",
              { className: "dsh-persona-cols" },
              h(
                "div",
                { className: "dsh-persona-list" },
                personas.length === 0
                  ? h("div", { className: "dsh-persona-muted" }, "还没有人格，点「新建人格」开始。")
                  : personas.map((persona) =>
                      h(
                        "button",
                        {
                          key: persona.id,
                          type: "button",
                          className: "dsh-persona-item",
                          "data-active": String(mode === "edit" && persona.id === selectedId),
                          onClick: () => {
                            setMode("edit");
                            setSelectedId(persona.id);
                          },
                        },
                        h("span", null, persona.emoji || "🙂"),
                        h("span", { className: "dsh-persona-item-name" }, persona.name),
                        persona.id === data.defaultId ? h("span", { className: "dsh-persona-tag" }, "默认") : null,
                      ),
                    ),
              ),
              h(
                "div",
                { className: "dsh-persona-editor" },
                draft === null
                  ? h("div", { className: "dsh-persona-muted" }, "左侧选择一套人格，或新建。")
                  : h(
                      react.Fragment,
                      null,
                      h(
                        "div",
                        { className: "dsh-persona-row" },
                        h("div", { style: { width: "64px" } }, h(Field, {
                          label: "图标",
                          value: draft.emoji,
                          onChange: (value) => setDraft({ ...draft, emoji: value }),
                        })),
                        h("div", { style: { flex: 1, minWidth: "160px" } }, h(Field, {
                          label: "名称",
                          value: draft.name,
                          placeholder: "例如：精简架构师",
                          onChange: (value) => setDraft({ ...draft, name: value }),
                        })),
                      ),
                      h(Field, {
                        label: "简介（在选择器里显示）",
                        value: draft.description,
                        placeholder: "一句话说明这套人格适合什么场景",
                        onChange: (value) => setDraft({ ...draft, description: value }),
                      }),
                      h(Field, {
                        label: "人格前缀 —— 插在系统提示词最前面（order 0）",
                        value: draft.prefix,
                        multiline: true,
                        placeholder: "例如：回答时先给结论，再给支撑它的最少必要细节……",
                        onChange: (value) => setDraft({ ...draft, prefix: value }),
                      }),
                      h(Field, {
                        label: "人格后缀 —— 追加在系统提示词末尾（order 10200）",
                        value: draft.suffix,
                        multiline: true,
                        placeholder: "可留空",
                        onChange: (value) => setDraft({ ...draft, suffix: value }),
                      }),
                      h(
                        "div",
                        { className: "dsh-persona-row" },
                        h(
                          "label",
                          { className: "dsh-persona-check" },
                          h("input", {
                            type: "checkbox",
                            checked: draft.complete,
                            onChange: (event) => setDraft({ ...draft, complete: event.target.checked }),
                          }),
                          "完全接管（只用人格文本作为系统提示词）",
                        ),
                        h(
                          "label",
                          { className: "dsh-persona-check" },
                          h("input", {
                            type: "checkbox",
                            checked: draft.suppressRuntimeContext,
                            onChange: (event) => setDraft({ ...draft, suppressRuntimeContext: event.target.checked }),
                          }),
                          "不注入运行时上下文",
                        ),
                      ),
                      h(
                        "div",
                        { className: "dsh-persona-hint" },
                        "「完全接管」会丢弃 Harness 自带的工具说明与政策文本，人格文本必须自备全部行为约束；不确定时请不要勾选。",
                      ),
                      h("div", { className: "dsh-persona-divider" }),
                      h(
                        "div",
                        { className: "dsh-persona-actions" },
                        h(
                          "button",
                          {
                            className: "dsh-persona-btn",
                            type: "button",
                            "data-kind": "primary",
                            disabled: busy || draft.name.trim().length === 0,
                            onClick: save,
                          },
                          mode === "create" ? "创建" : "保存修改",
                        ),
                        mode === "edit" && current !== null
                          ? h(
                              "button",
                              {
                                className: "dsh-persona-btn",
                                type: "button",
                                disabled: busy || current.id === data.defaultId,
                                onClick: () => setDefault(current),
                              },
                              current.id === data.defaultId ? "已是默认" : "设为默认人格",
                            )
                          : null,
                        h(
                          "button",
                          {
                            className: "dsh-persona-btn",
                            type: "button",
                            disabled: busy || data.defaultId === null,
                            onClick: () => run(() => mutate(undefined, "setDefault", { id: null })),
                          },
                          "取消默认",
                        ),
                        mode === "edit" && current !== null
                          ? h(
                              "button",
                              {
                                className: "dsh-persona-btn",
                                type: "button",
                                "data-kind": "danger",
                                disabled: busy,
                                onClick: () => remove(current),
                              },
                              "删除",
                            )
                          : null,
                        mode === "create"
                          ? h(
                              "button",
                              { className: "dsh-persona-btn", type: "button", onClick: () => setMode("edit") },
                              "取消",
                            )
                          : null,
                      ),
                      h(
                        "div",
                        { className: "dsh-persona-hint" },
                        "默认人格只决定「没有单独指定人格的会话」用哪一套；已单独切换过的会话不受影响。",
                      ),
                      // 模型工具这一路完全在 Host 半：第三方插件 import 不到
                      // `@deepseek-ai/dsh-tools`，注册方式与失败原因都只有 Host 知道，
                      // 所以把它的状态显示出来，省得「UI 好了但模型没有工具」没人发现。
                      h(
                        "div",
                        { className: "dsh-persona-hint" },
                        data.tools === undefined
                          ? "模型工具：状态未知（Host 半未上报）"
                          : data.tools.error
                            ? `模型工具：注册失败 —— ${data.tools.error}`
                            : `模型工具：已注册 ${(data.tools.registered ?? []).join("、") || "（无）"}，模型可自行列人格 / 切人格 / 建人格。`,
                      ),
                    ),
              ),
            ),
      );
    }

    // ── 输入框旁的会话级切换器 ────────────────────────────────────────────────────

    function PersonaSwitcher(props) {
      const sessionId = props.sessionId;
      const snapshot = useSnapshot();
      const [open, setOpen] = useState(false);
      const [deferred, setDeferred] = useState(false);
      const [busy, setBusy] = useState(false);
      const anchorRef = useRef(null);
      const popRef = useRef(null);

      useEffect(() => {
        if (typeof sessionId !== "string" || sessionId.length === 0) return;
        void refresh(sessionId);
      }, [sessionId]);

      // 外部点击关闭。用 document 级捕获监听，而不是全屏遮罩元素：
      // 遮罩层会盖住菜单本身，让菜单里的按钮全部点不动（这正是此前的 bug）。
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event?.target ?? null;
          if (target === null) return;
          if (anchorRef.current !== null && anchorRef.current.contains(target)) return;
          if (popRef.current !== null && popRef.current.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
      }, [open]);

      const data = snapshot.snapshot;
      const session = data?.session ?? null;
      const effective = data?.effective ?? null;
      const personas = data?.personas ?? [];
      const binding = session?.binding ?? null;

      const currentName =
        effective === null
          ? null
          : effective.source === "custom"
            ? "自定义人格"
            : personas.find((persona) => persona.id === effective.personaId)?.name ?? effective.personaId;
      const currentEmoji =
        effective === null
          ? null
          : effective.source === "custom"
            ? "✎"
            : personas.find((persona) => persona.id === effective.personaId)?.emoji || "🙂";

      const apply = (personaId, custom) => {
        setBusy(true);
        void mutate(sessionId, "switch", { sessionId, personaId, custom, activate: !deferred })
          .catch(() => {})
          .finally(() => {
            setBusy(false);
            setOpen(false);
          });
      };

      const chip = h(
        "button",
        {
          type: "button",
          className: "dsh-persona-chip",
          "data-custom": String(effective?.source === "custom"),
          title:
            effective === null
              ? "人格：跟随默认/预设（点击切换）"
              : `人格：${currentName}（来源：${
                  effective.source === "default" ? "默认人格" : effective.source === "custom" ? "会话自定义文本" : "本会话指定"
                }）`,
          onClick: () => setOpen((value) => !value),
          ref: anchorRef,
        },
        h("span", null, currentEmoji ?? "🎭"),
        h("span", { className: "dsh-persona-chip-label" }, currentName ?? "人格"),
        h("span", { style: { opacity: 0.55, fontSize: "10px" } }, "▾"),
      );

      if (!open) return chip;

      const popover = h(
        "div",
        { className: "dsh-persona-pop", role: "dialog", ref: popRef },
        h(
          "div",
          { className: "dsh-persona-pop-head" },
          h("strong", null, "本会话人格"),
          h(
            "span",
            { className: "dsh-persona-muted" },
            effective === null
              ? "跟随默认/预设"
              : effective.source === "default"
                ? "来自默认人格"
                : effective.source === "custom"
                  ? "会话自定义文本"
                  : "本会话指定",
          ),
        ),
        h(
          "div",
          { className: "dsh-persona-pop-list" },
          h(
            "button",
            {
              type: "button",
              className: "dsh-persona-pop-item",
              "data-active": String(binding === null || (binding?.personaId === undefined && binding?.custom === undefined)),
              disabled: busy,
              onClick: () => apply(null, undefined),
            },
            h("span", null, "🎭"),
            h("span", { className: "dsh-persona-item-name" }, "跟随默认人格 / preset"),
          ),
          personas.map((persona) =>
            h(
              "button",
              {
                key: persona.id,
                type: "button",
                className: "dsh-persona-pop-item",
                "data-active": String(binding?.personaId === persona.id && binding?.custom === undefined),
                disabled: busy,
                title: persona.description || persona.name,
                onClick: () => apply(persona.id, undefined),
              },
              h("span", null, persona.emoji || "🙂"),
              h("span", { className: "dsh-persona-item-name" }, persona.name),
              persona.id === data?.defaultId ? h("span", { className: "dsh-persona-tag" }, "默认") : null,
            ),
          ),
        ),
        h(
          "div",
          { className: "dsh-persona-pop-foot" },
          h(
            "label",
            { className: "dsh-persona-check" },
            h("input", {
              type: "checkbox",
              checked: deferred,
              onChange: (event) => setDeferred(event.target.checked),
            }),
            "仅对下一个会话生效（保留当前提示词，不清空 KV 缓存）",
          ),
          h(
            "div",
            { className: "dsh-persona-hint" },
            deferred
              ? "选择后只记录，本会话继续用原人格。"
              : "选择后立刻注入：下一次模型请求即用新人格，缓存前缀自首个变化的 token 起失效。",
          ),
          h(
            "div",
            { className: "dsh-persona-actions", style: { marginTop: "8px" } },
            h(
              "button",
              {
                className: "dsh-persona-btn",
                type: "button",
                disabled: busy,
                onClick: () => {
                  const custom = window.prompt("本会话临时人格文本（留空则取消）：", binding?.custom ?? "");
                  if (custom === null) return;
                  if (custom.trim().length === 0) return;
                  apply(null, custom);
                },
              },
              "临时文本…",
            ),
            h(
              "button",
              {
                className: "dsh-persona-btn",
                type: "button",
                disabled: busy,
                onClick: () => {
                  setBusy(true);
                  void mutate(sessionId, "activate", { sessionId })
                    .catch(() => {})
                    .finally(() => setBusy(false));
                },
              },
              "立即重注入",
            ),
            h(
              "button",
              { className: "dsh-persona-btn", type: "button", onClick: () => setOpen(false) },
              "关闭",
            ),
          ),
          h(
            "div",
            { className: "dsh-persona-hint" },
            "在「设置 → 模型人格」里管理人格库与默认人格。",
          ),
        ),
      );

      // 菜单挂在 chip 旁的绝对定位容器里（不引入 react-dom portal）：输入框工具行有
      // overflow/transform，所以靠「绝对定位 + 高 z-index + document 级外部点击监听」
      // 保证菜单可见且每一项都能点到。
      return h(
        react.Fragment,
        null,
        h(
          "span",
          { style: { position: "relative", display: "inline-flex" } },
          chip,
          h("span", { style: { position: "absolute", bottom: "100%", left: 0, zIndex: 2147483600 } }, popover),
        ),
      );
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────────────

    /** 依赖的客户端服务：缺任何一个，对应挂载点就不会注册（而不是整个插件挂掉）。 */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: NS,
            order: 25,
            label: () => "模型人格",
            // 不要再声明 children：`settings.general.item` 已经由 ui-settings-general 的
            // general 条目声明过了，重复声明会让 register() 直接抛
            // `slot "settings.general.item" is already declared`，本页也就注册不上。
          },
          PersonaSettings,
        ),
      );

      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: `${NS}.switcher`,
            order: 120,
            label: () => "人格",
            // 会话作用域的槽位把 session id 交给 inject；这里同时容忍「直接给 id 字符串」
            // 与「给会话对象」两种形状，避免宿主版本差异把切换器打瘸。
            inject: (session) => {
              const id =
                typeof session === "string"
                  ? session
                  : typeof session?.id === "string"
                    ? session.id
                    : undefined;
              return { sessionId: id };
            },
          },
          PersonaSwitcher,
        ),
      );

      // 首次打开就把快照拉回来，设置页与切换器都立即有数据。
      void refresh();

      // 客户端没有 session 级事件，只有这四个：connection/reset、locale/change、
      // slots/changed、theme/change。连接代次重建后重新同步一次快照即可。
      ctx.effect(
        () => ctx.on("connection/reset", () => void refresh()),
        "persona.connection-reset",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = NS;
    return module.exports;
  },
});
//# sourceMappingURL=client.js.map
