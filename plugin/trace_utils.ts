import {AliasEntry, CollabError, safeNumber} from './core';

export interface RawQueryResult {
  columns: string[];
  rows: any[][];
}

export async function queryRows(trace: any, sql: string, maxRows = 1000): Promise<RawQueryResult> {
  const result = await trace.engine.query(`SELECT * FROM (${sql}\n) AS collab_internal LIMIT ${maxRows + 1}`);
  const columns = result.columns();
  const rows: any[][] = [];
  const iterator = result.iter({});
  for (; iterator.valid(); iterator.next()) {
    rows.push(columns.map((column) => iterator.get(column)));
  }
  return {columns, rows};
}

export function isTrackVisible(node: any): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.collapsed) return false;
    parent = parent.parent;
  }
  return true;
}

export async function resolveAliasEntry(trace: any, sliceId: string, alias?: string): Promise<AliasEntry> {
  const id = safeNumber(sliceId, 'slice id');
  const resolved = await trace.selection.resolveSqlEvents('slice', [id]);
  if (resolved.length !== 1) {
    throw new CollabError('SLICE_NOT_FOUND', `Slice ${sliceId} does not exist or has no visible track`);
  }
  const result = await queryRows(trace, `SELECT id, track_id, ts, dur, name, depth FROM slice WHERE id = ${id}`, 1);
  const row = result.rows[0];
  if (!row) throw new CollabError('SLICE_NOT_FOUND', `Slice ${sliceId} does not exist`);
  const ts = BigInt(row[2]);
  const dur = BigInt(row[3]);
  if (dur < 0n) throw new CollabError('INVALID_ALIAS_TARGET', 'Unfinished slices cannot be assigned a display alias');
  const originalName = String(row[4] ?? '');
  return {
    slice_id: String(row[0]),
    track_uri: resolved[0].trackUri,
    start: ts.toString(),
    end: (ts + dur).toString(),
    original_name: originalName,
    alias: alias ?? originalName,
    depth: Number(row[5] ?? 0),
  };
}

export async function validateAliasTargets(trace: any, entries: AliasEntry[]): Promise<void> {
  if (!entries.length) return;
  const ids = entries.map((entry) => safeNumber(entry.slice_id, 'alias.slice_id'));
  const result = await queryRows(trace, `SELECT id, track_id, ts, dur, name, depth FROM slice WHERE id IN (${ids.join(',')})`, entries.length);
  const rows = new Map(result.rows.map((row) => [String(row[0]), row]));
  for (const entry of entries) {
    const row = rows.get(entry.slice_id);
    if (!row) throw new CollabError('ALIAS_TARGET_NOT_FOUND', `Alias target slice does not exist: ${entry.slice_id}`);
    const track = trace.tracks.getTrack(entry.track_uri);
    const trackIds = track?.tags?.trackIds ?? [];
    const expectedEnd = (BigInt(row[2]) + BigInt(row[3])).toString();
    if (!trackIds.some((id: number) => id.toString() === String(row[1])) ||
        String(row[2]) !== entry.start || expectedEnd !== entry.end ||
        String(row[4] ?? '') !== entry.original_name || Number(row[5] ?? 0) !== entry.depth) {
      throw new CollabError('ALIAS_TARGET_MISMATCH', `Alias target metadata does not match slice ${entry.slice_id}`);
    }
  }
}

export async function showCpuTracks(trace: any): Promise<Record<string, any>> {
  const categories = ['cpu_op', 'user_annotation', 'cuda_runtime', 'cuda_driver', 'overhead', 'sched_switch', 'sched_wakeup', 'syscall'];
  const predicate = categories.map((category) => `INSTR(lower(COALESCE(category, '')), '${category}') > 0`).join(' OR ');
  const result = await queryRows(trace, `SELECT DISTINCT track_id FROM slice WHERE ${predicate}`, 10_000);
  const ids = new Set(result.rows.map((row) => String(row[0])));
  const cpuNodes = trace.currentWorkspace.flatTracksOrdered.filter((node: any) => {
    if (!node.uri) return false;
    const track = trace.tracks.getTrack(node.uri);
    return (track?.tags?.trackIds ?? []).some((id: number) => ids.has(id.toString()));
  });
  let expanded = 0;
  for (const node of cpuNodes) {
    if (node.collapsed || !isTrackVisible(node)) expanded++;
    node.reveal();
    node.expand();
  }
  return {
    available: cpuNodes.length,
    visible: cpuNodes.filter(isTrackVisible).length,
    expanded,
    track_ids: Array.from(ids),
    track_uris: cpuNodes.map((node: any) => node.uri),
  };
}
