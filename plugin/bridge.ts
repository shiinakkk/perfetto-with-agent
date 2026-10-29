import {
  assertCompatibleView,
  CollabError,
  encodeQueryResult,
  int64String,
  MAX_QUERY_RESPONSE_BYTES,
  timeRange,
  validateSql,
  validateViewDocument,
  VIEW_FORMAT,
  VIEW_FORMAT_VERSION,
} from './core';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface PerfettoAdapter {
  onExternalChange?: () => void;
  isReady(): boolean;
  traceName(): string;
  snapshot(): Record<string, any>;
  applyView(view: Record<string, any>): Promise<void> | void;
  setViewport(start: string, end: string): Promise<void> | void;
  center(start: string, end?: string): Promise<void> | void;
  zoomToSelection(): Promise<void> | void;
  showCpuTracks(): Promise<Record<string, any>>;
  renameSelected(): Promise<void>;
  setAlias(sliceId: string, alias: string): Promise<Record<string, any>>;
  removeAlias(sliceId: string): Record<string, any>;
  clearAliases(): Record<string, any>;
  selectSlices(sliceIds: string[]): Promise<void> | void;
  clearSelection(): void;
  setArea(start: string, end: string, trackUris: string[]): Promise<void> | void;
  clearArea(): void;
  setLayout(trackUri: string, action: string): void;
  resetLayout(): void;
  addNote(args: Record<string, any>): Promise<Record<string, any>> | Record<string, any>;
  updateNote(id: string, args: Record<string, any>): Promise<Record<string, any>> | Record<string, any>;
  removeNote(id: string): void;
  query(sql: string, maxRows?: number): Promise<QueryResult>;
  cancelQuery?(): Promise<void> | void;
}

interface Connection {
  session: string;
  token: string;
  request_url: string;
}

interface HistoryEntry {
  before: Record<string, any>;
  afterVersion: number;
}

