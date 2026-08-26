import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";

export const V1_MEDIA_PATH = "/ws/media";
export const V2_MEDIA_PATH = "/ws/media-v2";

export function isVoiceV2RouteEnabled(value) {
  return value === "true";
}

export function attachIsolatedVoiceRoutes({
  server,
  attachV1,
  v2EnabledValue,
  initializeV2Session,
  logger = console,
  buildSha = "unknown",
  WebSocketServerClass = WebSocketServer,
}) {
  if (!server || typeof server.on !== "function") throw new TypeError("server_required");
  if (typeof attachV1 !== "function") throw new TypeError("attach_v1_required");

  const v1UpgradeTarget = new EventEmitter();
  const v1WebSocketServer = attachV1(v1UpgradeTarget);
  const v2WebSocketServer = new WebSocketServerClass({ noServer: true });
  const v2Enabled = isVoiceV2RouteEnabled(v2EnabledValue);

  emitLog(logger, {
    event: "V2_ROUTE_CONFIGURED",
    route: V2_MEDIA_PATH,
    enabled: v2Enabled,
    buildSha,
  });

  v2WebSocketServer.on("connection", (socket, request) => {
    emitLog(logger, {
      event: "V2_ROUTE_SESSION_ACCEPTED",
      route: V2_MEDIA_PATH,
      requestPath: request?.url || null,
      buildSha,
    });

    if (typeof initializeV2Session !== "function") {
      emitLog(logger, {
        event: "V2_ROUTE_SESSION_INITIALIZATION_FAILED",
        route: V2_MEDIA_PATH,
        reason: "INITIALIZER_UNAVAILABLE",
        buildSha,
      }, "error");
      closeSafely(socket, 1011, "V2 session unavailable");
      return;
    }

    try {
      const initialized = initializeV2Session({ socket, request, buildSha });
      Promise.resolve(initialized).then(
        () => emitLog(logger, { event: "V2_ROUTE_SESSION_STARTED", route: V2_MEDIA_PATH, requestPath: request?.url || null, buildSha }),
        (error) => failInitialization({ logger, socket, error, buildSha }),
      );
    } catch (error) {
      failInitialization({ logger, socket, error, buildSha });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const requestPath = request?.url || "";
    const upgrade = String(request?.headers?.upgrade || "").toLowerCase();
    if (upgrade !== "websocket") return destroySafely(socket);

    if (matchesPath(requestPath, V1_MEDIA_PATH)) {
      v1UpgradeTarget.emit("upgrade", request, socket, head);
      return;
    }

    if (!matchesPath(requestPath, V2_MEDIA_PATH)) return destroySafely(socket);

    if (!v2Enabled) {
      emitLog(logger, {
        event: "V2_ROUTE_FLAG_DISABLED",
        route: V2_MEDIA_PATH,
        requestPath,
        buildSha,
      });
      destroySafely(socket);
      return;
    }

    try {
      v2WebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        v2WebSocketServer.emit("connection", webSocket, request);
      });
    } catch (error) {
      emitLog(logger, {
        event: "V2_ROUTE_UPGRADE_FAILED",
        route: V2_MEDIA_PATH,
        requestPath,
        error: safeError(error),
        buildSha,
      }, "error");
      destroySafely(socket);
    }
  });

  return Object.freeze({
    v1WebSocketServer,
    v2WebSocketServer,
    v2Enabled,
    paths: Object.freeze({ v1: V1_MEDIA_PATH, v2: V2_MEDIA_PATH }),
  });
}

function matchesPath(requestPath, routePath) {
  return requestPath === routePath || requestPath.startsWith(`${routePath}?`) || requestPath.startsWith(`${routePath}/`);
}

function failInitialization({ logger, socket, error, buildSha }) {
  emitLog(logger, {
    event: "V2_ROUTE_SESSION_INITIALIZATION_FAILED",
    route: V2_MEDIA_PATH,
    reason: "INITIALIZER_FAILED",
    error: safeError(error),
    buildSha,
  }, "error");
  closeSafely(socket, 1011, "V2 initialization failed");
}

function emitLog(logger, event, level = "info") {
  const writer = logger?.[level] || logger?.log;
  if (typeof writer === "function") writer.call(logger, Object.freeze({ ...event }));
}

function safeError(error) {
  return Object.freeze({ name: error?.name || "Error", message: error?.message || String(error) });
}

function destroySafely(socket) {
  try { socket?.destroy?.(); } catch {}
}

function closeSafely(socket, code, reason) {
  try { socket?.close?.(code, reason); } catch {}
}
