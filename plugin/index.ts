import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {CollabController} from './bridge';
import {fingerprintBlob} from './fingerprint';
import {CollabPanel} from './panel';
import {OfficialPerfettoAdapter} from './perfetto_adapter';
import {UPSTREAM_PARSER_VERSION} from './upstream_version';

export default class LocalCollabPlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.LocalCollab';
  static readonly description = 'Local-only, explicitly authorized agent collaboration';
  private controller?: CollabController;
  private panel?: CollabPanel;
  private disposed = false;

  constructor(_trace: Trace) {}

  async onTraceLoad(ctx: Trace): Promise<void> {
    this.panel = new CollabPanel();
    this.panel.showStatus('Trace is loading. Agent access is not authorized.');
    ctx.trash.defer(() => {
      this.disposed = true;
      this.controller?.destroy();
      this.panel?.destroy();
    });
    const readyListener = ctx.onTraceReady.addListener(() => {
      readyListener[Symbol.dispose]();
      void this.initialize(ctx);
    });
    ctx.trash.use(readyListener);
  }

  private async initialize(ctx: Trace): Promise<void> {
    try {
      this.panel?.showStatus('Reading the local trace for its content fingerprint. No data is uploaded.');
      const file = await ctx.getTraceFile();
      const fingerprint = await fingerprintBlob(file, (processed, total) => {
        if (!this.disposed && total > 0) {
          this.panel?.showStatus(`Computing local trace fingerprint: ${Math.floor(processed * 100 / total)}%. Agent access remains off.`);
        }
      });
      if (this.disposed) return;
      const adapter = new OfficialPerfettoAdapter(ctx);
      this.controller = new CollabController({
        adapter,
        fingerprint,
        parserVersion: UPSTREAM_PARSER_VERSION,
        onUpdate: () => {
          ctx.raf.scheduleFullRedraw();
          this.panel?.refresh();
        },
      });
      this.panel?.setController(this.controller);
      ctx.raf.scheduleFullRedraw();
    } catch (error) {
      if (!this.disposed) this.panel?.showError(error);
    }
  }
}
