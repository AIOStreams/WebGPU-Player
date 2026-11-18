/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import LAYOUT from './tools/constants.json';

export default defineConfig({
    // The FLAC extension also installs upstream Mediabunny as a peer. Tests use the engine's fork.
    resolve: {
        alias: { mediabunny: fileURLToPath(new URL('./vendor/mediabunny/dist/modules/src/index.js', import.meta.url)) }
    },
    plugins: [ tsconfigPaths() ],
    test: {
        environment: 'jsdom',
        // The engine's tests, and each decoder project's own beside its sources
        include: [ `${LAYOUT.testDirectory}/**/*.test.ts`, `${LAYOUT.decodersDirectory}/*/test/**/*.test.ts` ],
        // Every test starts from fresh mocks: restoreMocks restores vi.spyOn spies, and mockReset clears each mock's calls and resets its implementation
        mockReset: true,
        restoreMocks: true
    }
});
