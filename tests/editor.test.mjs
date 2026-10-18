import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestBoundary, parseKeyframes, validateSegments, outputDuration, outputTimeline, mergeAdjacent, audioFilter } from '../docs/editor.js';

test('snap to nearest keyframe; ties prefer earlier boundary', () => {
  assert.equal(nearestBoundary(1.6, [0, 1, 2, 6]), 2);
  assert.equal(nearestBoundary(1.5, [0, 1, 2, 6]), 1);
});

test('parse real packet timestamps, including negative B-frame DTS', () => {
  assert.deepEqual(parseKeyframes('#tb 0: 1/30\n0, -2, 0, 1, 8, 0x1\n0, 28, 30, 1, 8, 0x2\n', 2),
    { boundaries: [0, 1, 2], decodeLead: 2 / 30 });
  assert.throws(() => parseKeyframes('#tb 0: 1/30\n', 2));
});

test('MP4 preroll is a valid origin, including clips without another keyframe', () => {
  const header = '#tb 0: 1/30\n';
  assert.deepEqual(parseKeyframes(header + '0, -23, -21, 1, 8, 0x1\n0, 37, 39, 1, 8, 0x2\n', 2).boundaries,
    [0, 1.3, 2]);
  assert.deepEqual(parseKeyframes(header + '0, -23, -21, 1, 8, 0x1\n', 0.5).boundaries, [0, 0.5]);
  assert.throws(() => parseKeyframes(header + '0, 37, 39, 1, 8, 0x1\n', 2));
});

test('reject overlap, empty, unsnapped, zero length, invalid speed', () => {
  const a = { start: 0, end: 2, speed: 1 };
  const boundaries = [0, 1, 2, 3];
  for (const plan of [[], [a, { start: 1, end: 3, speed: 1 }],
    [{ ...a, start: 0.1 }], [{ ...a, end: 0 }], [{ ...a, speed: 0 }]]) {
    assert.throws(() => validateSegments(plan, boundaries));
  }
});

test('duration and coalescing preserve gaps and speed changes', () => {
  const plan = [{ start: 0, end: 1, speed: 1 }, { start: 1, end: 2, speed: 1 },
    { start: 2, end: 4, speed: 2 }, { start: 5, end: 6, speed: 2 }];
  assert.equal(outputDuration(plan), 3.5);
  assert.equal(mergeAdjacent(plan).length, 3);
  assert.equal(plan[0].end, 1);
  assert.match(audioFilter([{ start: 1, end: 3, speed: 4 }]), /atempo=2,atempo=2/);
});

test('edited positions accumulate kept ranges at their chosen speeds', () => {
  const plan = [{ start: 0, end: 10, speed: 1 }, { start: 20, end: 40, speed: 10 },
    { start: 50, end: 54, speed: 0.5 }];
  assert.deepEqual(outputTimeline(plan), [
    { start: 0, end: 10, duration: 10 }, { start: 10, end: 12, duration: 2 },
    { start: 12, end: 20, duration: 8 },
  ]);
  assert.equal(outputTimeline(plan).at(-1).end, outputDuration(plan));
  assert.deepEqual(outputTimeline([]), []);
  validateSegments([{ start: 0, end: 10, speed: 10 }], [0, 10]);
  assert.match(audioFilter([{ start: 0, end: 10, speed: 10 }]), /atempo=2,atempo=2,atempo=2,atempo=1.25/);
});
