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
  banner: {
    js: `
// Polyfill URL for Decentraland's sandboxed runtime (no browser APIs)
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = class URL {
    constructor(url, base) {
      if (base && url.startsWith('/')) url = base.replace(/\\/$/, '') + url;
      this.href = url;
      const match = url.match(/^(https?|wss?):\\/\\/([^/:]+)(:(\\d+))?(.*?)$/);
      if (match) {
        this.protocol = match[1] + ':';
        this.hostname = match[2];
        this.port = match[4] || '';
        this.pathname = match[5] ? match[5].split('?')[0] : '/';
        this.search = match[5] && match[5].includes('?') ? '?' + match[5].split('?')[1] : '';
      } else {
        this.protocol = 'https:';
        this.hostname = 'localhost';
        this.port = '';
        this.pathname = url;
        this.search = '';
      }
      this.host = this.hostname + (this.port ? ':' + this.port : '');
      this.origin = this.protocol + '//' + this.host;
    }
    toString() { return this.href; }
  };
}
`,
  },
})

console.log('Built dist/index.js (bundled with URL polyfill)')
