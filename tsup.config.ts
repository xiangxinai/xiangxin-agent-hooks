import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/dsh.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts', 'src/dsh.ts'] },
  clean: true,
  target: 'node18',
  platform: 'node',
  sourcemap: false,
  splitting: true,
  treeshake: true,
  external: ['@deepseek-ai/dsh-llm'],
})
