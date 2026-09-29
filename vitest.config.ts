import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Unit tests run without the Electron binary; main-process modules only
      // need the `app` object to exist at import time.
      electron: new URL('./tests/electron-stub.ts', import.meta.url).pathname,
    },
  },
})
