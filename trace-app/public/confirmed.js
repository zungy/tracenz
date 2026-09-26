const params = new URLSearchParams(location.hash.slice(1));
const failed =
  params.has("error") || new URLSearchParams(location.search).has("error");
// Never retain or forward session credentials from an email redirect.
history.replaceState(null, "", location.pathname);
if (failed)
  document.querySelector("#confirmation-message").textContent =
    "This confirmation link could not be completed. Return to Trace and try signing in, or request a new confirmation email through your account administrator.";
