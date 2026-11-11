import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLogsEndpoint,
  fetchSparkManager,
  requestSparkManager,
  sanitizeErrorPayload,
} from "../SparkManager.js";

const OPERATION_ID = "op_0123456789abcdef0123456789abcdef";

function accepted(kind) {
  return {
    operationId: OPERATION_ID,
    kind,
    model: "model-a",
    desiredState: kind === "start" ? "running" : "stopped",
    lifecycleState: "queued",
    operationStatus: "queued",
    statusUrl: `/operations/${OPERATION_ID}`,
    modelStatusUrl: "/models/model-a/status",
  };
}

const RUNNING_RUNTIME = {
  observed: true,
  present: true,
  containers: [{
    id: "4f0c",
    name: "model-a",
    running: true,
    restarting: false,
    status: "running",
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    startedAt: "2026-10-29T09:12:44.123Z",
    finishedAt: null,
  }],
  error: null,
};

function readiness(overrides = {}) {
  return {
    configured: true,
    ready: false,
    source: "probe",
    endpoint: "http://127.0.0.1:8888/v1/models",
    httpStatus: null,
    servedModelIds: [],
    checkedAt: "2026-10-29T09:13:00.000Z",
    error: null,
    ...overrides,
  };
}

function readinessTimeout() {
  return {
    operationId: OPERATION_ID,
    kind: "start",
    code: "READINESS_TIMEOUT",
    message: "The model did not report ready within 15 minutes.",
    at: "2026-10-29T09:28:00.000Z",
    exitCode: null,
    signal: null,
    retrySafe: false,
    logTail: ["Waiting for readiness", "Start failed (READINESS_TIMEOUT)"],
  };
}

function managedStatus(overrides = {}) {
  return {
    displayName: "model-a",
    lifecycleState: "stopped",
    externallyManaged: false,
    desiredState: null,
    activeOperation: null,
    lastOperation: null,
    lastError: null,
    runtime: { observed: true, present: false, containers: [], error: null },
    readiness: readiness({ checkedAt: null }),
    ...overrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("local Spark Manager discovery stays on loopback and forwards auth", async () => {
  let request;
  const result = await fetchSparkManager({ isLocal: true }, "/models", {
    port: 3456,
    token: "secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { models: [{ displayName: "Model A", workspaceDirectory: "/a" }] });
    },
  });

  assert.equal(request.url, "http://127.0.0.1:3456/models");
  assert.equal(request.init.headers.Authorization, "Bearer secret");
  assert.match(request.init.headers["X-Request-Id"], /^[0-9a-f-]{36}$/);
  assert.equal(result.models[0].displayName, "Model A");
});

test("Spark Manager requests preserve correlation IDs without logging tokens", async () => {
  const entries = [];
  const logger = {
    info: (message) => entries.push(JSON.parse(message)),
    warn: (message) => entries.push(JSON.parse(message)),
    error: (message) => entries.push(JSON.parse(message)),
  };
  let request;
  await requestSparkManager({ id: "local", isLocal: true }, "/models/model-a/start", {
    requestId: "browser-123",
    token: "must-not-be-logged",
    logger,
    method: "POST",
    body: {},
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { model: { displayName: "model-a" } });
    },
  });

  assert.equal(request.init.headers["X-Request-Id"], "browser-123");
  assert.equal(entries[0].requestId, "browser-123");
  assert.equal(entries[0].tokenConfigured, true);
  assert.equal(entries.at(-1).event, "request.completed");
  assert.equal(JSON.stringify(entries).includes("must-not-be-logged"), false);
});

test("Spark Manager status requests do not emit proxy logs", async () => {
  const entries = [];
  const logger = {
    info: (message) => entries.push(message),
    warn: (message) => entries.push(message),
    error: (message) => entries.push(message),
  };
  await fetchSparkManager({ isLocal: true }, "/models/status", {
    logger,
    fetchImpl: async () => response(200, { models: [] }),
  });
  assert.deepEqual(entries, []);
});

test("remote Spark Manager discovery uses and closes an SSH loopback tunnel", async () => {
  let closed = false;
  const result = await fetchSparkManager({ isLocal: false }, "/models/status", {
    port: 3000,
    openTunnel: async () => ({
      host: "127.0.0.1",
      port: 45678,
      via: "ssh-tunnel",
      close: () => {
        closed = true;
      },
    }),
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:45678/models/status");
      return response(200, { models: [] });
    },
  });

  assert.deepEqual(result, { models: [] });
  assert.equal(closed, true);
});

test("Spark Manager errors retain their status and message", async () => {
  await assert.rejects(
    fetchSparkManager({ isLocal: true }, "/models/status", {
      fetchImpl: async () =>
        response(401, { error: { code: "UNAUTHORIZED", message: "Invalid token" } }),
    }),
    (error) => error.status === 401 && error.message === "Invalid token"
  );
});

