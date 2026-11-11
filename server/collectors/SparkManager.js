import { randomUUID } from "node:crypto";
import { onceClose, openSshLlmTunnel } from "./llmTunnel.js";

const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;
export const OPERATION_ID_PATTERN = /^op_[a-f0-9]{32}$/;

function configuredPort() {
  const port = Number(process.env.SPARK_MANAGER_API_PORT || DEFAULT_PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

function upstreamError(message, status = 502, payload) {
  const error = new Error(message);
  error.status = status;
  if (payload !== undefined) error.payload = payload;
  return error;
}

function validRequestId(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : null;
}

function describeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.cause?.code ? { causeCode: error.cause.code } : {}),
  };
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("/")) return false;
  let parsed;
  try {
    parsed = new URL(endpoint, "http://spark-manager.invalid");
  } catch {
    return false;
  }
  if (parsed.origin !== "http://spark-manager.invalid" || parsed.hash) return false;
  const pathAllowed =
    /^\/models(?:\/(?:status|running)|\/[^/]+\/(?:start|stop|status|logs))?$/.test(parsed.pathname) ||
    OPERATION_ID_PATTERN.test(parsed.pathname.replace(/^\/operations\//, ""));
  if (!pathAllowed) return false;
  if (!parsed.search) return true;
  if (!/\/models\/[^/]+\/logs$/.test(parsed.pathname)) return false;
  return [...parsed.searchParams.keys()].every((key) => key === "after" || key === "limit");
}

/**
 * Spark Manager's 409 MODEL_ALREADY_RUNNING lists whole registry entries in
 * `runningModels`, including unmasked launch option environments and the raw
 * readiness URL. The browser only needs to name them, so keep identity fields.
 */
export function sanitizeErrorPayload(payload) {
  const error = payload?.error;
  if (!error || typeof error !== "object" || !Array.isArray(error.runningModels)) return payload;
  return {
    ...payload,
    error: {
      ...error,
      runningModels: error.runningModels
        .filter((model) => model && typeof model.displayName === "string")
        .map(({ displayName, workspaceDirectory }) => ({
          displayName,
          ...(typeof workspaceDirectory === "string" ? { workspaceDirectory } : {}),
        })),
    },
  };
}

function invalidLogQuery(message) {
  return upstreamError(message, 400, { error: { code: "INVALID_LOG_QUERY", message } });
}

/**
 * Build the upstream logs endpoint from a browser query. Mirrors Spark
 * Manager's own rules: only `after` (non-negative integer) and `limit`
 * (1..1000), each at most once.
 */
export function buildLogsEndpoint(displayName, query = {}) {
  const result = { after: 0, limit: DEFAULT_LOG_LIMIT };
  for (const [name, value] of Object.entries(query)) {
    if (name !== "after" && name !== "limit") {
      throw invalidLogQuery(`Unexpected query parameter ${JSON.stringify(name)}`);
    }
    const number = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
    const [min, max] = name === "after" ? [0, Number.MAX_SAFE_INTEGER] : [1, MAX_LOG_LIMIT];
    if (!(number >= min && number <= max)) {
      throw invalidLogQuery(`${name} must be a single integer from ${min} to ${max}`);
    }
    result[name] = number;
  }
  const params = new URLSearchParams({ after: String(result.after), limit: String(result.limit) });
  return `/models/${encodeURIComponent(displayName)}/logs?${params}`;
}

/** Request a Spark Manager endpoint, tunneling loopback over SSH when remote. */
export async function requestSparkManager(spark, endpoint, opts = {}) {
  if (!validateEndpoint(endpoint)) {
    throw new Error("Unsupported Spark Manager endpoint");
  }

  const port = opts.port ?? configuredPort();
  const token = opts.token ?? process.env.SPARK_MANAGER_API_TOKEN ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  const openTunnel = opts.openTunnel || openSshLlmTunnel;
  const method = opts.method ?? "GET";
  const requestId = validRequestId(opts.requestId) || randomUUID();
  const isLifecycleRequest = method === "POST" && /\/(?:start|stop)$/.test(endpoint);
  const logger = opts.logger === false || !isLifecycleRequest ? null : (opts.logger || console);
  const startedAt = performance.now();
  let responseStatus = null;
  let target = {
    host: "127.0.0.1",
    port,
    via: "direct",
    close: onceClose(() => {}),
  };

  logger?.info(JSON.stringify({
    service: "sparkdash",
    component: "spark-manager-proxy",
    event: "request.started",
    requestId,
    sparkId: spark?.id ?? null,
    method,
    endpoint,
    managerPort: port,
    remoteSpark: !spark?.isLocal,
    tokenConfigured: Boolean(String(token).trim()),
    body: opts.body ?? null,
  }));

  try {
    if (!spark?.isLocal) target = await openTunnel(spark, port);

    logger?.info(JSON.stringify({
      service: "sparkdash",
      component: "spark-manager-proxy",
      event: "target.ready",
      requestId,
      via: target.via,
      targetHost: target.host,
      targetPort: target.port,
    }));

    const headers = { "X-Request-Id": requestId };
    if (String(token).trim()) headers.Authorization = `Bearer ${String(token).trim()}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetchImpl(`http://${target.host}:${target.port}${endpoint}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const detail = cause?.cause?.code || cause?.cause?.message || cause?.message || String(cause);
      throw upstreamError(`Unable to reach Spark Manager: ${detail}`);
    }

    const payload = await response.json().catch(() => null);
    responseStatus = response.status;
    opts.onResponse?.({ status: response.status });
    logger?.[response.ok ? "info" : "warn"](JSON.stringify({
      service: "sparkdash",
      component: "spark-manager-proxy",
      event: "response.received",
      requestId,
      status: response.status,
      ok: response.ok,
      responseRequestId: response.headers?.get?.("x-request-id") ?? null,
      payloadShape: payload && typeof payload === "object"
        ? (Array.isArray(payload) ? "array" : Object.keys(payload))
        : typeof payload,
    }));
    if (!response.ok) {
      throw upstreamError(
        payload?.error?.message || `Spark Manager returned HTTP ${response.status}`,
        response.status,
        sanitizeErrorPayload(payload)
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw upstreamError("Spark Manager returned an invalid JSON response");
    }
    return payload;
  } catch (error) {
    logger?.error(JSON.stringify({
      service: "sparkdash",
      component: "spark-manager-proxy",
      event: "request.failed",
      requestId,
      method,
      endpoint,
      error: describeError(error),
    }));
    throw error;
  } finally {
    target.close();
    logger?.info(JSON.stringify({
      service: "sparkdash",
      component: "spark-manager-proxy",
      event: "request.completed",
      requestId,
      method,
      endpoint,
      status: responseStatus,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      tunnelClosed: true,
    }));
  }
}

/** Backward-compatible discovery helper used by existing callers. */
export async function fetchSparkManager(spark, endpoint, opts = {}) {
  const payload = await requestSparkManager(spark, endpoint, opts);
  if (!Array.isArray(payload.models)) {
    throw upstreamError("Spark Manager returned an invalid models response");
  }
  return payload;
}
