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
- **ProcessJ: Show Concurrency Graph** (or the **Concurrency graph** lens) for the process network: pan, zoom and
  search it, and see where the program gets stuck, with each proven deadlock and each FDR counterexample drawn on
  it, replayed step by step and told in words; double-click a process for its state machine in the CSP model, with
  the states FDR's run went through numbered and the one it is stuck in marked
- **ProcessJ: Export Concurrency Graph** to write the network next to the file as SVG, an Excalidraw scene, the
  self-contained HTML viewer (all three by default) or JSON
- **ProcessJ: Show Protocol Flow** for inheritance, case coverage and observed message producers/consumers
- **ProcessJ: Show Procedure Effects** for direct and transitive channel, blocking, parallel, timer and mobile effects
- **ProcessJ: Convert to CSP** to write the program (or one procedure) as CSPm next to the file, for FDR
- **ProcessJ: Check with FDR** (or the **FDR: check** lens) to have FDR check deadlock freedom, runtime errors and
  termination: when a check fails the graph panel opens on the counterexample (`processj.fdrShowGraph`:
  `onFailure`, `always` or `never`; otherwise a report tells it step by step), stuck statements get diagnostics
  saying who could have answered them (also a write that waits forever while the rest of the program keeps
  running), hovering one explains it, and its **Quick Fix…** menu has **Show in graph**. The lens then shows the
  verdict (`FDR: deadlock (4 steps)`, or `FDR: no deadlock, 11 states; the compiled program may differ`) and opens
  the panel on it; a verdict with nothing to show (`FDR: timed out · check again`) runs the check again. A run that
  relies on what the model abstracts says so in the panel. The check's notification has a **Cancel** button
  (or use **ProcessJ: Cancel FDR Check**). Needs [FDR4](https://cocotec.io/fdr/); set `processj.fdrPath` if it is
  not found
- channel inlay hints and effect/protocol code lenses; hover any procedure or channel for the detailed summary
- **Quick Fix…** on a diagnostic, or a selection, for conservative channel repairs, procedure extraction and safe `par` conversion
- the ProcessJ language-status entry to see whether the server is ready and open its output
- **ProcessJ: Restart Language Server** if you are troubleshooting

Settings live under File > Preferences > Settings; search for "ProcessJ". They cover the ProcessJ and Java
locations, live compiler checking, lints, code lenses, compiler debounce and timeouts, FDR's location, time and
memory limits and search workers, when a check opens the graph, server path, and LSP protocol tracing. Changes apply automatically without
reloading the VS Code window: FDR's settings reach the running server, keeping its results; the others restart it
(`processj.liveViewer`, which only affects the browser page other editors open, applies at the next server start).

Scratch buffers are supported: open an untitled file and choose **ProcessJ** with "Change Language Mode".
