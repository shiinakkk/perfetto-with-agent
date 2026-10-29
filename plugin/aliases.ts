import {AliasEntry, CollabError, int64String, validateAliasEntries, validateAliasEntry, validateAliasText} from './core';

const EDITOR_CSS = `
.pc-alias-editor{position:fixed;z-index:10002;width:340px;padding:12px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;box-shadow:0 5px 20px #0005;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.pc-alias-editor label{display:block;font-weight:600;margin-bottom:6px}
.pc-alias-editor input{width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #80868b;border-radius:4px;font:inherit}
.pc-alias-editor input:focus{outline:2px solid #1a73e8;outline-offset:1px}
.pc-alias-editor .pc-alias-original{margin:7px 0;color:#5f6368;font:11px/1.4 monospace;overflow-wrap:anywhere;max-height:54px;overflow:auto}
.pc-alias-editor .pc-alias-actions{display:flex;gap:6px;margin-top:9px}
.pc-alias-editor button{padding:5px 9px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;font:inherit}
.pc-alias-editor button.pc-alias-save{background:#1a73e8;border-color:#1a73e8;color:#fff}
.pc-alias-editor .pc-alias-error{margin-top:6px;color:#b3261e;overflow-wrap:anywhere}
.pc-alias-editor .pc-alias-help{margin-top:7px;color:#5f6368;font-size:11px}
`;

interface EditorState {
  entry: AliasEntry;
  container: HTMLElement;
  input: HTMLInputElement;
  error: HTMLElement;
  anchor?: {x: number; y: number};
}

interface LabelTarget {
  attrs: any;
  renderer: any;
  original?: (row: any) => string;
  originalGetKey?: () => string;
  originalColorizer?: (row: any) => any;
}

export class SliceAliasManager {
  onChanged?: () => void;
  onEditRequest?: (selection: any, canvas?: HTMLCanvasElement, anchor?: {x: number; y: number}) => Promise<void>;
  private trace: any;
  private aliases = new Map<string, AliasEntry>();
  private labelTargets = new Map<string, LabelTarget>();
  private labelVersions = new Map<string, number>();
  private editor?: EditorState;

  constructor(trace: any) {
    this.trace = trace;
    const style = document.createElement('style');
    style.textContent = EDITOR_CSS;
    document.head.appendChild(style);
    this.refreshLabelOverrides();
    const doubleClick = (event: MouseEvent) => this.onDoubleClick(event);
    const keyDown = (event: KeyboardEvent) => this.onKeyDown(event);
    document.addEventListener('dblclick', doubleClick, true);
    document.addEventListener('keydown', keyDown, true);
    trace.trash.defer(() => {
      document.removeEventListener('dblclick', doubleClick, true);
      document.removeEventListener('keydown', keyDown, true);
      for (const target of this.labelTargets.values()) {
        target.attrs.sliceName = target.original;
        target.attrs.getKey = target.originalGetKey;
        target.attrs.colorizer = target.originalColorizer;
      }
      this.labelTargets.clear();
      this.labelVersions.clear();
      this.closeEditor();
      style.remove();
    });
  }

