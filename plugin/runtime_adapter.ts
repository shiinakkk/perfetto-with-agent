import {CollabError, int64String, safeNumber, sqlForSubquery, timeRange} from './core';
import type {PerfettoAdapter, QueryResult} from './bridge';

type Trace = any;
type Note = any;
type SpanNote = any;
type NoteManagerInternal = any;
type SelectionManagerInternal = any;
type TrackNode = any;

const Time = {fromRaw: (value: bigint) => value};

function highPrecisionSpan(trace: Trace, start: bigint, end: bigint): any {
  return trace.timeline.visibleWindow.constructor.fromTime(start, end);
}

export class RuntimePerfettoAdapter implements PerfettoAdapter {
  private trace: Trace;
  private notes: NoteManagerInternal;
  private selection: SelectionManagerInternal;
  private initialLayout: Array<Record<string, any>>;

  constructor(trace: Trace) {
    this.trace = trace;
    this.notes = trace.notes as NoteManagerInternal;
    this.selection = trace.selection as SelectionManagerInternal;
    this.initialLayout = this.currentLayout();
  }

  isReady(): boolean {
    return true;
  }

  traceName(): string {
    return this.trace.traceInfo.traceTitle;
  }

  snapshot(): Record<string, any> {
    const visible = this.trace.timeline.visibleWindow;
    const selection = this.trace.selection.selection;
    let focus: Record<string, any> | null = null;
    let area: Record<string, any> | null = null;
    if (selection.kind === 'track_event') {
      focus = {
        kind: selection.kind,
        event_id: selection.eventId.toString(),
        track_uri: selection.trackUri,
        ts: selection.ts.toString(),
        ...(selection.dur === undefined ? {} : {dur: selection.dur.toString()}),
      };
    } else if (selection.kind === 'track' || selection.kind === 'note') {
      focus = selection.kind === 'track' ?
        {kind: 'track', track_uri: selection.trackUri} :
        {kind: 'note', id: selection.id};
    } else if (selection.kind === 'area') {
      area = {
        start: selection.start.toString(),
        end: selection.end.toString(),
        track_uris: [...selection.trackUris],
      };
    }
    return {
      viewport: {start: visible.start.integral.toString(), end: visible.end.integral.toString()},
      focus,
      area,
      notes: Array.from(this.notes.notes.values(), (note) => this.serializeNote(note)),
      layout: this.currentLayout(),
      tracks: this.trackList(),
    };
  }

  async applyView(view: Record<string, any>): Promise<void> {
    this.validateViewTargets(view);
    this.resetLayout();
    for (const entry of view.layout) this.applyLayoutEntry(entry);
    const desiredNotes = new Map<string, Record<string, any>>(view.notes.map((note: Record<string, any>) => [note.id, note]));
    for (const id of this.notes.notes.keys()) {
      if (!desiredNotes.has(id)) this.notes.removeNote(id);
    }
    for (const note of view.notes) this.writeNote(note);
    if (view.area) {
      this.trace.selection.selectArea({
        start: Time.fromRaw(BigInt(view.area.start)),
        end: Time.fromRaw(BigInt(view.area.end)),
        trackUris: view.area.track_uris,
      });
    } else if (view.focus) {
      await this.restoreFocus(view.focus);
    } else {
      this.trace.selection.clearSelection();
    }
    if (view.viewport) this.setViewport(view.viewport.start, view.viewport.end);
  }

  setViewport(startValue: string, endValue: string): void {
    const range = timeRange(startValue, endValue);
    const start = BigInt(range.start);
    const end = BigInt(range.end);
    if (end - start > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CollabError('INVALID_TIME_RANGE', 'The visible window duration exceeds the frontend numeric range');
    }
    this.trace.timeline.setVisibleWindow(highPrecisionSpan(this.trace, start, end));
  }

  center(start: string, end?: string): void {
    if (end === undefined) {
      this.trace.timeline.panIntoView(Time.fromRaw(BigInt(int64String(start, 'start'))), {align: 'center', animation: 'step'});
    } else {
      const range = timeRange(start, end);
      this.trace.timeline.panSpanIntoView(Time.fromRaw(BigInt(range.start)), Time.fromRaw(BigInt(range.end)), {align: 'center', animation: 'step'});
    }
  }

