import type { AudioSample } from 'mediabunny';
import { expect, it } from 'vitest';

import { CUSTOM_STEREO_CHANNEL_LAYOUT } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';
import type { PackageDecodedAudioOutput } from 'webgpu-player/decode/audio/PackageSoftwareAudioDecoder';
import { flacSamples } from 'webgpu-player/embed/NativeFlacSamples';
import { secondsToMicroseconds } from 'webgpu-player/MediaTime';

function block(time: number, frameCount: number): PackageDecodedAudioOutput {
    return {
        channelData: [new Float32Array(frameCount).fill(1), new Float32Array(frameCount).fill(-1)],
        channelLayout: CUSTOM_STEREO_CHANNEL_LAYOUT,
        channelMask: 3,
        frameCount,
        mediaTimeMicroseconds: secondsToMicroseconds(time),
        objectCount: null,
        sampleRate: 48_000
    };
}

it('trims seek preroll and overlapping PCM across flushes while preserving a real gap', async () => {
    const written: { frames: number; startFrame: number }[] = [];
    const samples = flacSamples({ add: async (sample: AudioSample) => {
        written.push({ frames: sample.numberOfFrames, startFrame: Math.round(sample.timestamp * sample.sampleRate) });
        const pcm = new Int16Array(sample.numberOfFrames * 2);
        sample.copyTo(pcm, { planeIndex: 0 });
        expect(Array.from(pcm.slice(0, 2))).toEqual([32767, -32768]);
    } }, 1, 'stereo');
    await samples.writeBlocks([block(0.99, 960)]);
    await samples.flush();
    await samples.writeBlocks([block(1, 480), block(1.005, 480), block(1.0154, 480), block(1.05, 480)]);
    await samples.flush();
    expect(written).toEqual([{ frames: 480, startFrame: 0 }, { frames: 720, startFrame: 480 }, { frames: 480, startFrame: 2400 }]);
});
