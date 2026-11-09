// A URL described as a media server's media source, for a host that has no server-side probe of the file.
// A Dolby Vision stream is described by its base layer.
import { ALL_FORMATS, Input, UrlSource, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';

/** The Jellyfin MediaStream fields the eligibility and the presentation input read. */
export type DescribedStream = {
    AverageFrameRate: number | null
    BitDepth: number | null
    ChannelLayout: string | null
    Channels: number | null
    Codec: string | null
    ColorPrimaries: string | null
    ColorRange: string | null
    ColorSpace: string | null
    ColorTransfer: string | null
    DisplayTitle: string | null
    Height: number | null
    Index: number
    IsDefault: boolean
    IsExternal: false
    IsInterlaced: boolean
    Language: string | null
    Level: number | null
    PixelFormat: string | null
    Profile: string | null
    RealFrameRate: number | null
    Rotation: number | null
    SampleRate: number | null
    Title: string | null
    Type: 'Audio' | 'Video'
    VideoRange: string | null
    VideoRangeType: string | null
    Width: number | null
};

export type DescribedSource = {
    Container: string
    Id: string
    MediaStreams: DescribedStream[]
    RunTimeTicks: number | null
};

export class DescribeSourceError extends Error {}

const TICKS_PER_SECOND = 10_000_000;
const UNDETERMINED_LANGUAGE = 'und';

const CONTAINERS: Readonly<Record<string, string>> = {
    'AVI': 'avi',
    'Matroska': 'mkv',
    'MP4': 'mp4',
    'MPEG Program Stream': 'mpeg',
    'MPEG Transport Stream': 'ts',
    'Ogg': 'ogg',
    'QuickTime File Format': 'mov',
    'WebM': 'webm'
};

// FFmpeg's names, which the eligibility's alias tables read
const VIDEO_CODECS: Readonly<Record<string, string>> = {
    av1: 'av1',
    avc: 'h264',
    hevc: 'hevc',
    mpeg1: 'mpeg1video',
    mpeg2: 'mpeg2video',
    mpeg4: 'mpeg4',
    prores: 'prores',
    vc1: 'vc1',
    vp8: 'vp8',
    vp9: 'vp9'
};

const AUDIO_CODECS: Readonly<Record<string, string>> = {
    'aac': 'aac',
    'ac3': 'ac3',
    'alaw': 'pcm_alaw',
    'dts': 'dts',
    'eac3': 'eac3',
    'flac': 'flac',
    'mp3': 'mp3',
    'opus': 'opus',
    'pcm-f32': 'pcm_f32le',
    'pcm-f32be': 'pcm_f32be',
    'pcm-f64': 'pcm_f64le',
    'pcm-f64be': 'pcm_f64be',
    'pcm-s16': 'pcm_s16le',
    'pcm-s16be': 'pcm_s16be',
    'pcm-s24': 'pcm_s24le',
    'pcm-s24be': 'pcm_s24be',
    'pcm-s32': 'pcm_s32le',
    'pcm-s32be': 'pcm_s32be',
    'pcm-s8': 'pcm_s8',
    'pcm-u8': 'pcm_u8',
    'truehd': 'truehd',
    'ulaw': 'pcm_mulaw',
    'vorbis': 'vorbis'
};

const PRIMARIES: Readonly<Record<string, string>> = {
    bt2020: 'bt2020',
    bt470bg: 'bt470bg',
    bt709: 'bt709',
    smpte170m: 'smpte170m',
    smpte432: 'smpte432'
};
const TRANSFERS: Readonly<Record<string, string>> = {
    'bt709': 'bt709',
    'hlg': 'arib-std-b67',
    'iec61966-2-1': 'iec61966-2-1',
    'linear': 'linear',
    'pq': 'smpte2084',
    'smpte170m': 'smpte170m'
};
const MATRICES: Readonly<Record<string, string>> = {
    'bt2020-ncl': 'bt2020nc',
    'bt470bg': 'bt470bg',
    'bt709': 'bt709',
    'rgb': 'gbr',
    'smpte170m': 'smpte170m'
};
const RANGE_TYPES: Readonly<Record<string, string>> = { 'arib-std-b67': 'HLG', 'smpte2084': 'HDR10' };

type Chroma = 400 | 420 | 422 | 444;

type CodecFacts = { bitDepth: number | null, chroma: Chroma | null, level: number | null, profile: string | null };

const NO_FACTS: CodecFacts = { bitDepth: null, chroma: null, level: null, profile: null };

const H264_PROFILES: Readonly<Record<number, { name: string, bitDepth: number, chroma: Chroma }>> = {
    66: { bitDepth: 8, chroma: 420, name: 'Baseline' },
    77: { bitDepth: 8, chroma: 420, name: 'Main' },
    88: { bitDepth: 8, chroma: 420, name: 'Extended' },
    100: { bitDepth: 8, chroma: 420, name: 'High' },
    110: { bitDepth: 10, chroma: 420, name: 'High 10' },
    122: { bitDepth: 10, chroma: 422, name: 'High 4:2:2' },
    244: { bitDepth: 10, chroma: 444, name: 'High 4:4:4 Predictive' }
};
const HEVC_PROFILES: Readonly<Record<number, { name: string, bitDepth: number | null }>> = {
    1: { bitDepth: 8, name: 'Main' },
    2: { bitDepth: 10, name: 'Main 10' },
    3: { bitDepth: 8, name: 'Main Still Picture' },
    4: { bitDepth: null, name: 'Rext' }
};
const HEVC_CHROMA: readonly Chroma[] = [ 400, 420, 422, 444 ];
// hvcC: chromaFormat in byte 16, bitDepthLumaMinus8 in byte 17
const HVCC_CHROMA_FORMAT = 16;
const HVCC_BIT_DEPTH_LUMA = 17;
const AV1_PROFILES: readonly string[] = [ 'Main', 'High', 'Professional' ];
const VP9_CHROMA: readonly Chroma[] = [ 420, 420, 422, 444 ];

const integerOrNull = (text: string | undefined, radix = 10): number | null => {
    const value = Number.parseInt(text ?? '', radix);
    return Number.isFinite(value) ? value : null;
};

// avc1.PPCCLL: profile_idc, constraint flags, and level_idc in hex
function readAvcFacts(parts: readonly string[]): CodecFacts {
    const hex = parts[1] ?? '';
    const profile = H264_PROFILES[integerOrNull(hex.slice(0, 2), 16) ?? -1];
    return {
        bitDepth: profile?.bitDepth ?? 8,
        chroma: profile?.chroma ?? 420,
        level: integerOrNull(hex.slice(4, 6), 16),
        profile: profile?.name ?? null
    };
}

// hvc1.[A-C]P.compat.[LH]level.constraints, with depth and chroma from the configuration record where it has them
function readHevcFacts(parts: readonly string[], record: Uint8Array | null): CodecFacts {
    const profile = HEVC_PROFILES[integerOrNull(parts[1]?.replace(/^[A-C]/u, '')) ?? -1];
    const level = integerOrNull(parts[3]?.replace(/^[LH]/u, ''));
    if (record && record.byteLength > HVCC_BIT_DEPTH_LUMA) {
        return {
            bitDepth: (record[HVCC_BIT_DEPTH_LUMA] & 0b111) + 8,
            chroma: HEVC_CHROMA[record[HVCC_CHROMA_FORMAT] & 0b11] ?? null,
            level,
            profile: profile?.name ?? null
        };
    }
    return { bitDepth: profile?.bitDepth ?? null, chroma: profile?.bitDepth ? 420 : null, level, profile: profile?.name ?? null };
}

// av01.P.LLT.DD.M.CCC
function readAv1Facts(parts: readonly string[]): CodecFacts {
    const subsampling = parts[5] ?? '110';
    let chroma: Chroma = 444;
    if (parts[4] === '1') {
        chroma = 400;
    } else if (subsampling.startsWith('11')) {
        chroma = 420;
    } else if (subsampling.startsWith('10')) {
        chroma = 422;
    }
    return {
        bitDepth: integerOrNull(parts[3]),
        chroma,
        level: integerOrNull(parts[2]),
        profile: AV1_PROFILES[Number(parts[1])] ?? null
    };
}

// vp09.PP.LL.DD.CC
function readVp9Facts(parts: readonly string[]): CodecFacts {
    const profile = integerOrNull(parts[1]);
    const profileDepth = profile !== null && profile >= 2 ? 10 : 8;
    return {
        bitDepth: integerOrNull(parts[3]) ?? profileDepth,
        chroma: VP9_CHROMA[integerOrNull(parts[4]) ?? 1] ?? null,
        level: null,
        profile: profile === null ? null : `Profile ${profile}`
    };
}

/** From the track's RFC 6381 codec string, and HEVC's configuration record. */
function readCodecFacts(codec: string | null, parameters: string | null, record: Uint8Array | null): CodecFacts {
    const parts = (parameters ?? '').split('.');
    switch (codec) {
        case 'avc':
            return readAvcFacts(parts);
        case 'hevc':
            return readHevcFacts(parts, record);
        case 'av1':
            return readAv1Facts(parts);
        case 'vp9':
            return readVp9Facts(parts);
        case 'vp8':
            return { bitDepth: 8, chroma: 420, level: null, profile: 'Profile 0' };
        default:
            return NO_FACTS;
    }
}

function pixelFormatOf({ bitDepth, chroma }: CodecFacts): string | null {
    if (bitDepth === null || chroma === null) {
        return null;
    }
    const base = chroma === 400 ? 'gray' : `yuv${chroma}p`;
    return bitDepth > 8 ? `${base}${bitDepth}le` : base;
}

function asBytes(description: AllowSharedBufferSource | undefined): Uint8Array | null {
    if (!description) {
        return null;
    }
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
    }
    return new Uint8Array(description);
}

