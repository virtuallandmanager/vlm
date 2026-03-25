import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['@dcl/sdk', '@dcl/sdk/*', '@dcl/ecs', '@dcl/ecs/*'],
  minify: false,
  sourcemap: true,
})

console.log('Built dist/index.js (bundled, all workspace deps inlined)')
