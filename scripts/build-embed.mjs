#!/usr/bin/env node
// Builds src/embed into the served assets, beside the decoder packages it loads, after scripts/build.mjs.
// Usage: node scripts/build-embed.mjs [--production]

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    entryPoints: [ join(SOURCE_DIRECTORY, 'embed', 'EmbeddedPlayer.ts') ],
    format: 'esm',
    loader: { '.css': 'text' },
    logLevel: 'warning',
    minify: PRODUCTION,
    outfile: join(LIBRARY_OUTPUT_DIRECTORY, 'webgpu-player', 'EmbeddedPlayer.js'),
    platform: 'browser',
    sourcemap: PRODUCTION ? false : 'linked',
    target: 'es2022'
});
console.log(`webgpu-player: built the embedding facade with ${packages.length} decoder packages (key ${assetKey})`);