const WRITE_COMMANDS = new Set([
  'state.import', 'viewport.set', 'viewport.center', 'viewport.zoomToSelection',
  'selection.set', 'selection.clear', 'area.set', 'area.clear', 'layout.set',
  'layout.reset', 'notes.add', 'notes.update', 'notes.remove', 'history.undo',
  'tracks.showCpu', 'aliases.set', 'aliases.remove', 'aliases.clear',
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function errorCode(error: unknown): string {
  return error instanceof CollabError ? error.code : 'COMMAND_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CollabController {
  readonly parserVersion: string;
  private adapter: PerfettoAdapter;
  private fingerprint: string;
  private traceTitle: string;
  private connection?: Connection;
  private socket?: WebSocket;
  private version = 0;
  private lastSnapshot = '';
  private history?: HistoryEntry;
  private logs: Array<Record<string, any>> = [];
  private activeQueryId?: string;
  private mutating = false;
  private destroyed = false;
  private onUpdate: () => void;
  private pollTimer?: number;

  constructor(options: {
    adapter: PerfettoAdapter;
    fingerprint: string;
    parserVersion: string;
    onUpdate?: () => void;
  }) {
    this.adapter = options.adapter;
    this.fingerprint = options.fingerprint;
    this.parserVersion = options.parserVersion;
    this.traceTitle = options.adapter.traceName();
    this.onUpdate = options.onUpdate ?? (() => {});
    this.lastSnapshot = JSON.stringify(this.captureView());
    this.adapter.onExternalChange = () => this.refreshFromUser();
    this.pollTimer = window.setInterval(() => this.refreshFromUser(), 400);
  }

  stateVersion(): number {
    return this.version;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connectionInfo(): (Connection & {request_url: string}) | undefined {
    return this.connection ? clone(this.connection) : undefined;
  }

  operationLogs(): Array<Record<string, any>> {
    return clone(this.logs);
  }

  canUndo(): boolean {
    return this.history !== undefined && this.history.afterVersion === this.version;
  }

  async showCpuTracks(): Promise<Record<string, any>> {
    let result: Record<string, any> | undefined;
    await this.runUserWrite(async () => {
      result = await this.adapter.showCpuTracks();
    });
    return result as Record<string, any>;
  }

  async renameSelected(): Promise<void> {
    await this.adapter.renameSelected();
  }

  async authorize(): Promise<Connection> {
    if (!this.adapter.isReady()) throw new CollabError('TRACE_NOT_READY', 'Wait for the trace to finish loading');
    if (this.isConnected()) return this.connection as Connection;
    const response = await fetch('/api/browser/sessions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        traceName: this.traceTitle.slice(0, 512),
        traceFingerprint: this.fingerprint,
        parserVersion: this.parserVersion,
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new CollabError(body.error?.code ?? 'AUTHORIZATION_FAILED', body.error?.message ?? 'Could not create an agent session');
    this.connection = {session: body.session, token: body.token, request_url: body.request_url};
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws/browser?session=${encodeURIComponent(body.session)}&token=${encodeURIComponent(body.token)}`);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') void this.receive(event.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.connection = undefined;
        void this.adapter.cancelQuery?.();
        this.onUpdate();
      }
    };
    socket.onerror = () => this.onUpdate();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new CollabError('CONNECTION_TIMEOUT', 'Timed out while connecting to the local bridge')), 10_000);
      socket.addEventListener('open', () => {
        window.clearTimeout(timer);
        resolve();
      }, {once: true});
      socket.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new CollabError('CONNECTION_FAILED', 'Could not connect to the local bridge'));
      }, {once: true});
    });
    this.onUpdate();
    return this.connection;
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    const socket = this.socket;
    this.connection = undefined;
    this.socket = undefined;
    if (socket) socket.close(1000, 'User revoked agent access');
    if (connection) {
      try {
        await fetch(`/api/browser/sessions/${encodeURIComponent(connection.session)}`, {
          method: 'DELETE',
          headers: {Authorization: `Bearer ${connection.token}`},
          keepalive: true,
        });
      } catch {
        // Closing the authorized websocket also revokes the server session.
      }
    }
    this.onUpdate();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    void this.disconnect();
  }

  refreshFromUser(): void {
    if (this.destroyed || this.mutating) return;
    const current = JSON.stringify(this.captureView());
    if (current === this.lastSnapshot) return;
    this.lastSnapshot = current;
    this.version++;
    this.saveLocal();
    this.onUpdate();
  }

  captureView(): Record<string, any> {
    const snapshot = clone(this.adapter.snapshot());
    return {
      format: VIEW_FORMAT,
      format_version: VIEW_FORMAT_VERSION,
      trace: {
        fingerprint: this.fingerprint,
        name: this.traceTitle,
        parser_version: this.parserVersion,
      },
      viewport: snapshot.viewport ?? null,
      focus: snapshot.focus ?? null,
      area: snapshot.area ?? null,
      notes: snapshot.notes ?? [],
      aliases: snapshot.aliases ?? [],
      layout: snapshot.layout ?? [],
      tracks: snapshot.tracks ?? [],
    };
  }

  state(): Record<string, any> {
    const view = this.captureView();
    const cpuTracks = view.tracks.filter((track: Record<string, any>) => track.is_cpu);
    return {
      ...view,
      cpu: {
        available: cpuTracks.length,
        visible: cpuTracks.filter((track: Record<string, any>) => track.visible).length,
      },
      state_version: this.version,
      agent_connected: this.isConnected(),
      can_undo: this.canUndo(),
      query_busy: this.activeQueryId !== undefined,
    };
  }

  private localKey(slot: 'manual' | 'auto'): string {
    return `perfetto-collab:v1:${this.parserVersion}:${this.fingerprint}:${slot}`;
  }

  saveLocal(manual = false): boolean {
    if (manual && this.mutating) {
      this.logs.push({time: new Date().toISOString(), kind: 'storage.save', ok: false, error_code: 'VIEW_BUSY', message: 'A view operation is still in progress'});
      if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
      return false;
    }
    try {
      const view = validateViewDocument(this.captureView());
      localStorage.setItem(this.localKey(manual ? 'manual' : 'auto'), JSON.stringify(view));
      return true;
    } catch (error) {
      this.logs.push({time: new Date().toISOString(), kind: 'storage.save', ok: false, error_code: errorCode(error), message: errorMessage(error).slice(0, 200)});
      if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
      return false;
    }
  }

  hasSavedView(): boolean {
    return localStorage.getItem(this.localKey('manual')) !== null || localStorage.getItem(this.localKey('auto')) !== null;
  }

  async restoreLocal(): Promise<void> {
    const encoded = localStorage.getItem(this.localKey('manual')) ?? localStorage.getItem(this.localKey('auto'));
    if (!encoded) throw new CollabError('NO_SAVED_VIEW', 'No saved view exists for this trace and parser version');
    const view = validateViewDocument(JSON.parse(encoded));
    assertCompatibleView(view, this.fingerprint, this.parserVersion);
    await this.runUserWrite(async () => {
      await this.adapter.applyView(view);
    });
  }

  async importView(view: unknown): Promise<void> {
    await this.runUserWrite(async () => {
      const valid = validateViewDocument(view);
      assertCompatibleView(valid, this.fingerprint, this.parserVersion);
      await this.adapter.applyView(valid);
    });
  }

  private async runUserWrite(action: () => Promise<void>): Promise<void> {
    if (this.mutating) throw new CollabError('VIEW_BUSY', 'Another view operation is in progress; retry after it completes');
    this.mutating = true;
    try {
      await action();
    } finally {
      this.mutating = false;
      this.refreshFromUser();
    }
  }

  private async receive(data: string): Promise<void> {
    let request: Record<string, any>;
    try {
      request = JSON.parse(data);
    } catch {
      return;
    }
    const id = typeof request.id === 'string' ? request.id : '';
    const started = performance.now();
    try {
      if (request.session !== this.connection?.session) {
        throw new CollabError('SESSION_MISMATCH', 'Request belongs to a different trace session');
      }
      const result = await this.execute(request.kind, request.args ?? {}, request.expected_version, id);
      this.send({id, ok: true, version: this.version, result: result ?? null});
      if (WRITE_COMMANDS.has(request.kind) || request.kind === 'query') {
        this.addLog(request.kind, started, true, undefined, result);
      }
    } catch (error) {
      this.send({
        id,
        ok: false,
        version: this.version,
        error: {code: errorCode(error), message: errorMessage(error), ...(error instanceof CollabError && error.details !== undefined ? {details: error.details} : {})},
      });
      if (WRITE_COMMANDS.has(request.kind) || request.kind === 'query') this.addLog(request.kind, started, false, errorCode(error));
    }
  }

  private send(message: Record<string, any>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async execute(kind: string, args: Record<string, any>, expectedVersion: unknown, requestId: string): Promise<unknown> {
    if (this.mutating && kind !== 'query' && kind !== 'query.cancel' && kind !== 'history.list') {
      throw new CollabError('VIEW_BUSY', 'Another view operation is in progress; retry after it completes');
    }
    if (kind === 'state.get') {
      this.refreshFromUser();
      return this.state();
    }
    if (kind === 'state.export') {
      this.refreshFromUser();
      return validateViewDocument(this.captureView());
    }
    if (kind === 'history.list') return this.operationLogs();
    if (kind === 'query') return this.runQuery(args, requestId);
    if (kind === 'query.cancel') {
      if (args.query_id !== this.activeQueryId) throw new CollabError('QUERY_NOT_FOUND', 'The specified query is not active');
      if (!this.adapter.cancelQuery) throw new CollabError('QUERY_CANCEL_UNSUPPORTED', 'The upstream browser engine does not expose query cancellation');
      await this.adapter.cancelQuery();
      return {cancel_requested: true};
    }
    if (!WRITE_COMMANDS.has(kind)) throw new CollabError('UNKNOWN_COMMAND', `Unsupported command: ${String(kind)}`);
    this.refreshFromUser();
    if (expectedVersion !== undefined && expectedVersion !== this.version) {
      throw new CollabError('VERSION_CONFLICT', 'The view changed after the agent read it; read state again before writing', {
        expected_version: expectedVersion,
        current_version: this.version,
      });
    }
    if (kind === 'history.undo') return this.undo();
    const before = this.captureView();
    this.mutating = true;
    let result: unknown;
    try {
      result = await this.executeWrite(kind, args);
      const after = this.captureView();
      const afterEncoded = JSON.stringify(after);
      if (JSON.stringify(before) !== afterEncoded) {
        this.version++;
        this.lastSnapshot = afterEncoded;
        this.history = {before, afterVersion: this.version};
        this.saveLocal();
      }
      this.onUpdate();
      return result ?? after;
    } finally {
      this.mutating = false;
    }
  }

  private async executeWrite(kind: string, args: Record<string, any>): Promise<unknown> {
    switch (kind) {
      case 'state.import': {
        const view = validateViewDocument(args.view);
        assertCompatibleView(view, this.fingerprint, this.parserVersion);
        await this.adapter.applyView(view);
        return {imported: true};
      }
      case 'viewport.set': {
        const range = timeRange(args.start, args.end);
        await this.adapter.setViewport(range.start, range.end);
        return range;
      }
      case 'viewport.center': {
        if (args.end !== undefined) timeRange(args.start, args.end);
        else int64String(args.start, 'start');
        await this.adapter.center(args.start, args.end);
        return {centered: true};
      }
      case 'viewport.zoomToSelection':
        await this.adapter.zoomToSelection();
        return {zoomed: true};
      case 'tracks.showCpu':
        return this.adapter.showCpuTracks();
      case 'aliases.set': {
        if (typeof args.alias !== 'string') throw new CollabError('INVALID_ALIAS', 'alias is required');
        return this.adapter.setAlias(int64String(args.slice_id, 'slice id'), args.alias);
      }
      case 'aliases.remove':
        return this.adapter.removeAlias(int64String(args.slice_id, 'slice id'));
      case 'aliases.clear':
        return this.adapter.clearAliases();
      case 'selection.set': {
        if (!Array.isArray(args.slice_ids) || args.slice_ids.length < 1 || args.slice_ids.length > 1000) {
          throw new CollabError('INVALID_SELECTION', 'slice_ids must contain between 1 and 1000 entries');
        }
        const ids = args.slice_ids.map((id: unknown) => int64String(id, 'slice id'));
        await this.adapter.selectSlices(ids);
        return {slice_ids: ids};
      }
      case 'selection.clear':
        this.adapter.clearSelection();
        return {cleared: true};
      case 'area.set': {
        const range = timeRange(args.start, args.end);
        if (!Array.isArray(args.track_uris) || args.track_uris.length < 1 || args.track_uris.length > 10_000 || args.track_uris.some((uri: unknown) => typeof uri !== 'string' || !uri)) {
          throw new CollabError('INVALID_AREA', 'track_uris must be a non-empty array of track URI strings');
        }
        await this.adapter.setArea(range.start, range.end, args.track_uris);
        return {...range, track_uris: args.track_uris};
      }
      case 'area.clear':
        this.adapter.clearArea();
        return {cleared: true};
      case 'layout.set': {
        if (typeof args.track_uri !== 'string' || !args.track_uri || !['collapse', 'expand', 'pin', 'unpin'].includes(args.action)) {
          throw new CollabError('INVALID_LAYOUT', 'A track_uri and one valid layout action are required');
        }
        this.adapter.setLayout(args.track_uri, args.action);
        return {track_uri: args.track_uri, action: args.action};
      }
      case 'layout.reset':
        this.adapter.resetLayout();
        return {reset: true};
      case 'notes.add':
        return this.adapter.addNote(this.validateNote(args));
      case 'notes.update': {
        if (typeof args.id !== 'string') throw new CollabError('INVALID_NOTE', 'Note id is required');
        return this.adapter.updateNote(args.id, this.validateNote(args, true));
      }
      case 'notes.remove':
        if (typeof args.id !== 'string') throw new CollabError('INVALID_NOTE', 'Note id is required');
        this.adapter.removeNote(args.id);
        return {removed: args.id};
      default:
        throw new CollabError('UNKNOWN_COMMAND', `Unsupported command: ${kind}`);
    }
  }

  private validateNote(args: Record<string, any>, partial = false): Record<string, any> {
    if ((!partial || args.text !== undefined) && (typeof args.text !== 'string' || args.text.trim().length === 0 || args.text.length > 10_000)) {
      throw new CollabError('INVALID_NOTE', 'Note text must contain 1-10000 characters');
    }
    if (!partial || args.start !== undefined) int64String(args.start, 'note.start');
    if (args.end !== undefined && args.end !== null && args.start !== undefined) timeRange(args.start, args.end);
    if (args.color !== undefined && (typeof args.color !== 'string' || args.color.length > 100)) {
      throw new CollabError('INVALID_NOTE', 'Invalid note color');
    }
    return args;
  }

  private async runQuery(args: Record<string, any>, requestId: string): Promise<unknown> {
    if (this.activeQueryId) throw new CollabError('QUERY_BUSY', 'Another query is still running in this tab, possibly after an earlier timeout');
    const sql = validateSql(args.sql);
    const maxRows = args.max_rows ?? 100;
    const timeout = args.timeout_ms ?? 30_000;
    this.activeQueryId = requestId;
    let timer: number | undefined;
    let settled = false;
    let timedOut = false;
    const query = this.adapter.query(sql, maxRows);
    const onSettled = () => {
      settled = true;
      if (this.activeQueryId === requestId) {
        this.activeQueryId = undefined;
        this.onUpdate();
      }
    };
    query.then(onSettled, onSettled);
    this.onUpdate();
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          timedOut = true;
          const canCancel = this.adapter.cancelQuery !== undefined;
          if (canCancel) Promise.resolve(this.adapter.cancelQuery!()).catch(() => {});
          reject(new CollabError(
            'QUERY_TIMEOUT',
            canCancel ?
              'Query exceeded its deadline; cancellation was requested and late results will be discarded' :
              'Query exceeded its deadline; this engine cannot cancel it, so it may still be running and late results will be discarded',
            {cancel_requested: canCancel, underlying_query_may_run: true},
          ));
        }, timeout);
      });
      const result = await Promise.race([query, expired]);
      return encodeQueryResult(result.columns, result.rows, maxRows, MAX_QUERY_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw new CollabError('QUERY_FAILED', errorMessage(error));
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (!timedOut || settled) {
        if (this.activeQueryId === requestId) this.activeQueryId = undefined;
      }
      this.onUpdate();
    }
  }

  async undoForUser(): Promise<void> {
    if (this.mutating) throw new CollabError('VIEW_BUSY', 'Another view operation is in progress; retry after it completes');
    await this.undo();
  }

  private async undo(): Promise<unknown> {
    if (!this.history) throw new CollabError('NOTHING_TO_UNDO', 'There is no agent operation to undo');
    if (this.history.afterVersion !== this.version) {
      throw new CollabError('UNDO_CONFLICT', 'The user or another agent operation changed the view after this action; refusing to overwrite newer edits');
    }
    this.mutating = true;
    try {
      await this.adapter.applyView(this.history.before);
      this.history = undefined;
      this.version++;
      this.lastSnapshot = JSON.stringify(this.captureView());
      this.saveLocal();
      this.onUpdate();
      return {undone: true};
    } finally {
      this.mutating = false;
    }
  }

  private addLog(kind: string, started: number, ok: boolean, code?: string, result?: unknown): void {
    const entry: Record<string, any> = {
      time: new Date().toISOString(),
      kind,
      duration_ms: Math.round(performance.now() - started),
      ok,
      state_version: this.version,
    };
    if (code) entry.error_code = code;
    if (kind === 'query' && result && Number.isSafeInteger((result as any).row_count)) entry.row_count = (result as any).row_count;
    if (kind === 'selection.set' && result && Array.isArray((result as any).slice_ids)) entry.object_ids = (result as any).slice_ids.slice(0, 100);
    if (kind === 'aliases.set' && result && typeof (result as any).slice_id === 'string') entry.object_ids = [(result as any).slice_id];
    if (kind === 'aliases.remove' && result && typeof (result as any).removed === 'string') entry.object_ids = [(result as any).removed];
    if (kind.startsWith('notes.') && result && typeof (result as any).id === 'string') entry.object_ids = [(result as any).id];
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.onUpdate();
  }
}
