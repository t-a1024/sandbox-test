import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

/**
 * 拡張の有効化
 */
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

    try {
      panel.webview.html = await loadHtmlForWebview(panel.webview, context.extensionUri);
    } catch (err) {
      panel.webview.html = `<html><body><h2>HTML読み込みエラー</h2><pre>${String(err)}</pre></body></html>`;
    }

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
  // noop
}

/**
 * media/webview.html を読み込み、プレースホルダを置換して返す
 * ここで media/langConfig.json も読み、インラインスクリプトとして埋込む
 */
async function loadHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const htmlPath = vscode.Uri.joinPath(extensionUri, "media", "webview.html").fsPath;
  let html = fs.readFileSync(htmlPath, { encoding: "utf8" });

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));
  const nonce = getNonce();
  const baseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media"));

  // read config json
  const configPath = vscode.Uri.joinPath(extensionUri, "media", "langConfig.json").fsPath;
  let langConfig = {};
  try {
    const txt = fs.readFileSync(configPath, { encoding: "utf8" });
    langConfig = JSON.parse(txt);
  } catch (e) {
    // fallback to empty config
    langConfig = {};
  }

  // create inline script that sets window.LANG_CONFIG
  const configScript = `<script nonce="${nonce}">window.LANG_CONFIG = ${JSON.stringify(langConfig)};</script>`;

  html = html.replace(/%SCRIPT_URI%/g, String(scriptUri));
  html = html.replace(/%STYLE_URI%/g, String(styleUri));
  html = html.replace(/%NONCE%/g, nonce);
  html = html.replace(/%BASE_URI%/g, String(baseUri));
  html = html.replace(/%LANG_CONFIG_SCRIPT%/g, configScript);

  return html;
}

/**
 * 実行ハンドラ
 * message: { command: 'run', language, code, execCommand }
 * - execCommand は Webview の textarea の値（ユーザーが編集済みの可能性あり）
 * - ただし、execCommand が空の場合は config の command を使う
 */
async function handleRun(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    panel.webview.postMessage({ kind: "error", text: "ワークスペースが開かれていません。まずワークスペースを開いてください。" });
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const lang = message.language;
  const code = message.code || "";
  const userExecCommand = (message.execCommand || "").trim();

  // read config again (defensive)
  const configPath = path.join(context.extensionPath, "media", "langConfig.json");
  let langConfig: any = {};
  try {
    const txt = fs.readFileSync(configPath, { encoding: "utf8" });
    langConfig = JSON.parse(txt);
  } catch (e) {
    langConfig = {};
  }

  const conf = langConfig[lang];
  if (!conf) {
    panel.webview.postMessage({ kind: "error", text: `未サポートの言語: ${lang}` });
    return;
  }

  const tmpFileName = conf.filename || (lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js");
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  try {
    // write provided code to the configured filename (overwrites if exists)
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `一時ファイル書き込みエラー: ${String(err)}` });
    return;
  }

  // determine exec command: priority -> userExecCommand (non-empty) else conf.command
  let execCmd: string;
  const baseCmd = userExecCommand.length > 0 ? userExecCommand : (conf.command || "");
  if (baseCmd.includes("{file}")) {
    execCmd = baseCmd.replace(/{file}/g, tmpFileName);
  } else {
    execCmd = `${baseCmd} ${tmpFileName}`.trim();
  }

  const options = { cwd: workspaceRoot, maxBuffer: 20 * 1024 * 1024 };
  panel.webview.postMessage({ kind: "status", text: `実行: ${execCmd}` });

  // exec をコールバック無しで呼び出し、child を扱う（ストリームで逐次転送）
  const child = exec(execCmd, options);

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

  child.on("close", (code: number | null, signal: string | null) => {
    panel.webview.postMessage({
      kind: "exit",
      code: code,
      signal: signal
    });

    // cleanup: always delete temp file
    try {
      fs.unlinkSync(tmpFilePath);
    } catch (e) {
      // ignore
    }

    // delete additional files declared in conf.deletefile
    // conf.deletefile may be empty string or comma-separated list
    try {
      const df = conf.deletefile;
      if (df && typeof df === "string" && df.trim().length > 0) {
        // support comma-separated values, trim spaces
        const targets = df.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        for (const t of targets) {
          // if t is relative, resolve to workspaceRoot
          const targetPath = path.isAbsolute(t) ? t : path.join(workspaceRoot, t);
          try {
            if (fs.existsSync(targetPath)) {
              fs.unlinkSync(targetPath);
            }
          } catch (e) {
            // ignore individual failures
          }
        }
      }
    } catch (e) {
      // ignore
    }
  });

  child.on("error", (err: Error) => {
    panel.webview.postMessage({ kind: "error", text: `実行エラー: ${String(err)}` });
    // attempt cleanup
    try { fs.unlinkSync(tmpFilePath); } catch (e) {}
  });
}

/** nonce 生成ユーティリティ */
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
