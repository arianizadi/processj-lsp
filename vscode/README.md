# ProcessJ for VS Code

Built from source; there is no marketplace listing, so you always get the latest.

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp/vscode
npm run install-extension     # builds the server, packages the extension, installs it into VS Code
```

Needs Node.js 20+ and the `code` command on PATH (VS Code: "Shell Command: Install 'code' command in PATH").
To update later: `git pull` and run the same command again.

`npm run package` only produces `processj-lsp-vscode-<version>.vsix`, which you can install with
"Extensions: Install from VSIX" or share.

Settings (File > Preferences > Settings, search "ProcessJ"): `processj.installDir`, `processj.checkOnChange`,
`processj.lint`, `processj.serverPath`.
