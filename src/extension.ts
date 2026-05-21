import * as vscode from "vscode";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

const execAsync = promisify(exec);
const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;

const DATA_URI_IMG_REGEX =
  /<img\b[^>]*?\bsrc\s*=\s*"(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+))"[^>]*>/gi;

interface ExtractedImage {
  ext: string;
  buffer: Buffer;
  fullMatch: string;
}

async function getClipboardTargets(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("xclip -selection clipboard -t TARGETS -o");
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getClipboardHtml(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("xclip -selection clipboard -t text/html -o", {
      maxBuffer: MAX_CLIPBOARD_BYTES,
    });
    return stdout;
  } catch {
    return null;
  }
}

function getClipboardImageBuffer(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      { maxBuffer: MAX_CLIPBOARD_BYTES, encoding: "buffer" as BufferEncoding },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const buf = stdout as unknown as Buffer;
        if (!buf || buf.length < 8) {
          resolve(null);
          return;
        }
        resolve(buf);
      }
    );
  });
}

function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  if (doc.languageId === "markdown") return true;
  const fsPath = doc.uri.fsPath || "";
  const ext = path.extname(fsPath).toLowerCase();
  return ext === ".md" || ext === ".markdown" || ext === ".mdown" || ext === ".mkd";
}

function extractImages(html: string): { images: ExtractedImage[]; htmlMatches: string[] } {
  const images: ExtractedImage[] = [];
  const htmlMatches: string[] = [];
  for (const match of html.matchAll(DATA_URI_IMG_REGEX)) {
    const mime = match[2].toLowerCase();
    const ext = mime === "jpeg" ? "jpg" : mime === "svg+xml" ? "svg" : mime;
    const buffer = Buffer.from(match[3], "base64");
    images.push({ ext, buffer, fullMatch: match[0] });
    htmlMatches.push(match[0]);
  }
  return { images, htmlMatches };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function resolveAttachmentsDir(doc: vscode.TextDocument): Promise<string> {
  const config = vscode.workspace.getConfiguration("richPaste");
  const subdir = config.get<string>("attachmentsSubdir", "attachments");
  const useDocSub = config.get<boolean>("useDocumentSubfolder", true);

  const docDir = path.dirname(doc.uri.fsPath);
  const docBase = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const full = useDocSub ? path.join(docDir, subdir, docBase) : path.join(docDir, subdir);
  await fs.mkdir(full, { recursive: true });
  return full;
}

function relForMarkdown(docPath: string, filePath: string): string {
  const rel = path.relative(path.dirname(docPath), filePath);
  return rel.split(path.sep).join("/");
}

function htmlToPlainTextLines(html: string): string {
  let s = html;
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

async function buildMarkdownPaste(
  doc: vscode.TextDocument,
  html: string,
  fallbackText: string
): Promise<string | null> {
  const { images, htmlMatches } = extractImages(html);
  if (images.length === 0) return null;

  const attachmentsDir = await resolveAttachmentsDir(doc);
  const docBase = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
  const ts = timestamp();

  let workingHtml = html;
  const replacements: Array<{ fullMatch: string; markdown: string }> = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const filename = `${docBase}-${ts}-${i + 1}.${img.ext}`;
    const filePath = path.join(attachmentsDir, filename);
    await fs.writeFile(filePath, img.buffer);
    const rel = relForMarkdown(doc.uri.fsPath, filePath);
    const markdown = `\n\n![](${rel})\n\n`;
    replacements.push({ fullMatch: img.fullMatch, markdown });
  }
  for (const { fullMatch, markdown } of replacements) {
    workingHtml = workingHtml.replace(fullMatch, `\n${markdown}\n`);
  }

  const text = htmlToPlainTextLines(workingHtml);
  if (text.trim().length > 0) return text;
  return fallbackText.trim().length > 0 ? fallbackText : null;
}

async function promptSaveUntitled(
  editor: vscode.TextEditor
): Promise<vscode.TextEditor | null> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const defaultDir = wsFolder ? wsFolder.uri.fsPath : os.homedir();
  const defaultName = "notes.md";

  const targetUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName)),
    filters: { Markdown: ["md"], Text: ["txt"], "All files": ["*"] },
    saveLabel: "Save and Rich Paste",
    title: "Rich Paste: save this document before pasting images",
  });
  if (!targetUri) return null;

  const content = editor.document.getText();
  await fs.writeFile(targetUri.fsPath, content);

  const newDoc = await vscode.workspace.openTextDocument(targetUri);
  const newEditor = await vscode.window.showTextDocument(newDoc, editor.viewColumn);
  return newEditor;
}

async function pasteImageOnly(editor: vscode.TextEditor, buffer: Buffer): Promise<void> {
  const attachmentsDir = await resolveAttachmentsDir(editor.document);
  const docBase = path.basename(
    editor.document.uri.fsPath,
    path.extname(editor.document.uri.fsPath)
  );
  const filename = `${docBase}-${timestamp()}.png`;
  const filePath = path.join(attachmentsDir, filename);
  await fs.writeFile(filePath, buffer);
  const rel = relForMarkdown(editor.document.uri.fsPath, filePath);
  const markdown = `![](${rel})`;

  await editor.edit((editBuilder) => {
    for (const selection of editor.selections) {
      if (selection.isEmpty) editBuilder.insert(selection.active, markdown);
      else editBuilder.replace(selection, markdown);
    }
  });
}

async function smartPaste(): Promise<void> {
  let editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    return;
  }

  if (process.platform !== "linux") {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    return;
  }

  const targets = await getClipboardTargets();
  const hasHtml = targets.includes("text/html");
  const hasImage = targets.includes("image/png");

  let html: string | null = null;
  let hasDataUri = false;
  if (hasHtml) {
    html = await getClipboardHtml();
    if (html) {
      DATA_URI_IMG_REGEX.lastIndex = 0;
      hasDataUri = DATA_URI_IMG_REGEX.test(html);
      DATA_URI_IMG_REGEX.lastIndex = 0;
    }
  }

  const isMd = isMarkdownDocument(editor.document) || editor.document.isUntitled;
  const wantSmart = hasDataUri || (hasImage && isMd);

  if (!wantSmart) {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    return;
  }

  if (editor.document.isUntitled) {
    const saved = await promptSaveUntitled(editor);
    if (!saved) return;
    editor = saved;
  }

  try {
    if (hasDataUri && html) {
      const fallbackText = await vscode.env.clipboard.readText();
      const markdown = await buildMarkdownPaste(editor.document, html, fallbackText);
      if (!markdown) {
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        return;
      }
      await editor.edit((editBuilder) => {
        for (const selection of editor!.selections) {
          if (selection.isEmpty) editBuilder.insert(selection.active, markdown);
          else editBuilder.replace(selection, markdown);
        }
      });
      return;
    }

    if (hasImage) {
      const buffer = await getClipboardImageBuffer();
      if (!buffer) {
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        return;
      }
      await pasteImageOnly(editor, buffer);
      return;
    }

    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Rich Paste failed: ${msg}`);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("richPaste.smartPaste", smartPaste)
  );
}

export function deactivate(): void {}
