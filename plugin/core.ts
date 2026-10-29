export const VIEW_FORMAT = 'perfetto-local-collab-view';
export const VIEW_FORMAT_VERSION = 1;
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;
export const MAX_QUERY_RESPONSE_BYTES = 1024 * 1024;

export class CollabError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
    this.details = details;
  }
}

export function int64String(value: unknown, name: string): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CollabError('INVALID_INT64', `${name} must be a safe integer or a base-10 string`);
    }
    return value.toString(10);
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new CollabError('INVALID_INT64', `${name} must be a base-10 integer string`);
  }
  return value.replace(/^(-?)0+(?=\d)/, '$1');
}

export function safeNumber(value: unknown, name: string): number {
  const text = int64String(value, name);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new CollabError('UNSAFE_INT64', `${name} is outside the frontend's safe integer range`);
  }
  return number;
}

export function timeRange(start: unknown, end: unknown): {start: string; end: string} {
  const range = {start: int64String(start, 'start'), end: int64String(end, 'end')};
  if (BigInt(range.start) >= BigInt(range.end)) {
    throw new CollabError('INVALID_TIME_RANGE', 'start must be smaller than end');
  }
  return range;
}

function sqlCodeOnly(sql: string): string {
  let output = '';
  let state: 'code' | 'single' | 'double' | 'backtick' | 'bracket' | 'line' | 'block' = 'code';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (state === 'line') {
      if (char === '\n' || char === '\r') {
        state = 'code';
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block') {
      output += ' ';
      if (char === '*' && next === '/') {
        output += ' ';
        i++;
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      output += ' ';
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : state === 'backtick' ? '`' : ']';
      if (char === quote) {
        if (state !== 'bracket' && next === quote) {
          output += ' ';
          i++;
        } else {
          state = 'code';
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      output += '  ';
      i++;
      state = 'line';
    } else if (char === '/' && next === '*') {
      output += '  ';
      i++;
      state = 'block';
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      output += ' ';
      state = char === "'" ? 'single' : char === '"' ? 'double' : char === '`' ? 'backtick' : 'bracket';
    } else {
      output += char;
    }
  }
  if (['single', 'double', 'backtick', 'bracket', 'block'].includes(state)) {
    throw new CollabError('INVALID_QUERY', 'SQL contains an unterminated quote, identifier, or comment');
  }
  return output;
}

export function validateSql(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 100_000 || sql.includes('\0')) {
    throw new CollabError('INVALID_QUERY', 'SQL must be a non-empty string of at most 100000 characters');
  }
  let code = sqlCodeOnly(sql).trim();
  if (code.endsWith(';')) code = code.slice(0, -1);
  if (code.includes(';')) {
    throw new CollabError('SQL_NOT_ALLOWED', 'Only one SQL statement is allowed');
  }
  if (!/^(SELECT|WITH)\b/i.test(code.trim())) {
    throw new CollabError('SQL_NOT_ALLOWED', 'Only read-only SELECT and WITH queries are allowed');
  }
  const forbidden = /\b(ATTACH|DETACH|PRAGMA|LOAD_EXTENSION|READFILE|WRITEFILE|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|REINDEX|ANALYZE)\b/i;
  const match = forbidden.exec(code);
  if (match) {
    throw new CollabError('SQL_NOT_ALLOWED', `SQL operation is not allowed: ${match[1].toUpperCase()}`);
  }
  return sql.trim();
}

export function sqlForSubquery(sql: string): string {
  const original = validateSql(sql);
  const code = sqlCodeOnly(original);
  const end = code.trimEnd().length;
  if (end > 0 && code[end - 1] === ';') {
    return `${original.slice(0, end - 1)}${original.slice(end)}`.trim();
  }
  return original;
}

function encodeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CollabError('INT64_PRECISION_LOSS', 'Query engine returned an unsafe integer; refusing to silently lose precision');
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    return {$bytes: Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')};
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
    return value ?? null;
  }
  throw new CollabError('INVALID_QUERY_RESULT', `Unsupported query result value: ${typeof value}`);
}

export function encodeQueryResult(
  columns: string[],
  inputRows: unknown[][],
  maxRows = 100,
  maxBytes = MAX_QUERY_RESPONSE_BYTES,
): {columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean; bytes: number} {
  if (!Array.isArray(columns) || columns.length > 1000 || columns.some((column) => typeof column !== 'string')) {
    throw new CollabError('INVALID_QUERY_RESULT', 'Invalid query result columns');
  }
  const rows = inputRows.slice(0, maxRows).map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new CollabError('INVALID_QUERY_RESULT', 'Query result row does not match its columns');
    }
    return row.map(encodeValue);
  });
  const result = {columns, rows, row_count: rows.length, truncated: inputRows.length > rows.length, bytes: 0};
  const size = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
  while (rows.length > 0 && size() > maxBytes) {
    rows.pop();
    result.truncated = true;
  }
  result.row_count = rows.length;
  result.bytes = size();
  if (result.bytes > maxBytes) {
    throw new CollabError('RESPONSE_TOO_LARGE', 'Query result metadata exceeds the response byte limit');
  }
  return result;
}

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollabError('INVALID_VIEW', `${name} must be an object`);
  }
  return value as Record<string, any>;
}

