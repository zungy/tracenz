import { Forwarding } from "./forwarding.js";
import { configFromEnv } from "./config.js";
import { LocalStore } from "./local-store.js";
import { SupabaseStore } from "./supabase-store.js";
import { createSummarizer, createWorker } from "./ai.js";
import { createApp } from "./app.js";
import { randomUUID } from "node:crypto";
import { publishBridge } from "./local-bridge.js";

const config = configFromEnv();
if (config.mode === "local") config.bridgeInstance = randomUUID();
const store =
  config.mode === "local"
    ? new LocalStore(config.dataDir)
    : new SupabaseStore(config);
const forwarding = config.mode === "local" ? new Forwarding(store) : null;
if (process.env.TRACE_FORWARDING_START_PAUSED === "1" && forwarding?.config())
  forwarding.save({ enabled: false });
forwarding?.start();
const server = createApp(config, store, { forwarding });
let unpublish = async () => {},
  fallback = false;
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && config.mode === "local" && !fallback) {
    fallback = true;
    server.listen(0, config.host);
  } else {
    console.error("Trace backend could not listen:", error.message);
    stop(1);
  }
});
server.on("listening", async () => {
  try {
    if (config.mode === "local")
      unpublish = await publishBridge(config, store, server.address().port);
    console.log(
      `Trace backend ready: http://${config.host}:${server.address().port} (${config.mode}, ${config.ai})`,
    );
  } catch (error) {
    console.error("Trace connection could not be published:", error.message);
    stop(1);
  }
});
server.listen(config.port, config.host);
const worker = createWorker(store, createSummarizer(config));
let cleaning = false;
const cleanup = setInterval(async () => {
  if (!store.cleanup || cleaning) return;
  cleaning = true;
  try {
    await store.cleanup();
  } catch (error) {
    console.error("Image cleanup deferred:", error.message);
  } finally {
    cleaning = false;
  }
}, 60_000);
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(cleanup);
  server.close();
  await unpublish();
  await worker.stop();
  await forwarding?.stop();
  while (cleaning) await new Promise((r) => setTimeout(r, 25));
  store.close();
  process.exit(typeof code === "number" ? code : 0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
