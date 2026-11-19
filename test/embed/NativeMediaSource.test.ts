// Two one-track muxers hold their last fragment until the next second or finalization.
// The media clock can advance only inside the intersection of the appended audio and video.
import { EncodedPacket, MATROSKA, type AudioSample, type IsobmffOutputFormatOptions, type VideoTrackMetadata } from 'mediabunny';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CUSTOM_STEREO_CHANNEL_LAYOUT } from 'webgpu-player/audio/processing/CustomAudioChannelLayout';
import { prepareNativeDtsPlayback } from 'webgpu-player/embed/NativeDtsPlayback';

type Span = [number, number];
const duration = 14;
const sampleRate = 48_000;
const packet = (time: number) => new EncodedPacket(new Uint8Array(1), 'key', time, 1);
const ranges = (spans: Span[]) => ({ length: spans.length, start: (i: number) => spans[i][0], end: (i: number) => spans[i][1] });
const fixture = { first: 0, end: duration, rotation: 0, quota: 'none' as 'none' | 'full' | 'recover' };
const metadata = vi.fn<(options: VideoTrackMetadata) => void>();
const soundEnd = vi.fn();
let rejections = 0;
let removals = 0;

class BufferDouble extends EventTarget {
    spans: Span[] = [];
    timestampOffset = 0;
    constructor(readonly video: boolean) { super(); }
    get buffered() { return ranges(this.spans); }
    appendBuffer(bytes: Uint8Array) {
        if (bytes.length) {
            const [a, b] = new Float64Array(bytes.buffer, bytes.byteOffset, 2);
            const start = a + this.timestampOffset;
            const end = b + this.timestampOffset;
            if (this.video && (fixture.quota === 'full' || (fixture.quota === 'recover' && this.spans.length && end - this.spans[0][0] > 6))) {
                rejections++;
                throw new DOMException('Full', 'QuotaExceededError');
            }
            const last = this.spans.at(-1);
            if (last && start <= last[1] + 1e-5) last[1] = Math.max(last[1], end);
            else this.spans.push([start, end]);
        }
        void Promise.resolve().then(() => this.dispatchEvent(new Event('updateend')));
    }
    remove(_start: number, end: number) {
        removals++;
        this.spans = this.spans.filter(s => s[1] > end).map(s => [Math.max(s[0], end), s[1]]);
        void Promise.resolve().then(() => this.dispatchEvent(new Event('updateend')));
    }
}

class MediaDouble extends EventTarget {
    static isTypeSupported(mime: string) { return !mime.includes('dts'); }
    buffers: BufferDouble[] = [];
    readyState = 'open';
    addSourceBuffer(mime: string) {
        const buffer = new BufferDouble(mime.startsWith('video/'));
        this.buffers.push(buffer);
        return buffer;
    }
    endOfStream() { this.readyState = 'ended'; }
    get joint(): Span[] {
        const [video, audio] = this.buffers;
        return (video?.spans ?? []).flatMap(([vs, ve]) => (audio?.spans ?? []).flatMap(([as, ae]): Span[] =>
            Math.min(ve, ae) > Math.max(vs, as) ? [[Math.max(vs, as), Math.min(ve, ae)]] : []));
    }
}

class MuxTrack {
    write!: (span: Span) => void;
    async add(sample: EncodedPacket | AudioSample) { this.write([sample.timestamp, sample.timestamp + sample.duration]); }
}

class MuxDouble {
    state = 'pending';
    private pending: Span | null = null;
    private video = false;
    constructor(private readonly options: { format: { options: IsobmffOutputFormatOptions } }) {}
    private emit() {
        if (!this.pending) return;
        const format = this.options.format.options;
        format.onMoof!(new Uint8Array(), 0, 0);
        format.onMdat!(new Uint8Array(new Float64Array(this.pending).buffer), 0);
        this.pending = null;
    }
    private connect(track: MuxTrack) {
        track.write = ([start, end]) => {
            if (this.pending && (start - this.pending[0] >= 1 - 1e-5 || start > this.pending[1] + 1e-5)) this.emit();
            this.pending = this.pending ? [this.pending[0], end] : [start, end];
        };
    }
    addVideoTrack(track: MuxTrack, options: VideoTrackMetadata) {
        this.video = true;
        metadata(options);
        this.connect(track);
    }
    addAudioTrack(track: MuxTrack) { this.connect(track); }
    async start() { this.state = 'started'; }
    async finalize() {
        this.emit();
        this.state = 'finalized';
        if (!this.video) soundEnd();
    }
    async cancel() { this.state = 'canceled'; }
}

