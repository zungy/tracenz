// Desktop and local forwarder share the same approved backend address format.
function backendUrl(value, { allowLocal = true } = {}) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const path = url.pathname.replace(/\/$/, "");
  const edge = path === "/functions/v1/trace";
  if (url.username || url.password || url.search || url.hash || (path && !edge))
    throw new Error(
      "Use a Trace backend origin or its /functions/v1/trace endpoint.",
    );
  if (url.protocol !== "https:" && !(allowLocal && local))
    throw new Error("Remote backends require HTTPS.");
  if (url.hostname.endsWith(".supabase.co") && !edge)
    throw new Error(
      "Use the deployed Trace Edge Function URL, including /functions/v1/trace.",
    );
  return url.origin + path;
}
module.exports = { backendUrl };
