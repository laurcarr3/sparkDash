import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { onceClose, openSshLlmTunnel } from "./llmTunnel.js";
import { sshExec } from "./ssh.js";

const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 30_000;
const REGISTRY_RELATIVE_PATH = ".spark-manager/registry.json";

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

/** Request a Spark Manager endpoint, tunneling loopback over SSH when remote. */
export async function requestSparkManager(spark, endpoint, opts = {}) {
  if (!/^\/models(?:\/(?:status|running)|\/[^/]+\/(?:start|stop))?$/.test(endpoint)) {
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
        payload
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

function registryCandidates(spark) {
  const configured = String(process.env.SPARK_MANAGER_REGISTRY_PATH || "").trim();
  if (configured) return [configured];

  const candidates = [path.join(os.homedir(), REGISTRY_RELATIVE_PATH)];
  const hostRoot = String(process.env.HOST_ROOT_PATH || "").trim();
  const user = String(spark?.ssh?.user || "").trim();
  if (hostRoot && user && /^[a-z_][a-z0-9_-]*[$]?$/i.test(user)) {
    candidates.unshift(path.join(hostRoot, "home", user, REGISTRY_RELATIVE_PATH));
  }
  return [...new Set(candidates)];
}

function parseRegistry(raw, source) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw upstreamError(`Unable to parse Spark Manager registry ${source}: ${cause.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw upstreamError(`Invalid Spark Manager registry ${source}: expected an object`);
  }
  return Object.entries(value).map(([displayName, entry]) => {
    if (!displayName.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw upstreamError(`Invalid Spark Manager registry entry ${JSON.stringify(displayName)}`);
    }
    const workspaceDirectory = entry.workspaceDirectory;
    if (typeof workspaceDirectory !== "string" || !workspaceDirectory.trim()) {
      throw upstreamError(`Invalid workspaceDirectory for ${JSON.stringify(displayName)}`);
    }
    return {
      displayName,
      workspaceDirectory,
      ...(Array.isArray(entry.launchOptions) ? { launchOptions: entry.launchOptions } : {}),
    };
  });
}

/** Read registry.json so new metadata need not wait on an API release. */
export async function readSparkManagerRegistry(spark, opts = {}) {
  const execRemote = opts.sshExecImpl || sshExec;
  if (!spark?.isLocal) {
    const raw = await execRemote(spark, 'cat "$HOME/.spark-manager/registry.json"', {
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { models: parseRegistry(raw, "~/.spark-manager/registry.json") };
  }

  const readFileImpl = opts.readFileImpl || fs.readFile;
  let lastError;
  for (const candidate of opts.registryPaths || registryCandidates(spark)) {
    try {
      return { models: parseRegistry(await readFileImpl(candidate, "utf8"), candidate) };
    } catch (error) {
      lastError = error;
    }
  }
  throw upstreamError(`Unable to read Spark Manager registry: ${lastError?.message || "not found"}`);
}

/** Enrich live API data with registry-only fields such as launchOptions. */
export async function discoverSparkManagerModels(spark, opts = {}) {
  const apiPayload = await fetchSparkManager(spark, "/models", opts);
  let registry;
  try {
    registry = await readSparkManagerRegistry(spark, opts);
  } catch {
    return apiPayload;
  }
  const byName = new Map(registry.models.map((model) => [model.displayName, model]));
  return {
    ...apiPayload,
    models: apiPayload.models.map((model) => ({
      ...byName.get(model.displayName),
      ...model,
      launchOptions: model.launchOptions ?? byName.get(model.displayName)?.launchOptions,
    })),
  };
}
