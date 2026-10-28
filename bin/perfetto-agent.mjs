#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AgentError, agentRequest} from './agent-client.mjs';

const HELP = `Perfetto local agent CLI

Connection (copy values from the browser's Agent collaboration panel):
  $env:PERFETTO_AGENT_SESSION="<session>"
  $env:PERFETTO_AGENT_TOKEN="<token>"
  Optional: $env:PERFETTO_AGENT_URL="http://127.0.0.1:19400/api/agent/request"

Commands:
  state
  query --sql "SELECT id, ts, dur, name FROM slice LIMIT 10" [--max-rows 100] [--timeout-ms 30000]
  select --slice-id 123
  clear-selection
  zoom --start <int64> --end <int64>
  center --start <int64> [--end <int64>]
  zoom-selection
  area --start <int64> --end <int64> --track <track-uri> [--track <track-uri>]
  clear-area
  layout --track <track-uri-or-node-id> [--collapse|--expand|--pin|--unpin]
  reset-layout
  note --text "investigate this" --start <int64> [--end <int64>] [--color <css-color>]
  update-note --id <note-id> [--text "updated"] [--start <int64>] [--end <int64>] [--color <css-color>]
  remove-note --id <note-id>
  cancel-query --query-id <request-id>
  undo
  logs
  export [--output view.json] [--force]
  import --input view.json

Global options: --connection connection.json, --expected-version N, --url URL,
                --session SESSION, --token TOKEN, --request-id ID, --pretty.
                Timestamps and int64 values are strings.
`;

function parse(argv) {
  const positionals = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (['--collapse', '--expand', '--pin', '--unpin', '--force', '--help', '--pretty'].includes(arg)) {
      options.set(arg.slice(2), true);
    } else {
      if (i + 1 >= argv.length) throw new AgentError('INVALID_ARGUMENTS', `Missing value for ${arg}`);
      const key = arg.slice(2);
      const values = options.get(key) ?? [];
      values.push(argv[++i]);
      options.set(key, values);
    }
  }
  return {positionals, options};
}

function one(options, key, required = false) {
  const value = options.get(key);
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new AgentError('INVALID_ARGUMENTS', `--${key} may be specified only once`);
    return value[0];
  }
  if (required && value === undefined) throw new AgentError('INVALID_ARGUMENTS', `--${key} is required`);
  return value;
}

function many(options, key) {
  const value = options.get(key);
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function int64(value, name) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new AgentError('INVALID_ARGUMENTS', `${name} must be a base-10 integer string`);
  }
  return value;
}

async function main() {
  const {positionals, options} = parse(process.argv.slice(2));
  const command = positionals[0];
  if (!command || command === 'help' || options.has('help')) {
    console.log(HELP);
    return;
  }
  const connectionPath = one(options, 'connection');
  const fileConnection = connectionPath ? JSON.parse(await readFile(path.resolve(connectionPath), 'utf8')) : {};
  const connection = {
    url: one(options, 'url') ?? fileConnection.url ?? fileConnection.request_url,
    session: one(options, 'session') ?? fileConnection.session,
    token: one(options, 'token') ?? fileConnection.token,
  };
  const versionText = one(options, 'expected-version');
  const expectedVersion = versionText === undefined ? undefined : Number(versionText);
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    throw new AgentError('INVALID_ARGUMENTS', '--expected-version must be a non-negative safe integer');
  }
  const requestId = one(options, 'request-id');
  const call = (kind, args = {}) => agentRequest(connection, kind, args, {expectedVersion, id: requestId});
  let response;
  switch (command) {
    case 'state': response = await call('state.get'); break;
    case 'query': {
      const sqlFile = one(options, 'file');
      const sql = one(options, 'sql') ?? (sqlFile ? await readFile(path.resolve(sqlFile), 'utf8') : undefined);
      if (!sql) throw new AgentError('INVALID_ARGUMENTS', 'query requires --sql or --file');
      response = await call('query', {
        sql,
        max_rows: Number(one(options, 'max-rows') ?? 100),
        timeout_ms: Number(one(options, 'timeout-ms') ?? 30_000),
      });
      break;
    }
    case 'select': {
      const ids = many(options, 'slice-id');
      if (!ids.length) throw new AgentError('INVALID_ARGUMENTS', 'select requires at least one --slice-id');
      response = await call('selection.set', {slice_ids: ids.map((id) => int64(id, 'slice id'))});
      break;
    }
    case 'clear-selection': response = await call('selection.clear'); break;
    case 'zoom':
      response = await call('viewport.set', {
        start: int64(one(options, 'start', true), 'start'),
        end: int64(one(options, 'end', true), 'end'),
      });
      break;
    case 'zoom-selection': response = await call('viewport.zoomToSelection'); break;
    case 'center':
      response = await call('viewport.center', {
        start: int64(one(options, 'start', true), 'start'),
        end: one(options, 'end') === undefined ? undefined : int64(one(options, 'end'), 'end'),
      });
      break;
    case 'area':
      response = await call('area.set', {
        start: int64(one(options, 'start', true), 'start'),
        end: int64(one(options, 'end', true), 'end'),
        track_uris: many(options, 'track'),
      });
      break;
    case 'clear-area': response = await call('area.clear'); break;
    case 'layout': {
      const action = ['collapse', 'expand', 'pin', 'unpin'].filter((name) => options.has(name));
      if (action.length !== 1) throw new AgentError('INVALID_ARGUMENTS', 'Choose exactly one of --collapse, --expand, --pin, --unpin');
      response = await call('layout.set', {track_uri: one(options, 'track', true), action: action[0]});
      break;
    }
    case 'reset-layout': response = await call('layout.reset'); break;
    case 'note':
      response = await call('notes.add', {
        text: one(options, 'text', true),
        start: int64(one(options, 'start', true), 'start'),
        end: one(options, 'end') === undefined ? undefined : int64(one(options, 'end'), 'end'),
        color: one(options, 'color'),
      });
      break;
    case 'update-note': {
      const start = one(options, 'start');
      const end = one(options, 'end');
      response = await call('notes.update', {
        id: one(options, 'id', true),
        text: one(options, 'text'),
        start: start === undefined ? undefined : int64(start, 'start'),
        end: end === undefined ? undefined : int64(end, 'end'),
        color: one(options, 'color'),
      });
      break;
    }
    case 'remove-note': response = await call('notes.remove', {id: one(options, 'id', true)}); break;
    case 'cancel-query': response = await call('query.cancel', {query_id: one(options, 'query-id', true)}); break;
    case 'undo': response = await call('history.undo'); break;
    case 'logs': response = await call('history.list'); break;
    case 'export': response = await call('state.export'); break;
    case 'import': {
      const input = one(options, 'input', true);
      const view = JSON.parse(await readFile(path.resolve(input), 'utf8'));
      response = await call('state.import', {view});
      break;
    }
    default: throw new AgentError('INVALID_ARGUMENTS', `Unknown command: ${command}\n\n${HELP}`);
  }
  const output = options.has('pretty') ? JSON.stringify(response, null, 2) : JSON.stringify(response);
  const destination = command === 'export' ? one(options, 'output') : undefined;
  if (destination) {
    await writeFile(path.resolve(destination), `${JSON.stringify(response.result, null, 2)}\n`, {flag: options.has('force') ? 'w' : 'wx'});
    console.log(JSON.stringify({ok: true, output: path.resolve(destination), version: response.version}));
  } else {
    console.log(output);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: {
      code: error instanceof AgentError ? error.code : 'CLI_ERROR',
      message: error.message,
      ...(error.details === undefined ? {} : {details: error.details}),
    },
  }));
  process.exitCode = 1;
});
