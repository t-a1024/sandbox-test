// main.js (webview)
// Responsibilities:
// - Load Monaco Editor via AMD loader (require.js)
// - Initialize editor in #editor
// - Provide language switch (javascript/typescript)
// - Send {command: 'run', language, code} to extension when Run clicked
// - Receive and display execution output messages from extension

(function () {
  const vscode = acquireVsCodeApi();

  const editorContainer = document.getElementById("editor");
  const runBtn = document.getElementById("runBtn");
  const langSelect = document.getElementById("langSelect");
  const outputArea = document.getElementById("outputArea");
  const loadTemplateBtn = document.getElementById("loadTemplateBtn");

  let monacoEditor = null;
  let monacoInstance = null;
  let model = null;
  let currentLang = langSelect.value || "javascript";

  const templates = {
    javascript: `// JavaScript template\nconsole.log("Hello from Monaco sandbox (JS)");\n`,
    typescript: `// TypeScript template\nconst greet = (name: string) => {\n  return \`Hello, \${name} (TS)\`;\n};\nconsole.log(greet("World"));\n`
  };

  // Load require.js then Monaco via CDN
  function loadMonaco() {
    // load require.js from CDN
    const requireScript = document.createElement("script");
    requireScript.src = "https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js";
    requireScript.onload = () => {
      // Configure require to load Monaco from jsDelivr
      const baseUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min";
      // @ts-ignore
      window.require.config({ paths: { vs: baseUrl + "/vs" } });

      // Prevent worker errors by setting MonacoEnvironment to use CDN
      // @ts-ignore
      window.MonacoEnvironment = {
        getWorkerUrl: function (moduleId, label) {
          // Use blob URL to satisfy CSP restrictions in webview
          const proxy = URL.createObjectURL(new Blob([`
            self.MonacoEnvironment = { baseUrl: '${baseUrl}' };
            importScripts('${baseUrl}/vs/base/worker/workerMain.js');
          `], { type: 'text/javascript' }));
          return proxy;
        }
      };

      // require the editor main
      // @ts-ignore
      window.require(["vs/editor/editor.main"], function () {
        // monaco global available as window.monaco
        monacoInstance = window.monaco;
        createEditor();
      });
    };
    requireScript.onerror = (e) => {
      appendOutput("[error] require.js のロードに失敗しました。オフライン環境の場合は Monaco をローカル同梱してください。\n");
    };
    document.body.appendChild(requireScript);
  }

  function createEditor() {
    // create model with initial content
    const initial = templates[currentLang] || "";
    model = monacoInstance.editor.createModel(initial, currentLang === "typescript" ? "typescript" : "javascript");

    monacoEditor = monacoInstance.editor.create(editorContainer, {
      model: model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      theme: "vs-dark"
    });
  }

  // language switch
  langSelect.addEventListener("change", (ev) => {
    const lang = ev.target.value;
    currentLang = lang;
    if (monacoInstance && model) {
      const monLang = lang === "typescript" ? "typescript" : "javascript";
      monacoInstance.editor.setModelLanguage(model, monLang);
    }
    // replace doc with template
    setEditorContent(templates[lang] || "");
  });

  function setEditorContent(text) {
    if (!model) return;
    model.setValue(text);
  }

  function getEditorContent() {
    if (!model) return "";
    return model.getValue();
  }

  // Run handler
  runBtn.addEventListener("click", () => {
    const code = getEditorContent();
    outputArea.textContent = ""; // clear
    vscode.postMessage({ command: "run", language: currentLang, code });
  });

  loadTemplateBtn.addEventListener("click", () => {
    if (confirm("テンプレートを読み込みます。現在の内容は上書きされます。よろしいですか？")) {
      setEditorContent(templates[currentLang] || "");
    }
  });

  // messages from extension
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
      case "result":
        if (msg.stdout) appendOutput(msg.stdout);
        if (msg.stderr) appendOutput(msg.stderr);
        break;
      case "error":
        appendOutput(`[error] ${msg.text}\n`);
        break;
      case "info":
        appendOutput(`[info] ${msg.text}\n`);
        break;
      case "exit":
        appendOutput(`\n[process exited, code=${msg.code}, signal=${msg.signal}]\n`);
        break;
    }
  });

  function appendOutput(text) {
    outputArea.textContent += text;
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  // Initialize
  appendOutput("Monaco sandbox initializing...\n");
  loadMonaco();
})();