test("Spark Manager connection failures are described as upstream errors", async () => {
  await assert.rejects(
    fetchSparkManager({ isLocal: true }, "/models", {
      fetchImpl: async () => {
        const error = new Error("fetch failed");
        error.cause = { code: "ECONNREFUSED" };
        throw error;
      },
    }),
    (error) => error.status === 502 && /ECONNREFUSED/.test(error.message)
  );
});

test("lifecycle requests forward JSON and the bearer token", async () => {
  let request;
  const result = await requestSparkManager(
    { isLocal: true },
    "/models/model-a/start",
    {
      token: "secret",
      method: "POST",
      body: { switchRunning: true, launchOptionSelections: { profile: "compact" } },
      fetchImpl: async (url, init) => {
        request = { url, init };
        return response(202, accepted("start"));
      },
    }
  );

  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["Content-Type"], "application/json");
  assert.equal("Idempotency-Key" in request.init.headers, false);
  assert.deepEqual(JSON.parse(request.init.body), {
    switchRunning: true,
    launchOptionSelections: { profile: "compact" },
  });
  assert.equal(result.model, "model-a");
  assert.equal(result.operationId, OPERATION_ID);
});

test("structured lifecycle endpoints and bounded log queries are allowed", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return response(200, { operationId: OPERATION_ID, lines: [] });
  };
  await requestSparkManager({ isLocal: true }, "/models/model-a/status", { fetchImpl });
  await requestSparkManager({ isLocal: true }, "/models/model-a/logs?after=12&limit=100", { fetchImpl });
  await requestSparkManager({ isLocal: true }, `/operations/${OPERATION_ID}`, { fetchImpl });
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/models/model-a/status",
    "http://127.0.0.1:3000/models/model-a/logs?after=12&limit=100",
    `http://127.0.0.1:3000/operations/${OPERATION_ID}`,
  ]);
});

test("Spark Manager proxy rejects unsupported log query parameters", async () => {
  for (const endpoint of [
    "/models/model-a/logs?path=/etc/passwd",
    "/models/model-a/logs?cursor=12&limit=100",
  ]) {
    await assert.rejects(
      requestSparkManager({ isLocal: true }, endpoint, { fetchImpl: async () => response(200, {}) }),
      /Unsupported Spark Manager endpoint/
    );
  }
});

test("Spark Manager proxy only allows op_ operation IDs", async () => {
  for (const operationId of ["op-1", "op_0123", `${OPERATION_ID}0`, "OP_0123456789ABCDEF0123456789ABCDEF"]) {
    await assert.rejects(
      requestSparkManager({ isLocal: true }, `/operations/${operationId}`, {
        fetchImpl: async () => response(200, {}),
      }),
      /Unsupported Spark Manager endpoint/
    );
  }
});

test("log queries are rebuilt with after and limit only", () => {
  assert.equal(buildLogsEndpoint("qwen3.8-27b"), "/models/qwen3.8-27b/logs?after=0&limit=200");
  assert.equal(
    buildLogsEndpoint("a b", { after: "41", limit: "1000" }),
    "/models/a%20b/logs?after=41&limit=1000"
  );
  for (const query of [
    { cursor: "12" },
    { after: "-1" },
    { after: "1.5" },
    { after: ["1", "2"] },
    { after: "" },
    { limit: "0" },
    { limit: "1001" },
  ]) {
    assert.throws(
      () => buildLogsEndpoint("model-a", query),
      (error) => error.status === 400 && error.payload.error.code === "INVALID_LOG_QUERY",
      JSON.stringify(query)
    );
  }
});

test("lifecycle callers can preserve an upstream 202 response", async () => {
  let status;
  const result = await requestSparkManager({ isLocal: true }, "/models/model-a/start", {
    method: "POST",
    body: {},
    onResponse: (meta) => { status = meta.status; },
    fetchImpl: async () => response(202, {
      operationId: OPERATION_ID,
      kind: "start",
      model: "model-a",
      desiredState: "running",
      lifecycleState: "queued",
      operationStatus: "queued",
      statusUrl: `/operations/${OPERATION_ID}`,
      modelStatusUrl: "/models/model-a/status",
    }),
  });
  assert.equal(status, 202);
  assert.equal(result.operationId, OPERATION_ID);
});

test("lifecycle refusals keep their status, code and details", async () => {
  await assert.rejects(
    requestSparkManager({ isLocal: true }, "/models/model-a/stop", {
      method: "POST",
      body: {},
      logger: false,
      fetchImpl: async () => response(409, {
        error: {
          code: "OPERATION_IN_PROGRESS",
          message: "model-a already has an active operation.",
          activeOperationId: OPERATION_ID,
          activeModel: "model-a",
        },
      }),
    }),
    (error) =>
      error.status === 409 &&
      error.message === "model-a already has an active operation." &&
      error.payload.error.code === "OPERATION_IN_PROGRESS" &&
      error.payload.error.activeOperationId === OPERATION_ID
  );
});


