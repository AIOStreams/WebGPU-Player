// Remux the original video and the selected audio track onto the same native media clock.
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import {
    AudioSample,
    AudioSampleSource,
    EncodedAudioPacketSource,
    EncodedVideoPacketSource,
    Input,
    MATROSKA,
    MP4,
    Mp4OutputFormat,
    NullTarget,
    Output,
    PacketReader,
    UrlSource,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack
} from 'mediabunny';

import { prepareCustomAudioOutputChannelData } from '../audio/processing/CustomAudioChannelLayout';
import PackageSoftwareAudioDecoder from '../decode/audio/PackageSoftwareAudioDecoder';
import { loadDecoderPackage, type AudioDecoderPackage } from '../decode/packages/DecoderPackage';
import { isDTSExpressTrack } from '../demux/CustomAudioTrackMetadata';
import { secondsToMicroseconds } from '../MediaTime';

const FLAC_MIME = 'audio/mp4; codecs="flac"';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(target: EventTarget, event: string, signal: AbortSignal, action?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const cleanup = (): void => {
            target.removeEventListener(event, success);
            target.removeEventListener('error', failure);
            signal.removeEventListener('abort', failure);
        };
        const success = (): void => {
            cleanup();
            resolve();
        };
        const failure = (): void => {
            cleanup();
            reject(signal.reason ?? new Error('Native media operation failed'));
        };
        target.addEventListener(event, success);
        target.addEventListener('error', failure);
        signal.addEventListener('abort', failure, { once: true });
        try {
            action?.();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

function fragmentOutput(buffer: SourceBuffer, element: HTMLVideoElement, signal: AbortSignal, appended: () => void) {
    let header: Uint8Array | null = null;
    let ready = Promise.resolve();
    const first = (data: Uint8Array): void => {
        header = data.slice();
    };
    const last = (data: Uint8Array): void => {
        if (!header) throw new Error('Missing MP4 fragment header');
        const fragment = new Uint8Array(header.byteLength + data.byteLength);
        fragment.set(header);
        fragment.set(data, header.byteLength);
        header = null;
        ready = ready.then(async () => {
            let quotaFull = false;
            for (;;) {
                signal.throwIfAborted();
                if (buffer.buffered.length && element.currentTime - buffer.buffered.start(0) > (quotaFull ? 2 : 4)) {
                    await waitFor(buffer, 'updateend', signal, () => buffer.remove(0, element.currentTime - (quotaFull ? 1 : 1.5)));
                }
                try {
                    await waitFor(buffer, 'updateend', signal, () => buffer.appendBuffer(fragment));
                    appended();
                    return;
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
                    quotaFull = true;
                    await sleep(150);
                }
            }
        });
        // The packet producer awaits the same promise after each write.
        void ready.catch(() => undefined);
    };
    const format = new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: 1,
        onFtyp: first,
        onMoov: last,
        onMoof: first,
        onMdat: last
    });
    return { output: new Output({ format, target: new NullTarget() }), ready: () => ready };
}

type AudioChoice = {
    track: InputAudioTrack;
    codec: NonNullable<Awaited<ReturnType<InputAudioTrack['getCodec']>>>;
    config: AudioDecoderConfig | null;
    channels: number;
    mime: string;
    language: string;
    title: string | null;
    isDefault: boolean;
};

async function audioChoice(track: InputAudioTrack): Promise<AudioChoice | null> {
    const [codec, config, language, title, disposition] = await Promise.all([
        track.getCodec(),
        track.getDecoderConfig(),
        track.getLanguageCode(),
        track.getName(),
        track.getDisposition()
    ]);
    if (!codec || isDTSExpressTrack(codec, config)) return null;
    const mime = codec === 'dts' ? FLAC_MIME : `audio/mp4; codecs="${config?.codec}"`;
    if (!MediaSource.isTypeSupported(mime)) return null;
    return {
        track,
        codec,
        config,
        mime,
        language,
        title,
        channels: await track.getNumberOfChannels(),
        isDefault: disposition.default
    };
}

