import { AudioSample, type AudioSampleSource } from 'mediabunny';

import { prepareCustomAudioOutputChannelData } from '../audio/processing/CustomAudioChannelLayout';
import type { PackageDecodedAudioOutput } from '../decode/audio/PackageSoftwareAudioDecoder';

export function flacSamples(flac: Pick<AudioSampleSource, 'add'>, start: number, outputLayout: 'stereo' | '5.1') {
    // Each AudioSample sent to the FLAC worker carries several decoded blocks.
    const channels = outputLayout === '5.1' ? 6 : 2;
    const capacity = 8192;
    const stereo = outputLayout === 'stereo';
    // Use 16-bit FLAC for the stereo downmix and preserve up to 24 bits for multichannel output.
    const pcm = stereo ? new Int16Array(capacity * channels) : new Float32Array(capacity * channels);
    let frames = 0;
    let rate = 0;
    let nextTime = 0;
    let timestamp = 0;
    const flush = async (): Promise<void> => {
        if (!frames) return;
        const sample = new AudioSample({
            data: pcm.slice(0, frames * channels),
            format: stereo ? 's16' : 'f32',
            sampleRate: rate,
            numberOfChannels: channels,
            timestamp
        });
        try {
            await flac.add(sample);
        } finally {
            sample.close();
        }
        frames = 0;
    };
    const writeBlock = async (block: PackageDecodedAudioOutput): Promise<void> => {
        const time = block.mediaTimeMicroseconds / 1e6 - start;
        const planes = prepareCustomAudioOutputChannelData(block.channelData, block.channelLayout, outputLayout);
        // Matroska timestamps can be rounded to milliseconds. Trim real overlap even across FLAC batches.
        const overlap = nextTime - time;
        const skip = Math.max(0, Math.round((overlap > 0.002 ? overlap : -time) * block.sampleRate));
        if (skip >= block.frameCount) return;
        const first = time + skip / block.sampleRate;
        const gap = first > nextTime + 0.002;
        if (frames && (rate !== block.sampleRate || gap)) await flush();
        rate = block.sampleRate;
        const begin = gap ? first : nextTime;
        for (let i = skip; i < block.frameCount; i++) {
            if (!frames) timestamp = begin + (i - skip) / rate;
            for (let c = 0; c < channels; c++) {
                const sample = planes[c][i];
                pcm[frames * channels + c] = stereo ? Math.max(-32768, Math.min(32767, Math.round(sample * 32768))) : sample;
            }
            if (++frames === capacity) await flush();
        }
        nextTime = begin + (block.frameCount - skip) / rate;
    };
    const writeBlocks = async (blocks: readonly PackageDecodedAudioOutput[]): Promise<void> => {
        for (const block of blocks) await writeBlock(block);
    };
    return { flush, writeBlocks };
}
