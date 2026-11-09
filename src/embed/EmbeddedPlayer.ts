// The engine for a page that plays URLs without a media server's probe, built by scripts/build-embed.mjs into one module
// served beside the engine's assets and decoder packages, which it finds from its own URL.
import { CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE } from '../audio/CustomAudioOutputPolicy';
import CustomDecodeNativeAudioBridge from '../audio/native/CustomDecodeNativeAudioBridge';
import { selectCustomAudioOutputLayout, selectCustomAudioSpeakerLayout } from '../audio/NativeMultichannelAudioOutput';
import { prewarmBrowserAudioContext, type BrowserAudioContextPrewarmLease } from '../audio/output/BrowserAudioContextPrewarm';
import { createBrowserCustomAudioOutputFactory } from '../audio/output/BrowserCustomAudioOutput';
import { getWebGPUAudioOutputManager } from '../audio/output/WebGPUAudioOutputManager';
import { createDefaultAudioDownmixSettings } from '../audio/processing/CustomAudioDownmix';
import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from '../audio/processing/CustomAudioDownmixAlgorithm';
import { probeCustomDecodeCapabilities } from '../capability/CustomDecodeCapabilities';
import {
    getAudioMetadataLayout,
    getCustomPlaybackEligibility,
    type CustomAudioRenderTarget,
    type EligibleCustomPlayback
} from '../capability/CustomPlaybackEligibility';
import { getCustomPlaybackRuntimeAvailability } from '../capability/CustomPlaybackRuntime';
import { probeCachedNativeMediaAudioCapabilities } from '../capability/NativeMediaAudioCapabilities';
import { loadDecoderPackage, type AudioDecoderPackage, type VideoDecoderPackage } from '../decode/packages/DecoderPackage';
import { configureEngineAssets } from '../EngineAssets';
import { configureEngineFeatureFlags } from '../EngineConfiguration';
import type { Microseconds } from '../MediaTime';
import CustomPlaybackController from '../pipeline/CustomPlaybackController';
import type {
    CustomPlaybackControllerEvent,
    CustomPlaybackPlayOptions,
    CustomPlaybackStartResult,
    CustomPlaybackState
} from '../pipeline/CustomPlaybackControllerTypes';
import CustomPlaybackFrameLoop from '../pipeline/CustomPlaybackFrameLoop';
import {
    alignPresentationInputBitDepth,
    configurePresentationColorPipeline,
    createGPUVideoDecodeSessionFactory,
    getCustomPresentationEligibilityOptions,
    getGPUVideoDecoderOffers,
    getStaticHDRRenderSettings,
    isWebGPUPresentationInput,
    precompileGPUVideoDecoder,
    readPresentationInput,
    type HDRRenderConfiguration,
    type PresentationInput
} from '../presentation/PresentationSetup';
import { createHDRToSDRRenderSettings, HDR_RENDER_SETTING_RANGES } from '../presentation/RenderSettings';
import WebGPUPresenter, { type PresentationFallbackReason, type PresentationSurface } from '../presentation/WebGPUPresenter';
import canvasStyles from '../style.css';
import { requireMicroseconds } from '../TimeMath';
import { describeSource, type DescribedSource, type DescribedStream } from './DescribeSource';

// Defined by the build
declare const __WEBGPU_PLAYER_ASSET_KEY__: string;
declare const __WEBGPU_PLAYER_DECODER_PACKAGES__: readonly string[];

const DIRECT_PLAY_METHOD = 'DirectPlay';
const MICROSECONDS_PER_MILLISECOND = 1000;
const HIDDEN_DOCUMENT_STATE = 'hidden';
// Hosts the page plays from rarely expose Content-Range to it
const ANY_PATH = /^\//u;

configureEngineAssets({ baseURL: new URL('../', import.meta.url).href, cacheKey: __WEBGPU_PLAYER_ASSET_KEY__ });
configureEngineFeatureFlags({ isHDRToneMappingEnabled: (): Promise<boolean> => Promise.resolve(true) });
const canvasStyle = document.createElement('style');
canvasStyle.textContent = canvasStyles;
document.head.append(canvasStyle);

export type EmbeddedPlayerState = 'loading' | 'playing' | 'paused' | 'waiting' | 'ended';

export type EmbeddedPlayerEvents = Readonly<{
    onState(state: EmbeddedPlayerState): void
    onTime(ms: number): void
    onDuration(ms: number | null): void
    /** The engine gave up; the host plays the source its own way from `atMs`. */
    onFallback(reason: string, atMs: number): void
    onError(message: string): void
}>;