function colorRangeOf(fullRange: boolean | null | undefined): string | null {
    if (fullRange === undefined || fullRange === null) {
        return null;
    }
    return fullRange ? 'pc' : 'tv';
}

const lookUp = (table: Readonly<Record<string, string>>, key: string | null | undefined): string | null => (key ? table[key] ?? null : null);

function emptyStream(index: number, type: 'Audio' | 'Video'): DescribedStream {
    return {
        AverageFrameRate: null,
        BitDepth: null,
        ChannelLayout: null,
        Channels: null,
        Codec: null,
        ColorPrimaries: null,
        ColorRange: null,
        ColorSpace: null,
        ColorTransfer: null,
        DisplayTitle: null,
        Height: null,
        Index: index,
        IsDefault: false,
        IsExternal: false,
        IsInterlaced: false,
        Language: null,
        Level: null,
        PixelFormat: null,
        Profile: null,
        RealFrameRate: null,
        Rotation: null,
        SampleRate: null,
        Title: null,
        Type: type,
        VideoRange: null,
        VideoRangeType: null,
        Width: null
    };
}

async function describeVideo(track: InputVideoTrack, index: number): Promise<DescribedStream> {
    const [ codec, parameters, config, color, width, height, rotation, disposition, language, name ] = await Promise.all([
        track.getCodec(),
        track.getCodecParameterString().catch((): null => null),
        track.getDecoderConfig().catch((): null => null),
        track.getColorSpace().catch((): VideoColorSpaceInit => ({})),
        track.getCodedWidth(),
        track.getCodedHeight(),
        track.getRotation(),
        track.getDisposition(),
        track.getLanguageCode(),
        track.getName()
    ]);
    const facts = readCodecFacts(codec, parameters, asBytes(config?.description));
    const transfer = lookUp(TRANSFERS, color.transfer);
    const rangeType = (transfer && RANGE_TYPES[transfer]) ?? 'SDR';
    return {
        ...emptyStream(index, 'Video'),
        BitDepth: facts.bitDepth,
        Codec: codec ? VIDEO_CODECS[codec] ?? codec : null,
        ColorPrimaries: lookUp(PRIMARIES, color.primaries),
        ColorRange: colorRangeOf(color.fullRange),
        ColorSpace: lookUp(MATRICES, color.matrix),
        ColorTransfer: transfer,
        Height: height,
        IsDefault: disposition.default,
        Language: language === UNDETERMINED_LANGUAGE ? null : language,
        Level: facts.level,
        PixelFormat: pixelFormatOf(facts),
        Profile: facts.profile,
        Rotation: rotation || null,
        Title: name,
        VideoRange: rangeType === 'SDR' ? 'SDR' : 'HDR',
        VideoRangeType: rangeType,
        Width: width
    };
}

