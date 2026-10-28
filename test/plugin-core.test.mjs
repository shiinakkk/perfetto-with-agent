import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCompatibleView,
  encodeQueryResult,
  int64String,
  sqlForSubquery,
  timeRange,
  validateSql,
  validateViewDocument,
  VIEW_FORMAT,
  VIEW_FORMAT_VERSION,
} from '../plugin/core.ts';
import {fingerprintBlob, IncrementalSha256} from '../plugin/fingerprint.ts';

test('SQL validation permits only one read-only statement', () => {
  assert.equal(validateSql(" SELECT ';' AS semi; -- trailing comment\n"), "SELECT ';' AS semi; -- trailing comment");
  assert.match(validateSql('WITH x AS (SELECT 1 AS id) SELECT * FROM x'), /^WITH/);
  for (const sql of [
    'SELECT 1; SELECT 2',
    'PRAGMA database_list',
    'SELECT load_extension(\'x\')',
    'SELECT writefile(\'/tmp/x\', \'x\')',
    'WITH x AS (SELECT 1) DELETE FROM slice',
    'INCLUDE PERFETTO MODULE android.frames.timeline',
    'SELECT \'unterminated',
  ]) {
    assert.throws(() => validateSql(sql), undefined, sql);
  }
});

test('subquery wrapping removes only the statement terminator', () => {
  assert.equal(sqlForSubquery("SELECT ';' AS semi;"), "SELECT ';' AS semi");
  assert.equal(sqlForSubquery('SELECT 1; -- trailing comment\n'), 'SELECT 1 -- trailing comment');
  assert.equal(sqlForSubquery('SELECT 1 /* ; */'), 'SELECT 1 /* ; */');
});

test('int64 and time ranges retain arbitrary precision', () => {
  assert.equal(int64String('18446744073709551615', 'value'), '18446744073709551615');
  assert.equal(int64String(123n, 'value'), '123');
  assert.throws(() => int64String(9007199254740992, 'value'), /safe integer/);
  assert.deepEqual(timeRange('10000000000000000000', '10000000000000000001'), {
    start: '10000000000000000000',
    end: '10000000000000000001',
  });
  assert.throws(() => timeRange(2, 2), /smaller/);
});

test('query encoding preserves bigint and enforces row and byte limits', () => {
  const result = encodeQueryResult(['id', 'ts', 'dur', 'ratio'], [
    [1n, 90071992547409931234n, 42n, 1.5],
    [2n, 3n, 4n, 2.5],
  ], 1);
  assert.equal(result.rows[0][1], '90071992547409931234');
  assert.equal(result.rows[0][2], '42');
  assert.equal(result.rows[0][3], 1.5);
  assert.equal(result.truncated, true);
  assert.throws(() => encodeQueryResult(['id'], [[9007199254740992]]), /unsafe integer/);
});

function validView() {
  return {
    format: VIEW_FORMAT,
    format_version: VIEW_FORMAT_VERSION,
    trace: {fingerprint: 'a'.repeat(64), parser_version: 'test-parser'},
    viewport: {start: '1', end: '2'},
    focus: null,
    area: null,
    notes: [{id: 'note-1', start: '1', text: 'hello'}],
    layout: [{track_uri: 'track-1', collapsed: false, pinned: true}],
  };
}

test('view import validates format, content fingerprint and parser version', () => {
  const view = validateViewDocument(validView());
  assert.doesNotThrow(() => assertCompatibleView(view, 'a'.repeat(64), 'test-parser'));
  assert.throws(() => assertCompatibleView(view, 'b'.repeat(64), 'test-parser'), /different trace/);
  assert.throws(() => assertCompatibleView(view, 'a'.repeat(64), 'new-parser'), /different trace/);
  const bad = validView();
  bad.notes[0].text = 42;
  assert.throws(() => validateViewDocument(bad), /Note text/);
  const duplicate = validView();
  duplicate.notes.push({...duplicate.notes[0]});
  assert.throws(() => validateViewDocument(duplicate), /Duplicate note id/);
  const badArea = validView();
  badArea.area = {start: '1', end: '2', track_uris: [null]};
  assert.throws(() => validateViewDocument(badArea), /track_uri/);
});

test('incremental SHA-256 matches known vectors and chunk boundaries', async () => {
  for (const [input, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ]) {
    const hash = new IncrementalSha256();
    hash.update(new TextEncoder().encode(input));
    assert.equal(hash.hex(), expected);
  }
  const bytes = new Uint8Array(1000).map((_, index) => index % 251);
  const actual = await fingerprintBlob(new Blob([bytes]));
  const expected = await import('node:crypto').then(({createHash}) => createHash('sha256').update(bytes).digest('hex'));
  assert.equal(actual, expected);
});
