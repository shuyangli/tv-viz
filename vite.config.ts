import { defineConfig, type Plugin } from 'vitest/config'

/** LG CX ships webOS 5.x, whose web engine is Chromium 68. */
const WEBOS_CHROMIUM_TARGET = 'chrome68'

/**
 * webOS loads apps from file://, where Chromium refuses module scripts as a CORS
 * violation. The IIFE build needs no module semantics, so turn the module script
 * into a classic deferred script. `defer` keeps the DOM-ready ordering that module
 * scripts had implicitly.
 */
function classicDeferredScript(): Plugin {
  return {
    name: 'webos-classic-deferred-script',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(/\s+type="module"/g, ' defer')
        .replace(/\s+crossorigin/g, '')
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [classicDeferredScript()],
  build: {
    target: WEBOS_CHROMIUM_TARGET,
    modulePreload: { polyfill: false },
    assetsDir: '.',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
