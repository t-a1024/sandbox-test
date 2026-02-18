import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("sandbox.open", async () => {
    const panel = vscode.window.createWebviewPanel(
      "sandboxView",
      "Sandbox",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "run":
            await handleRun(message, panel, context);
            return;
          default:
            panel.webview.postMessage({ kind: "error", text: "Unknown command" });
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  // no-op
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));

  // nonce for CSP
  const nonce = getNonce();

  // Note: we will load require.js & Monaco from CDN inside webview script.
  // CSP allows scripts from https: and the nonce for inline script if needed.
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource} https:; script-src 'nonce-${nonce}' https:; connect-src https: http: ws: ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Sandbox (Monaco)</title>
</head>
<body>
  <div class="toolbar">
    <select id="langSelect">
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
    </select>
    <button id="runBtn">Run</button>
    <button id="loadTemplateBtn">Load Template</button>
  </div>

  <div id="editor" class="editor"></div>

  <div class="output">
    <div class="output-header">Output</div>
    <pre id="outputArea" class="output-area"></pre>
  </div>

  <!-- main UI script -->
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

async function handleRun(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    panel.webview.postMessage({ kind: "error", text: "ワークスペースが開かれていません。ワークスペースを開いてください。" });
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const lang = message.language;
  const code = message.code || "";

  const tmpFileName = lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js";
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  try {
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `一時ファイル書き込みエラー: ${String(err)}` });
    return;
  }

  // Execute per user's requirement: run `node sandbox_temp.js` or `node sandbox_temp.ts`
  const execCmd = `node ${tmpFileName}`;
  const options = { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 };

  panel.webview.postMessage({ kind: "status", text: `実行: ${execCmd}` });

  const child = exec(execCmd, options, (error, stdout, stderr) => {
    const outText = stdout || "";
    const errText = stderr || (error ? String(error) : "");
    panel.webview.postMessage({
      kind: "result",
      stdout: outText,
      stderr: errText
    });

    // cleanup
    try {
      fs.unlinkSync(tmpFilePath);
    } catch (e) {
      // ignore
    }
  });

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

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
