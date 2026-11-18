import { expect, it } from 'vitest';

import { canWaitForPlayback } from 'webgpu-player/embed/NativeBuffering';

const bufferedTo = (seconds: number) => ({ buffered: { length: 1, start: () => 0, end: () => seconds } });

it('continues demuxing until both track muxers have supplied the native player', () => {
    // The decoder has reached 8 s, but the video muxer needs the 12 s keyframe to release the GOP that begins at 3 s.
    expect(canWaitForPlayback(8, 2.7, bufferedTo(3), bufferedTo(7))).toBe(false);
    expect(canWaitForPlayback(8, 2.7, bufferedTo(12), bufferedTo(3))).toBe(false);
    expect(canWaitForPlayback(12, 2.7, bufferedTo(12), bufferedTo(7))).toBe(true);
    expect(canWaitForPlayback(7, 2.7, bufferedTo(12), bufferedTo(7))).toBe(false);
    expect(canWaitForPlayback(12, 2.7, bufferedTo(12), null)).toBe(true);
});
