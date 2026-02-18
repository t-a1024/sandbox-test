import * as fs from "fs";
import * as path from "path";
import { exec, ChildProcess } from "child_process";
import * as vscode from "vscode";

/**
 * 言語設定インターフェース（langConfig.json の各エントリ相当）
 */
export interface LangConfigEntry {
  command?: string;
  filename?: string;
  deletefile?: string;
  templatecode?: string;
}

/**
 * runCommand
 * - workspaceRoot: 実行時のカレント（ワークスペースルート）
 * - lang: 選択された言語キー（例: "javascript"）
 * - code: 実行するソースコード
 * - userExecCommand: Webview の textarea でユーザーが入力したコマンド（空文字なら config の command を使う）
 * - conf: 言語ごとの設定（LangConfigEntry）
 * - panel: webview のパネル（メッセージ送信用）
 *
 * Promise を返す。内部でメッセージを panel.webview.postMessage(...) で送信する。
 */
export async function runCommand(opts: {
  workspaceRoot: string;
  lang: string;
  code: string;
  userExecCommand: string;
  conf: LangConfigEntry;
  panel: vscode.WebviewPanel;
}): Promise<void> {
  const { workspaceRoot, lang, code, userExecCommand, conf, panel } = opts;

  // 決定ファイル名（conf.filename があれば使う。無ければ言語に応じたデフォルト）
  const tmpFileName = (conf && conf.filename) ? conf.filename : (lang === "typescript" ? "sandbox_temp.ts" : "sandbox_temp.js");
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  // 1) ファイル書き込み
  try {
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `一時ファイル書き込みエラー: ${String(err)}` });
    return;
  }

  // 2) 実行コマンド決定（優先: userExecCommand 非空 → それを使用。空なら conf.command）
  const baseCmd = (userExecCommand && userExecCommand.trim().length > 0) ? userExecCommand.trim() : (conf && conf.command ? conf.command : "");
  let execCmd = "";
  if (baseCmd.length === 0) {
    // safety fallback
    execCmd = `node ${tmpFileName}`;
  } else {
    if (baseCmd.includes("{file}")) {
      execCmd = baseCmd.replace(/{file}/g, tmpFileName);
    } else {
      execCmd = `${baseCmd} ${tmpFileName}`.trim();
    }
  }

  panel.webview.postMessage({ kind: "status", text: `実行: ${execCmd}` });

  // 3) プロセス起動（exec）。ストリームで送信、終了時にファイル削除などを行う
  let child: ChildProcess;
  try {
    child = exec(execCmd, { cwd: workspaceRoot, maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    panel.webview.postMessage({ kind: "error", text: `プロセス起動エラー: ${String(err)}` });
    // try cleanup
    try { fs.unlinkSync(tmpFilePath); } catch (e) {}
    return;
  }

  // ストリーム受け取り
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

  // 終了とクリーンアップは Promise で待てるようにする
  await new Promise<void>((resolve) => {
    child.on("close", (code: number | null, signal: string | null) => {
      panel.webview.postMessage({
        kind: "exit",
        code,
        signal
      });

      // 常に一時ファイルを削除
      try {
        if (fs.existsSync(tmpFilePath)) {
          fs.unlinkSync(tmpFilePath);
        }
      } catch (e) {
        // ignore
      }

      // conf.deletefile を処理（空文字 or comma-separated）
      try {
        const df = (conf && conf.deletefile) ? conf.deletefile : "";
        if (typeof df === "string" && df.trim().length > 0) {
          const targets = df.split(",").map(s => s.trim()).filter(s => s.length > 0);
          for (const t of targets) {
            // 相対パスは workspaceRoot 基準で解決、絶対パスはそのまま
            const targetPath = path.isAbsolute(t) ? t : path.join(workspaceRoot, t);
            try {
              if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
              }
            } catch (e) {
              // ignore individual failure
            }
          }
        }
      } catch (e) {
        // ignore
      }

      resolve();
    });

    child.on("error", (err: Error) => {
      panel.webview.postMessage({ kind: "error", text: `実行中のエラー: ${String(err)}` });
      // attempt cleanup
      try { if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath); } catch (e) {}
      resolve();
    });
  });

  // runCommand 完了
  return;
}
