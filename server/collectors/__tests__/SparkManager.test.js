import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverSparkManagerModels,
  fetchSparkManager,
  readSparkManagerRegistry,
  requestSparkManager,
} from "../SparkManager.js";

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

test("registry launch options enrich an older API response", async () => {
  const result = await discoverSparkManagerModels({ isLocal: true }, {
    registryPaths: ["/registry.json"],
    readFileImpl: async () => JSON.stringify({
      "model-a": {
        workspaceDirectory: "/models/a",
        launchOptions: [{
          id: "profile",
          label: "Profile",
          defaultChoice: "balanced",
          choices: [{ id: "balanced", label: "Balanced", environment: { CONTEXT: "131072" } }],
        }],
      },
    }),
    fetchImpl: async () => response(200, {
      models: [{ displayName: "model-a", workspaceDirectory: "/models/a" }],
    }),
  });

  assert.equal(result.models[0].launchOptions[0].defaultChoice, "balanced");
});

test("remote registry is read from the Spark user's home directory", async () => {
  let command;
  const result = await readSparkManagerRegistry({ isLocal: false }, {
    sshExecImpl: async (_spark, cmd) => {
      command = cmd;
      return JSON.stringify({ "model-a": { workspaceDirectory: "/models/a" } });
    },
  });

  assert.equal(command, 'cat "$HOME/.spark-manager/registry.json"');
  assert.equal(result.models[0].displayName, "model-a");
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
        return response(200, { model: { displayName: "model-a" }, command: { exitCode: 0 } });
      },
    }
  );

  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.init.body), {
    switchRunning: true,
    launchOptionSelections: { profile: "compact" },
  });
  assert.equal(result.model.displayName, "model-a");
});