async function describeAudio(track: InputAudioTrack, index: number): Promise<DescribedStream> {
    const [ codec, channels, sampleRate, disposition, language, name ] = await Promise.all([
        track.getCodec(),
        track.getNumberOfChannels(),
        track.getSampleRate(),
        track.getDisposition(),
        track.getLanguageCode(),
        track.getName()
    ]);
    return {
        ...emptyStream(index, 'Audio'),
        Channels: channels,
        Codec: codec ? AUDIO_CODECS[codec] ?? codec : null,
        IsDefault: disposition.default,
        Language: language === UNDETERMINED_LANGUAGE ? null : language,
        SampleRate: sampleRate,
        Title: name
    };
}

/** Streams keep the demuxer's track order, so each type's ordinal is the decode worker's. */
export async function describeSource(url: string): Promise<DescribedSource> {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
    try {
        const format = await input.getFormat().catch((error: unknown): never => {
            throw new DescribeSourceError(`source-unreadable: ${String(error)}`);
        });
        const container = CONTAINERS[format.name];
        if (!container) {
            throw new DescribeSourceError(`container-unsupported: ${format.name}`);
        }
        const streams: DescribedStream[] = [];
        for (const [ index, track ] of (await input.getTracks()).entries()) {
            if (track.isVideoTrack()) {
                streams.push(await describeVideo(track, index));
            } else if (track.isAudioTrack()) {
                streams.push(await describeAudio(track, index));
            }
        }
        const seconds = await input.computeDuration().catch((): null => null);
        return {
            Container: container,
            Id: url,
            MediaStreams: streams,
            RunTimeTicks: seconds && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * TICKS_PER_SECOND) : null
        };
    } finally {
        input.dispose();
    }
}
