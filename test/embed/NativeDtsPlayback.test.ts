import { afterEach, expect, it, vi } from 'vitest';

import { prepareNativeDtsPlayback } from 'webgpu-player/embed/NativeDtsPlayback';

vi.mock('mediabunny', async (original) => ({
    ...await original<typeof import('mediabunny')>(),
    Input: class {
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

afterEach(() => vi.unstubAllGlobals());

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
