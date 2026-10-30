import express from "express";
import { errorHandler } from "./errors.js";
import { catalogRoutes, mockProviderRoutes, orderRoutes, webhookRoutes, type Deps } from "./routes.js";

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");

  // Raw-body webhook route goes first, before express.json() consumes the stream.
  app.use(webhookRoutes(deps));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(catalogRoutes(deps));
  app.use(orderRoutes(deps));
  if (deps.config.mockProviderEnabled) app.use(mockProviderRoutes(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "route_not_found", message: "No such route" } });
  });
  app.use(errorHandler);
  return app;
}