  list(): AliasEntry[] {
    return Array.from(this.aliases.values(), (entry) => ({...entry})).sort((a, b) => {
      const left = BigInt(a.slice_id);
      const right = BigInt(b.slice_id);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  get(sliceId: string): AliasEntry | undefined {
    const entry = this.aliases.get(int64String(sliceId, 'slice id'));
    return entry ? {...entry} : undefined;
  }

  load(entries: AliasEntry[]): void {
    const valid = validateAliasEntries(entries);
    for (const entry of valid) this.assertSupported(entry.track_uri);
    this.aliases = new Map(valid.map((entry) => [entry.slice_id, entry]));
    for (const uri of this.labelTargets.keys()) this.bumpVersion(uri);
    this.closeEditor();
    this.changed();
  }

  setAlias(entry: AliasEntry): AliasEntry {
    const valid = validateAliasEntry(entry);
    this.assertSupported(valid.track_uri);
    this.aliases.set(valid.slice_id, valid);
    this.bumpVersion(valid.track_uri);
    this.closeEditor();
    this.changed();
    return {...valid};
  }

  removeAlias(sliceId: string): boolean {
    const id = int64String(sliceId, 'slice id');
    const entry = this.aliases.get(id);
    const removed = this.aliases.delete(id);
    if (removed && entry) {
      this.bumpVersion(entry.track_uri);
      this.closeEditor();
      this.changed();
    }
    return removed;
  }

  clearAliases(): number {
    const count = this.aliases.size;
    this.aliases.clear();
    if (count > 0) {
      for (const uri of this.labelTargets.keys()) this.bumpVersion(uri);
    }
    this.closeEditor();
    this.changed();
    return count;
  }

  openEditor(entry: AliasEntry, _canvas?: HTMLCanvasElement, anchor?: {x: number; y: number}): void {
    this.assertSupported(entry.track_uri);
    this.closeEditor();
    const container = document.createElement('div');
    container.className = 'pc-alias-editor';
    const label = document.createElement('label');
    label.textContent = 'Operator display alias';
    const input = document.createElement('input');
    input.value = entry.alias;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Operator display alias');
    const original = document.createElement('div');
    original.className = 'pc-alias-original';
    original.textContent = `Original: ${entry.original_name}`;
    const error = document.createElement('div');
    error.className = 'pc-alias-error';
    const actions = document.createElement('div');
    actions.className = 'pc-alias-actions';
    const save = document.createElement('button');
    save.textContent = 'Save alias';
    save.className = 'pc-alias-save';
    const reset = document.createElement('button');
    reset.textContent = 'Restore original';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    actions.append(save, reset, cancel);
    const help = document.createElement('div');
    help.className = 'pc-alias-help';
    help.textContent = 'Only the rendered label changes. Slice colors, SQL, and the original trace stay unchanged. Enter to save, Esc to cancel.';
    container.append(label, input, original, actions, help, error);
    document.body.appendChild(container);
    this.editor = {entry: {...entry}, container, input, error, anchor};
    save.onclick = () => this.commit();
    reset.onclick = () => {
      this.removeAlias(entry.slice_id);
      this.closeEditor();
    };
    cancel.onclick = () => this.closeEditor();
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeEditor();
      }
    };
    input.focus();
    input.select();
    this.updateEditorPosition();
  }

  closeEditor(): void {
    this.editor?.container.remove();
    this.editor = undefined;
  }

  private commit(): void {
    const editor = this.editor;
    if (!editor) return;
    try {
      this.setAlias({...editor.entry, alias: validateAliasText(editor.input.value)});
    } catch (error) {
      editor.error.textContent = error instanceof Error ? error.message : String(error);
      editor.input.focus();
    }
  }

  private changed(): void {
    this.refreshLabelOverrides();
    this.trace.raf.scheduleFullRedraw();
    this.onChanged?.();
  }

  private bumpVersion(trackUri: string): void {
    this.labelVersions.set(trackUri, (this.labelVersions.get(trackUri) ?? 0) + 1);
  }

  private refreshLabelOverrides(): void {
    const activeUris = new Set<string>();
    for (const track of this.trace.tracks.getAllTracks()) {
      const attrs = track.renderer?.attrs;
      if (!attrs?.dataset || typeof track.renderer?.getColor !== 'function') continue;
      activeUris.add(track.uri);
      if (this.labelTargets.has(track.uri)) continue;
      const original = attrs.sliceName;
      const originalGetKey = attrs.getKey;
      const originalColorizer = attrs.colorizer;
      const renderer = track.renderer;
      this.labelTargets.set(track.uri, {attrs, renderer, original, originalGetKey, originalColorizer});
      this.labelVersions.set(track.uri, this.labelVersions.get(track.uri) ?? 0);
      attrs.sliceName = (row: any) => {
        const entry = this.aliases.get(String(row.id));
        if (entry) return entry.alias;
        return original ? original.call(attrs, row) : String(row.name ?? '');
      };
      attrs.getKey = () => {
        const base = originalGetKey ? originalGetKey.call(attrs) : '';
        return `${base}:collab-alias-${this.labelVersions.get(track.uri) ?? 0}`;
      };
      attrs.colorizer = (row: any) => {
        if (originalColorizer) return originalColorizer.call(attrs, row);
        const originalTitle = original ? original.call(attrs, row) : String(row.name ?? '');
        const current = attrs.colorizer;
        attrs.colorizer = undefined;
        try {
          return renderer.getColor(row, originalTitle);
        } finally {
          attrs.colorizer = current;
        }
      };
    }
    for (const [uri, target] of this.labelTargets) {
      if (!activeUris.has(uri)) {
        target.attrs.sliceName = target.original;
        target.attrs.getKey = target.originalGetKey;
        target.attrs.colorizer = target.originalColorizer;
        this.labelTargets.delete(uri);
        this.labelVersions.delete(uri);
      }
    }
  }

  private assertSupported(trackUri: string): void {
    this.refreshLabelOverrides();
    if (!this.labelTargets.has(trackUri)) {
      throw new CollabError('UNSUPPORTED_ALIAS_TRACK', `This track does not expose native slice label rendering: ${trackUri}`);
    }
  }

  private onDoubleClick(event: MouseEvent): void {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event' || !(event.target instanceof Element)) return;
    const content = event.target.closest('.pf-track__canvas');
    if (!content) return;
    event.preventDefault();
    event.stopPropagation();
    void this.requestEdit(selection, undefined, {x: event.clientX, y: event.clientY});
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'track_event') return;
    event.preventDefault();
    event.stopPropagation();
    void this.requestEdit(selection);
  }

  private async requestEdit(selection: any, _canvas?: HTMLCanvasElement, anchor?: {x: number; y: number}): Promise<void> {
    if (!this.onEditRequest) return;
    try {
      await this.onEditRequest(selection, undefined, anchor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.omnibox.showStatusMessage(message);
    }
  }

  private updateEditorPosition(): void {
    const editor = this.editor;
    if (!editor) return;
    const left = editor.anchor ? editor.anchor.x - 20 : window.innerWidth / 2 - 170;
    const top = editor.anchor ? editor.anchor.y - 52 : Math.max(80, window.innerHeight / 3);
    editor.container.style.left = `${Math.min(Math.max(8, left), Math.max(8, window.innerWidth - 350))}px`;
    editor.container.style.top = `${Math.min(Math.max(8, top), Math.max(8, window.innerHeight - 190))}px`;
  }
}