export type EmbeddedOpenRequest = Readonly<{
    url: string
    startMs: number
    paused: boolean
    /** Among the file's audio tracks; null takes the default. */
    audioOrdinal: number | null
    volume: number
    muted: boolean
    rate: number
}>;

export type EmbeddedAudioTrack = Readonly<{
    ordinal: number
    codec: string | null
    channels: number | null
    language: string | null
    title: string | null
    isDefault: boolean
}>;

export type EmbeddedOpenResult =
    | Readonly<{
        eligible: true
        audio: readonly EmbeddedAudioTrack[]
        audioOrdinal: number | null
        width: number | null
        height: number | null
        durationMs: number | null
        route: string
    }>
    | Readonly<{ eligible: false, reason: string }>;

export type EmbeddedStats = Readonly<{
    route: string
    video: DescribedStream | null
    audio: DescribedStream | null
    dolbyVisionProfile: number | null
    toneMapped: boolean
    audioOutputLayout: string | null
    audioObjects: number | null
    audioUnderflows: number
    framesPresented: number
    framesDropped: number
    framesLate: number
    videoAheadMs: number | null
    audioAheadMs: number | null
    clockMs: number
    presentedMs: number | null
}>;

export type EmbeddedPlayer = Readonly<{
    open(request: EmbeddedOpenRequest): Promise<EmbeddedOpenResult>
    play(): void
    pause(): void
    seek(ms: number): void
    setVolume(volume: number): void
    setMuted(muted: boolean): void
    setRate(rate: number): void
    /** Restarts the route at the clock. */
    setAudio(ordinal: number): Promise<EmbeddedOpenResult>
    /** Null before a frame shows. */
    presentedMs(): number | null
    /** Null while nothing plays. */
    stats(): EmbeddedStats | null
    destroy(): void
}>;

/** Each source is still checked as it opens. */
export function isEmbeddedPlayerSupported(): boolean {
    return getCustomPlaybackRuntimeAvailability(undefined, { audioOutput: true }).available;
}

function isPageVisible(): boolean {
    // eslint-disable-next-line compat/compat -- WebGPU playback is capability-gated
    return !(typeof document !== 'undefined' && document.visibilityState === HIDDEN_DOCUMENT_STATE);
}

const toMilliseconds = (time: Microseconds | number): number => time / MICROSECONDS_PER_MILLISECOND;
const toMicroseconds = (ms: number): Microseconds => requireMicroseconds(Math.max(0, Math.round(ms * MICROSECONDS_PER_MILLISECOND)));

type DecoderPackages = { audio: AudioDecoderPackage[], video: VideoDecoderPackage[] };
type LoadedPackage = AudioDecoderPackage | VideoDecoderPackage | null;

// By the codec names describeSource gives
const PACKAGE_OF_CODEC: Readonly<Record<string, string>> = {
    ac3: 'eac3',
    av1: 'av1',
    dts: 'dts',
    eac3: 'eac3',
    hevc: 'hevc',
    jpeg2000: 'jpeg2000',
    mlp: 'truehd',
    mpeg1video: 'mpeg2',
    mpeg2video: 'mpeg2',
    mpeg4: 'mpeg4',
    rawvideo: 'uncompressed',
    truehd: 'truehd',
    vc1: 'vc1',
    wmalossless: 'wma',
    wmapro: 'wma',
    wmav1: 'wma',
    wmav2: 'wma',
    wmv3: 'vc1'
};

const loadedPackages = new Map<string, Promise<LoadedPackage>>();

/** Null for a package that fails to load. */
function loadPackage(name: string): Promise<LoadedPackage> {
    let loading = loadedPackages.get(name);
    if (!loading) {
        loading = fetch(new URL(`../wgpud/${name}.wasm?v=${__WEBGPU_PLAYER_ASSET_KEY__}`, import.meta.url))
            .then(async (response: Response): Promise<LoadedPackage> => (response.ok ? loadDecoderPackage(await response.arrayBuffer()) : null))
            .catch((): null => null);
        loadedPackages.set(name, loading);
    }
    return loading;
}