  zoomToSelection(): void {
    if (!this.trace.selection.getTimeSpanOfSelection()) {
      throw new CollabError('NO_SELECTION', 'Select a timeline object before zooming to the selection');
    }
    this.trace.selection.scrollToSelection('focus');
  }

  async selectSlices(sliceIds: string[]): Promise<void> {
    if (sliceIds.length !== 1) {
      throw new CollabError('INVALID_SELECTION', 'Perfetto has one focused slice. Provide exactly one slice id; use area.set for multiple tracks');
    }
    const id = safeNumber(sliceIds[0], 'slice id');
    const resolved = await this.trace.selection.resolveSqlEvents('slice', [id]);
    if (resolved.length !== 1) {
      throw new CollabError('SLICE_NOT_FOUND', `Slice ${sliceIds[0]} does not exist or has no visible track`);
    }
    await this.trace.selection.selectTrackEvent(resolved[0].trackUri, resolved[0].eventId, {scrollToSelection: false});
  }

  clearSelection(): void {
    this.trace.selection.clearSelection();
  }

  setArea(start: string, end: string, trackUris: string[]): void {
    for (const uri of trackUris) {
      if (!this.trace.tracks.getTrack(uri) || !this.trace.currentWorkspace.getTrackByUri(uri)) {
        throw new CollabError('TRACK_NOT_FOUND', `Area track is not registered and visible: ${uri}`);
      }
    }
    this.trace.selection.selectArea({
      start: Time.fromRaw(BigInt(start)),
      end: Time.fromRaw(BigInt(end)),
      trackUris,
    });
  }

  clearArea(): void {
    if (this.trace.selection.selection.kind === 'area') this.trace.selection.clearSelection();
  }

  setLayout(trackUri: string, action: string): void {
    const node = this.findNode(trackUri);
    if (!node) throw new CollabError('TRACK_NOT_FOUND', `Track or group not found: ${trackUri}`);
    if (action === 'collapse') node.collapse();
    else if (action === 'expand') node.expand();
    else if (action === 'pin') node.pin();
    else if (action === 'unpin') node.unpin();
  }

  resetLayout(): void {
    for (const entry of this.initialLayout) this.applyLayoutEntry(entry);
  }

  addNote(args: Record<string, any>): Record<string, any> {
    if (args.id !== undefined && this.trace.notes.getNote(args.id)) {
      throw new CollabError('NOTE_EXISTS', `A note with id ${args.id} already exists`);
    }
    return this.writeNote(args);
  }

  updateNote(id: string, args: Record<string, any>): Record<string, any> {
    const previous = this.trace.notes.getNote(id);
    if (!previous) throw new CollabError('NOTE_NOT_FOUND', `Note not found: ${id}`);
    const previousStart = previous.noteType === 'SPAN' ? previous.start : previous.timestamp;
    const previousEnd = previous.noteType === 'SPAN' ? previous.end : undefined;
    return this.writeNote({
      id,
      text: args.text ?? previous.text,
      color: args.color ?? previous.color,
      start: args.start ?? previousStart.toString(),
      end: args.end === null ? null : args.end ?? previousEnd?.toString(),
    });
  }

  removeNote(id: string): void {
    if (!this.trace.notes.getNote(id)) throw new CollabError('NOTE_NOT_FOUND', `Note not found: ${id}`);
    this.notes.removeNote(id);
  }

  async query(sql: string, maxRows = 100): Promise<QueryResult> {
    const limitedSql = `SELECT * FROM (${sqlForSubquery(sql)}\n) AS agent_result LIMIT ${maxRows + 1}`;
    const result = await this.trace.engine.query(limitedSql);
    const columns = result.columns();
    const rows: unknown[][] = [];
    const iterator = result.iter({});
    for (; iterator.valid(); iterator.next()) {
      rows.push(columns.map((column) => iterator.get(column)));
    }
    return {columns, rows};
  }