let dtsPackage: Promise<AudioDecoderPackage> | undefined;
function loadDts(): Promise<AudioDecoderPackage> {
    dtsPackage ??= (async () => {
        const response = await fetch(new URL('../wgpud/dts.wasm', import.meta.url));
        if (!response.ok && response.status !== 0) throw new Error('DTS decoder unavailable');
        const pkg = await loadDecoderPackage(await response.arrayBuffer());
        if (pkg.kind !== 'audio') throw new Error('Invalid DTS decoder package');
        registerFlacEncoder();
        return pkg;
    })().catch((error) => {
        dtsPackage = undefined;
        throw error;
    });
    return dtsPackage;
}

type NativeSource = {
    video: InputVideoTrack;
    codec: NonNullable<Awaited<ReturnType<InputVideoTrack['getCodec']>>>;
    config: VideoDecoderConfig;
    duration: number;
    decoder: AudioDecoderPackage;
};

function flacSamples(flac: AudioSampleSource, start: number, outputLayout: 'stereo' | '5.1') {
    // Each AudioSample sent to the FLAC worker carries several DTS blocks.
    const channels = outputLayout === '5.1' ? 6 : 2;
    const capacity = 8192;
    const stereo = outputLayout === 'stereo';
    const pcm = stereo ? new Int16Array(capacity * channels) : new Float32Array(capacity * channels);
    let frames = 0;
    let rate = 0;
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
    type DecodedBlock = ReturnType<PackageSoftwareAudioDecoder['decode']>[number];
    const writeBlock = async (block: DecodedBlock): Promise<void> => {
        const time = block.mediaTimeMicroseconds / 1e6 - start;
        const planes = prepareCustomAudioOutputChannelData(block.channelData, block.channelLayout, outputLayout);
        const skip = Math.max(0, Math.round(-time * block.sampleRate));
        if (skip >= block.frameCount) return;
        if (
            frames
            && (rate !== block.sampleRate || Math.abs(time + skip / block.sampleRate - (timestamp + frames / rate)) > 0.002)
        ) { await flush(); }
        rate = block.sampleRate;
        for (let i = skip; i < block.frameCount; i++) {
            if (!frames) timestamp = Math.max(0, time + i / rate);
            for (let c = 0; c < channels; c++) {
                const sample = planes[c][i];
                pcm[frames * channels + c] = stereo ? Math.max(-32768, Math.min(32767, Math.round(sample * 32768))) : sample;
            }
            if (++frames === capacity) await flush();
        }
    };
    const writeBlocks = async (blocks: readonly DecodedBlock[]): Promise<void> => {
        for (const block of blocks) await writeBlock(block);
    };
    return { flush, writeBlocks };
}

