// sandbox_init.js
// - 他 webview に埋め込み可能な形で、#sandbox-root に UI（toolbar, cmd textarea, editor, output）を描画する。
// - window.LANG_CONFIG を参照して言語リスト・テンプレート・デフォルトコマンドを設定。
// - Monaco の初期化や postMessage の送受信は内部で行う。

(function () {
  const vscode = (typeof acquireVsCodeApi === "function") ? acquireVsCodeApi() : null;

  // root element (外部 webview の HTML 内に <div id="sandbox-root"> が必要)
  const ROOT_ID = "sandbox-root";
  const root = document.getElementById(ROOT_ID);
  if (!root) {
    console.error("sandbox_init: root element not found. Please include <div id=\"sandbox-root\"></div> in your HTML.");
    return;
  }

  // LANG_CONFIG must be present on window (injected by extension or embedding page)
  const LANG_CONFIG = window.LANG_CONFIG || {};
  const LANGS = Object.keys(LANG_CONFIG);
  if (LANGS.length === 0) {
    // fallback default
    console.warn("sandbox_init: LANG_CONFIG is empty or not found.");
  }

  // create DOM structure inside root
  root.innerHTML = `
    <div class="sandbox-toolbar" id="sb-toolbar"></div>
    <div class="sandbox-cmd" id="sb-cmd"></div>
    <div class="sandbox-editor" id="sb-editor" style="height: 360px;"></div>
    <div class="sandbox-output" id="sb-output"><div class="output-header">Output</div><pre id="sb-output-area" class="output-area"></pre></div>
  `;

  const toolbar = document.getElementById("sb-toolbar");
  const cmdArea = document.getElementById("sb-cmd");
  const editorEl = document.getElementById("sb-editor");
  const outputArea = document.getElementById("sb-output-area");

  // build toolbar: language select + run + load template
  const select = document.createElement("select");
  select.id = "sb-langSelect";
  for (const l of LANGS) {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    select.appendChild(opt);
  }
  toolbar.appendChild(select);

  const runBtn = document.createElement("button");
  runBtn.id = "sb-runBtn";
  runBtn.textContent = "Run";
  toolbar.appendChild(runBtn);

  const loadBtn = document.createElement("button");
  loadBtn.id = "sb-loadBtn";
  loadBtn.textContent = "Load Template";
  toolbar.appendChild(loadBtn);

  // cmd area: textarea + note
  cmdArea.innerHTML = `
    <textarea id="sb-execCommand" placeholder="実行コマンドをここに記述。{file} がテンポラリファイル名に置換されます。" style="width:70%;height:64px;font-family:monospace;"></textarea>
    <div style="font-size:12px;color:#666;margin-left:8px;">
      <div>説明: <code>{file}</code> は一時ファイル名に置換されます。</div>
      <div>例: <code>node {file}</code> / <code>ts-node {file}</code> / <code>gcc {file} -o a.out && ./a.out</code></div>
    </div>
  `;

  // helper to append output
  function appendOutput(text) {
    outputArea.textContent += text;
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  // Monaco editor setup (load via CDN require)
  let monaco = null;
  let editor = null;
  let model = null;

  function loadMonacoAndCreateEditor(initialLang, initialCode) {
    const requireScriptUrl = "https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js";

    if (window.require && window.monaco) {
      // already loaded
      monaco = window.monaco;
      createEditorInstance(initialLang, initialCode);
      return;
    }

    // load require.js
    const s = document.createElement("script");
    s.src = requireScriptUrl;
    s.onload = () => {
      const baseUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min";
      // @ts-ignore
      window.require.config({ paths: { vs: baseUrl + "/vs" } });

      // prevent worker issues with webview
      // @ts-ignore
      window.MonacoEnvironment = {
        getWorkerUrl: function () {
          const proxy = URL.createObjectURL(new Blob([`
            self.MonacoEnvironment = { baseUrl: '${baseUrl}' };
            importScripts('${baseUrl}/vs/base/worker/workerMain.js');
          `], { type: 'text/javascript' }));
          return proxy;
        }
      };

      // @ts-ignore
      window.require(["vs/editor/editor.main"], function () {
        monaco = window.monaco;
        createEditorInstance(initialLang, initialCode);
      });
    };
    s.onerror = () => {
      appendOutput("[error] require.js のロードに失敗しました。Monaco をロードできません。\n");
    };
    document.head.appendChild(s);
  }

  function createEditorInstance(lang, code) {
    try {
      const monLang = (lang === "typescript") ? "typescript" : "javascript";
      model = monaco.editor.createModel(code || "", monLang);
      editor = monaco.editor.create(editorEl, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        theme: "vs-dark",
        fontSize: 13,
        scrollBeyondLastLine: false
      });
    } catch (e) {
      appendOutput(`[error] Monaco editor 作成失敗: ${String(e)}\n`);
    }
  }

  // helper to get template and default command from LANG_CONFIG
  function getConfigFor(lang) {
    return (LANG_CONFIG && LANG_CONFIG[lang]) ? LANG_CONFIG[lang] : null;
  }

  // initialize selection and exec command textarea with first language
  const execTextarea = document.getElementById("sb-execCommand");
  const initialLang = select.value || Object.keys(LANG_CONFIG)[0] || "javascript";
  const initialConf = getConfigFor(initialLang) || {};
  execTextarea.value = initialConf.command || "";
  const initialTemplate = initialConf.templatecode || "";

  // load Monaco with initial language/template
  loadMonacoAndCreateEditor(initialLang, initialTemplate);

  // language change handler
  select.addEventListener("change", (ev) => {
    const lang = select.value;
    const conf = getConfigFor(lang) || {};
    // set exec command to config's command (overwrite initial; user can edit after)
    execTextarea.value = conf.command || "";
    // change editor language & set template
    if (monaco && model) {
      const monLang = (lang === "typescript") ? "typescript" : "javascript";
      monaco.editor.setModelLanguage(model, monLang);
      model.setValue(conf.templatecode || "");
    }
  });

  // Run button handler: gather code, execCommand, send to extension via postMessage
  runBtn.addEventListener("click", () => {
    const code = (model && model.getValue) ? model.getValue() : "";
    const execCommand = (execTextarea && execTextarea.value) ? execTextarea.value : "";
    // clear output
    outputArea.textContent = "";
    // send message: other extension's webview environment must handle messages; if acquireVsCodeApi exists then post to extension
    if (vscode) {
      vscode.postMessage({ command: "run", language: select.value, code, execCommand });
    } else {
      // if not in an extension webview, try to call window.onSandboxMessage if embedding page supplies it
      if (typeof window.onSandboxMessage === "function") {
        window.onSandboxMessage({ command: "run", language: select.value, code, execCommand }, (reply) => {
          // optional callback (not used here)
        });
      } else {
        appendOutput("[info] 実行メッセージを送信できません（acquireVsCodeApi が存在しません）。\n");
      }
    }
  });

  // Load template button: replace editor content with template
  loadBtn.addEventListener("click", () => {
    const conf = getConfigFor(select.value) || {};
    const tmpl = conf.templatecode || "";
    if (model && typeof model.setValue === "function") {
      model.setValue(tmpl);
    }
  });

  // Receive messages from extension (stream / error / exit / status)
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || !msg.kind) return;
    switch (msg.kind) {
      case "status":
        appendOutput(`[status] ${msg.text}\n`);
        break;
      case "stream":
        if (msg.stdout) appendOutput(msg.stdout);
        if (msg.stderr) appendOutput(msg.stderr);
        break;
      case "exit":
        appendOutput(`\n[process exited, code=${msg.code}, signal=${msg.signal}]\n`);
        break;
      case "error":
        appendOutput(`[error] ${msg.text}\n`);
        break;
      case "info":
        appendOutput(`[info] ${msg.text}\n`);
        break;
    }
  });

  // initial note
  appendOutput("Sandbox ready. 言語を選択して実行してください。\n");
})();
