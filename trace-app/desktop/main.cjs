const {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  globalShortcut,
} = require("electron");
const { join } = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { BackendClient } = require("./transport.cjs");
const { readBridge } = require("./bridge.cjs");
const { installFusion, fusionStatus } = require("./fusion.cjs");
const { CloudPairing, CredentialVault } = require("./pairing.cjs");
const cloudConfig = require("./cloud-config.cjs");
const { allowedRequest } = require("./renderer-policy.cjs");
const { registerCaptureShortcut } = require("./hotkey.cjs");
const {
  DesignReportExporter,
  renderReportPdf,
} = require("./design-report.cjs");
const root = join(__dirname, "..");
if (process.env.TRACE_DESKTOP_DATA)
  app.setPath("userData", process.env.TRACE_DESKTOP_DATA);
const smoke = process.env.TRACE_SMOKE === "1";
// Trace displays 2D screenshots; software rendering also supports machines with
// restrictive GPU drivers and remote desktop sessions.
app.disableHardwareAcceleration();
if (process.platform === "win32") app.setAppUserModelId("nz.trace.desktop");
let window,
  child,
  baseUrl,
  client,
  localClient,
  localUrl,
  pairing,
  localError,
  tray,
  captureShortcut,
  reportExporter,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (window) {
    window.show();
    window.focus();
  }
});
const uiUrl = pathToFileURL(join(root, "public/index.html")).href;
const idPattern = /^[0-9a-f-]{36}$/i;

function trusted(event) {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url.split("#")[0] !== uiUrl
  )
    throw new Error("Untrusted IPC sender.");
}
const { backendUrl: validUrl } = require("./backend-url.cjs");
const request = (path, options) => client.request(path, options);
let accountOperation = Promise.resolve();
// Account changes are ordered so a slower login cannot pair after a later logout.
function changeAccount(operation) {
  const next = accountOperation.then(operation);
  accountOperation = next.catch(() => {});
  return next;
}
async function startLocal() {
  const existing = await readBridge();
  if (existing) return existing.url;
  // Never silently abandon a running legacy backend and its document history.
  try {
    const response = await fetch("http://127.0.0.1:4318/api/health", {
      signal: AbortSignal.timeout(700),
    });
    const health = await response.json();
    if (health.service === "trace-backend" && !health.instanceId)
      throw new Error(
        "Restart the previously running Trace backend to enable automatic Fusion connection.",
      );
  } catch (error) {
    if (error.message.startsWith("Restart the previously")) throw error;
  }
  let launchError;
  if (!child) {
    child = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", join(root, "server/index.js")],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          TRACE_MODE: "local",
          TRACE_FORWARDING_START_PAUSED: "1",
          HOST: "127.0.0.1",
          PORT: "4318",
          TRACE_DATA_DIR:
            process.env.TRACE_DATA_DIR ||
            join(app.getPath("userData"), "trace-data"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => console.log(String(chunk).trim()));
    child.stderr.on("data", (chunk) => console.error(String(chunk).trim()));
    child.on("error", (error) => {
      launchError = error;
      child = null;
    });
    child.on("exit", () => {
      child = null;
    });
  }
  for (let n = 0; n < 80; n++) {
    const record = await readBridge();
    if (record) return record.url;
    if (launchError) throw launchError;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Local Trace connection could not start. Restart Trace and try again.",
  );
}

