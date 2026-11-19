import { MATROSKA, MPEG_TS, type InputFormat, type InputOptions } from 'mediabunny';
import { afterEach, expect, it, vi } from 'vitest';

import { prepareNativeDtsPlayback } from 'webgpu-player/embed/NativeDtsPlayback';

const opened = vi.fn<(options: InputOptions) => void>();
const getFormat = vi.fn<() => InputFormat>(() => MATROSKA);
const getSize = vi.fn<() => number | null>();
const getEndTime = vi.fn<() => number>();

vi.mock('mediabunny', async (original) => ({
    ...await original<typeof import('mediabunny')>(),
    Input: class {
        constructor(options: InputOptions) { opened(options); }

        getFormat = getFormat;
        source = { getSizeOrNull: getSize };
        computeDuration = getEndTime;
        getFirstTimestamp() { return 600; }

        getPrimaryVideoTrack() {
            return { getCodec: () => 'avc', getDecoderConfig: () => ({ codec: 'avc1.64001f' }) };
        }

        getAudioTracks() {
            return [
                ['vorbis', 'vorbis', 'ita'],
                ['truehd', 'mlpa', 'fra'],
                ['dts', 'dtsl', 'deu'],
                ['aac', 'mp4a.40.2', 'eng']
            ].map(([codec, config, language], index) => ({
                getCodec: () => codec,
                getDecoderConfig: () => ({ codec: config }),
                getLanguageCode: () => language,
                getName: () => null,
                getDisposition: () => ({ default: index === 0 }),
                getNumberOfChannels: () => 2,
                getSampleRate: () => 48_000
            }));
        }

        getDurationFromMetadata() { return 5; }
        dispose = vi.fn();
    }
}));
vi.mock('webgpu-player/decode/packages/DecoderPackage', () => ({
    loadDecoderPackage: () => ({ kind: 'audio' })
}));
vi.mock('@mediabunny/flac-encoder', () => ({ registerFlacEncoder: () => undefined }));

afterEach(() => {
    vi.unstubAllGlobals();
    getFormat.mockReset();
    getSize.mockReset();
    getEndTime.mockReset();
});

it('keeps the original audio ordinals when a native TV cannot play the default track', async () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: (mime: string) => !['mlpa', 'vorbis', 'dtsl'].some(codec => mime.includes(codec)) });
    vi.stubGlobal('AudioContext', class {
        destination = { maxChannelCount: 2 };
        close = vi.fn();
    });
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array()));
    // eslint-disable-next-line compat/compat -- The native DTS path requires AbortController.
    const owner = new AbortController();
    const video = document.createElement('video');
    try {
        const player = await prepareNativeDtsPlayback(video, 'https://example.test/movie.mkv', {}, owner.signal, vi.fn());
        expect(player?.tracks.map(({ ordinal, language }) => [ordinal, language])).toEqual([[1, 'fra'], [2, 'deu'], [3, 'eng']]);
        expect(player?.selected()).toBe(1);
        player?.start(0, 0);
        expect(player?.selected()).toBe(1);
        expect(video.hasAttribute('src')).toBe(false);
    } finally {
        owner.abort();
    }
});

it('leaves a natively supported source on the direct playback path', async () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    vi.stubGlobal('AudioContext', class {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    // eslint-disable-next-line compat/compat -- The native playback path requires AbortController.
    const owner = new AbortController();
    try {
        const video = document.createElement('video');
        vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
        const handle = await prepareNativeDtsPlayback(video, 'https://example.test/movie.mkv', {}, owner.signal, vi.fn());
        expect(handle).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    } finally {
        owner.abort();
    }
});

it('forwards timed subtitle bytes without retaining the cluster or dispatching after abort', async () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    vi.stubGlobal('AudioContext', class {
        destination = { maxChannelCount: 2 };
        close = vi.fn();
    });
    // eslint-disable-next-line compat/compat -- The native playback path requires AbortController.
    const owner = new AbortController();
    const subtitles = vi.fn();
    try {
        await prepareNativeDtsPlayback(document.createElement('video'), 'https://example.test/movie.mkv', {}, owner.signal, vi.fn(), subtitles);
        const report = opened.mock.lastCall![0].formatOptions?.matroska?.onOtherTrackBlock;
        expect(report).toBeTypeOf('function');
        const cluster = new Uint8Array([7, 8, 9]);
        const block = { trackNumber: 12, timestamp: 1.25, duration: 0.5, data: cluster.subarray(1, 2) };
        report!(block);
        report!({ ...block, duration: null });
        cluster.fill(0);
        const expected = { trackNumber: 12, timestampMs: 1250, durationMs: 500, data: new Uint8Array([8]) };
        expect(subtitles.mock.calls).toEqual([[[expected]], [[{ ...expected, durationMs: null }]]]);
        expect(subtitles.mock.calls[0][0][0].data.buffer.byteLength).toBe(1);
        owner.abort();
        report!(block);
        expect(subtitles).toHaveBeenCalledTimes(2);
    } finally {
        owner.abort();
    }
});

it('only reads the end of a finite transport stream and requires playable time after its program clock origin', async () => {
    getFormat.mockReturnValue(MPEG_TS);
    getSize.mockReturnValueOnce(null).mockReturnValue(188_000);
    getEndTime.mockReturnValueOnce(599).mockReturnValue(625);
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    vi.stubGlobal('AudioContext', class {
        destination = { maxChannelCount: 2 };
        close = vi.fn();
    });
    // eslint-disable-next-line compat/compat -- The native playback path requires AbortController.
    const owner = new AbortController();
    try {
        const video = document.createElement('video');
        const open = () => prepareNativeDtsPlayback(video, 'https://example.test/film.m2ts', {}, owner.signal, vi.fn());
        expect(await open()).toBeNull();
        expect(getEndTime).not.toHaveBeenCalled();
        expect(await open()).toBeNull();
        const player = await open();
        expect(opened.mock.lastCall?.[0].formats).toContain(MPEG_TS);
        expect(player?.tracks.map(({ codec }) => codec)).toContain('dts');
        expect(getEndTime).toHaveBeenCalledTimes(2);
    } finally {
        owner.abort();
    }
});
