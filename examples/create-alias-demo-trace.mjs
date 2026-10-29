import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const events = [
  {ph: 'M', pid: 1, tid: 0, name: 'process_name', args: {name: 'w8a16 alias demo'}},
  {ph: 'M', pid: 1, tid: 1, name: 'thread_name', args: {name: 'GPU stream 1'}},
  {ph: 'M', pid: 1, tid: 100, name: 'thread_name', args: {name: 'CPU main thread'}},
  {name: 'aten::linear', cat: 'cpu_op', ph: 'X', pid: 1, tid: 100, ts: 800, dur: 500, args: {layer: 1}},
  {name: 'aten::matmul', cat: 'cpu_op', ph: 'X', pid: 1, tid: 100, ts: 1400, dur: 450, args: {layer: 1}},
  {name: 'FFN CPU epilogue', cat: 'cpu_op', ph: 'X', pid: 1, tid: 100, ts: 2200, dur: 350, args: {layer: 1}},
  {name: 'w8a16_kernel/gate_up_proj', cat: 'kernel,gpu', ph: 'X', pid: 1, tid: 1, ts: 1000, dur: 1800, args: {stream: 1, layer: 1}},
  {name: 'w8a16_kernel/gate_up_proj', cat: 'kernel,gpu', ph: 'X', pid: 1, tid: 1, ts: 3600, dur: 1400, args: {stream: 1, layer: 2}},
  {name: 'fl_attn', cat: 'kernel,gpu', ph: 'X', pid: 1, tid: 1, ts: 5400, dur: 800, args: {stream: 1}},
];
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'alias-demo-trace.json');
await writeFile(output, `${JSON.stringify({traceEvents: events, displayTimeUnit: 'ms'}, null, 2)}\n`);
console.log(output);