app
  .whenReady()
  .then(async () => {
    // Production always opens the account's Supabase history. Old local or
    // custom-workspace preferences must not silently change that destination.
    baseUrl = validUrl(smoke ? "http://127.0.0.1:4318" : cloudConfig.apiUrl);
    client = new BackendClient(baseUrl);
    reportExporter = new DesignReportExporter({
      client,
      selectPath: () =>
        dialog.showSaveDialog(window, {
          title: "Save engineering design report",
          defaultPath: join(
            app.getPath("downloads"),
            "Trace-design-report.pdf",
          ),
          filters: [{ name: "Engineering report PDF", extensions: ["pdf"] }],
        }),
      normalizeImage: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty())
          throw new Error("The screenshot could not be decoded.");
        const { width, height } = image.getSize();
        if (!width || !height || width * height > 16_000_000)
          throw new Error("The screenshot dimensions are not supported.");
        const scale = Math.min(1, 1500 / width, 1000 / height);
        return (
          scale < 1
            ? image.resize({
                width: Math.max(1, Math.round(width * scale)),
                height: Math.max(1, Math.round(height * scale)),
                quality: "best",
              })
            : image
        ).toPNG();
      },
      renderPdf: (input, assertCurrent) =>
        renderReportPdf(input, assertCurrent, {
          BrowserWindow,
          temporaryRoot: app.getPath("userData"),
          fontDirectory: join(root, "public/fonts"),
        }),
    });
    // Fusion always has its local durable receiver, even when viewing cloud history.
    try {
      localUrl = await startLocal();
      localClient = new BackendClient(localUrl);
      if (baseUrl.startsWith("http://127.0.0.1:")) {
        baseUrl = localUrl;
        client.connect(baseUrl);
      }
    } catch (error) {
      localError = error.message;
      console.error(error.message);
      if (smoke) throw error;
    }
    pairing = new CloudPairing({
      cloud: client,
      local: localClient,
      vault: new CredentialVault(
        join(app.getPath("userData"), "trace-upload-credentials.bin"),
        safeStorage,
      ),
    });
    try {
      await pairing.pause();
    } catch (error) {
      localError = error.message;
    }
    if (!smoke && localClient)
      captureShortcut = registerCaptureShortcut({
        globalShortcut,
        canCapture: () => Boolean(client.session) && !quitting,
      });
    ipcMain.handle("trace:fusion-status", async (event) => {
      trusted(event);
      return {
        ...(await fusionStatus()),
        shortcut: {
          registered: Boolean(captureShortcut?.registered),
          error: captureShortcut?.error || null,
        },
      };
    });
    ipcMain.handle("trace:install-fusion", async (event) => {
      trusted(event);
      return installFusion(join(root, "fusion/DesignRecorderAgent"));
    });
    ipcMain.handle("trace:connection", (event) => {
      trusted(event);
      return {
        url: baseUrl,
        desktop: true,
        localUrl,
        cloudUrl: cloudConfig.apiUrl,
        version: app.getVersion(),
        syncError: pairing.error || localError || null,
      };
    });
    ipcMain.handle("trace:resume-sync", (event) => {
      trusted(event);
      if (baseUrl === localUrl)
        throw new Error("Log in to your cloud account first.");
      return changeAccount(() => pairing.pair());
    });
    ipcMain.handle("trace:open-signup", async (event) => {
      trusted(event);
      const config = await request("/api/config");
      if (!config.signupUrl)
        throw new Error("The signup website has not been configured yet.");
      const target = new URL(config.signupUrl);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error("Invalid signup website.");
      await shell.openExternal(target.href);
      return { ok: true };
    });
    ipcMain.handle("trace:request", async (event, path, options = {}) => {
      trusted(event);
      if (!allowedRequest(path, options.method || "GET") || options.binary)
        throw new Error("Unsupported request.");
      const optionsSafe = {
        method: options.method,
        body: options.body,
      };
      if (path.startsWith("/api/forwarding")) {
        if (!localClient)
          throw new Error(
            localError || "Local Fusion receiver is unavailable.",
          );
        return changeAccount(async () => {
          await request("/api/auth/me");
          return localClient.request(path, optionsSafe);
        });
      }
      if (path === "/api/auth/login") {
        reportExporter.invalidate();
        return changeAccount(() => pairing.login(optionsSafe.body));
      }
      if (path === "/api/auth/logout") {
        reportExporter.invalidate();
        return changeAccount(() => pairing.logout());
      }
      return request(path, optionsSafe);
    });
    ipcMain.handle("trace:image", async (event, id) => {
      trusted(event);
      if (!idPattern.test(id)) throw new Error("Invalid event ID.");
      const bytes = await request(`/api/events/${id}/image`, { binary: true });
      return `data:image/png;base64,${bytes.toString("base64")}`;
    });
    ipcMain.handle("trace:export", async (event, id) => {
      trusted(event);
      if (!idPattern.test(id)) throw new Error("Invalid document ID.");
      const result = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath("downloads"), "trace-export.zip"),
        filters: [{ name: "Trace ZIP archive", extensions: ["zip"] }],
      });
      if (result.canceled) return { canceled: true };
      const bytes = await request(`/api/documents/${id}/export`, {
        binary: true,
      });
      await writeFile(result.filePath, bytes);
      return { ok: true };
    });
    ipcMain.handle("trace:design-report", (event, id) => {
      trusted(event);
      return reportExporter.generate(id, (progress) => {
        if (!event.sender.isDestroyed())
          event.sender.send("trace:design-report-progress", progress);
      });
    });
    ipcMain.handle("trace:import", async (event) => {
      trusted(event);
      const json = await dialog.showOpenDialog(window, {
        title: "Select Fusion event.json or an upload envelope",
        properties: ["openFile"],
        filters: [{ name: "Checkpoint JSON", extensions: ["json"] }],
      });
      if (json.canceled) return { canceled: true };
      const raw = await readFile(json.filePaths[0]);
      if (raw.length > 12 * 1024 * 1024) throw new Error("JSON exceeds 12 MB.");
      const value = JSON.parse(raw.toString("utf8"));
      let envelope;
      if (value.event && value.viewport?.base64) envelope = value;
      else {
        const png = await dialog.showOpenDialog(window, {
          title: "Select the viewport PNG for this checkpoint",
          properties: ["openFile"],
          filters: [{ name: "PNG screenshot", extensions: ["png"] }],
        });
        if (png.canceled) return { canceled: true };
        const bytes = await readFile(png.filePaths[0]);
        if (bytes.length > 8 * 1024 * 1024)
          throw new Error("PNG exceeds 8 MB.");
        envelope = {
          event: value.event || value,
          viewport: {
            filename: "viewport.png",
            contentType: "image/png",
            base64: bytes.toString("base64"),
          },
        };
      }
      return request("/api/events", { method: "POST", body: envelope });
    });
    window = new BrowserWindow({
      width: 1360,
      height: 920,
      minWidth: 780,
      minHeight: 600,
      show: !smoke,
      backgroundColor: "#e9ebf3",
      icon: join(__dirname, "assets/trace.ico"),
      title: `Trace ${app.getVersion()} — Engineering memory`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("render-process-gone", (_event, details) =>
      console.error("Trace renderer exited:", JSON.stringify(details)),
    );
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== uiUrl) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    if (!smoke) {
      tray = new Tray(
        nativeImage.createFromPath(join(__dirname, "assets/trace-tray.png")),
      );
      tray.setToolTip("Trace - Fusion connection stays active");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "Open Trace",
            click: () => {
              window.show();
              window.focus();
            },
          },
          { label: "Quit Trace", click: () => app.quit() },
        ]),
      );
      tray.on("click", () => {
        window.show();
        window.focus();
      });
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
    }
    await window.loadURL(uiUrl);
    if (smoke) {
      const result = await window.webContents.executeJavaScript(
        `(async () => ({ title: document.title, nodeExposed: typeof require !== 'undefined', bridge: typeof window.trace.request === 'function', config: await window.trace.request('/api/config'), user: await window.trace.request('/api/auth/me'), documents: await window.trace.request('/api/documents') }))()`,
      );
      if (
        result.nodeExposed ||
        !result.bridge ||
        result.config.mode !== "local"
      )
        throw new Error("Desktop isolation smoke check failed.");
      console.log("TRACE_DESKTOP_SMOKE " + JSON.stringify(result));
      app.quit();
    }
  })
  .catch((error) => {
    if (smoke) {
      console.error(error);
      app.exit(1);
    } else {
      dialog.showErrorBox("Trace could not start", error.message);
      app.quit();
    }
  });
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
let shutdownStarted = false,
  shutdownReady = false;
app.on("before-quit", (event) => {
  quitting = true;
  captureShortcut?.dispose();
  reportExporter?.invalidate();
  if (shutdownReady) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Also pause a receiver reused from another Trace process before leaving.
  Promise.race([
    pairing?.pause(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Receiver pause timed out.")), 2500),
    ),
  ])
    .catch(() =>
      console.error("Receiver pause could not be confirmed during shutdown."),
    )
    .finally(() => {
      child?.kill();
      shutdownReady = true;
      app.quit();
    });
});
