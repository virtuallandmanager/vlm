import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // ~system/* modules are provided by the Decentraland runtime; URL/XMLHttpRequest
  // polyfills live in vlm-client (ensureNetworkPolyfills) and are bundled in
  external: ['@dcl/sdk', '@dcl/sdk/*', '@dcl/ecs', '@dcl/ecs/*', '~system/*'],
  minify: false,
  sourcemap: true,
})

console.log('Built dist/index.js')