async function packagesFor(source: DescribedSource): Promise<DecoderPackages> {
    const names = new Set(source.MediaStreams
        .map((stream: DescribedStream): string | undefined => PACKAGE_OF_CODEC[stream.Codec ?? ''])
        .filter((name: string | undefined): name is string => !!name && __WEBGPU_PLAYER_DECODER_PACKAGES__.includes(`${name}.wasm`)));
    const loaded = await Promise.all([ ...names ].map(loadPackage));
    return {
        audio: loaded.filter((loadedPackage: LoadedPackage): loadedPackage is AudioDecoderPackage => loadedPackage?.kind === 'audio'),
        video: loaded.filter((loadedPackage: LoadedPackage): loadedPackage is VideoDecoderPackage => loadedPackage?.kind === 'video')
    };
}

function automaticRenderConfiguration(detectedInputPeakNits: number): HDRRenderConfiguration {
    const defaults = createHDRToSDRRenderSettings();
    const range = HDR_RENDER_SETTING_RANGES.inputPeakNits;
    const inputPeakNits = Math.min(Math.max(detectedInputPeakNits, range.minimum), range.maximum);
    return {
        automaticInputPeakNits: true,
        settings: createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits, paperWhiteNits: Math.min(defaults.toneMapping.paperWhiteNits, inputPeakNits) }
        })
    };
}

function createPlayOptions(
    eligibility: EligibleCustomPlayback,
    startTimeMicroseconds: Microseconds,
    decodedAudio: boolean,
    target: CustomAudioRenderTarget
): CustomPlaybackPlayOptions {
    return {
        ...(eligibility.audioDecoder ? { audioDecoder: eligibility.audioDecoder } : {}),
        audioDownmixAlgorithm: decodedAudio ? DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM : undefined,
        audioDownmixSettings: decodedAudio ? createDefaultAudioDownmixSettings() : undefined,
        audioMetadataLayout: getAudioMetadataLayout(eligibility),
        audioOutputMode: eligibility.audioOutputMode ?? undefined,
        audioRendersObjects: decodedAudio ? eligibility.audioRendersObjects === true : undefined,
        audioTrackIndex: eligibility.audioTrackIndex,
        binauralHeadphones: decodedAudio ? target.binauralHeadphones : undefined,
        decodedAudioOutputLayout: decodedAudio ?
            selectCustomAudioOutputLayout(target.speakerLayout, eligibility.audioSourceChannelCount, eligibility.audioRendersObjects === true) :
            undefined,
        dolbyVisionProfile: eligibility.dolbyVisionProfile,
        durationMicroseconds: eligibility.durationMicroseconds,
        ...(eligibility.gpuVideoDecoder ? { gpuVideoDecoder: eligibility.gpuVideoDecoder } : {}),
        maximumCodedHeight: eligibility.maximumCodedHeight,
        maximumCodedWidth: eligibility.maximumCodedWidth,
        nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
        neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
        source: eligibility.source,
        startTimeMicroseconds,
        videoDecoderBackend: eligibility.videoDecoderBackend,
        videoOutputMode: eligibility.videoOutputMode,
        videoTrackIndex: eligibility.videoTrackIndex
    };
}

const STATES: Readonly<Partial<Record<CustomPlaybackState, EmbeddedPlayerState>>> = {
    ended: 'ended',
    paused: 'paused',
    playing: 'playing',
    seeking: 'loading',
    starting: 'loading'
};

const audioStreamsOf = (source: DescribedSource): DescribedStream[] => source.MediaStreams.filter((stream: DescribedStream): boolean => stream.Type === 'Audio');

function audioTracksOf(source: DescribedSource): EmbeddedAudioTrack[] {
    return audioStreamsOf(source).map((stream: DescribedStream, ordinal: number): EmbeddedAudioTrack => ({
        channels: stream.Channels,
        codec: stream.Codec,
        isDefault: stream.IsDefault,
        language: stream.Language,
        ordinal,
        title: stream.Title
    }));
}

function describeRoute(eligibility: EligibleCustomPlayback): string {
    const decoder = eligibility.gpuVideoDecoder ? ' gpu-package' : '';
    return `${eligibility.videoDecoderBackend} ${eligibility.videoOutputMode}${decoder}, audio ${eligibility.audioOutputMode ?? 'none'}`;
}

type Route = {
    audioPrewarm: BrowserAudioContextPrewarmLease | null
    controller: CustomPlaybackController | null
    eligibility: EligibleCustomPlayback | null
    frameLoop: CustomPlaybackFrameLoop | null
    input: PresentationInput | null
    options: unknown
    /** Names what a fallback's reason only classifies. */
    lastError: string | null
};

