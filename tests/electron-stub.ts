// Minimal Electron stub for unit tests. Main-process modules import `app` at
// module load; unit tests never call into real Electron APIs, so a stub lets
// the suite run on machines without the Electron binary (Linux dev / CI).
export const app = {
  isReady: () => false,
  getPath: () => '.',
  setLoginItemSettings: () => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  getFileIcon: async () => ({ toDataURL: () => '' }),
}

export default { app }
