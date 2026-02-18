import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("sandbox.open", async () => {
    // Open webview panel on the right (ViewColumn.Two)
    const panel = vscode.window.createWebviewPanel(
      "sandboxView",
      "Sandbox",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    // Set HTML content
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "run":
            await handleRun(message, panel, context);
            return;
          case "saveTemplate":
            // optional: allow saving template to workspace
            await handleSaveTemplate(message, panel);
            return;
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  // nothing special
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));

  // We use CodeMirror from CDN in the webview (module). The webview itself runs the UI in media/.
  // Use a nonce for CSP
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource} https:; script-src 'nonce-${nonce}' https:; connect-src https: http: file: ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Sandbox</title>
</head>
<body>
  <div class="toolbar">
    <select id="langSelect">
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
    </select>
    <button id="runBtn">Run</button>
    <button id="templateBtn">Load Template</button>
  </div>

  <div id="editor" class="editor"></div>

  <div class="output">
    <div class="output-header">Output</div>
    <pre id="outputArea" class="output-area"></pre>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

async function handleRun(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  // message: { command: 'run', language: 'javascript'|'typescript', code: '...' }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    panel.webview.postMessage({ kind: "error", text: "ワークスペースが開かれていません。まずワークスペースを開いてください。" });
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const lang = message.language;
  const code = message.code || "";

  // choose file name and execution command per language
  const tmpFileName = lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js";
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  // write file
  try {
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `一時ファイル書き込みエラー: ${String(err)}` });
    return;
  }

  // Prepare command: as requested, execute `node sandbox_temp.js` or `node sandbox_temp.ts`
  // NOTE: Running .ts directly with node requires ts-node or similar installed in the project's environment.
  const execCmd = `node ${tmpFileName}`;
  const options = { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 };

  panel.webview.postMessage({ kind: "status", text: `実行: ${execCmd}` });

  const child = exec(execCmd, options, (error, stdout, stderr) => {
    // send result back
    const outText = stdout || "";
    const errText = stderr || (error ? String(error) : "");
    panel.webview.postMessage({
      kind: "result",
      stdout: outText,
      stderr: errText
    });

    // try to cleanup temp file
    try {
      fs.unlinkSync(tmpFilePath);
    } catch (e) {
      // ignore cleanup error
    }
  });

  // optionally stream output back in realtime
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      panel.webview.postMessage({ kind: "stream", stdout: String(chunk) });
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      panel.webview.postMessage({ kind: "stream", stderr: String(chunk) });
    });
  }
}

async function handleSaveTemplate(message: any, panel: vscode.WebviewPanel) {
  // optional: save template to workspace file if requested
  panel.webview.postMessage({ kind: "info", text: "テンプレートの保存は未実装 (必要なら追加します)" });
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
