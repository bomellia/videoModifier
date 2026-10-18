// Uses the exact bundled browser WASM core, not the installed native encoder.
// Native ffmpeg/ffprobe only generate fixtures and independently inspect results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import createCore from '../docs/lib/ffmpeg-core.js';
import { CopyEditor, outputDuration } from '../docs/editor.js';

const root = fileURLToPath(new URL('./.tmp/', import.meta.url));
await fs.mkdir(root, { recursive: true });
const fixture = path.join(root, 'fixture.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
  '-c:v', 'libx264', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture]);
const core = await createCore({ wasmBinary: await fs.readFile(new URL('../docs/lib/ffmpeg-core.wasm', import.meta.url)) });
const listeners = [];
let commands = [];
core.setLogger(data => listeners.forEach(listener => listener(data)));
const client = {
  on: (event, fn) => { if (event === 'log') listeners.push(fn); },
  writeFile: async (name, data) => core.FS.writeFile(name, data),
  readFile: async (name, encoding) => core.FS.readFile(name, encoding ? { encoding } : {}),
  deleteFile: async name => core.FS.unlink(name),
  exec: async args => {
    commands.push(args);
    core.exec(...args);
    const code = core.ret;
    core.reset();
    return code;
  },
};
const editor = new CopyEditor(client);
const source = await fs.readFile(fixture);
const file = { arrayBuffer: async () => source };
const info = await editor.prepare(file, 6);
assert.equal(info.hasAudio, true);
assert.deepEqual(info.boundaries, [0, 1, 2, 3, 4, 5, 6]);
function probe(filename, extra = []) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...extra, '-of', 'json', filename], { maxBuffer: 32 * 1024 * 1024 }));
}
const hashes = probe(fixture, ['-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256']).packets.map(p => p.data_hash);
const cases = [
  ['unchanged', [{ start: 0, end: 6, speed: 1 }], {}, 180],
  ['trim', [{ start: 1, end: 3, speed: 1 }], {}, 60],
  ['cut', [{ start: 0, end: 1, speed: 1 }, { start: 3, end: 5, speed: 1 }], {}, 90],
  ['mixed', [{ start: 0, end: 2, speed: 1 }, { start: 2, end: 4, speed: 2 }, { start: 4, end: 6, speed: 1 }], {}, 180],
  ['slow-cut-fast', [{ start: 0, end: 2, speed: 4 }, { start: 3, end: 5, speed: 0.5 }], {}, 120],
  ['muted', [{ start: 0, end: 2, speed: 1.5 }, { start: 4, end: 6, speed: 3 }], { mute: true }, 120],
  ['rotated', [{ start: 1, end: 3, speed: 2 }], { rotation: 90 }, 60],
  ['ten-times', [{ start: 0, end: 2, speed: 1 }, { start: 2, end: 4, speed: 10 }, { start: 4, end: 6, speed: 1 }], {}, 180],
];
for (const [name, plan, options, expectedFrames] of cases) {
  commands = [];
  const start = performance.now();
  const blob = await editor.export(plan, options);
  const filename = path.join(root, `${name}.mp4`);
  await fs.writeFile(filename, new Uint8Array(await blob.arrayBuffer()));
  const streams = probe(filename, ['-show_streams', '-count_frames']).streams;
  const video = streams.find(s => s.codec_type === 'video');
  assert.equal(Number(video.nb_read_frames), expectedFrames, name + ' decoded frames');
  assert.ok(Math.abs(Number(video.duration) - outputDuration(plan)) < 0.04, name + ' duration');
  const audio = streams.find(s => s.codec_type === 'audio');
  assert.equal(Boolean(audio), !options.mute, name + ' audio');
  if (audio) assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.09, name + ' AV sync');
  const packets = probe(filename, ['-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256']).packets;
  assert.equal(packets.length, expectedFrames, name + ' encoded packet count');
  for (const [i, packet] of packets.entries()) {
    assert.ok(hashes.includes(packet.data_hash), name + ' video payload unchanged');
    if (i) assert.ok(Number(packet.dts) > Number(packets[i - 1].dts), name + ' DTS strictly increasing');
  }
  const frames = probe(filename, ['-select_streams', 'v:0', '-show_frames']).frames.filter(f => f.media_type === 'video');
  for (let i = 1; i < frames.length; i++) {
    assert.ok(Number(frames[i].best_effort_timestamp) > Number(frames[i - 1].best_effort_timestamp), name + ' presentation order');
  }
  if (name === 'rotated') assert.equal(Math.abs(video.side_data_list.find(s => 'rotation' in s).rotation), 90);
  assert.ok(commands.every(args => !args.includes('-c:v') || args[args.indexOf('-c:v') + 1] === 'copy'));
  assert.ok(!core.FS.readdir('/').some(name => /^(part-|audio\.|output\.|join\.)/.test(name)), name + ' temporary files cleaned');
  console.log(`PASS ${name}: ${expectedFrames} frames, ${video.duration}s, ${(performance.now() - start).toFixed(0)}ms (includes independent inspection)`);
}
// Existing display rotation must survive the default (no additional rotation).
const rotatedInput = path.join(root, 'rotated.mp4');
const rotatedDuration = Number(probe(rotatedInput, ['-show_format']).format.duration);
await editor.prepare({ arrayBuffer: async () => fs.readFile(rotatedInput) }, rotatedDuration);
assert.equal(editor.info.sourceRotation, -90);
const preservedRotation = path.join(root, 'preserved-rotation.mp4');
await fs.writeFile(preservedRotation, new Uint8Array(await (await editor.export([{ start: 0, end: rotatedDuration, speed: 1 }])).arrayBuffer()));
assert.equal(probe(preservedRotation, ['-show_streams']).streams[0].side_data_list.find(s => 'rotation' in s).rotation, -90);
console.log('PASS existing display rotation preserved');
// A previous streamcopy trim may retain negative-timestamp preroll packets.
const prerollInput = path.join(root, 'preroll.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.7', '-t', '4', '-i', fixture, '-c', 'copy', prerollInput]);
const prerollDuration = Number(probe(prerollInput, ['-show_format']).format.duration);
await editor.prepare({ arrayBuffer: async () => fs.readFile(prerollInput) }, prerollDuration);
assert.equal(editor.info.boundaries[0], 0);
const prerollPlan = [{ start: 0, end: editor.info.boundaries[2], speed: 1 },
  { start: editor.info.boundaries[3], end: prerollDuration, speed: 2 }];
