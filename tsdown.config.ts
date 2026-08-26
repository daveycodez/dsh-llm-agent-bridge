import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const ID = 'dsh-llm-agent-bridge'

/**
 * Node half: the adapter, the runtime, and the channel the browser half reads.
 * DSH's own packages and the Agent SDK stay external — the host resolves them
 * from the dsh installation at load time.
 */
const HOST_EXTERNALS = [
  /^node:/,
  /^@deepseek-ai\//,
  /^@anthropic-ai\/claude-agent-sdk$/,
  /^zod$/,
]

const hostConfig: UserConfig = {
  name: `${ID}/host`,
  entry: {
    'host-plugin': 'host-plugin.js',
    'typert.host': 'typert.host.js',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => HOST_EXTERNALS.some(pattern => pattern.test(specifier)),
    alwaysBundle: specifier => !HOST_EXTERNALS.some(pattern => pattern.test(specifier)),
  },
}

const CSS_MODULE = /UsageMeter\.module\.css$/

/** Deterministic `local` -> `dsh-ab-local` mapping for the CSS-module classes. */
function scopedName(local: string): string {
  return `dsh-ab-${local}`
}

/**
 * Rewrite the CSS-module import into a module that exports the class-name map
 * and injects the rewritten stylesheet once, guarded by a data attribute so a
 * reload cannot stack duplicate tags.
 *
 * The module is claimed at RESOLVE time under a `.js`-suffixed virtual id:
 * loading it under its real path is not enough, because the bundler's own CSS
 * pipeline dispatches on the `.css` extension and would emit this generated
 * JavaScript into a stylesheet, handing the importer an empty class map and
 * rendering the component unstyled.
 */
function inlineCssModule() {
  return {
    name: 'inline-css-module',
    resolveId(source: string, importer: string | undefined) {
      if (!CSS_MODULE.test(source) || importer === undefined) return null
      const path = new URL(source, `file://${importer}`).pathname
      return `${path}.inlined.js`
    },
    load(id: string) {
      if (!id.endsWith('.inlined.js')) return null
      const real = id.slice(0, -'.inlined.js'.length)
      if (!CSS_MODULE.test(real)) return null
      const source = readFileSync(real, 'utf8')
      const classes = [...new Set([...source.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map(match => match[1]!))]
      let css = source
      for (const local of classes) {
        css = css.replaceAll(new RegExp(`\\.${local}\\b`, 'g'), `.${scopedName(local)}`)
      }
      const map = Object.fromEntries(classes.map(local => [local, scopedName(local)]))
      return [
        `const css = ${JSON.stringify(css)};`,
        `const TAG = ${JSON.stringify(`${ID}/UsageMeter.module.css`)};`,
        'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${TAG}"]`) === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = TAG;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(map)};`,
      ].join('\n')
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  // The shell fetches `lib/client.js`; tsdown would otherwise write `.cjs`.
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  sourcemap: true,
  clean: false,
  external: [/^@deepseek-ai\//, 'react', 'react/jsx-runtime'],
  plugins: [inlineCssModule()],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
}

export default [hostConfig, clientConfig]
