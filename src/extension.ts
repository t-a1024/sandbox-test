// src/extension.ts (修正版)
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { runCommand, LangConfigEntry } from "./runner";

/** コマンド名 */
const OPEN_CMD = "sandbox.open";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(OPEN_CMD, async () => {
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
      panel.webview.html = await loadSandboxHtml(panel.webview, context.extensionUri);
    } catch (err) {
      panel.webview.html = `<html><body><h2>読み込みエラー</h2><pre>${String(err)}</pre></body></html>`;
    }

    // ← ここが重要: Webview からのメッセージを受け取るハンドラを必ず登録する
    panel.webview.onDidReceiveMessage(
      async (message) => {
        // 期待する message: { command: 'run', language, code, execCommand }
        if (!message || !message.command) {
          panel.webview.postMessage({ kind: "error", text: "無効なメッセージを受信しました。" });
          return;
        }

        switch (message.command) {
          case "run":
            await handleRunFromWebview(message, panel, context);
            break;
          default:
            panel.webview.postMessage({ kind: "error", text: `不明なコマンド: ${message.command}` });
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

async function loadSandboxHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const htmlPath = vscode.Uri.joinPath(extensionUri, "media", "sandbox.html").fsPath;
  let html = fs.readFileSync(htmlPath, { encoding: "utf8" });

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "sandbox_init.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css"));
  const nonce = getNonce();
  const baseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media"));

  // langConfig.json を読み込んで埋める
  const configPath = vscode.Uri.joinPath(extensionUri, "media", "langConfig.json").fsPath;
  let langConfig = {};
  try {
    langConfig = JSON.parse(fs.readFileSync(configPath, { encoding: "utf8" }));
  } catch (e) {
    langConfig = {};
  }
  const langConfigScript = `<script nonce="${nonce}">window.LANG_CONFIG = ${JSON.stringify(langConfig)};</script>`;

  html = html.replace(/%SCRIPT_URI%/g, String(scriptUri));
  html = html.replace(/%STYLE_URI%/g, String(styleUri));
  html = html.replace(/%NONCE%/g, nonce);
  html = html.replace(/%BASE_URI%/g, String(baseUri));
  html = html.replace(/%LANG_CONFIG_SCRIPT%/g, langConfigScript);

  return html;
}

/** Webview からの run メッセージを runner に渡す */
async function handleRunFromWebview(message: any, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    panel.webview.postMessage({ kind: "error", text: "ワークスペースが開かれていません。まずワークスペースを開いてください。" });
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const lang = message.language;
  const code = message.code || "";
  const userExecCommand = (message.execCommand || "").trim();

  // config を読み直す（防御的）
  const configPath = path.join(context.extensionPath, "media", "langConfig.json");
  let langConfig: { [k: string]: LangConfigEntry } = {};
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

  // runner に委譲
  try {
    await runCommand({
      workspaceRoot,
      lang,
      code,
      userExecCommand,
      conf,
      panel
    });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `実行中に例外が発生しました: ${String(err)}` });
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
