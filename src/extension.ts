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
        // ローカルリソース参照を許可するルート
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );

    try {
      panel.webview.html = await loadHtmlForWebview(panel.webview, context.extensionUri);
    } catch (err) {
      panel.webview.html = `<html><body><h2>HTML読み込みエラー</h2><pre>${String(err)}</pre></body></html>`;
    }

    // webview からのメッセージを受け取る
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

/**
 * 非アクティベート処理（必要なら）
 */
export function deactivate() {
  // noop
}

/**
 * media/webview.html を読み込み、プレースホルダを置換して返す
 */
async function loadHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  // media/webview.html の絶対パス
  const htmlPath = vscode.Uri.joinPath(extensionUri, "media", "webview.html").fsPath;

  let html = fs.readFileSync(htmlPath, { encoding: "utf8" });

  // Webview 内で使う各リソースの webview URI を作る
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));

  // nonce を生成して CSP 用に差し替え
  const nonce = getNonce();

  // (任意) media フォルダをベースURIとして提供したければ置換
  const baseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media"));

  // プレースホルダ置換
  html = html.replace(/%SCRIPT_URI%/g, String(scriptUri));
  html = html.replace(/%STYLE_URI%/g, String(styleUri));
  html = html.replace(/%NONCE%/g, nonce);
  html = html.replace(/%BASE_URI%/g, String(baseUri));

  return html;
}

/**
 * Run 実行ハンドラ（既存のロジックをそのまま使用）
 */
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

  const tmpFileName = lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js";
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  try {
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `一時ファイル書き込みエラー: ${String(err)}` });
    return;
  }

  // 実行コマンド（要求どおり node を実行）
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

    // 一時ファイルのクリーンアップ（失敗しても無視）
    try {
      fs.unlinkSync(tmpFilePath);
    } catch (e) {}
  });

  // 実行中のストリームを随時送る（リアルタイム表示）
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

/** nonce 生成ユーティリティ */
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
