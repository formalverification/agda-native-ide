// File: vscode/src/panel.ts

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function panelOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; base-uri 'none'; form-action 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Agda Workbench</title>
</head>
<body>
  <h1>Agda Workbench</h1>
  <section id="compatibility" role="status" hidden>
    <h2>Agda mode version</h2>
    <p id="version-message"></p>
  </section>
  <h2 id="module">Open an Agda module</h2>
  <p id="buffer"></p>
  <p>Load the module, then place the cursor inside a goal.  Write the term
    in the goal before giving or refining.</p>
  <div class="commands" aria-label="Agda commands">
    <button data-action="load">Load</button>
    <button data-action="give">Give</button>
    <button data-action="refine">Refine</button>
    <button data-action="goalContext">Goal and context</button>
    <button data-action="highlighting">Highlighting</button>
  </div>
  <p id="activity" role="status" aria-live="polite"></p>
  <p>Read Agda mode's panel for goals and errors.</p>
  <h2>Native lanes</h2>
  <p>These run the project's own Agda beside the mode's, on the module as
    it is saved: a command saves it first.</p>
  <div class="commands" aria-label="Native lane commands">
    <button data-action="laneGoal">Goal and context</button>
    <button data-action="laneInfer">Infer</button>
    <button data-action="laneNormalize">Normalize</button>
    <button data-action="laneGive">Give</button>
    <button data-action="checkFile">Check file</button>
  </div>
  <pre id="answer" aria-live="polite"></pre>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
