// Remux the original video and the selected audio track onto the same native media clock.
import { registerFlacEncoder } from '@mediabunny/flac-encoder';
import {
    AudioSampleSource,
    EncodedAudioPacketSource,
    EncodedVideoPacketSource,
    getDolbyVisionHevcCodec,
    Input,
    MATROSKA,
    MP4,
    MPEG_TS,
    Mp4OutputFormat,
    NullTarget,
    Output,
    PacketReader,
    QTFF,
    UrlSource,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack
} from 'mediabunny';

import { isSupportedTrueHDInputRoute } from '../audio/CustomCompressedAudioRoute';
import { getCustomAudioOutputChannelMask } from '../audio/processing/CustomWaveChannelLayout';
import PackageSoftwareAudioDecoder from '../decode/audio/PackageSoftwareAudioDecoder';
import { loadDecoderPackage, type AudioDecoderPackage } from '../decode/packages/DecoderPackage';
import {
    DTS_SEEK_PREROLL_MICROSECONDS,
    getAudioPrerollTimeMicroseconds,
    getAudioStartPacket,
    TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS
} from '../demux/AudioStartPacket';
import { MediaHTTPError } from '../demux/MediaFetchPolicy';
import { isDTSExpressTrack } from '../demux/CustomAudioTrackMetadata';
import { readPlaybackTimelineOriginMicroseconds } from '../demux/PlaybackTimelineOrigin';
import { microsecondsToSeconds, secondsToMicroseconds } from '../MediaTime';
import { decoderPackageURL, hasDecoderPackage } from './DecoderPackageAssets';
import { flacSamples } from './NativeFlacSamples';
import { canWaitForPlayback, hasStartupBuffer } from './NativeBuffering';
import type { ContainerSubtitleBlock } from '../pipeline/DecodeWorkerProtocol';

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

type SoftwareCodec = 'dts' | 'truehd';
const seekPreroll = {
    dts: DTS_SEEK_PREROLL_MICROSECONDS,
    truehd: TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS,
    passthrough: 0
};

type AudioChoice = {
    softwareCodec: SoftwareCodec | null;
    track: InputAudioTrack;
    codec: NonNullable<Awaited<ReturnType<InputAudioTrack['getCodec']>>>;
    config: AudioDecoderConfig | null;
    channels: number;
    mime: string;
    language: string;
    title: string | null;
    isDefault: boolean;
};

async function audioChoice(track: InputAudioTrack, element: HTMLVideoElement): Promise<AudioChoice | null> {
    const [codec, config, language, title, disposition] = await Promise.all([
        track.getCodec(),
        track.getDecoderConfig(),
        track.getLanguageCode(),
        track.getName(),
        track.getDisposition()
    ]);
    if (!codec || isDTSExpressTrack(codec, config)) return null;
    const nativeMime = `audio/mp4; codecs="${config?.codec}"`;
    const canPass = !!config && MediaSource.isTypeSupported(nativeMime);
    const channels = await track.getNumberOfChannels();
    let softwareCodec: SoftwareCodec | null = null;
    if (codec === 'dts' && (!canPass || !element.canPlayType('audio/mp4; codecs="dtsl"'))) softwareCodec = codec;
    if (codec === 'truehd' && (!canPass || !element.canPlayType('audio/mp4; codecs="mlpa"'))) {
        if (!isSupportedTrueHDInputRoute(codec, channels, await track.getSampleRate())) return null;
        softwareCodec = codec;
    }
    if (softwareCodec && !hasDecoderPackage(softwareCodec)) return null;
    const mime = softwareCodec ? FLAC_MIME : nativeMime;
    if (!softwareCodec && !canPass) return null;
    return {
        track,
        codec,
        config,
        mime,
        language,
        title,
        channels,
        softwareCodec,
        isDefault: disposition.default
    };
}

const decoderPackages: Partial<Record<SoftwareCodec, Promise<AudioDecoderPackage>>> = {};
function loadAudioDecoder(codec: SoftwareCodec): Promise<AudioDecoderPackage> {
    decoderPackages[codec] ??= (async () => {
        const response = await fetch(decoderPackageURL(codec));
        if (!response.ok && response.status !== 0) throw new Error(`${codec} decoder unavailable`);
        const pkg = await loadDecoderPackage(await response.arrayBuffer());
        if (pkg.kind !== 'audio') throw new Error(`Invalid ${codec} decoder package`);
        registerFlacEncoder();
        return pkg;
    })().catch((error) => {
        delete decoderPackages[codec];
        throw error;
    });
    return decoderPackages[codec];
}

