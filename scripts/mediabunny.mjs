#!/usr/bin/env node
// Builds the vendored Mediabunny fork, which the engine's `mediabunny` dependency links to, when its build is missing or is not of the pinned commit and patches.
// patches/mediabunny/ carries changes the engine needs ahead of the fork; each one the checkout lacks is applied first.
// The build is the fork's ES modules and declarations in its dist/modules/, which its package.json exports; its bundles and extension packages go unused.
// npm runs this as the engine's prepare script, and scripts/build.mjs runs it first.
// Usage: node scripts/mediabunny.mjs [--force]
//   --force  rebuilds even when the build matches the checked-out commit, as after editing the fork in place
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_ROOT, MEDIABUNNY_SOURCE_DIRECTORY } from '../tools/constants.mjs';

const FORCE_FLAG = '--force';
const BUILD_DIRECTORY = join(MEDIABUNNY_SOURCE_DIRECTORY, 'dist');
// Names the commit and patches a build is of, so a moved pin or a changed patch rebuilds
const BUILD_STAMP_FILE = join(BUILD_DIRECTORY, 'webgpu-player-build.json');
const PATCH_DIRECTORY = join(ENGINE_ROOT, 'patches', 'mediabunny');
// The fork's own build steps for its modules, from its scripts/build.sh: type check and emit, then add the import extensions
// The toolchain is the fork's devDependencies, which npm leaves out under NODE_ENV=production, as a host's production build sets;
// npx would then run a tsc from a folder above, which type checks against that folder's @types
const BUILD_COMMAND_LINES = [
    'npm ci --ignore-scripts --include=dev',
    'npx --no -- tsc -p src',
    'npx --no -- tsx scripts/add-import-extensions.ts'
];
// npm run passes this package's configuration down as npm_* variables; the fork is a separate npm project
const NPM_VARIABLE_PATTERN = /^npm_/iu;

/** Returns the fork's checked-out commit, or null outside a Git checkout. */
function readCheckedOutCommit() {
    // Git from PATH, as every build of a checkout already uses
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('git', [ '-C', MEDIABUNNY_SOURCE_DIRECTORY, 'rev-parse', 'HEAD' ], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

/** Returns what the existing build is of, or null when there is no build. */
function readBuildStamp() {
    if (!existsSync(BUILD_STAMP_FILE)) {
        return null;
    }
    return JSON.parse(readFileSync(BUILD_STAMP_FILE, 'utf8'));
}

/** Returns the patches in name order. */
function readPatches() {
    if (!existsSync(PATCH_DIRECTORY)) {
        return [];
    }
    return readdirSync(PATCH_DIRECTORY)
        .filter((name) => name.endsWith('.patch'))
        .sort()
        .map((name) => join(PATCH_DIRECTORY, name));
}

function hashPatches(patches) {
    const hash = createHash('sha256');
    for (const patch of patches) {
        hash.update(readFileSync(patch));
    }
    return hash.digest('hex').slice(0, 16);
}

function runGitInFork(argumentList) {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    return spawnSync('git', [ '-C', MEDIABUNNY_SOURCE_DIRECTORY, ...argumentList ], { encoding: 'utf8' });
}

/** Applies each patch the checkout does not carry yet; one that applies in reverse is already in. */
function applyPatches(patches) {
    for (const patch of patches) {
        if (runGitInFork([ 'apply', '--reverse', '--check', patch ]).status === 0) {
            continue;
        }
        const result = runGitInFork([ 'apply', patch ]);
        if (result.status !== 0) {
            throw new Error(`mediabunny-patch-failed: ${patch} does not apply to ${MEDIABUNNY_SOURCE_DIRECTORY}: ${result.stderr.trim()}`);
        }
    }
}

/** Runs a command line in the fork's directory through the shell, which resolves npm.cmd and npx.cmd on Windows. */
function runInForkDirectory(commandLine) {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([ variableName ]) => !NPM_VARIABLE_PATTERN.test(variableName))
    );
    // Fixed command lines only
    const result = spawnSync(commandLine, { cwd: MEDIABUNNY_SOURCE_DIRECTORY, env: environment, shell: true, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`mediabunny-build-failed: ${commandLine} exited with ${result.status} in ${MEDIABUNNY_SOURCE_DIRECTORY}`);
    }
}

/** Builds the fork unless its build is of the checked-out commit and the patches. */
export function ensureMediabunnyBuild(force = false) {
    if (!existsSync(join(MEDIABUNNY_SOURCE_DIRECTORY, 'package.json'))) {
        throw new Error(`mediabunny-source-missing: no fork at ${MEDIABUNNY_SOURCE_DIRECTORY}; run git submodule update --init --depth 1 in the engine root`);
    }

    const patches = readPatches();
    applyPatches(patches);
    const patchesHash = hashPatches(patches);
    const checkedOutCommit = readCheckedOutCommit();
    const stamp = readBuildStamp();
    // Without Git the commit is unknown, so an existing build stands
    const buildIsCurrent = stamp !== null
        && (checkedOutCommit === null || stamp.commit === checkedOutCommit)
        && stamp.patches === patchesHash;
    if (buildIsCurrent && !force) {
        return;
    }

    console.log(`mediabunny: building ${checkedOutCommit ?? 'the fork'} in ${MEDIABUNNY_SOURCE_DIRECTORY}`);
    rmSync(BUILD_DIRECTORY, { force: true, recursive: true });
    for (const commandLine of BUILD_COMMAND_LINES) {
        runInForkDirectory(commandLine);
    }
    writeFileSync(BUILD_STAMP_FILE, `${JSON.stringify({ commit: checkedOutCommit, patches: patchesHash }, null, 2)}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    ensureMediabunnyBuild(process.argv.includes(FORCE_FLAG));
}