vi.mock('mediabunny', async (original) => ({
    ...await original<typeof import('mediabunny')>(),
    Input: class {
        getPrimaryVideoTrack() {
            return { video: true, getCodec: () => 'avc', getDecoderConfig: () => ({ codec: 'avc1' }), getRotation: () => fixture.rotation };
        }
        getAudioTracks() {
            return ['dts', 'aac'].map(codec => ({
                getCodec: () => codec, getDecoderConfig: () => ({ codec: codec === 'aac' ? 'mp4a.40.2' : 'dtsl' }),
                getLanguageCode: () => 'eng', getName: () => null, getDisposition: () => ({ default: codec === 'dts' }),
                getNumberOfChannels: () => 2, getSampleRate: () => sampleRate
            }));
        }
        getFormat() { return MATROSKA; }
        getDurationFromMetadata() { return duration; }
        dispose = vi.fn();
    },
    PacketReader: class {
        constructor(private track: { video?: boolean }) {}
        getFirstKey() { return packet(0); }
        getKeyAt(t: number) { return packet(Math.floor(t)); }
        getFirst() { return packet(this.track.video ? 0 : fixture.first); }
        getAt(t: number) { return t < fixture.first ? null : packet(Math.min(fixture.end - 1, Math.floor(t))); }
        getNext(p: EncodedPacket) {
            const end = this.track.video ? duration : fixture.end;
            return p.timestamp + 1 < end ? packet(p.timestamp + 1) : null;
        }
    },
    Output: class { constructor(options: ConstructorParameters<typeof MuxDouble>[0]) { return new MuxDouble(options); } },
    Mp4OutputFormat: class { constructor(readonly options: IsobmffOutputFormatOptions) {} },
    get AudioSampleSource() { return MuxTrack; },
    get EncodedVideoPacketSource() { return MuxTrack; },
    get EncodedAudioPacketSource() { return MuxTrack; }
}));
vi.mock('webgpu-player/decode/packages/DecoderPackage', () => ({ loadDecoderPackage: () => ({ kind: 'audio' }) }));
vi.mock('@mediabunny/flac-encoder', () => ({ registerFlacEncoder: vi.fn() }));
vi.mock('webgpu-player/decode/audio/PackageSoftwareAudioDecoder', () => ({
    default: { create: () => ({
        decode: (_: Uint8Array, time: number) => [{
            channelData: [new Float32Array(sampleRate).fill(0.25), new Float32Array(sampleRate).fill(0.25)],
            channelLayout: CUSTOM_STEREO_CHANNEL_LAYOUT, frameCount: sampleRate, mediaTimeMicroseconds: time, sampleRate
        }],
        drain: () => [], close: vi.fn(), setRenderTarget: vi.fn()
    }) }
}));

let media: MediaDouble;
beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(fixture, { first: 0, end: duration, rotation: 0, quota: 'none' });
    rejections = removals = 0;
    vi.stubGlobal('MediaSource', MediaDouble);
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL(object: MediaSource | Blob) {
            media = object as unknown as MediaDouble;
            void Promise.resolve().then(() => media.dispatchEvent(new Event('sourceopen')));
            return 'blob:test';
        }
        static readonly revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('__WEBGPU_PLAYER_DECODER_PACKAGES__', { dts: 'digest' });
    vi.stubGlobal('fetch', () => new Response(new Uint8Array()));
    vi.stubGlobal('AudioContext', class { destination = { maxChannelCount: 2 }; close = vi.fn(); });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function run(ordinal = 0) {
    // eslint-disable-next-line compat/compat -- The native playback path requires AbortController.
    const owner = new AbortController();
    const element = document.createElement('video');
    element.autoplay = true;
    Object.defineProperty(element, 'buffered', { get: () => ranges(media.joint) });
    const play = vi.spyOn(element, 'play').mockResolvedValue();
    const failed = vi.fn();
    try {
        const player = await prepareNativeDtsPlayback(element, 'https://example.test/movie.mkv', {}, owner.signal, failed);
        expect(player).not.toBeNull();
        player!.start(0, ordinal);
        for (let tick = 0; tick < 210 && !failed.mock.calls.length && element.currentTime < duration; tick++) {
            await vi.advanceTimersByTimeAsync(100);
            const span = media.joint.find(([start, end]) => start <= element.currentTime + 1e-5 && end > element.currentTime);
            if (play.mock.calls.length && span) element.currentTime = Math.min(span[1], element.currentTime + 0.125);
        }
        return { errors: failed.mock.calls, played: play.mock.calls.length, time: element.currentTime, ended: media.readyState === 'ended' };
    } finally {
        owner.abort();
    }
}

it.each([{ first: 2, end: duration }, { first: 0, end: 4 }])('plays video to EOF with DTS from $first to $end', async span => {
    Object.assign(fixture, span);
    expect(await run()).toMatchObject({ errors: [], ended: true, time: duration });
    expect(soundEnd).toHaveBeenCalledOnce();
});
it.each([{ first: 2, end: duration }, { first: 0, end: 4 }])('signals fallback for passthrough audio from $first to $end', async span => {
    Object.assign(fixture, span);
    expect((await run(1)).errors).toHaveLength(1);
    if (span.first === 0) expect(soundEnd).toHaveBeenCalledOnce();
});
it('rejects a fragment that never fits during priming', async () => {
    fixture.quota = 'full';
    expect((await run()).errors).toHaveLength(1);
    expect(rejections).toBeLessThan(20);
});
it('resumes appending when the clock advances and the back buffer can be freed', async () => {
    fixture.quota = 'recover';
    expect(await run()).toMatchObject({ errors: [], ended: true, time: duration });
    expect(removals).toBeGreaterThan(0);
    expect(rejections).toBeGreaterThan(0);
});
it('passes the input rotation to the video muxer', async () => {
    fixture.rotation = 90;
    await run();
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ rotation: 90 }));
});