type NativeSource = {
    video: InputVideoTrack;
    codec: NonNullable<Awaited<ReturnType<InputVideoTrack['getCodec']>>>;
    config: VideoDecoderConfig;
    videoMime: string;
    dolbyVisionConfig?: Uint8Array;
    duration: number;
    origin: number;
};

function nativeVideoFormat(video: InputVideoTrack, codec: NativeSource['codec'], config: VideoDecoderConfig) {
    const record = codec === 'hevc' ? video.getDolbyVisionConfig() : null;
    if (record) {
        const dvCodec = getDolbyVisionHevcCodec(record);
        const videoMime = `video/mp4; codecs="${dvCodec}"`;
        if (dvCodec && MediaSource.isTypeSupported(videoMime)) return { videoMime, dolbyVisionConfig: record };
    }
    const videoMime = `video/mp4; codecs="${config.codec}"`;
    return MediaSource.isTypeSupported(videoMime) ? { videoMime } : null;
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
    const key = (await vr.getKeyAt(target + source.origin)) ?? (await vr.getFirstKey());
    if (!key) throw new Error('No video keyframe');
    const start = key.timestamp;
    const origin = secondsToMicroseconds(source.origin);
    const lookup = getAudioPrerollTimeMicroseconds(secondsToMicroseconds(start), seekPreroll[audio.softwareCodec ?? 'passthrough'], origin);
    const audioStart = await getAudioStartPacket(ar, lookup, origin);
    signal.throwIfAborted();
    media.duration = source.duration;
    const videoBuffer = media.addSourceBuffer(source.videoMime);
    const audioBuffer = media.addSourceBuffer(audio.mime);
    const playbackStart = start - source.origin;
    videoBuffer.timestampOffset = playbackStart;
    audioBuffer.timestampOffset = playbackStart;
    element.currentTime = Math.max(playbackStart, target);
    const video = fragmentOutput(videoBuffer, element, signal, appended);
    const sound = fragmentOutput(audioBuffer, element, signal, appended);
    const picture = new EncodedVideoPacketSource(source.codec);
    video.output.addVideoTrack(picture, { dolbyVisionConfig: source.dolbyVisionConfig });
    const flac = audio.softwareCodec ? new AudioSampleSource({ codec: 'flac' }) : null;
    const passthrough = flac ? null : new EncodedAudioPacketSource(audio.codec);
    sound.output.addAudioTrack(flac ?? passthrough!);
    let decoder: PackageSoftwareAudioDecoder | undefined;
    try {
        if (audio.softwareCodec) {
            const pkg = await loadAudioDecoder(audio.softwareCodec);
            signal.throwIfAborted();
            decoder = await PackageSoftwareAudioDecoder.create(pkg, audio.softwareCodec, null);
            decoder.setRenderTarget({ channelMask: getCustomAudioOutputChannelMask(outputLayout), binaural: false });
        }
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
            signal.throwIfAborted();
            const position = Math.max(target, element.currentTime);
            if (canWaitForPlayback(end - source.origin, position, nextVideo && videoBuffer, nextAudio && audioBuffer)) {
                await sleep(75);
                continue;
            }
            end += 1;
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
    onError: (error: unknown) => void,
    onSubtitleBlocks?: (blocks: readonly ContainerSubtitleBlock[]) => void
) {
    if (!('MediaSource' in globalThis && 'AudioContext' in globalThis && 'AbortController' in globalThis)) return null;
    const { MediaSource: NativeMediaSource, AudioContext: NativeAudioContext, AbortController: NativeAbortController } = globalThis;
    if (!NativeMediaSource.isTypeSupported(FLAC_MIME)) return null;
    let retained = false;
    let retries = 0;
    const urlSource = new UrlSource(url, {
        requestInit: { headers },
        maxCacheSize: 12 * 1024 * 1024,
        async fetchFn(input, init) {
            const response = await fetch(input, init);
            if (!response.ok && retained) {
                const error = new MediaHTTPError(response.status);
                if (error.retryable) {
                    void response.body?.cancel().catch(() => undefined);
                    throw error;
                }
            }
            return response;
        },
        getRetryDelay(attempt) {
            // A broken response body can restart at the same byte, resetting Mediabunny's attempt count.
            if (!retained || owner.aborted || attempt > 2 || retries >= 2) return null;
            return 0.25 * 2 ** retries++;
        }
    });
    urlSource.on('read', ({ start, end }) => {
        if (end > start) retries = 0;
    });
    const input = new Input({
        formats: [MATROSKA, MP4, QTFF, MPEG_TS],
        formatOptions: onSubtitleBlocks ? {
            matroska: {
                onOtherTrackBlock(block) {
                    if (owner.aborted) return;
                    onSubtitleBlocks([{
                        trackNumber: block.trackNumber,
                        timestampMs: block.timestamp * 1000,
                        durationMs: block.duration === null ? null : block.duration * 1000,
                        // The demuxer's view can retain an entire 4K cluster.
                        data: block.data.slice()
                    }]);
                }
            }
        } : undefined,
        source: urlSource
    });
    let epoch: AbortController | undefined;
    let objectURL: string | undefined;
    let paused = true;
    let priming = true;
    const release = (): void => {
        epoch?.abort();
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = undefined;
    };
    const destroy = (): void => {
        if (epoch) element.autoplay = priming ? !paused : !element.paused;
        retained = false;
        release();
        epoch = undefined;
        owner.removeEventListener('abort', destroy);
        input.dispose();
    };
    owner.addEventListener('abort', destroy, { once: true });
    try {
        owner.throwIfAborted();
        const video = await input.getPrimaryVideoTrack();
        if (!video) return null;
        const tracks = await Promise.all((await input.getAudioTracks()).map((track) => audioChoice(track, element).catch(() => null)));
        if (!tracks.some((track) => track?.softwareCodec)) return null;
        const isTransportStream = await input.getFormat() === MPEG_TS;
        if (isTransportStream && await input.source.getSizeOrNull() === null) return null;
        const playableTracks = [video, ...tracks.flatMap((audio) => audio ? [audio.track] : [])];
        const [codec, config, end, originTime] = await Promise.all([
            video.getCodec(),
            video.getDecoderConfig(),
            isTransportStream ? input.computeDuration(playableTracks, { skipLiveWait: true }) : input.getDurationFromMetadata(),
            readPlaybackTimelineOriginMicroseconds(input, playableTracks)
        ]);
        const origin = microsecondsToSeconds(originTime);
        const duration = (end ?? 0) - origin;
        if (!codec || !config || !Number.isFinite(duration) || duration <= 0) return null;
        const format = nativeVideoFormat(video, codec, config);
        if (!format) return null;
        const source: NativeSource = { video, codec, config, duration, origin, ...format };
        owner.throwIfAborted();
        let selected = tracks.findIndex((track) => track?.isDefault);
        if (selected < 0) selected = tracks.findIndex((track) => track !== null);
        // A webOS app with the built-in speakers has a stereo destination; only opt into 5.1 when the host can actually output it.
        let outputLayout: 'stereo' | '5.1' = 'stereo';
        const context = new NativeAudioContext();
        try {
            if (context.destination.maxChannelCount >= 6) outputLayout = '5.1';
        } finally {
            await context.close();
        }
        owner.throwIfAborted();
        paused = !element.autoplay;
        const setPaused = (value: boolean): void => {
            paused = value;
            if (paused) element.pause();
            else if (!priming) void element.play().catch(() => undefined);
        };
        const start = (seconds: number, ordinal = selected): void => {
            const target = Math.max(0, Math.min(duration, seconds));
            const audio = tracks[ordinal];
            if (!audio || owner.aborted) return;
            if (epoch && !priming) paused = element.paused;
            const rate = element.playbackRate;
            release();
            selected = ordinal;
            epoch = new NativeAbortController();
            const { signal } = epoch;
            const media = new NativeMediaSource();
            priming = true;
            element.autoplay = false;
            const appended = (): void => {
                if (!priming || signal.aborted) return;
                if (hasStartupBuffer(element, duration) || media.readyState === 'ended') {
                    priming = false;
                    setPaused(paused);
                }
            };
            objectURL = URL.createObjectURL(media);
            const open = waitFor(media, 'sourceopen', signal);
            element.src = objectURL;
            void open
                .then(() => {
                    signal.throwIfAborted();
                    if (element.playbackRate === element.defaultPlaybackRate) element.playbackRate = rate;
                    return feedEpoch(
                        element,
                        source,
                        audio,
                        target,
                        { media, signal, appended },
                        audio.channels > 2 ? outputLayout : 'stereo'
                    );
                })
                .catch((error) => {
                    if (!signal.aborted) {
                        epoch?.abort();
                        onError(error);
                    }
                });
        };
        retained = true;
        return {
            tracks: tracks.flatMap((track, ordinal) => track ? [{
                ordinal,
                label: track.title ?? '',
                language: track.language,
                codec: track.codec,
                default: track.isDefault
            }] : []),
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