// An epoch owns its muxers, decoder, SourceBuffers and object URL. A seek outside the buffer or an audio
// change starts at the preceding keyframe and keeps the original file's clock for subtitles and resume.
async function feedEpoch(
    element: HTMLVideoElement,
    source: NativeSource,
    audio: AudioChoice,
    target: number,
    session: { media: MediaSource; signal: AbortSignal; appended: () => void },
    outputLayout: 'stereo' | '5.1'
): Promise<void> {
    const { media, signal, appended } = session;
    const vr = new PacketReader(source.video);
    const ar = new PacketReader(audio.track);
    const key = (await vr.getKeyAt(target)) ?? (await vr.getFirstKey());
    if (!key) throw new Error('No video keyframe');
    const start = key.timestamp;
    const audioStart = (await ar.getAt(start)) ?? (await ar.getFirst());
    signal.throwIfAborted();
    media.duration = source.duration;
    const videoBuffer = media.addSourceBuffer(`video/mp4; codecs="${source.config.codec}"`);
    const audioBuffer = media.addSourceBuffer(audio.mime);
    videoBuffer.timestampOffset = start;
    audioBuffer.timestampOffset = start;
    element.currentTime = Math.max(start, target);
    const video = fragmentOutput(videoBuffer, element, signal, appended);
    const sound = fragmentOutput(audioBuffer, element, signal, appended);
    const picture = new EncodedVideoPacketSource(source.codec);
    video.output.addVideoTrack(picture);
    const flac = audio.codec === 'dts' ? new AudioSampleSource({ codec: 'flac' }) : null;
    const passthrough = flac ? null : new EncodedAudioPacketSource(audio.codec);
    sound.output.addAudioTrack(flac ?? passthrough!);
    let decoder: PackageSoftwareAudioDecoder | undefined;
    const throttle = async (timestamp: number): Promise<void> => {
        while (timestamp > Math.max(target, element.currentTime) + 4.5) {
            signal.throwIfAborted();
            await sleep(75);
        }
        signal.throwIfAborted();
    };
    try {
        if (flac) decoder = await PackageSoftwareAudioDecoder.create(source.decoder, 'dts', null);
        await Promise.all([video.output.start(), sound.output.start()]);
        let nextVideo: EncodedPacket | null = key;
        const writeVideo = async (end: number): Promise<void> => {
            while (nextVideo && nextVideo.timestamp < end) {
                signal.throwIfAborted();
                const packet: EncodedPacket = nextVideo;
                await picture.add(
                    packet.clone({ timestamp: packet.timestamp - start }),
                    packet === key ? { decoderConfig: source.config } : undefined
                );
                nextVideo = await vr.getNext(packet);
            }
            await video.ready();
        };
        const samples = flac ? flacSamples(flac, start, outputLayout) : null;
        let nextAudio = audioStart;
        const writeAudio = async (end: number): Promise<void> => {
            while (nextAudio && nextAudio.timestamp < end) {
                signal.throwIfAborted();
                const packet: EncodedPacket = nextAudio;
                if (decoder && samples) {
                    await samples.writeBlocks(decoder.decode(packet.data, secondsToMicroseconds(packet.timestamp)));
                } else if (passthrough && packet.timestamp >= start) {
                    await passthrough.add(
                        packet.clone({ timestamp: packet.timestamp - start }),
                        audio.config ? { decoderConfig: audio.config } : undefined
                    );
                }
                nextAudio = await ar.getNext(packet);
            }
            await sound.ready();
        };
        let end = start;
        while (nextVideo || nextAudio) {
            end += 1;
            // Do not throttle a long GOP before its muxer emits the first complete fragment.
            if (videoBuffer.buffered.length && audioBuffer.buffered.length) await throttle(end - 1);
            await Promise.all([writeVideo(end), writeAudio(end)]);
        }
        if (decoder && samples) {
            await samples.writeBlocks(decoder.drain());
            await samples.flush();
        }
        await Promise.all([video.output.finalize(), sound.output.finalize()]);
        await Promise.all([video.ready(), sound.ready()]);
        signal.throwIfAborted();
        media.endOfStream();
        appended();
    } finally {
        decoder?.close();
        for (const mux of [video.output, sound.output]) if (mux.state === 'started') await mux.cancel().catch(() => undefined);
    }
}

