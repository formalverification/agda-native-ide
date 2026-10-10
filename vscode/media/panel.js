// File: vscode/media/panel.js
(() => {
  const vscode = acquireVsCodeApi();
  let state = vscode.getState();
  const module = document.getElementById('module');
  const buffer = document.getElementById('buffer');
  const activity = document.getElementById('activity');
  const buttons = [...document.querySelectorAll('button[data-action]')];
  for (const button of buttons) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'command', action: button.dataset.action }));
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'snapshot') return;
    const compatibility = message.compatibility;
    document.getElementById('compatibility').hidden = compatibility.supported;
    document.getElementById('version-message').textContent = compatibility.message;
    state = message.state;
    vscode.setState(state);
    vscode.postMessage({ type: 'persisted', state });
    module.textContent = message.module ?? 'Open an Agda module';
    buffer.textContent = message.module ? `Buffer version ${message.version}${message.dirty ? ', unsaved' : ', saved'}.` : '';
    for (const button of buttons) button.disabled = message.busy || !message.module;
    const report = state?.lastCommand;
    activity.textContent = message.error ?? (message.busy ? 'Running command...' : report ?
      `${report.action} returned in ${report.elapsedMs.toFixed(1)} ms.  ${report.documentChanged ? 'The buffer changed.' : 'The buffer is unchanged.'}${report.tokenCount === undefined ? '' : `  ${report.tokenCount} semantic tokens.`}` : '');
  });
  vscode.postMessage({ type: 'ready' });
})();