const withDetail = (route: Route, reason: string): string => (route.lastError ? `${reason}: ${route.lastError}` : reason);

type Opened = {
    request: EmbeddedOpenRequest
    source: DescribedSource
    route: Route | null
};

class RouteRefused extends Error {}

export function createEmbeddedPlayer(surface: PresentationSurface, events: EmbeddedPlayerEvents): EmbeddedPlayer {
    let generation = 0;
    let opened: Opened | null = null;
    let volume = 1;
    let muted = false;
    let rate = 1;

    const advance = (): number => {
        generation += 1;
        return generation;
    };

    const isCurrent = (route: Route, controller: CustomPlaybackController): boolean => (
        opened?.route === route && route.controller === controller
    );

    /** Returns where the route's clock stopped. */
    const stopRoute = (route: Route): number => {
        route.frameLoop?.destroy();
        route.frameLoop = null;
        const controller = route.controller;
        route.controller = null;
        presenter.endSession(advance());
        const atMs = controller ? toMilliseconds(controller.currentTimeMicroseconds) : 0;
        void controller?.destroy();
        route.audioPrewarm?.close().catch((): void => undefined);
        route.audioPrewarm = null;
        return atMs;
    };

    const fallBack = (route: Route, reason: string): void => {
        if (opened?.route !== route) {
            return;
        }
        const atMs = stopRoute(route);
        opened.route = null;
        events.onFallback(reason, atMs);
    };

    const handleStart = (route: Route, controller: CustomPlaybackController, result: CustomPlaybackStartResult): void => {
        if (!isCurrent(route, controller)) {
            return;
        }
        if (result.status === 'fallback') {
            fallBack(route, withDetail(route, result.fallbackReason ?? 'start-fallback'));
        } else if (result.status === 'started' && controller.playbackState === 'paused') {
            route.frameLoop?.schedule(false);
        }
    };

    const applyStaticHDRMetadata = (route: Route, metadata: Extract<CustomPlaybackControllerEvent, { type: 'static-hdr-metadata' }>['metadata']): void => {
        if (!route.input) {
            return;
        }
        const settings = getStaticHDRRenderSettings({
            createHDRRenderConfiguration: automaticRenderConfiguration,
            currentSettings: presenter.getRenderSettings(),
            eligibility: route.eligibility,
            input: route.input,
            metadata,
            options: route.options
        });
        if (settings) {
            presenter.updateRenderSettings(settings, generation, true);
        }
    };

    const handleStateChange = (route: Route, state: CustomPlaybackState): void => {
        const shown = STATES[state];
        if (shown) {
            events.onState(shown);
        }
        if (state === 'paused' || state === 'playing') {
            route.frameLoop?.cancel();
            route.frameLoop?.schedule(state === 'playing');
        }
    };

    const handleEvent = (route: Route, controller: CustomPlaybackController, event: CustomPlaybackControllerEvent): void => {
        if (!isCurrent(route, controller)) {
            return;
        }
        switch (event.type) {
            case 'statechange':
                handleStateChange(route, event.state);
                break;
            case 'ready':
                events.onDuration(event.durationMicroseconds === null ? null : toMilliseconds(event.durationMicroseconds));
                if (controller.playbackState === 'paused') {
                    route.frameLoop?.schedule(false);
                }
                break;
            case 'playing':
                events.onState('playing');
                route.frameLoop?.schedule(true);
                break;
            case 'waiting':
                events.onState('waiting');
                break;
            case 'timeupdate':
                events.onTime(toMilliseconds(event.currentTimeMicroseconds));
                break;
            case 'ended':
                route.frameLoop?.cancel();
                events.onState('ended');
                break;
            case 'error':
                route.lastError = event.message;
                if (!event.recoverable) {
                    events.onError(event.message);
                }
                break;
            case 'static-hdr-metadata':
                applyStaticHDRMetadata(route, event.metadata);
                break;
            default:
                break;
        }
    };

    const handlePresentationFallback = (fallbackGeneration: number, reason: PresentationFallbackReason, detail: string): void => {
        const route = opened?.route;
        if (route && fallbackGeneration === generation) {
            fallBack(route, `${reason}: ${detail}`);
        }
    };

    // Redraws a paused frame after a settings change by decoding it again
    const handleDecodedRefresh = (refreshGeneration: number): void => {
        const route = opened?.route;
        const controller = route?.controller;
        if (!route || !controller || refreshGeneration !== generation || controller.playbackState !== 'paused') {
            return;
        }
        const next = advance();
        route.frameLoop?.setPresentationGeneration(next);
        presenter.seek(next);
        presenter.setDecodedFramePushMode(true, next);
        controller.seek(controller.currentTimeMicroseconds).then(
            (result: CustomPlaybackStartResult): void => handleStart(route, controller, result),
            (): void => undefined
        );
    };

    const presenter = new WebGPUPresenter(handlePresentationFallback, handleDecodedRefresh);
    const gpuVideoDecodeSessionFactory = createGPUVideoDecodeSessionFactory(presenter, { slicing: false });
    const onVisibility = (): void => {
        opened?.route?.frameLoop?.synchronizePageVisibility(isPageVisible());
    };
    document.addEventListener('visibilitychange', onVisibility);

    /** Throws RouteRefused when the engine has no route for the source. */
    const chooseRoute = async (
        current: Opened,
        route: Route,
        routeGeneration: number,
        target: CustomAudioRenderTarget
    ): Promise<{ eligibility: EligibleCustomPlayback, input: PresentationInput }> => {
        const live = (): boolean => opened === current && current.route === route && generation >= routeGeneration;
        const ensureLive = (): void => {
            if (!live()) {
                throw new RouteRefused('superseded');
            }
        };
        const audioStream = audioStreamsOf(current.source)[current.request.audioOrdinal ?? -1];
        const mediaSource = { ...current.source, ...(audioStream ? { DefaultAudioStreamIndex: audioStream.Index } : {}) };
        const options = {
            mediaSource,
            playMethod: DIRECT_PLAY_METHOD,
            source: { hiddenContentRangePathPattern: ANY_PATH, kind: 'url', url: current.request.url }
        };
        route.options = options;
        const input = readPresentationInput(options);
        route.input = input;
        if (!isWebGPUPresentationInput(options, input, true)) {
            throw new RouteRefused('presentation-unavailable');
        }
        presenter.startSession(routeGeneration);
        const [ capabilities, nativeMediaAudioCapabilities, packages ] = await Promise.all([
            probeCustomDecodeCapabilities(mediaSource),
            probeCachedNativeMediaAudioCapabilities(),
            packagesFor(current.source)
        ]);
        ensureLive();
        const presentationOptions = await getCustomPresentationEligibilityOptions(presenter, {
            input,
            isCurrent: live,
            isHDRToneMappingEnabled: (): Promise<boolean> => Promise.resolve(true),
            options
        });
        ensureLive();
        if (!presentationOptions) {
            throw new RouteRefused('presentation-unavailable');
        }
        const gpuVideoDecoders = await getGPUVideoDecoderOffers(presenter, packages.video, options);
        ensureLive();
        const eligibility = getCustomPlaybackEligibility(options, capabilities, {
            ...presentationOptions,
            audioDecoders: packages.audio,
            audioRenderTarget: target,
            gpuVideoDecoders,
            nativeMediaAudioCapabilities,
            runtimeAvailability: getCustomPlaybackRuntimeAvailability()
        });
        if (!eligibility.eligible) {
            throw new RouteRefused(eligibility.reason);
        }
        return { eligibility, input };
    };

    const createController = (route: Route, hasAudio: boolean): CustomPlaybackController => {
        // Its callbacks may run before the constructor returns
        const created: { controller: CustomPlaybackController | null } = { controller: null };
        const controller = new CustomPlaybackController({
            audioOutputFactory: hasAudio ? createBrowserCustomAudioOutputFactory(route.audioPrewarm, getWebGPUAudioOutputManager()) : undefined,
            eventHandler: (event: CustomPlaybackControllerEvent): void => {
                if (created.controller) {
                    handleEvent(route, created.controller, event);
                }
            },
            fallbackHook: (request): void => {
                if (created.controller && isCurrent(route, created.controller)) {
                    fallBack(route, withDetail(route, request.reason));
                }
            },
            gpuVideoDecodeSessionFactory,
            nativeAudioBridgeFactory: hasAudio ? (): CustomDecodeNativeAudioBridge => new CustomDecodeNativeAudioBridge() : undefined
        });
        created.controller = controller;
        controller.setVolume(volume);
        controller.setMuted(muted);
        void controller.setPlaybackRate(rate);
        return controller;
    };

    /** Throws RouteRefused when the engine can't play the opened source. */
    const playRoute = async (current: Opened, route: Route, routeGeneration: number, startMs: number): Promise<EligibleCustomPlayback> => {
        const audioContext = route.audioPrewarm?.audioContext;
        const target: CustomAudioRenderTarget = {
            binauralHeadphones: false,
            speakerLayout: selectCustomAudioSpeakerLayout('auto', audioContext?.destination.maxChannelCount ?? null)
        };
        const { eligibility, input } = await chooseRoute(current, route, routeGeneration, target);
        void precompileGPUVideoDecoder(presenter, eligibility);
        const decodedAudio = eligibility.audioTrackIndex !== null && eligibility.audioOutputMode === 'decoded-pcm';
        if (!decodedAudio) {
            route.audioPrewarm?.close().catch((): void => undefined);
            route.audioPrewarm = null;
        }
        route.eligibility = eligibility;
        route.input = alignPresentationInputBitDepth(input, eligibility.rawVideoFrameFormat);
        presenter.setDecodedFramePushMode(true, routeGeneration);
        presenter.attach(surface, routeGeneration);
        const configured = await configurePresentationColorPipeline(presenter, {
            clearDetectedInputPeak: (): void => undefined,
            createHDRRenderConfiguration: automaticRenderConfiguration,
            dolbyVisionProfile: eligibility.dolbyVisionProfile,
            eligibility,
            generation: routeGeneration,
            input: route.input,
            options: route.options,
            rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
            videoOutputMode: eligibility.videoOutputMode
        });
        if (opened !== current || current.route !== route) {
            throw new RouteRefused('superseded');
        }
        if (!configured) {
            throw new RouteRefused('color-pipeline-unavailable');
        }
        const controller = createController(route, eligibility.audioTrackIndex !== null);
        route.controller = controller;
        const frameLoop = new CustomPlaybackFrameLoop({
            controller,
            isCurrent: (): boolean => isCurrent(route, controller),
            onFailure: (error: unknown): void => events.onError(`frame-presentation-failed: ${String(error)}`),
            presenter,
            presentationGeneration: routeGeneration
        });
        route.frameLoop = frameLoop;
        frameLoop.synchronizePageVisibility(isPageVisible());
        events.onState('loading');
        const result = await controller.play(createPlayOptions(eligibility, toMicroseconds(startMs), decodedAudio, target));
        if (!isCurrent(route, controller)) {
            throw new RouteRefused('superseded');
        }
        if (result.status === 'fallback') {
            throw new RouteRefused(withDetail(route, result.fallbackReason ?? 'start-fallback'));
        }
        handleStart(route, controller, result);
        if (current.request.paused) {
            controller.pause();
        }
        return eligibility;
    };

    const startRoute = async (current: Opened, startMs: number, audioPrewarm: BrowserAudioContextPrewarmLease): Promise<EmbeddedOpenResult> => {
        const route: Route = { audioPrewarm, controller: null, eligibility: null, frameLoop: null, input: null, lastError: null, options: null };
        current.route = route;
        try {
            const eligibility = await playRoute(current, route, advance(), startMs);
            const video = current.source.MediaStreams.find((stream: DescribedStream): boolean => stream.Type === 'Video');
            return {
                audio: audioTracksOf(current.source),
                audioOrdinal: eligibility.audioTrackIndex,
                durationMs: eligibility.durationMicroseconds === null ? null : toMilliseconds(eligibility.durationMicroseconds),
                eligible: true,
                height: video?.Height ?? null,
                route: describeRoute(eligibility),
                width: video?.Width ?? null
            };
        } catch (error) {
            if (current.route === route) {
                stopRoute(route);
                current.route = null;
            }
            const reason = error instanceof RouteRefused ? error.message : `route-start-failed: ${String(error)}`;
            return { eligible: false, reason };
        }
    };

    const stop = (): void => {
        if (opened?.route) {
            stopRoute(opened.route);
        }
        opened = null;
    };

    return {
        destroy: (): void => {
            stop();
            document.removeEventListener('visibilitychange', onVisibility);
            presenter.destroy();
        },
        open: async (request: EmbeddedOpenRequest): Promise<EmbeddedOpenResult> => {
            // Before the first await, while the page's activation still holds
            const audioPrewarm = prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE);
            stop();
            volume = request.volume;
            muted = request.muted;
            rate = request.rate;
            let source: DescribedSource;
            try {
                source = await describeSource(request.url);
            } catch (error) {
                audioPrewarm.close().catch((): void => undefined);
                return { eligible: false, reason: error instanceof Error ? error.message : String(error) };
            }
            const audio = audioTracksOf(source);
            const audioOrdinal = request.audioOrdinal ?? audio.find((track: EmbeddedAudioTrack): boolean => track.isDefault)?.ordinal ?? (audio.length ? 0 : null);
            const current: Opened = { request: { ...request, audioOrdinal }, route: null, source };
            opened = current;
            return startRoute(current, request.startMs, audioPrewarm);
        },
        pause: (): void => opened?.route?.controller?.pause(),
        play: (): void => opened?.route?.controller?.resume(),
        presentedMs: (): number | null => {
            const at = presenter.getLastPresentedMediaTime();
            return at === null ? null : toMilliseconds(at);
        },
        seek: (ms: number): void => {
            const route = opened?.route;
            const controller = route?.controller;
            if (!route || !controller) {
                return;
            }
            const next = advance();
            presenter.seek(next);
            route.frameLoop?.setPresentationGeneration(next);
            presenter.setDecodedFramePushMode(true, next);
            controller.seek(toMicroseconds(ms)).then(
                (result: CustomPlaybackStartResult): void => handleStart(route, controller, result),
                (error: unknown): void => events.onError(`seek-failed: ${String(error)}`)
            );
        },
        setAudio: async (ordinal: number): Promise<EmbeddedOpenResult> => {
            const current = opened;
            if (!current) {
                return { eligible: false, reason: 'nothing-open' };
            }
            const audioPrewarm = prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE);
            const paused = current.route?.controller?.playbackState === 'paused';
            const atMs = current.route ? stopRoute(current.route) : current.request.startMs;
            current.request = { ...current.request, audioOrdinal: ordinal, paused };
            return startRoute(current, atMs, audioPrewarm);
        },
        setMuted: (next: boolean): void => {
            muted = next;
            opened?.route?.controller?.setMuted(next);
        },
        setRate: (next: number): void => {
            rate = next;
            const route = opened?.route;
            const controller = route?.controller;
            if (!route || !controller) {
                return;
            }
            controller.setPlaybackRate(next)?.then(
                (result: CustomPlaybackStartResult): void => handleStart(route, controller, result),
                (): void => undefined
            );
        },
        setVolume: (next: number): void => {
            volume = next;
            opened?.route?.controller?.setVolume(next);
        },
        stats: (): EmbeddedStats | null => {
            const route = opened?.route;
            const controller = route?.controller;
            const eligibility = route?.eligibility;
            if (!opened || !controller || !eligibility) {
                return null;
            }
            const telemetry = controller.getTelemetry();
            const presentation = presenter.getTelemetry();
            const aheadOf = (end: Microseconds | null): number | null => (
                end === null ? null : Math.max(0, toMilliseconds(end - telemetry.currentTimeMicroseconds))
            );
            return {
                audio: audioStreamsOf(opened.source)[opened.request.audioOrdinal ?? -1] ?? null,
                audioAheadMs: aheadOf(telemetry.audioBridge?.submittedEndMediaTimeMicroseconds ?? null),
                audioObjects: telemetry.videoDecode.decodedAudioObjectCount,
                audioOutputLayout: telemetry.videoDecode.decodedAudioOutputLayout,
                audioUnderflows: telemetry.audioOutput?.underflowEvents ?? 0,
                clockMs: toMilliseconds(telemetry.currentTimeMicroseconds),
                dolbyVisionProfile: eligibility.dolbyVisionProfile,
                framesDropped: telemetry.videoDecode.droppedFrameCount,
                framesLate: telemetry.presentationTiming.lateFrameCount,
                framesPresented: presentation.presentedFrameCount,
                presentedMs: presentation.lastPresentedMediaTimeMicroseconds === null ? null : toMilliseconds(presentation.lastPresentedMediaTimeMicroseconds),
                route: describeRoute(eligibility),
                toneMapped: presentation.mode === 'hdr-to-sdr',
                video: opened.source.MediaStreams.find((stream: DescribedStream): boolean => stream.Type === 'Video') ?? null,
                videoAheadMs: aheadOf(telemetry.videoDecode.lastFrameEndMediaTimeMicroseconds)
            };
        }
    };
}
