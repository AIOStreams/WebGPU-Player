#!/usr/bin/env node
// Assembles the npm package of the embedding module in bin/package/, after scripts/build-embed.mjs.
// Usage: node scripts/package-embed.mjs

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DECODERS_DIRECTORY, ENGINE_ROOT, INSTALLED_RELEASES_FILE, LIBRARY_OUTPUT_DIRECTORY, OUTPUT_DIRECTORY, SCRIPTS_DIRECTORY } from '../tools/constants.mjs';

const PACKAGE_DIRECTORY = join(OUTPUT_DIRECTORY, 'package');

if (!existsSync(join(LIBRARY_OUTPUT_DIRECTORY, 'webgpu-player', 'EmbeddedPlayer.js'))) {
    throw new Error('Run scripts/build-embed.mjs first');
}

rmSync(PACKAGE_DIRECTORY, { force: true, recursive: true });
mkdirSync(PACKAGE_DIRECTORY, { recursive: true });
cpSync(LIBRARY_OUTPUT_DIRECTORY, join(PACKAGE_DIRECTORY, 'libraries'), { recursive: true });
copyFileSync(join(SCRIPTS_DIRECTORY, 'embed-package.json'), join(PACKAGE_DIRECTORY, 'package.json'));
copyFileSync(join(ENGINE_ROOT, 'LICENSE'), join(PACKAGE_DIRECTORY, 'LICENSE'));

// The LGPL decoder packages travel with their licenses and where their corresponding source is
const decoders = join(PACKAGE_DIRECTORY, 'libraries', 'wgpud');
copyFileSync(join(DECODERS_DIRECTORY, 'LICENSE'), join(decoders, 'LICENSE'));
for (const name of readdirSync(join(DECODERS_DIRECTORY, 'licenses'))) {
    copyFileSync(join(DECODERS_DIRECTORY, 'licenses', name), join(decoders, name));
}
const { decoders: release } = JSON.parse(readFileSync(INSTALLED_RELEASES_FILE, 'utf8'));
writeFileSync(
    join(decoders, 'SOURCE.txt'),
    `These packages are the ${release.tag} release of https://github.com/${release.repository}, whose release files include the corresponding source of the LGPL packages.\n`
);
const { name, version } = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8'));
console.log(`webgpu-player: assembled ${name}@${version} in ${PACKAGE_DIRECTORY}`);
