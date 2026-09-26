# Automatic Fusion connection

The bundled add-in is in `fusion/DesignRecorderAgent/` (v0.6.0). It preserves the normalized engineering-change contract introduced in v0.4 and adds automatic discovery, durable uploads and checkpoint hotkey support.

## Use it

1. Close Autodesk Fusion and start the Trace desktop app.
2. Log in, open **Fusion**, and choose **Install / update Fusion add-in**.
3. Restart Fusion. Finish any active modeling command, then press **Ctrl + Alt + S** or choose **Record Design Change**.
4. Add rationale and record the checkpoint. Trace handles the connection and upload.

The installer backs up an existing add-in and preserves its configuration. `uploadEnabled:false` remains respected. No manual URL editing is needed. The add-in does not upload directly to the cloud.

## Transport

The receiver publishes a per-user connection record under `%LOCALAPPDATA%/Trace/connection.json` on Windows. It contains a loopback address, random instance ID and upload-only local token. The default port is 4318; an occupied port triggers an automatic fallback. Both clients verify the instance ID, and the uploader rejects redirects and non-loopback destinations.

Fusion reads the CAD model, captures the viewport and saves documents on its main thread. A background thread uploads complete, atomically stored outbox payloads with UUIDs for deduplication. Network failures retry with bounded backoff; invalid payloads remain on disk for diagnosis. After a durable receiver acknowledgement, the uploader removes its outbox copy and updates the checkpoint's saved `event.json` delivery metadata.

The receiver then forwards evidence to the signed-in user's cloud account with a separate installation credential. Signing out pauses forwarding, and pending uploads remain bound to the account that captured them. A cloud upload already in flight may finish during signout.

Closing Trace hides it to the tray; **Quit Trace** stops it. The desktop does not start automatically with Windows. Fusion's pending outbox resumes while Fusion is running; if Fusion is closed, it waits until the next launch. The receiver's own durable cloud queue resumes with Trace.

## Contract and tests

`POST /api/events` accepts an `event` object with document/source metadata, normalized `engineeringChanges`, original `rationale` and raw `changes`, plus a `viewport` object containing a filename, `image/png` content type and base64 PNG bytes. Stable document identity groups checkpoints correctly; names alone are not identity.

Transport tests cover offline queue reconstruction, occupied-port fallback, retries, acknowledgements and server-instance validation. Run `npm run test:fusion` alongside `npm test`. A real Fusion checkpoint should also be tested after installing an updated add-in.
