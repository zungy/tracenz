// The desktop exposes account and design actions, never backend configuration.
function allowedRequest(path, method = "GET") {
  if (typeof path !== "string" || path.includes("#")) return false;
  const route = path.split("?")[0];
  // Account routes must match main-process dispatch exactly, so a query cannot
  // bypass the ordered login/logout and Fusion pairing operations.
  if (path.includes("?") && !(method === "GET" && route === "/api/events"))
    return false;
  if (method === "GET")
    return /^\/api\/(?:config|auth\/me|documents|forwarding|events(?:\/[0-9a-fA-F-]{36})?)$/.test(
      route,
    );
  if (method === "POST")
    return /^\/api\/(?:auth\/(?:login|logout)|forwarding\/retry|events(?:\/[0-9a-fA-F-]{36}\/retry-ai)?)$/.test(
      route,
    );
  if (method === "DELETE")
    return /^\/api\/events\/[0-9a-fA-F-]{36}$/.test(route);
  return false;
}
module.exports = { allowedRequest };
