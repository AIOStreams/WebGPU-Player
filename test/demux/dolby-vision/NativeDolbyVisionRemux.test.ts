// @vitest-environment node
import { BufferSource, BufferTarget, EncodedVideoPacketSource, getDolbyVisionHevcCodec, Input,
    MATROSKA, MP4, Mp4OutputFormat, Output, PacketReader } from 'mediabunny';
import { expect, it } from 'vitest';

import { concatenate } from '../../helpers/byteArrays';
import { createHEVCMatroskaWithKeyframes } from '../../helpers/hevcMatroskaVector';
import { createElement, createUnsignedIntegerElement, createVideoTrackMatroska } from '../../helpers/matroskaElements';

const record = new Uint8Array(24);
record.set([1, 0, 16, 53, 16]); // Profile 8.1, level 6, base layer and RPU.

it('reads the Dolby Vision mapping from the selected Matroska video track independently of child order', async () => {
    const file = createVideoTrackMatroska({
        blocks: [], codecID: 'V_MPEGH/ISO/HEVC', codecPrivate: null, defaultDurationMilliseconds: 40,
        pixelHeight: 180, pixelWidth: 320, trackElements: [createElement(0x41E4, concatenate([
            createElement(0x41ED, record), createUnsignedIntegerElement(0x41E7, 0x6476_7643)
        ]))]
    });
    const input = new Input({ formats: [MATROSKA], source: new BufferSource(file) });
    try {
        expect((await input.getPrimaryVideoTrack())?.getDolbyVisionConfig()).toEqual(record);
    } finally {
        input.dispose();
    }
});

it.each([
    { profile: 5, box: 'dvcC', codec: 'dvhe.05.06' },
    { profile: 8, box: 'dvvC', codec: 'dvhe.08.06' }
])('preserves the profile $profile configuration and HEVC packet in fragmented MP4', async ({ profile, box, codec }) => {
    const configuration = record.slice();
    configuration[2] = profile << 1;
    if (profile === 5) configuration[4] = 0;
    const file = await createHEVCMatroskaWithKeyframes([true]);
    const input = new Input({ formats: [MATROSKA], source: new BufferSource(file) });
    try {
        const track = (await input.getPrimaryVideoTrack())!;
        expect(track.getDolbyVisionConfig()).toBeNull();
        const packet = (await new PacketReader(track).getFirst())!;
        const target = new BufferTarget();
        const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'fragmented' }) });
        const source = new EncodedVideoPacketSource('hevc');
        output.addVideoTrack(source, { dolbyVisionConfig: configuration });
        await output.start();
        await source.add(packet, { decoderConfig: (await track.getDecoderConfig())! });
        await output.finalize();
        expect(await output.getMimeType()).toContain(codec);
        expect(Buffer.from(target.buffer!).includes(box)).toBe(true);
        const mp4 = new Input({ formats: [MP4], source: new BufferSource(target.buffer!) });
        try {
            const video = (await mp4.getPrimaryVideoTrack())!;
            expect(await video.getInternalCodecId()).toBe('dvhe');
            expect(video.getDolbyVisionConfig()).toEqual(configuration);
            expect((await new PacketReader(video).getFirst())?.data).toEqual(packet.data);
        } finally {
            mp4.dispose();
        }
    } finally {
        input.dispose();
    }
});

it('requires the RPU and base layer and excludes a missing enhancement track', () => {
    for (const flags of [1, 4, 7]) {
        const bytes = record.slice();
        bytes[3] = (bytes[3] & 0xF8) | flags;
        expect(getDolbyVisionHevcCodec(bytes)).toBeNull();
    }
    expect(getDolbyVisionHevcCodec(record.subarray(0, 4))).toBeNull();
});
