# Rich Paste

Override `Ctrl+V` so that, when the clipboard contains rich HTML with embedded images (data URIs), the images are saved as files next to the current document and the editor receives plain text + markdown image links.

Use case: pair with the patched Teams-for-Linux that injects images as `data:image/...;base64,...` into the clipboard's `text/html`. When you paste a Teams message into a markdown file in VSCode, you get text and images inline.

## Behavior

- Linux only (relies on `xclip`).
- Triggered on `Ctrl+V` inside any editor text input.
- Reads the clipboard's `text/html` target.
- If it contains at least one `<img src="data:image/...;base64,...">`, extract each image as a binary file under `<docDir>/attachments/<docBase>/<docBase>-<timestamp>-<n>.<ext>`, then insert plain text plus markdown image links at the cursor (using the standard `![alt](path)` syntax).
- Otherwise: defers to the default paste action (transparent passthrough).
- Skips untitled buffers (asks you to save the document first so images have a sensible parent dir).

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `richPaste.attachmentsSubdir` | `attachments` | Subdirectory (relative to the current document) where images are saved. |
| `richPaste.useDocumentSubfolder` | `true` | If `true`, images go into `<attachmentsSubdir>/<docBase>/`. If `false`, directly into `<attachmentsSubdir>/`. |

## Install (from source)

```bash
cd ~/vscode-rich-paste
npm install
npm run compile
npm run package    # produces vscode-rich-paste-<version>.vsix
code --install-extension vscode-rich-paste-*.vsix
```

Reload VSCode. The extension activates on startup and binds `Ctrl+V` in editors.

## Uninstall

```bash
code --uninstall-extension eric-blanquer.vscode-rich-paste
```

Or via VSCode's Extensions panel.

## Limitations

- Linux only (shell-out to `xclip`). Could be extended to Windows (`Get-Clipboard -Format Html` via PowerShell) and macOS (`pbpaste` + AppleScript) if needed.
- The HTML→text conversion is intentionally minimal (strip tags, decode common entities, normalize whitespace). It is not a full markdown converter — formatting is lost.
- Requires the source app (e.g. Teams-for-Linux) to put data URIs into the clipboard's `text/html`. Plain blob URLs or external HTTP URLs are not resolvable from outside the source app, and will pass through to the default paste.
