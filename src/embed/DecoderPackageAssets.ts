// The embed build hashes the decoder files it actually ships.
declare const __WEBGPU_PLAYER_DECODER_PACKAGES__: Readonly<Record<string, string>>;

export function hasDecoderPackage(name: string): boolean {
    return typeof __WEBGPU_PLAYER_DECODER_PACKAGES__[name] === 'string';
}

export function decoderPackageURL(name: string): URL {
    return new URL(`../wgpud/${name}.wasm?v=${__WEBGPU_PLAYER_DECODER_PACKAGES__[name]}`, import.meta.url);
}
