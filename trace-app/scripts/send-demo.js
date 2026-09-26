import { demoEnvelopes } from "../server/demo.js";
const base = process.env.TRACE_API_URL || "http://127.0.0.1:4318";
for (const body of demoEnvelopes()) {
  const response = await fetch(`${base}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TRACE_INGEST_TOKEN
        ? { Authorization: `Bearer ${process.env.TRACE_INGEST_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  console.log(
    body.event.engineeringChanges[0].feature.name,
    result.eventId,
    result.duplicate ? "already saved" : "saved",
  );
}
