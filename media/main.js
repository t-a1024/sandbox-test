// main.js (webview)
(function () {
  const vscode = acquireVsCodeApi();

  const editorContainer = document.getElementById("editor");
  const runBtn = document.getElementById("runBtn");
  const langSelect = document.getElementById("langSelect");
  const outputArea = document.getElementById("outputArea");
  const loadTemplateBtn = document.getElementById("loadTemplateBtn");
  const execCommandTextarea = document.getElementById("execCommand");

  let monacoEditor = null;
  let monacoInstance = null;
  let model = null;
  let currentLang = null;

  // LANG_CONFIG は extension.ts により注入される
  const LANG_CONFIG = window.LANG_CONFIG || {};

  // If no langs defined, fallback
  if (!LANG_CONFIG || Object.keys(LANG_CONFIG).length === 0) {
    appendOutput("[error] 言語設定が見つかりません。langConfig.json を確認してください。\n");
  }

  // Build language select options dynamically
  function buildLangOptions() {
    const langs = Object.keys(LANG_CONFIG);
    // Clear existing
    langSelect.innerHTML = "";
    for (const l of langs) {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l;
      langSelect.appendChild(opt);
    }
    // Set currentLang to first if not set
    if (!currentLang) currentLang = langs[0];
    langSelect.value = currentLang;
  }

  // templates / default commands from config
  function getTemplateFor(lang) {
    const c = LANG_CONFIG[lang];
    return (c && c.templatecode) ? c.templatecode : "";
  }
  function getCommandFor(lang) {
    const c = LANG_CONFIG[lang];
    return (c && c.command) ? c.command : "";
  }
  function getFilenameFor(lang) {
    const c = LANG_CONFIG[lang];
    return (c && c.filename) ? c.filename : (lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js");
  }

  // Load Monaco via CDN (require.js)
  function loadMonaco() {
    const requireScript = document.createElement("script");
    requireScript.src = "https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js";
    requireScript.onload = () => {
      const baseUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min";
      window.require.config({ paths: { vs: baseUrl + "/vs" } });

      window.MonacoEnvironment = {
        getWorkerUrl: function () {
          const proxy = URL.createObjectURL(new Blob([`
            self.MonacoEnvironment = { baseUrl: '${baseUrl}' };
            importScripts('${baseUrl}/vs/base/worker/workerMain.js');
          `], { type: 'text/javascript' }));
          return proxy;
        }
      };

      window.require(["vs/editor/editor.main"], function () {
        monacoInstance = window.monaco;
        createEditor();
      });
    };
    requireScript.onerror = (e) => {
      appendOutput("[error] require.js のロードに失敗しました。\n");
    };
    document.body.appendChild(requireScript);
  }

  function createEditor() {
    const initial = getTemplateFor(currentLang) || "";
    model = monacoInstance.editor.createModel(initial, currentLang === "typescript" ? "typescript" : "javascript");

    monacoEditor = monacoInstance.editor.create(editorContainer, {
      model: model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      theme: "vs-dark"
    });

    // set initial execCommand from config
    execCommandTextarea.value = getCommandFor(currentLang) || "";
  }

  // Initialize language options and editor
  buildLangOptions();
  if (Object.keys(LANG_CONFIG).length > 0) {
    currentLang = langSelect.value;
  } else {
    currentLang = "javascript";
  }
  loadMonaco();

  // On language change: change model language, update template and execCommand textarea
  langSelect.addEventListener("change", (ev) => {
    const lang = ev.target.value;
    currentLang = lang;
    if (monacoInstance && model) {
      const monLang = lang === "typescript" ? "typescript" : "javascript";
      monacoInstance.editor.setModelLanguage(model, monLang);
    }
    // update editor content to template for this language
    const tmpl = getTemplateFor(lang);
    if (model && typeof model.setValue === "function") {
      model.setValue(tmpl);
    }
    // set exec command from config (initial prefilling). We do NOT prevent user edits afterwards.
    const cmd = getCommandFor(lang);
    execCommandTextarea.value = cmd || "";
  });

  function getEditorContent() {
    if (!model) return "";
    return model.getValue();
  }

  // Run: post message with execCommand and selected language
  runBtn.addEventListener("click", () => {
    const code = getEditorContent();
    const execCommand = execCommandTextarea.value || "";
    outputArea.textContent = ""; // clear
    vscode.postMessage({ command: "run", language: currentLang, code, execCommand });
  });

  loadTemplateBtn.addEventListener("click", () => {
    if (confirm("テンプレートを読み込みます。現在の内容は上書きされます。よろしいですか？")) {
      const tmpl = getTemplateFor(currentLang) || "";
      if (model && typeof model.setValue === "function") {
        model.setValue(tmpl);
      }
    }
  });

  // Messages from extension
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

  function appendOutput(text) {
    outputArea.textContent += text;
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  appendOutput("Monaco sandbox ready. 言語を選択して実行してください。\n");
})();
