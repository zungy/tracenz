# Trace v0.7.0 accounts

Trace's released desktop is connected to the existing **tracenz** Supabase project (`sbupyqgysoznucelwsij`). Users create an account in their browser, then log in inside the desktop app to access their own design history. There is no local-workspace bypass or editable cloud endpoint in the account screen.

## User flow

1. Start Trace and choose **Create account** if an account is needed.
2. The default browser opens the signup URL supplied by the deployed backend: `https://tracenz.vercel.app/signup`.
3. Create an account using an email and password. Email confirmation is disabled for the demo, so signup does not verify ownership of the entered address and the account is immediately usable.
4. Return to Trace and log in with the same credentials. Signup does not automatically log the desktop in.
5. Trace opens the account timeline and pairs the internal Fusion receiver automatically. Use **Fusion connection** to install the add-in or recover interrupted uploads.

The website at `https://tracenz.vercel.app/app` also supports login with the same account. It opens the user's documents and a read-only history with search, viewport images, and document downloads. Editing, importing, and deleting checkpoints remains in the desktop app.

## Session and upload behavior

Cloud login tokens stay in Electron's main process and are never given to the renderer. Sessions are held in memory, so quitting/restarting Trace requires login again. Closing the window keeps Trace active in the system tray; use **Quit Trace** there to end the process.

Signing out immediately clears the visible account history and invalidates stale renderer responses. The main process pauses Fusion forwarding and clears its session even if cloud revocation cannot be confirmed while offline. An upload already in flight may finish during signout.

Successful login verifies the account, reuses or creates its upload-only installation credential, and enables new Fusion uploads. Per-account credentials are protected with Windows credential encryption; the internal receiver's active token is stored in its private local data directory. Queued forwarding jobs remain tied to their original destination. Existing local history is preserved and is not silently merged into the account.

If the service is unavailable at startup, Trace stays on the account screen with **Try again**. It does not fall back to a different workspace. The local receiver remains an internal capture/queue component, not an alternate desktop account mode.

## Deployment settings

The current Edge API is `https://sbupyqgysoznucelwsij.supabase.co/functions/v1/trace`. Its `supabase/functions/trace/deployment-config.json` supplies `signupUrl` and the retained confirmation redirect. The released desktop gets the signup destination through `/api/config`, so changing that deployed setting does not require repackaging the desktop.

Supabase's Site URL is `https://tracenz.vercel.app`, and `https://tracenz.vercel.app/login?confirmed=1` is an allowed callback. The Edge signup destination and website origin are configured for this live site. Keep public client configuration separate from server-only Supabase/OpenAI secrets. The optional Node server also supports `TRACE_SIGNUP_URL` and `TRACE_AUTH_REDIRECT_URL`; those environment variables configure that server, not the released desktop's destination.

No SMTP service is configured for the current immediate-signup demo. Email confirmation and password-reset email flows would require working email delivery before being enabled. Password-reset UI, social login, team invitations, and shared judge roles are not implemented.

Accounts are isolated by the API and Supabase ownership rules. A judge who creates a new account sees that account's history, not another user's designs. See [LIVE-SETUP.md](LIVE-SETUP.md) for deployed configuration and maintenance details.
