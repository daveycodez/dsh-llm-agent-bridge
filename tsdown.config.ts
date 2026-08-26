import type { UserConfig } from 'tsdown'

const ID = 'dsh-llm-agent-bridge'

/**
 * Host-only. Tool work is recorded by DSH's own trajectory, so the plugin
 * contributes no client bundle and no conversation renderer of its own.
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

export default [hostConfig]
