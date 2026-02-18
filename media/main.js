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
  let currentLang = langSelect.value || "javascript";

  const templates = {
    javascript: `// JavaScript template\nconsole.log("Hello from Monaco sandbox (JS)");\n`,
    typescript: `// TypeScript template\nconst greet = (name: string) => {\n  return \`Hello, \${name} (TS)\`;\n};\nconsole.log(greet("World"));\n`
  };

  // デフォルトの実行コマンドを言語ごとに設定
  const defaultCommands = {
    javascript: "node {file}",
    typescript: "node {file}" // ts-node などを使いたければユーザーが書き換える
  };

  // 初期コマンドセット
  execCommandTextarea.value = defaultCommands[currentLang];

  // load Monaco via require.js
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

  // 言語切替: モデル言語を切り替え、textareaのデフォルトコマンドも切り替える
  langSelect.addEventListener("change", (ev) => {
    const lang = ev.target.value;
    currentLang = lang;
    if (monacoInstance && model) {
      const monLang = lang === "typescript" ? "typescript" : "javascript";
      monacoInstance.editor.setModelLanguage(model, monLang);
    }
    setEditorContent(templates[lang] || "");
    // exec コマンドを言語デフォルトに更新（ユーザーが既に編集している場合は上書きしない方が良いが、簡易実装では切替で上書き）
    execCommandTextarea.value = defaultCommands[lang] || "";
  });

  function setEditorContent(text) {
    if (!model) return;
    model.setValue(text);
  }

  function getEditorContent() {
    if (!model) return "";
    return model.getValue();
  }

  // Run ボタン: コードと execCommand を送信
  runBtn.addEventListener("click", () => {
    const code = getEditorContent();
    const execCommand = execCommandTextarea.value || "";
    outputArea.textContent = ""; // clear
    vscode.postMessage({ command: "run", language: currentLang, code, execCommand });
  });

  loadTemplateBtn.addEventListener("click", () => {
    if (confirm("テンプレートを読み込みます。現在の内容は上書きされます。よろしいですか？")) {
      setEditorContent(templates[currentLang] || "");
    }
  });

  // extension からのメッセージ受け取り
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

  // 初期処理
  appendOutput("Monaco sandbox initializing...\n");
  loadMonaco();
})();
