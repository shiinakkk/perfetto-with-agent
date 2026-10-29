import {CollabController} from './bridge';
import {CollabError} from './core';
import {fingerprintBlob} from './fingerprint';
import {CollabPanel} from './panel';
import {RuntimePerfettoAdapter} from './runtime_adapter';
import {RUNTIME_PARSER_VERSION} from './runtime_version';

let panel: CollabPanel | undefined;
let activeTrace: any;
let activeCleanup: (() => void) | undefined;

function app(): any {
  return (window as any).app;
}

async function waitUntilIdle(): Promise<void> {
  const wait = (window as any).waitForPerfettoIdle;
  if (typeof wait === 'function') {
    await wait(100);
    return;
  }
  while (app()?.isLoadingTrace) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

function attach(trace: any): void {
  activeTrace = trace;
  let disposed = false;
  let initialized = false;
  let controller: CollabController | undefined;
  panel ??= new CollabPanel();
  panel.showStatus('Trace is loading. Agent access is not authorized.');

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    controller?.destroy();
    controller = undefined;
    if (activeTrace === trace) {
      activeTrace = undefined;
      activeCleanup = undefined;
      panel?.setController(undefined);
    }
  };
  activeCleanup = cleanup;
  trace.trash.defer(cleanup);

  const ready = new Promise<void>((resolve) => {
    trace.trash.use(trace.onTraceReady.addListener(() => resolve()));
  });

  void (async () => {
    try {
      try {
        await waitUntilIdle();
      } catch {
        await ready;
      }
      if (disposed || app()?.trace !== trace) return;
      const sourceType = trace.traceInfo.source?.type;
      if (sourceType === 'URL' || sourceType === 'HTTP_RPC' || !trace.traceInfo.downloadable) {
        throw new CollabError('UNSUPPORTED_TRACE_SOURCE', 'Agent authorization requires a local, downloadable trace opened by the user');
      }
      if (initialized) return;
      initialized = true;
      panel?.showStatus('Reading the local trace for its content fingerprint. No data is uploaded.');
      const file = await trace.getTraceFile();
      const fingerprint = await fingerprintBlob(file, (processed, total) => {
        if (!disposed && total > 0) {
          panel?.showStatus(`Computing local trace fingerprint: ${Math.floor(processed * 100 / total)}%. Agent access remains off.`);
        }
      });
      if (disposed || app()?.trace !== trace) return;
      const adapter = new RuntimePerfettoAdapter(trace);
      const cpu = await adapter.showCpuTracks();
      controller = new CollabController({
        adapter,
        fingerprint,
        parserVersion: RUNTIME_PARSER_VERSION,
        onUpdate: () => {
          app()?.raf?.scheduleFullRedraw();
          panel?.refresh();
        },
      });
      panel?.setController(controller);
      panel?.showStatus(`Trace ready. ${cpu.visible} CPU tracks visible. Agent access is not authorized.`);
      app()?.raf?.scheduleFullRedraw();
    } catch (error) {
      if (!disposed) panel?.showError(error);
    }
  })();
}

window.setInterval(() => {
  const trace = app()?.trace;
  if (trace !== activeTrace) {
    activeCleanup?.();
    if (trace) attach(trace);
    else panel?.setController(undefined);
  }
}, 50);
