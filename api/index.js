// Vercel Node function: wraps the Express app built from src/server.ts (compiled to dist/ by `npm run build`).
import { buildApp } from "../dist/server.js";
import { stripRoutingParams } from "../dist/vercelUrl.js";

let appPromise;

export default async function handler(req, res) {
  appPromise ??= buildApp().catch((e) => {
    appPromise = undefined; // allow a retry on the next request instead of caching a failed init
    throw e;
  });
  try {
    const app = await appPromise;
    req.url = stripRoutingParams(req.url);
    return app(req, res);
  } catch (e) {
    console.error("startup failed:", e.message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "service not configured" }));
  }
}