function optionalTrack(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2000) {
    throw new CollabError('INVALID_VIEW', 'track_uri must be a non-empty string of at most 2000 characters');
  }
  return value;
}

function requiredTrack(value: unknown): string {
  const track = optionalTrack(value);
  if (track === undefined) throw new CollabError('INVALID_VIEW', 'track_uri is required');
  return track;
}

export interface AliasEntry {
  slice_id: string;
  track_uri: string;
  start: string;
  end: string;
  original_name: string;
  alias: string;
  depth: number;
}

export function validateAliasText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw new CollabError('INVALID_ALIAS', 'Alias must contain 1-200 characters');
  }
  return value.trim();
}

export function validateAliasEntry(value: unknown): AliasEntry {
  const entry = object(value, 'alias');
  const alias = validateAliasText(entry.alias);
  if (typeof entry.original_name !== 'string' || entry.original_name.length > 10_000) {
    throw new CollabError('INVALID_ALIAS', 'original_name must be a string of at most 10000 characters');
  }
  const start = int64String(entry.start, 'alias.start');
  const end = int64String(entry.end, 'alias.end');
  if (BigInt(start) > BigInt(end)) throw new CollabError('INVALID_ALIAS', 'alias.start must not exceed alias.end');
  if (!Number.isSafeInteger(entry.depth) || entry.depth < 0 || entry.depth > 10_000) {
    throw new CollabError('INVALID_ALIAS', 'depth must be an integer between 0 and 10000');
  }
  return {
    slice_id: int64String(entry.slice_id, 'alias.slice_id'),
    track_uri: requiredTrack(entry.track_uri),
    start,
    end,
    original_name: entry.original_name,
    alias,
    depth: entry.depth,
  };
}

export function validateAliasEntries(value: unknown): AliasEntry[] {
  if (!Array.isArray(value) || value.length > 5000) {
    throw new CollabError('INVALID_VIEW', 'aliases must be an array of at most 5000 entries');
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    const entry = validateAliasEntry(raw);
    if (ids.has(entry.slice_id)) throw new CollabError('INVALID_VIEW', `Duplicate alias slice id: ${entry.slice_id}`);
    ids.add(entry.slice_id);
    return entry;
  });
}

