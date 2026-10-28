import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const events = [
  {ph: 'M', pid: 1, tid: 0, name: 'process_name', args: {name: 'B300 demo rank 0'}},
  {ph: 'M', pid: 1, tid: 7, name: 'thread_name', args: {name: 'GPU stream 7'}},
  {ph: 'M', pid: 1, tid: 8, name: 'thread_name', args: {name: 'GPU stream 8'}},
];
const kernels = [
  ['mRoPE', 7, 1000, 420],
  ['sparse MLA', 7, 1600, 2800],
  ['combine', 7, 4700, 650],
  ['gemm', 8, 1200, 900],
  ['sparse MLA', 8, 2400, 3600],
  ['combine', 8, 6300, 700],
  ['mRoPE', 7, 7200, 380],
];
for (let index = 0; index < kernels.length; index++) {
  const [name, stream, ts, dur] = kernels[index];
  events.push({
    name,
    cat: 'kernel,gpu',
    ph: 'X',
    pid: 1,
    tid: stream,
    ts,
    dur,
    args: {stream, correlation_id: 1000 + index, demo: true},
  });
}
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'demo-trace.json');
await writeFile(output, `${JSON.stringify({traceEvents: events, displayTimeUnit: 'ms'}, null, 2)}\n`);
console.log(output);
