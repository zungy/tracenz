const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("trace", {
  openSignup: () => ipcRenderer.invoke("trace:open-signup"),
  request: (path, options) =>
    ipcRenderer.invoke("trace:request", path, options),
  image: (id) => ipcRenderer.invoke("trace:image", id),
  exportDocument: (id) => ipcRenderer.invoke("trace:export", id),
  generateDesignReport: (id) => ipcRenderer.invoke("trace:design-report", id),
  onDesignReportProgress: (listener) => {
    if (typeof listener !== "function")
      throw new TypeError("A report progress listener is required.");
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("trace:design-report-progress", handler);
    return () =>
      ipcRenderer.removeListener("trace:design-report-progress", handler);
  },
  importCheckpoint: () => ipcRenderer.invoke("trace:import"),
  connection: () => ipcRenderer.invoke("trace:connection"),
  resumeSync: () => ipcRenderer.invoke("trace:resume-sync"),
  fusionStatus: () => ipcRenderer.invoke("trace:fusion-status"),
  installFusion: () => ipcRenderer.invoke("trace:install-fusion"),
});
