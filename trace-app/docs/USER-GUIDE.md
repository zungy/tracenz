# Trace for Windows v0.7.0

Trace keeps the changes, decisions and screenshots behind your Autodesk Fusion designs together.

## Get started

1. Extract the entire downloaded ZIP and keep its files together.
2. Quit any older Trace through its system tray menu, then open Trace.exe.
3. Create an account on https://tracenz.vercel.app/signup, then log in inside Trace.
4. Close Autodesk Fusion. Open Fusion in Trace's sidebar and choose Install / update Fusion add-in.
5. Restart Fusion and record a checkpoint. Your connection is handled automatically.

Use the same email and password at https://tracenz.vercel.app/app to view your documents, search checkpoints and download document archives in your browser.

## While designing

Press **Ctrl + Alt + S** while Fusion is active to record a Trace checkpoint with your rationale and screenshot. Finish any current modeling command first. The shortcut needs the updated add-in and a signed-in Trace app. Fusion's normal Ctrl + S save remains unchanged. If another app already uses the shortcut, use **Record Design Change** in Fusion; Trace's Fusion page shows the shortcut status.

Keep Trace running while you work in Fusion. Closing the window keeps the app in the system tray. Signing out pauses uploads to your account. Interrupted uploads are saved locally and retried automatically when the connection returns.

The desktop timeline includes captured viewports, original rationale, normalized engineering changes and AI summaries. Import checkpoint restores a selected saved event and PNG into your signed-in account. **Source files** downloads the event JSON, summary and PNG files together.

## Save an engineering report PDF

1. Let any waiting Fusion checkpoints finish uploading.
2. Select a document or one of its checkpoints, then choose **Design report**. You can also use **Design report** on a document card.
3. Choose **Generate PDF** and select where to save the file. Trace shows progress while it prepares the report and screenshots.

The PDF contains an engineering overview, cited analysis when AI is available, and a numbered appendix of **every saved checkpoint in that document**. Search results and the currently visible timeline page do not limit it. Original rationale, engineering changes, source information and available screenshots are included, even when a checkpoint's individual summary has not finished. Deleted checkpoints and captures that have not uploaded are not included.

Each narrative citation points to its supporting checkpoint. Screenshots are scaled for the PDF; missing images are marked clearly without removing the checkpoint text. The report records when its evidence was retrieved. Generate another report to include later changes.

If the document is too large for a single AI request, or AI is not enabled, Trace labels the PDF as a report of recorded evidence and keeps its complete appendix. An AI failure is shown for retry. Reports are saved only to the file you select; generating one does not change the design history. Signing out while it is being prepared cancels the export before saving.

The report limit is 2,000 checkpoints or 8 MB of text evidence, plus 96 MB of processed screenshots. Trace reports an error if a limit is exceeded rather than leaving checkpoints out. Only one report can run at a time in the app. Keep the connection available while the report downloads its screenshots.

Accounts have separate histories. A shared demo account gives everyone with its credentials access to the same history, including desktop editing and deletion. Use a separate demo account for demonstrations.

This version is a portable, unsigned Windows x64 build. Updates are downloaded manually from https://tracenz.vercel.app/download. macOS support is not included.
