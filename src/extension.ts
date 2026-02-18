import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { runCommand, LangConfigEntry } from "./runner";

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
 * Run メッセージを受け、runner に処理委譲する
 * message: { command: 'run', language, code, execCommand }
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

  // runner に処理委譲
  await runCommand({
    workspaceRoot,
    lang,
    code,
    userExecCommand,
    conf,
    panel
  });
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