const prerollOutput = path.join(root, 'preroll-edited.mp4');
await fs.writeFile(prerollOutput, new Uint8Array(await (await editor.export(prerollPlan)).arrayBuffer()));
assert.ok(Math.abs(Number(probe(prerollOutput, ['-show_format']).format.duration) - outputDuration(prerollPlan)) < 0.05);
const prerollPackets = probe(prerollOutput, ['-select_streams', 'v:0', '-show_packets']).packets;
for (let i = 1; i < prerollPackets.length; i++) assert.ok(Number(prerollPackets[i].dts) > Number(prerollPackets[i - 1].dts));
console.log('PASS negative-timestamp preroll with cut and speed change');
// No-audio input and a second preparation/export in the same instance.
const silent = path.join(root, 'silent.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fixture, '-an', '-c:v', 'copy', silent]);
await editor.prepare({ arrayBuffer: async () => fs.readFile(silent) }, 6);
assert.equal(editor.info.hasAudio, false);
await editor.export([{ start: 1, end: 3, speed: 2 }]);
console.log('PASS silent input, repeated export, source replacement');
// Preserve a real one-second audio delay when the whole clip is sped up 2x.
const delayed = path.join(root, 'delayed.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fixture, '-itsoffset', '1', '-i', fixture,
  '-map', '0:v:0', '-map', '1:a:0', '-t', '6', '-c', 'copy', delayed]);
await editor.prepare({ arrayBuffer: async () => fs.readFile(delayed) }, 6);
const delayedOutput = path.join(root, 'delayed-edited.mp4');
await fs.writeFile(delayedOutput, new Uint8Array(await (await editor.export([{ start: 0, end: 6, speed: 2 }])).arrayBuffer()));
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', delayedOutput, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
function rms(from, to) {
  let square = 0;
  for (let i = Math.floor(from * 48000); i < to * 48000; i++) square += pcm.readFloatLE(i * 4) ** 2;
  return Math.sqrt(square / ((to - from) * 48000));
}
assert.ok(rms(0.1, 0.35) < 0.001, 'delayed audio remains silent initially');
assert.ok(rms(0.8, 1) > 0.02, 'delayed audio is present after the scaled delay');
console.log('PASS delayed audio synchronization');
// A failed export must not leave partial outputs or poison subsequent attempts.
const execute = client.exec;
client.exec = async args => args.includes('join.txt') ? 1 : execute(args);
await assert.rejects(() => editor.export([{ start: 0, end: 2, speed: 2 }]));
assert.ok(!core.FS.readdir('/').some(name => /^(part-|audio\.|output\.|join\.)/.test(name)));
client.exec = execute;
await editor.export([{ start: 0, end: 2, speed: 1 }]);
console.log('PASS failure cleanup and retry');
