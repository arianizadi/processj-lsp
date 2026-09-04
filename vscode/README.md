# ProcessJ for VS Code

Built from source; there is no marketplace listing, so you always get the latest.

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp/vscode
npm run install-extension     # builds the server, packages the extension, installs it into VS Code
```

In a Remote SSH window the extension runs on the remote machine: clone and run this there.
Needs Node.js 20+ and the `code` command on PATH (VS Code: "Shell Command: Install 'code' command in PATH").
To update later: `git pull` and run the same command again.

Each successful GitHub Actions run also uploads a ready-to-install `processj.vsix` artifact. Download it,
unzip the artifact, and choose "Extensions: Install from VSIX" if you do not want to build locally.

`npm run package` only produces `processj-lsp-vscode-<version>.vsix`, which you can install with
"Extensions: Install from VSIX" or share.

Open a `.pj` file and use any of:

- the play button in the editor title or the **▶ Run** code lens above `main`
- **ProcessJ: Run Current File** / **ProcessJ: Build Current File** in the Command Palette
- **ProcessJ: Show Concurrency Graph** for a filterable, source-linked process/channel map with proven deadlocks
- **ProcessJ: Show Protocol Flow** for inheritance, case coverage and observed message producers/consumers
- **ProcessJ: Show Procedure Effects** for direct and transitive channel, blocking, parallel, timer and mobile effects
- channel inlay hints and effect/protocol code lenses; hover any procedure or channel for the detailed summary
- **Quick Fix…** on a diagnostic, or a selection, for conservative channel repairs, procedure extraction and safe `par` conversion
- the ProcessJ language-status entry to see whether the server is ready and open its output
- **ProcessJ: Restart Language Server** if you are troubleshooting

Settings live under File > Preferences > Settings; search for "ProcessJ". They cover the ProcessJ and Java
locations, live compiler checking, lints, code lenses, compiler debounce and timeouts, server path, and LSP
protocol tracing. Changes apply automatically without reloading the VS Code window.

Scratch buffers are supported: open an untitled file and choose **ProcessJ** with "Change Language Mode".