export function validateViewDocument(value: unknown): Record<string, any> {
  const view = object(value, 'view');
  if (view.format !== VIEW_FORMAT || view.format_version !== VIEW_FORMAT_VERSION) {
    throw new CollabError('INCOMPATIBLE_VIEW', 'Unsupported view format or format version');
  }
  const trace = object(view.trace, 'view.trace');
  if (typeof trace.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(trace.fingerprint)) {
    throw new CollabError('INCOMPATIBLE_VIEW', 'View has no valid trace content fingerprint');
  }
  if (typeof trace.parser_version !== 'string' || trace.parser_version.length > 200) {
    throw new CollabError('INCOMPATIBLE_VIEW', 'View has an invalid parser version');
  }
  if (view.viewport !== null) {
    const viewport = object(view.viewport, 'viewport');
    timeRange(viewport.start, viewport.end);
  }
  if (view.area !== null && view.area !== undefined) {
    const area = object(view.area, 'area');
    timeRange(area.start, area.end);
    if (!Array.isArray(area.track_uris) || area.track_uris.length > 10_000) {
      throw new CollabError('INVALID_VIEW', 'area.track_uris must be an array of at most 10000 entries');
    }
    area.track_uris.forEach(requiredTrack);
  }
  if (view.focus !== null && view.focus !== undefined) {
    const focus = object(view.focus, 'focus');
    if (focus.kind === 'track_event') {
      int64String(focus.event_id, 'focus.event_id');
      requiredTrack(focus.track_uri);
    } else if (focus.kind === 'track') {
      requiredTrack(focus.track_uri);
    } else if (focus.kind === 'note') {
      if (typeof focus.id !== 'string' || !focus.id) throw new CollabError('INVALID_VIEW', 'focus.id is required for a note');
    } else {
      throw new CollabError('INVALID_VIEW', 'Unsupported focus kind');
    }
  }
  if (!Array.isArray(view.notes) || view.notes.length > 5000) {
    throw new CollabError('INVALID_VIEW', 'notes must be an array of at most 5000 entries');
  }
  const noteIds = new Set<string>();
  for (const raw of view.notes) {
    const note = object(raw, 'note');
    if (typeof note.id !== 'string' || note.id.length < 1 || note.id.length > 200) {
      throw new CollabError('INVALID_VIEW', 'Every note needs a valid id');
    }
    if (noteIds.has(note.id)) {
      throw new CollabError('INVALID_VIEW', `Duplicate note id: ${note.id}`);
    }
    noteIds.add(note.id);
    if (typeof note.text !== 'string' || note.text.length > 10_000) {
      throw new CollabError('INVALID_VIEW', 'Note text must be a string of at most 10000 characters');
    }
    if (note.end !== undefined && note.end !== null) timeRange(note.start, note.end);
    else int64String(note.start, 'note.start');
    if (note.color !== undefined && (typeof note.color !== 'string' || note.color.length > 100)) {
      throw new CollabError('INVALID_VIEW', 'Note color must be a short string');
    }
    optionalTrack(note.track_uri);
  }
  view.aliases = validateAliasEntries(view.aliases ?? []);
  if (!Array.isArray(view.layout) || view.layout.length > 10_000) {
    throw new CollabError('INVALID_VIEW', 'layout must be an array of at most 10000 entries');
  }
  for (const raw of view.layout) {
    const entry = object(raw, 'layout entry');
    requiredTrack(entry.track_uri);
    if (typeof entry.collapsed !== 'boolean' || typeof entry.pinned !== 'boolean') {
      throw new CollabError('INVALID_VIEW', 'Every layout entry needs track_uri, collapsed, and pinned');
    }
  }
  const encoded = JSON.stringify(view);
  if (new TextEncoder().encode(encoded).byteLength > MAX_VIEW_BYTES) {
    throw new CollabError('VIEW_TOO_LARGE', 'View document exceeds 2 MiB');
  }
  return JSON.parse(encoded);
}

export function assertCompatibleView(view: Record<string, any>, fingerprint: string, parserVersion: string): void {
  if (view.trace.fingerprint !== fingerprint || view.trace.parser_version !== parserVersion) {
    throw new CollabError('INCOMPATIBLE_VIEW', 'The view belongs to a different trace or Perfetto parser version');
  }
}