  private writeNote(note: Record<string, any>): Record<string, any> {
    if (note.track_uri !== undefined && note.track_uri !== null) {
      throw new CollabError('UNSUPPORTED_NOTE_TRACK', 'This Perfetto version supports timeline notes, not track-bound notes');
    }
    const text = typeof note.text === 'string' ? note.text : '';
    const base = {id: note.id, text, ...(note.color === undefined ? {} : {color: note.color})};
    let id: string;
    if (note.end !== undefined && note.end !== null) {
      const range = timeRange(note.start, note.end);
      id = this.trace.notes.addSpanNote({
        ...base,
        start: Time.fromRaw(BigInt(range.start)),
        end: Time.fromRaw(BigInt(range.end)),
      });
    } else {
      id = this.trace.notes.addNote({
        ...base,
        timestamp: Time.fromRaw(BigInt(int64String(note.start, 'note.start'))),
      });
    }
    const saved = this.trace.notes.getNote(id);
    if (!saved) throw new CollabError('NOTE_FAILED', 'Perfetto did not retain the new note');
    return this.serializeNote(saved);
  }

  private serializeNote(note: Note | SpanNote): Record<string, any> {
    return {
      id: note.id,
      text: note.text,
      color: note.color,
      start: (note.noteType === 'SPAN' ? note.start : note.timestamp).toString(),
      end: note.noteType === 'SPAN' ? note.end.toString() : null,
    };
  }

  private trackList(): Array<Record<string, any>> {
    return this.trace.currentWorkspace.flatTracksOrdered.filter((node) => node.uri).map((node) => {
      const track = this.trace.tracks.getTrack(node.uri!);
      return {
        uri: node.uri,
        node_id: node.id,
        name: node.name,
        track_ids: (track?.tags?.trackIds ?? []).map((id) => id.toString()),
        collapsed: node.collapsed,
        pinned: this.trace.currentWorkspace.hasPinnedTrack(node),
      };
    });
  }

  private currentLayout(): Array<Record<string, any>> {
    return this.trace.currentWorkspace.flatTracksOrdered.map((node) => ({
      track_uri: node.uri ?? this.groupReference(node),
      node_id: node.id,
      name: node.name,
      path: [...node.fullPath],
      collapsed: node.collapsed,
      pinned: this.trace.currentWorkspace.hasPinnedTrack(node),
    }));
  }

  private groupReference(node: TrackNode): string {
    const indices: number[] = [];
    let current: TrackNode = node;
    while (current.parent) {
      indices.unshift(current.parent.children.indexOf(current));
      current = current.parent;
    }
    return `group:${indices.join('.')}`;
  }

  private findNode(reference: string): TrackNode | undefined {
    return this.trace.currentWorkspace.flatTracksOrdered.find((node) =>
      node.uri === reference || node.id === reference || (!node.uri && this.groupReference(node) === reference));
  }

  private applyLayoutEntry(entry: Record<string, any>): void {
    const node = this.findNode(entry.track_uri);
    if (!node) return;
    if (entry.collapsed) node.collapse();
    else node.expand();
    if (entry.pinned) node.pin();
    else node.unpin();
  }

  private async restoreFocus(focus: Record<string, any>): Promise<void> {
    if (focus.kind === 'track_event') {
      if (!this.trace.currentWorkspace.getTrackByUri(focus.track_uri)) {
        throw new CollabError('TRACK_NOT_FOUND', `Selected track not found: ${focus.track_uri}`);
      }
      await this.trace.selection.selectTrackEvent(focus.track_uri, safeNumber(focus.event_id, 'event id'), {scrollToSelection: false});
    } else if (focus.kind === 'track') {
      this.trace.selection.selectTrack(focus.track_uri);
    } else if (focus.kind === 'note') {
      if (!this.trace.notes.getNote(focus.id)) throw new CollabError('NOTE_NOT_FOUND', `Selected note not found: ${focus.id}`);
      this.selection.selectNote({id: focus.id});
    } else {
      throw new CollabError('INVALID_VIEW', `Unsupported focus kind: ${String(focus.kind)}`);
    }
  }

  private validateViewTargets(view: Record<string, any>): void {
    for (const entry of view.layout) {
      if (!this.findNode(entry.track_uri)) throw new CollabError('TRACK_NOT_FOUND', `Saved track not found: ${entry.track_uri}`);
    }
    for (const uri of view.area?.track_uris ?? []) {
      if (!this.trace.currentWorkspace.getTrackByUri(uri)) throw new CollabError('TRACK_NOT_FOUND', `Saved area track not found: ${uri}`);
    }
  }
}