test("Layer 4 status fields pass through the proxy unchanged", async () => {
  const models = [
    // Containers up, probe not answering yet: starting, not running.
    managedStatus({
      lifecycleState: "starting",
      desiredState: "running",
      activeOperation: { operationId: OPERATION_ID, kind: "start", status: "running" },
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ error: "connect ECONNREFUSED 127.0.0.1:8888" }),
    }),
    // Started by the CLI and answering.
    managedStatus({
      displayName: "model-b",
      lifecycleState: "running",
      externallyManaged: true,
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ ready: true, source: "none", endpoint: null, configured: false, checkedAt: null }),
    }),
    // READINESS_TIMEOUT while the model still loads: failed, containers present.
    managedStatus({
      displayName: "model-c",
      lifecycleState: "failed",
      desiredState: "running",
      lastOperation: { operationId: OPERATION_ID, kind: "start", status: "failed" },
      lastError: readinessTimeout(),
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ error: "HTTP 503", httpStatus: 503 }),
    }),
    // Became ready after the failed start: running, lastError kept.
    managedStatus({
      displayName: "model-d",
      lifecycleState: "running",
      desiredState: "running",
      lastOperation: { operationId: OPERATION_ID, kind: "start", status: "failed" },
      lastError: readinessTimeout(),
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ ready: true, httpStatus: 200, servedModelIds: ["model-d"] }),
    }),
  ];
  const result = await fetchSparkManager({ isLocal: true }, "/models/status", {
    fetchImpl: async () => response(200, { models }),
  });

  assert.deepEqual(result, { models });
  const [starting, external, timedOut, recovered] = result.models;
  assert.equal(starting.lifecycleState, "starting");
  assert.equal(starting.readiness.ready, false);
  assert.equal(starting.readiness.error, "connect ECONNREFUSED 127.0.0.1:8888");
  assert.equal(external.externallyManaged, true);
  assert.equal(timedOut.lastError.code, "READINESS_TIMEOUT");
  assert.equal(timedOut.lastError.retrySafe, false);
  assert.equal(recovered.lifecycleState, "running");
  assert.equal(recovered.lastError.code, "READINESS_TIMEOUT");
});

test("an operation that failed with READINESS_TIMEOUT keeps its error details", async () => {
  const operation = {
    operationId: OPERATION_ID,
    kind: "start",
    displayName: "model-a",
    status: "failed",
    requestId: "req-1",
    options: { switchRunning: false },
    createdAt: "2026-10-29T09:12:00.000Z",
    startedAt: "2026-10-29T09:12:01.000Z",
    finishedAt: "2026-10-29T09:28:00.000Z",
    command: { exitCode: 0, signal: null },
    error: readinessTimeout(),
  };
  const result = await requestSparkManager({ isLocal: true }, `/operations/${OPERATION_ID}`, {
    fetchImpl: async () => response(200, { operation }),
  });
  assert.deepEqual(result, { operation });
});

test("MODEL_ALREADY_RUNNING details are reduced to model identities", async () => {
  const upstream = {
    error: {
      code: "MODEL_ALREADY_RUNNING",
      message: "Another registered model is running. Retry with switchRunning set to true to stop it first.",
      runningModels: [{
        displayName: "model-b",
        workspaceDirectory: "/models/b",
        containerNames: ["model-b"],
        readiness: { url: "http://user:pass@127.0.0.1:8888/v1/models?key=secret" },
        launchOptions: [{
          id: "auth",
          label: "Auth",
          choices: [{ id: "on", label: "On", environment: { HF_TOKEN: "hf_unmaskedsecretvalue" } }],
        }],
      }],
    },
  };
  await assert.rejects(
    requestSparkManager({ isLocal: true }, "/models/model-a/start", {
      method: "POST",
      body: { switchRunning: false },
      logger: false,
      fetchImpl: async () => response(409, upstream),
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.deepEqual(error.payload, {
        error: {
          code: "MODEL_ALREADY_RUNNING",
          message: upstream.error.message,
          runningModels: [{ displayName: "model-b", workspaceDirectory: "/models/b" }],
        },
      });
      assert.equal(JSON.stringify(error.payload).includes("hf_unmasked"), false);
      assert.equal(JSON.stringify(error.payload).includes("pass@"), false);
      return true;
    }
  );
});

test("error payloads without runningModels are left untouched", () => {
  const payload = { error: { code: "LIFECYCLE_LOCK_HELD", message: "CLI busy", ownerPid: 42 } };
  assert.equal(sanitizeErrorPayload(payload), payload);
  assert.equal(sanitizeErrorPayload(null), null);
});

test("RUNTIME_INSPECTION_FAILED keeps its 503 status and code", async () => {
  await assert.rejects(
    requestSparkManager({ isLocal: true }, "/models/model-a/start", {
      method: "POST",
      body: {},
      logger: false,
      fetchImpl: async () => response(503, {
        error: { code: "RUNTIME_INSPECTION_FAILED", message: "Unable to check for running models: docker down" },
      }),
    }),
    (error) => error.status === 503 && error.payload.error.code === "RUNTIME_INSPECTION_FAILED"
  );
});
