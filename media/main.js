// This script runs inside the webview. It sets up CodeMirror for syntax highlighting,
// handles language switching, Run button, and communicates with extension via vscode.postMessage.

(function () {
  const vscode = acquireVsCodeApi();

  // Use CodeMirror 6 from CDN for editor (module). We'll load it dynamically.
  // NOTE: This requires web access from the webview to CDN. If offline, replace with packaged assets.
  const editorContainer = document.getElementById("editor");
  const runBtn = document.getElementById("runBtn");
  const langSelect = document.getElementById("langSelect");
  const outputArea = document.getElementById("outputArea");
  const templateBtn = document.getElementById("templateBtn");

  let editor = null;
  let currentLang = langSelect.value || "javascript";

  // Simple templates per language
  const templates = {
    javascript: `// JavaScript template\nconsole.log("Hello from sandbox (JS)");\n`,
    typescript: `// TypeScript template\nconst greet = (name: string) => {\n  return \`Hello, \${name} (TS)\`;\n};\nconsole.log(greet("World"));\n`
  };

  // load CodeMirror from CDN as an ES module
  async function loadEditor() {
    try {
      const [
        { EditorState },
        { EditorView, keymap },
        { default: javascript },
        { default: oneDark } // optional theme package
      ] = await Promise.all([
        import("https://cdn.jsdelivr.net/npm/@codemirror/state@6.2.1/dist/index.js"),
        import("https://cdn.jsdelivr.net/npm/@codemirror/view@6.14.0/dist/index.js"),
        import("https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.1.4/dist/index.js"),
        import("https://cdn.jsdelivr.net/npm/@codemirror/theme-one-dark@0.19.5/dist/index.js").catch(()=>({default: null}))
      ]);

      const { default: javascriptLang } = await import("https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.1.4/dist/index.js");
      const { default: typescriptLang } = await import("https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.1.4/dist/index.js");

      // Fallback simple theme
      const baseTheme = EditorView.theme({
        "&": { height: "100%" },
        ".cm-content": { fontFamily: "monospace", fontSize: "13px" }
      });

      const startDoc = templates[currentLang] || "";

      const state = EditorState.create({
        doc: startDoc,
        extensions: [
          EditorView.lineWrapping,
          baseTheme
        ]
      });

      editor = new EditorView({
        state,
        parent: editorContainer
      });

      // helper to reconfigure language mode
      window.setLanguage = (lang) => {
        currentLang = lang;
        let langSupport = null;
        if (lang === "typescript") {
          langSupport = javascriptLang({ typescript: true });
        } else {
          langSupport = javascriptLang({ jsx: false, typescript: false });
        }
        editor.dispatch({
          effects: EditorState.reconfigure.of([EditorView.lineWrapping, baseTheme, langSupport])
        });
      };

      // set initial language
      window.setLanguage(currentLang);
    } catch (e) {
      // If loading CDN modules fails, fall back to a plain textarea editor
      console.error("CodeMirror 6 をロードできませんでした。フォールバックします。", e);
      fallbackTextarea();
    }
  }

  function fallbackTextarea() {
    editorContainer.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.style.width = "100%";
    ta.style.height = "100%";
    ta.value = templates[currentLang] || "";
    editorContainer.appendChild(ta);
    editor = {
      getValue: () => ta.value,
      setValue: (v) => { ta.value = v; }
    };
  }

  // Initialize editor
  loadEditor();

  // Language change handler
  langSelect.addEventListener("change", (ev) => {
    const lang = ev.target.value;
    currentLang = lang;
    // if CodeMirror loaded, call setLanguage; else fallback
    if (window.setLanguage) {
      window.setLanguage(lang);
    }
    // set template into editor
    setEditorContent(templates[lang] || "");
  });

  function setEditorContent(text) {
    if (!editor) return;
    // CodeMirror view
    if (editor instanceof HTMLElement) {
      // improbable
    } else if (editor.getValue) {
      // CodeMirror
      try {
        editor.dispatch && editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: text }
        });
      } catch (e) {
        // fallback: if no dispatch, try setValue
        try { editor.setValue(text); } catch (e2) {}
      }
    } else {
      // fallback textarea object
      try { editor.setValue(text); } catch (e) {}
    }
  }

  function getEditorContent() {
    if (!editor) return "";
    try {
      // CodeMirror 6: editor.state.doc.toString()
      if (editor.state && editor.state.doc) {
        return editor.state.doc.toString();
      }
      if (editor.getValue) return editor.getValue();
    } catch (e) {}
    return "";
  }

  // Run button
  runBtn.addEventListener("click", () => {
    const code = getEditorContent();
    outputArea.textContent = ""; // clear
    vscode.postMessage({ command: "run", language: currentLang, code });
  });

  // Template load
  templateBtn.addEventListener("click", () => {
    if (confirm("テンプレートを読み込みます。現在の編集内容は上書きされます。よろしいですか？")) {
      setEditorContent(templates[currentLang] || "");
    }
  });

  // Receive messages from extension
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
    }
  });

  function appendOutput(text) {
    outputArea.textContent += text;
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  // initial output note
  appendOutput("Sandbox ready. 言語を選択してRunを押してください。\n");
})();