export async function prepareNativeDtsPlayback(
    element: HTMLVideoElement,
    url: string,
    headers: Record<string, string> | undefined,
    owner: AbortSignal,
    onError: (error: unknown) => void
) {
    if (!('MediaSource' in globalThis && 'AudioContext' in globalThis && 'AbortController' in globalThis)) return null;
    const { MediaSource: NativeMediaSource, AudioContext: NativeAudioContext, AbortController: NativeAbortController } = globalThis;
    if (!NativeMediaSource.isTypeSupported(FLAC_MIME)) return null;
    const input = new Input({
        formats: [MATROSKA, MP4],
        source: new UrlSource(url, {
            requestInit: { headers },
            maxCacheSize: 12 * 1024 * 1024,
            getRetryDelay: () => null
        })
    });
    let epoch: AbortController | undefined;
    let objectURL: string | undefined;
    const release = (): void => {
        epoch?.abort();
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = undefined;
    };
    const destroy = (): void => {
        release();
        owner.removeEventListener('abort', destroy);
        input.dispose();
    };
    owner.addEventListener('abort', destroy, { once: true });
    let retained = false;
    try {
        owner.throwIfAborted();
        const video = await input.getPrimaryVideoTrack();
        if (!video) return null;
        const tracks = await Promise.all((await input.getAudioTracks()).map(audioChoice));
        const eligible = tracks.filter((track): track is AudioChoice => track !== null);
        if (!eligible.some((track) => track.codec === 'dts') || eligible.length !== tracks.length) return null;
        const [codec, config, duration] = await Promise.all([
            video.getCodec(),
            video.getDecoderConfig(),
            input.getDurationFromMetadata()
        ]);
        if (
            !codec
            || !config
            || !duration
            || !Number.isFinite(duration)
            || !MediaSource.isTypeSupported(`video/mp4; codecs="${config.codec}"`)
        ) { return null; }
        const source: NativeSource = { video, codec, config, duration, decoder: await loadDts() };
        owner.throwIfAborted();
        let selected = Math.max(
            0,
            eligible.findIndex((track) => track.isDefault)
        );
        // A webOS app with the built-in speakers has a stereo destination; only opt into 5.1 when the host can actually output it.
        let outputLayout: 'stereo' | '5.1' = 'stereo';
        const context = new NativeAudioContext();
        try {
            if (context.destination.maxChannelCount >= 6) outputLayout = '5.1';
        } finally {
            await context.close();
        }
        owner.throwIfAborted();
        let paused = !element.autoplay;
        let priming = true;
        const setPaused = (value: boolean): void => {
            paused = value;
            if (paused) element.pause();
            else if (!priming) void element.play().catch(() => undefined);
        };
        const start = (seconds: number, ordinal = selected): void => {
            const target = Math.max(0, Math.min(duration, seconds));
            if (!eligible[ordinal] || owner.aborted) return;
            release();
            selected = ordinal;
            epoch = new NativeAbortController();
            const { signal } = epoch;
            const media = new NativeMediaSource();
            priming = true;
            element.autoplay = false;
            const appended = (): void => {
                if (!priming || signal.aborted) return;
                const ranges = element.buffered;
                for (let i = 0; i < ranges.length; i++) {
                    if (ranges.start(i) <= target + 0.1 && ranges.end(i) >= Math.min(duration - 0.05, target + 2)) {
                        priming = false;
                        setPaused(paused);
                        return;
                    }
                }
                if (media.readyState === 'ended') {
                    priming = false;
                    setPaused(paused);
                }
            };
            objectURL = URL.createObjectURL(media);
            const open = waitFor(media, 'sourceopen', signal);
            element.src = objectURL;
            void open
                .then(() =>
                    feedEpoch(
                        element,
                        source,
                        eligible[ordinal],
                        target,
                        { media, signal, appended },
                        eligible[ordinal].channels > 2 ? outputLayout : 'stereo'
                    )
                )
                .catch((error) => {
                    if (!signal.aborted) {
                        epoch?.abort();
                        onError(error);
                    }
                });
        };
        retained = true;
        return {
            tracks: eligible.map((track) => ({
                label: track.title ?? '',
                language: track.language,
                codec: track.codec,
                default: track.isDefault
            })),
            selected: () => selected,
            start,
            setPaused,
            seek(seconds: number): void {
                for (let i = 0; i < element.buffered.length; i++) {
                    if (seconds >= element.buffered.start(i) && seconds < element.buffered.end(i)) {
                        element.currentTime = seconds;
                        return;
                    }
                }
                start(seconds);
            },
            destroy
        };
    } finally {
        if (!retained) destroy();
    }
}
