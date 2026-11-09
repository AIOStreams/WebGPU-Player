// scripts/build-embed.mjs loads stylesheets as text
declare module '*.css' {
    const text: string;
    export default text;
}
