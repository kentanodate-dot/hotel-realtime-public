// Read-only connectivity test for Deno Deploy Free.
// No account credentials, no cookies, no background schedule, no persistent writes.
// Calls are manually triggered and lightly rate-limited per running instance.
const TARGETS = [
  { label: "HappyHotel hotel page", url: "https://happyhotel.jp/hotels/541262" },
  { label: "HappyHotel room page", url: "https://happyhotel.jp/reserve/keep/hotels/541262" },
  { label: "Hotenavi room page", url: "https://www.hotenavi.com/hihi/empty/" },
];
let lastProbeAt = 0;
function json(data, status = 200) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}
Deno.serve(async (request) => {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  if (path === "/") return json({
    service: "hotel-remote-access-check",
    ok: true,
    scheduled: false,
    authRequired: false,
    note: "Use GET /probe once to test outbound connectivity. No hotel login or session data is sent.",
  });
  if (path !== "/probe") return json({ error: "Not found" }, 404);
  const now = Date.now();
  if (now - lastProbeAt < 60000) return json({ error: "Retry after one minute" }, 429);
  lastProbeAt = now;
  const results = [];
  for (const target of TARGETS) {
    try {
      const response = await fetch(target.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: "text/html",
          "Accept-Language": "ja-JP,ja;q=0.9",
        },
      });
      const html = await response.text();
      results.push({
        source: target.label,
        httpStatus: response.status,
        finalHost: new URL(response.url).hostname,
        htmlReceived: html.length > 100,
        embeddedRoomData: /__NEXT_DATA__|emptyRoom|空室\s*[0-9０-９]+\s*室/.test(html),
        responseBytes: new TextEncoder().encode(html).byteLength,
      });
    } catch (error) {
      results.push({
        source: target.label,
        errorType: error instanceof Error ? error.name : "RequestFailed",
      });
    }
  }
  return json({
    testedAt: new Date().toISOString(),
    caveat: "HTTP 200 is not proof that member-only room data or Playwright login works.",
    results,
  });
});
