#!/usr/bin/env node
// Builds src/embed into the served assets, beside the decoder packages it loads, after scripts/build.mjs.
// Usage: node scripts/build-embed.mjs [--production]

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { build } from 'esbuild';

import { BUILD_INFO_FILE, DECODER_OUTPUT_DIRECTORY, ENGINE_ROOT, LIBRARY_OUTPUT_DIRECTORY, SOURCE_DIRECTORY } from '../tools/constants.mjs';

const PRODUCTION = process.argv.includes('--production');

if (!existsSync(BUILD_INFO_FILE)) {
    throw new Error('Run scripts/build.mjs first: the facade carries the asset key it writes');
}
const { assetKey } = JSON.parse(readFileSync(BUILD_INFO_FILE, 'utf8'));

const packages = existsSync(DECODER_OUTPUT_DIRECTORY) ?
    readdirSync(DECODER_OUTPUT_DIRECTORY).filter(name => name.endsWith('.wasm')).sort() :
    [];
mkdirSync(join(LIBRARY_OUTPUT_DIRECTORY, 'wgpud'), { recursive: true });
for (const name of packages) {
    copyFileSync(join(DECODER_OUTPUT_DIRECTORY, name), join(LIBRARY_OUTPUT_DIRECTORY, 'wgpud', name));
}

await build({
    absWorkingDir: ENGINE_ROOT,
    bundle: true,
    define: {
        __WEBGPU_PLAYER_ASSET_KEY__: JSON.stringify(assetKey),
        __WEBGPU_PLAYER_DECODER_PACKAGES__: JSON.stringify(packages)
    },
    entryPoints: [ 'EmbeddedPlayer', 'NativeDtsPlayback' ].map(name => join(SOURCE_DIRECTORY, 'embed', name + '.ts')),
    alias: { mediabunny: join(ENGINE_ROOT, 'vendor', 'mediabunny', 'dist', 'modules', 'src', 'index.js') },
    format: 'esm',
    loader: { '.css': 'text' },
    logLevel: 'warning',
    minify: PRODUCTION,
    outdir: join(LIBRARY_OUTPUT_DIRECTORY, 'webgpu-player'),
    platform: 'browser',
    sourcemap: PRODUCTION ? false : 'linked',
    target: 'es2022'
});
// The dedicated native audio module bundles the extension and its libFLAC encoder.
const flacRoot = join(dirname(createRequire(import.meta.url).resolve('@mediabunny/flac-encoder')), '..', '..');
for (const [source, name] of [['LICENSE', 'LICENSE.flac-encoder.txt'], ['licenses/libflac/COPYING.Xiph', 'LICENSE.libFLAC.txt']]) {
    copyFileSync(join(flacRoot, source), join(LIBRARY_OUTPUT_DIRECTORY, 'webgpu-player', name));
}
console.log(`webgpu-player: built the embedding facade with ${packages.length} decoder packages (key ${assetKey})`);
