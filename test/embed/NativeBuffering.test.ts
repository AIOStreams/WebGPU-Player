import { expect, it } from 'vitest';

import { canWaitForPlayback, hasStartupBuffer } from 'webgpu-player/embed/NativeBuffering';

const bufferedTo = (seconds: number) => ({ buffered: { length: 1, start: () => 0, end: () => seconds } });

it('continues demuxing until both track muxers have supplied the native player', () => {
    // The decoder has reached 8 s, but the video muxer needs the 12 s keyframe to release the GOP that begins at 3 s.
    expect(canWaitForPlayback(8, 2.7, bufferedTo(3), bufferedTo(7))).toBe(false);
    expect(canWaitForPlayback(8, 2.7, bufferedTo(12), bufferedTo(3))).toBe(false);
    expect(canWaitForPlayback(12, 2.7, bufferedTo(12), bufferedTo(7))).toBe(true);
    expect(canWaitForPlayback(7, 2.7, bufferedTo(12), bufferedTo(7))).toBe(false);
    expect(canWaitForPlayback(12, 2.7, bufferedTo(12), null)).toBe(true);
});

it('primes around the effective first keyframe when audio starts before video', () => {
    const buffered = { length: 1, start: () => 0.3, end: () => 2.3 };
    expect(hasStartupBuffer({ buffered, currentTime: 0 }, 12)).toBe(false);
    expect(hasStartupBuffer({ buffered, currentTime: 0.3 }, 12)).toBe(true);
    expect(hasStartupBuffer({ buffered, currentTime: 0.6 }, 12)).toBe(false);
});

it('requires a contiguous reserve covering the playhead for each active track', () => {
    const hole = { buffered: { length: 2, start: (i: number) => [0, 4][i], end: (i: number) => [2.1, 9][i] } };
    expect(canWaitForPlayback(9, 2, hole, bufferedTo(9))).toBe(false);
    expect(canWaitForPlayback(9, 2.5, bufferedTo(9), hole)).toBe(false);
    expect(canWaitForPlayback(10, 3.95, bufferedTo(9), hole)).toBe(true);
});
