import {CollabController} from './bridge';

const CSS = `
#perfetto-collab-panel{position:fixed;right:12px;top:54px;width:360px;max-height:calc(100vh - 70px);overflow:auto;z-index:10000;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:10px;box-shadow:0 4px 18px #0003;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#perfetto-collab-panel *{box-sizing:border-box}
#perfetto-collab-panel .pc-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#202124;color:#fff;border-radius:9px 9px 0 0;cursor:pointer}
#perfetto-collab-panel .pc-title{font-weight:600}
#perfetto-collab-panel .pc-body{padding:12px}
#perfetto-collab-panel.pc-collapsed .pc-body{display:none}
#perfetto-collab-panel .pc-status{padding:8px;border-radius:6px;background:#f1f3f4;margin-bottom:10px;word-break:break-word}
#perfetto-collab-panel .pc-status.pc-on{background:#e6f4ea;color:#137333}
#perfetto-collab-panel .pc-status.pc-error{background:#fce8e6;color:#c5221f}
#perfetto-collab-panel button{border:1px solid #dadce0;background:#fff;border-radius:5px;padding:6px 9px;margin:2px;cursor:pointer;color:#202124;font:inherit}
#perfetto-collab-panel button:hover{background:#f1f3f4}
#perfetto-collab-panel button.pc-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
#perfetto-collab-panel button.pc-danger{color:#b3261e}
#perfetto-collab-panel button:disabled{opacity:.45;cursor:not-allowed}
#perfetto-collab-panel .pc-row{margin:7px 0}
#perfetto-collab-panel .pc-label{font-size:11px;color:#5f6368;text-transform:uppercase;letter-spacing:.04em;margin-top:10px}
#perfetto-collab-panel code{display:block;padding:5px;background:#f8f9fa;border-radius:4px;word-break:break-all;font:11px/1.4 monospace}
#perfetto-collab-panel .pc-note{color:#5f6368;font-size:12px;margin:8px 0}
#perfetto-collab-panel .pc-log{border-top:1px solid #eee;padding:5px 0;font:11px/1.4 monospace;word-break:break-word}
#perfetto-collab-panel .pc-bad{color:#b3261e}
#perfetto-collab-panel .pc-good{color:#137333}
`;

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CollabPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private controller?: CollabController;
  private message = 'Open a local trace, then explicitly authorize the agent.';
  private error = false;

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root = element('aside');
    this.root.id = 'perfetto-collab-panel';
    const head = element('div', 'pc-head');
    head.append(element('span', 'pc-title', 'Agent collaboration'), element('span', undefined, '−'));
    head.onclick = () => {
      this.root.classList.toggle('pc-collapsed');
      head.lastChild!.textContent = this.root.classList.contains('pc-collapsed') ? '+' : '−';
    };
    this.body = element('div', 'pc-body');
    this.root.append(head, this.body);
    this.root.appendChild(style);
    document.body.appendChild(this.root);
    this.render();
  }

  setController(controller?: CollabController): void {
    this.controller = controller;
    this.message = controller ? 'Trace ready. The agent is not authorized.' : 'Open a local trace, then explicitly authorize the agent.';
    this.error = false;
    this.render();
  }

  showStatus(message: string): void {
    this.message = message;
    this.error = false;
    this.render();
  }

  showError(error: unknown): void {
    this.message = error instanceof Error ? error.message : String(error);
    this.error = true;
    this.render();
  }

  refresh(): void {
    if (this.controller && !this.controller.connectionInfo() && this.message === 'Agent access granted for this trace session.') {
      this.message = 'Agent disconnected. Re-authorize to create a new session.';
    }
    this.render();
  }

  destroy(): void {
    this.root.remove();
  }

  private button(text: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.className = className;
    button.onclick = async () => {
      try {
        this.error = false;
        await action();
      } catch (error) {
        this.showError(error);
      }
      this.render();
    };
    return button;
  }

  private render(): void {
    this.body.replaceChildren();
    const controller = this.controller;
    const connected = controller?.isConnected() ?? false;
    const status = element('div', `pc-status${connected ? ' pc-on' : this.error ? ' pc-error' : ''}`, this.message);
    this.body.appendChild(status);
    if (!controller) return;

    const connection = controller.connectionInfo();
    if (!connected) {
      this.body.appendChild(this.button('Allow agent to connect', async () => {
        await controller.authorize();
        this.message = 'Agent access granted for this trace session.';
      }, 'pc-primary'));
    } else {
      this.body.appendChild(this.button('Disconnect agent', async () => {
        await controller.disconnect();
        this.message = 'Agent disconnected. Re-authorize to create a new session.';
      }, 'pc-danger'));
    }

    const details = element('div', 'pc-row');
    details.append(
      element('div', 'pc-label', 'Trace state'),
      element('code', undefined, `Version ${controller.stateVersion()} · ${connected ? 'connected' : 'not connected'}`),
    );
    this.body.appendChild(details);

    if (connected && connection) {
      this.body.appendChild(element('div', 'pc-label', 'Agent endpoint'));
      this.body.appendChild(element('code', undefined, connection.request_url));
      this.body.appendChild(element('div', 'pc-label', 'Session'));
      this.body.appendChild(element('code', undefined, connection.session));
      const connectionActions = element('div');
      connectionActions.append(
        this.button('Copy PowerShell environment', async () => {
          const text = `$env:PERFETTO_AGENT_URL="${connection.request_url}"\n$env:PERFETTO_AGENT_SESSION="${connection.session}"\n$env:PERFETTO_AGENT_TOKEN="${connection.token}"`;
          await navigator.clipboard.writeText(text);
          this.message = 'Connection environment copied. Keep the token private.';
        }),
        this.button('Download connection.json', () => {
          this.download('perfetto-agent-connection.json', {
            request_url: connection.request_url,
            session: connection.session,
            token: connection.token,
          });
          this.message = 'Connection file downloaded. It contains a secret token.';
        }),
      );
      this.body.appendChild(connectionActions);
      this.body.appendChild(element('div', 'pc-note', 'The downloaded file and copied commands contain the agent credential. Disconnecting or changing trace invalidates them.'));
    }

    this.body.appendChild(element('div', 'pc-label', 'View state'));
    const viewActions = element('div');
    viewActions.append(
      this.button('Save', () => {
        if (!controller.saveLocal(true)) throw new Error('View could not be saved. Check the activity log and browser storage limits.');
        this.message = 'View saved in this browser for this trace and parser version.';
      }),
      this.button('Restore saved', async () => {
        await controller.restoreLocal();
        this.message = 'Saved view restored.';
      }),
      this.button('Export JSON', () => {
        this.download('perfetto-view.json', controller.captureView());
      }),
      this.button('Import JSON', () => this.chooseImport()),
      this.button('Undo last agent edit', () => controller.undoForUser()),
    );
    this.body.appendChild(viewActions);
    const undoButton = Array.from(this.body.querySelectorAll('button')).find((button) => button.textContent === 'Undo last agent edit') as HTMLButtonElement | undefined;
    if (undoButton) undoButton.disabled = !controller.canUndo();

    this.body.appendChild(element('div', 'pc-label', 'Agent activity'));
    const logs = controller.operationLogs().slice(-12).reverse();
    if (!logs.length) this.body.appendChild(element('div', 'pc-note', 'No agent operations yet.'));
    for (const log of logs) {
      const state = log.ok ? '✓' : '✗';
      const line = element('div', `pc-log ${log.ok ? 'pc-good' : 'pc-bad'}`, `${state} ${log.kind} · v${log.state_version} · ${log.duration_ms}ms${log.error_code ? ` · ${log.error_code}` : ''}`);
      this.body.appendChild(line);
    }
  }

  private chooseImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !this.controller) return;
      if (file.size > 2 * 1024 * 1024) {
        this.showError(new Error('View file exceeds 2 MiB'));
        return;
      }
      try {
        await this.controller.importView(JSON.parse(await file.text()));
        this.message = 'View imported.';
      } catch (error) {
        this.showError(error);
      }
    };
    input.click();
  }

  private download(name: string, value: unknown): void {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
