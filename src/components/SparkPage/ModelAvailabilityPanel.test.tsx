import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type {
  ModelLifecycleError,
  ModelLifecycleLogLine,
  ModelLifecycleLogsResponse,
  ModelLifecycleStatus,
  ModelReadinessStatus,
  RegisteredModel,
} from "../../api/types";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchRegisteredModels: vi.fn(),
  fetchRegisteredModelStatuses: vi.fn(),
  fetchRegisteredModelLogs: vi.fn(),
  fetchRegisteredModelOperation: vi.fn(),
  startRegisteredModel: vi.fn(),
  stopRegisteredModel: vi.fn(),
}));

import {
  ApiRequestError,
  fetchRegisteredModels,
  fetchRegisteredModelStatuses,
  fetchRegisteredModelLogs,
  fetchRegisteredModelOperation,
  startRegisteredModel,
  stopRegisteredModel,
} from "../../api/client";
import { ModelAvailabilityPanel, mayStillBeLoading, modelDisplayState } from "./ModelAvailabilityPanel";

const fetchModels = vi.mocked(fetchRegisteredModels);
const fetchStatuses = vi.mocked(fetchRegisteredModelStatuses);
const fetchLogs = vi.mocked(fetchRegisteredModelLogs);
const fetchOperation = vi.mocked(fetchRegisteredModelOperation);
const startModel = vi.mocked(startRegisteredModel);
const stopModel = vi.mocked(stopRegisteredModel);

const OP_A = "op_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OP_B = "op_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ENDPOINT = "http://127.0.0.1:8888/v1/models";
const RUNNING_RUNTIME = {
  observed: true,
  present: true,
  containers: [{
    id: "4f0c00000000",
    name: "deepseek",
    running: true,
    restarting: false,
    status: "running",
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    startedAt: "2026-10-29T12:00:00.000Z",
    finishedAt: null,
  }],
  error: null,
};

function readiness(overrides: Partial<ModelReadinessStatus> = {}): ModelReadinessStatus {
  return {
    configured: true,
    ready: false,
    source: "probe",
    endpoint: ENDPOINT,
    httpStatus: null,
    servedModelIds: [],
    checkedAt: null,
    error: null,
    ...overrides,
  };
}

function status(overrides: Partial<ModelLifecycleStatus> = {}): ModelLifecycleStatus {
  return {
    displayName: "DeepSeek-v4",
    lifecycleState: "stopped",
    externallyManaged: false,
    desiredState: null,
    activeOperation: null,
    lastOperation: null,
    lastError: null,
    runtime: { observed: true, present: false, containers: [], error: null },
    readiness: readiness(),
    ...overrides,
  };
}

function lifecycleError(overrides: Partial<ModelLifecycleError> = {}): ModelLifecycleError {
  return {
    operationId: OP_A,
    kind: "start",
    code: "START_COMMAND_FAILED",
    message: "The start command exited with status 3.",
    at: new Date().toISOString(),
    exitCode: 3,
    signal: null,
    retrySafe: false,
    logTail: [],
    ...overrides,
  };
}

function readinessTimeout(logTail: string[] = []) {
  return lifecycleError({
    code: "READINESS_TIMEOUT",
    message: "The model did not report ready within 15 minutes.",
    exitCode: null,
    logTail,
  });
}

function registryEntry(model: ModelLifecycleStatus, extra: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    displayName: model.displayName,
    workspaceDirectory: `/models/${model.displayName.toLowerCase()}`,
    readiness: { url: ENDPOINT },
    ...extra,
  };
}

function logLines(prefix: string, from: number, to: number): ModelLifecycleLogLine[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({
    seq: from + index,
    at: "2026-10-29T12:00:00.000Z",
    stream: "stdout" as const,
    text: `${prefix}-${String(from + index).padStart(4, "0")}`,
  }));
}

function logsPage(
  operationId: string | null,
  lines: ModelLifecycleLogLine[],
  overrides: Partial<ModelLifecycleLogsResponse> = {}
): ModelLifecycleLogsResponse {
  return {
    displayName: "DeepSeek-v4",
    operationId,
    operationKind: operationId ? "start" : null,
    operationStatus: operationId ? "running" : null,
    lines,
    nextAfter: lines.at(-1)?.seq ?? 0,
    truncated: false,
    hasMore: false,
    ...overrides,
  };
}

async function renderPanel(models: ModelLifecycleStatus[], registry = models.map((model) => registryEntry(model))) {
  fetchModels.mockResolvedValue({ models: registry });
  fetchStatuses.mockResolvedValue({ models });
  fetchLogs.mockResolvedValue(logsPage(null, []));
  fetchOperation.mockRejectedValue(new Error("not needed"));
  const result = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
  await flush();
  await flush();
  await flush();
  return result;
}

function actionButton(container: HTMLElement) {
  return container.querySelector("li div.mt-3.flex button:last-child") as HTMLButtonElement;
}

function chip(container: HTMLElement) {
  return container.querySelector("li span.rounded.px-2") as HTMLElement;
}

function byTestId(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="${id}"]`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelAvailabilityPanel", () => {
  it("reads the lifecycle state reported by Spark Manager", () => {
    expect(modelDisplayState(status({ lifecycleState: "running" }))).toBe("running");
    expect(modelDisplayState(status({ lifecycleState: "queued" }))).toBe("queued");
    expect(modelDisplayState(undefined)).toBe("unknown");
  });

  it("joins registry entries and statuses by display name without mixing their readiness fields", async () => {
    const models = [
      status({ lifecycleState: "running", runtime: RUNNING_RUNTIME, readiness: readiness({ ready: true, httpStatus: 200 }) }),
      status({ displayName: "Qwen" }),
    ];
    fetchModels.mockResolvedValue({ models: models.map((model) => registryEntry(model)) });
    fetchStatuses.mockResolvedValue({ models });

    const { container } = render(
      <ModelAvailabilityPanel sparkId="spark-1" servedModelIds={["org/deepseek-v4"]} />
    );
    await flush();
    await flush();

    expect(container.textContent).toContain("org/deepseek-v4");
    expect(container.textContent).toContain("/models/deepseek-v4");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Qwen");
    expect(container.textContent).toContain("Stopped");
  });

  it("refetches the registry when a status names a model it does not list", async () => {
    const qwen = status({ displayName: "Qwen" });
    fetchModels
      .mockResolvedValueOnce({ models: [registryEntry(status())] })
      .mockResolvedValue({ models: [registryEntry(status()), registryEntry(qwen)] });
    fetchStatuses.mockResolvedValue({ models: [status(), qwen] });

    const { container } = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
    await flush();
    await flush();
    await flush();

    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Qwen");
  });

  it("shows no failure for a stopped model", async () => {
    const { container } = await renderPanel([status()]);

    expect(container.textContent).toContain("Stopped");
    expect(byTestId(container, "row-summary")).toBeNull();
    expect(byTestId(container, "readiness-progress")).toBeNull();
  });

  it("shows unavailable status and the Docker query error when runtime was not observed", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "unknown",
      runtime: {
        observed: false,
        present: false,
        containers: [],
        error: "Unable to query Docker: daemon unavailable",
      },
    })]);

    expect(container.textContent).toContain("Status unavailable");
    expect(byTestId(container, "row-summary")?.textContent).toBe(
      "Docker unavailable: Unable to query Docker: daemon unavailable"
    );
    expect(container.textContent).not.toContain("Stopped");
    expect(chip(container).className).toContain("bg-danger/15");
  });

  it("renders a failed start with code, message and an expandable logTail", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "failed",
      desiredState: "running",
      lastOperation: { operationId: OP_A, kind: "start", status: "failed" },
      lastError: lifecycleError({ logTail: ["pulling image", "Start failed (START_COMMAND_FAILED): exit 3"] }),
    })]);

    expect(chip(container).textContent).toBe("Failed");
    expect(byTestId(container, "row-summary")?.textContent).toBe(
      "START_COMMAND_FAILED: The start command exited with status 3."
    );
    expect(byTestId(container, "row-summary")?.className).toContain("text-danger");
    const tail = byTestId(container, "last-error-log-tail");
    expect(tail?.closest("details")).not.toBeNull();
    expect(tail?.textContent).toBe("pulling image\nStart failed (START_COMMAND_FAILED): exit 3");
    expect(container.textContent).toContain("Log tail (2 lines)");
    expect(container.textContent).toContain("retry needs review");
    expect(actionButton(container).textContent).toBe("Retry");
  });

  it("shows starting with readiness detail, then running once the probe answers", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:10.000Z"));
    const starting = status({
      lifecycleState: "starting",
      desiredState: "running",
      activeOperation: { operationId: OP_A, kind: "start", status: "running" },
      runtime: RUNNING_RUNTIME,
      readiness: readiness({
        checkedAt: "2026-10-29T12:00:00.000Z",
        error: "connect ECONNREFUSED 127.0.0.1:8888",
      }),
    });
    const running = status({
      lifecycleState: "running",
      desiredState: "running",
      lastOperation: { operationId: OP_A, kind: "start", status: "succeeded" },
      runtime: RUNNING_RUNTIME,
      readiness: readiness({
        ready: true,
        httpStatus: 200,
        servedModelIds: ["deepseek-v4-flash"],
        checkedAt: "2026-10-29T12:00:12.000Z",
      }),
    });
    fetchModels.mockResolvedValue({ models: [registryEntry(starting)] });
    fetchStatuses.mockResolvedValueOnce({ models: [starting] }).mockResolvedValue({ models: [running] });
    fetchLogs.mockResolvedValue(logsPage(OP_A, []));
    fetchOperation.mockRejectedValue(new Error("not needed"));

    const { container } = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
    await flush();
    await flush();
    await flush();

    expect(chip(container).textContent).toBe("Starting");
    expect(chip(container).className).toContain("bg-warning/15");
    const progress = byTestId(container, "readiness-progress");
    expect(progress?.textContent).toContain("Waiting for API: connect ECONNREFUSED 127.0.0.1:8888");
    expect(progress?.textContent).toContain("checked 10s ago");
    expect(progress?.textContent).toContain(ENDPOINT);
    expect(progress?.textContent).not.toMatch(/%/);
    expect(actionButton(container).disabled).toBe(true);

    // Active cadence: a few seconds, not the 15s idle interval.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchStatuses).toHaveBeenCalledTimes(2);
    expect(chip(container).textContent).toBe("Running");
    expect(chip(container).className).toContain("bg-success/15");
    expect(byTestId(container, "readiness-progress")).toBeNull();
    expect(container.textContent).toContain("HTTP 200 · serving deepseek-v4-flash");
    expect(actionButton(container).textContent).toBe("Stop");
  });

  it("explains a start that is still running start.sh before any container exists", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "starting",
      activeOperation: { operationId: OP_A, kind: "start", status: "running" },
    })]);

    expect(byTestId(container, "readiness-progress")?.textContent).toContain(
      "Running start.sh: no model containers yet"
    );
  });

  it("shows HTTP status and served IDs when the probe answers with the wrong model", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "starting",
      activeOperation: { operationId: OP_A, kind: "start", status: "running" },
      runtime: RUNNING_RUNTIME,
      readiness: readiness({
        httpStatus: 200,
        servedModelIds: ["other-model"],
        checkedAt: new Date().toISOString(),
        error: 'Expected model "deepseek" is not served.',
      }),
    })]);

    const progress = byTestId(container, "readiness-progress")?.textContent;
    expect(progress).toContain('Waiting for API: Expected model "deepseek" is not served.');
    expect(progress).toContain("HTTP 200 · serving other-model · checked just now");
  });

  it("flags externally managed models and lets a CLI-started, still-loading model be stopped", async () => {
    const { container } = await renderPanel([
      status({
        lifecycleState: "starting",
        externallyManaged: true,
        runtime: RUNNING_RUNTIME,
        readiness: readiness({ checkedAt: new Date().toISOString(), error: "HTTP 503", httpStatus: 503 }),
      }),
      status({ displayName: "Qwen" }),
    ]);

    const rows = container.querySelectorAll("li");
    expect(rows[0].querySelector('[data-testid="external-badge"]')?.textContent).toBe("External");
    expect(rows[1].querySelector('[data-testid="external-badge"]')).toBeNull();
    expect(rows[0].textContent).toContain("Starting");
    expect(rows[0].textContent).toContain("Waiting for API: HTTP 503");
    const stop = rows[0].querySelector("div.mt-3.flex button:last-child") as HTMLButtonElement;
    expect(stop.textContent).toBe("Stop");
    expect(stop.disabled).toBe(false);
  });

  it("presents READINESS_TIMEOUT with live containers as 'may still be loading', not a hard failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const model = status({
      lifecycleState: "failed",
      desiredState: "running",
      lastOperation: { operationId: OP_A, kind: "start", status: "failed" },
      lastError: readinessTimeout(),
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ checkedAt: new Date().toISOString(), error: "connect ECONNREFUSED 127.0.0.1:8888" }),
    });
    expect(mayStillBeLoading(model)).toBe(true);
    const { container } = await renderPanel([model]);

    expect(chip(container).textContent).toBe("May still be loading");
    expect(chip(container).className).toContain("bg-warning/15");
    expect(chip(container).className).not.toContain("bg-danger");
    const summary = byTestId(container, "row-summary");
    expect(summary?.textContent).toContain("may still be loading");
    expect(summary?.className).toContain("text-warning");
    expect(byTestId(container, "readiness-progress")?.textContent).toContain("Waiting for API: connect ECONNREFUSED");
    expect(byTestId(container, "last-error")?.textContent).toContain("READINESS_TIMEOUT");
    expect(byTestId(container, "last-error")?.className).toContain("text-warning");
    expect(actionButton(container).textContent).toBe("Stop");

    // Keeps polling at the active cadence so the flip to running shows up.
    const calls = fetchStatuses.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchStatuses.mock.calls.length).toBe(calls + 1);
  });

  it("shows running with lastError when a model became ready after its start failed", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "running",
      desiredState: "running",
      lastOperation: { operationId: OP_A, kind: "start", status: "failed" },
      lastError: readinessTimeout(["waiting for /v1/models", "Readiness timed out"]),
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ ready: true, httpStatus: 200, servedModelIds: ["deepseek"], checkedAt: new Date().toISOString() }),
    })]);

    expect(chip(container).textContent).toBe("Running");
    expect(chip(container).className).toContain("bg-success/15");
    const summary = byTestId(container, "row-summary");
    expect(summary?.textContent).toContain("Running, but the last start failed.");
    expect(summary?.textContent).toContain("may still be loading");
    expect(summary?.className).not.toContain("text-danger");
    expect(byTestId(container, "readiness-progress")).toBeNull();
    // Failure-to-running still expands details, so code, message and log tail are reachable.
    expect(byTestId(container, "last-error")?.textContent).toContain("READINESS_TIMEOUT");
    expect(byTestId(container, "last-error-log-tail")?.textContent).toBe("waiting for /v1/models\nReadiness timed out");
    expect(actionButton(container).textContent).toBe("Stop");
  });

  it("keeps an older, superseded lastError out of the row but available in details", async () => {
    const { container } = await renderPanel([status({
      lifecycleState: "running",
      lastOperation: { operationId: OP_B, kind: "start", status: "succeeded" },
      lastError: lifecycleError(),
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ ready: true, httpStatus: 200 }),
    })]);

    expect(byTestId(container, "row-summary")).toBeNull();
    (container.querySelector("li div.mt-3.flex button") as HTMLButtonElement).click();
    await flush();
    const lastError = byTestId(container, "last-error");
    expect(lastError?.textContent).toContain("Earlier failure");
    expect(lastError?.textContent).toContain("START_COMMAND_FAILED");
    expect(lastError?.className).not.toContain("text-danger");
  });

  it("pages logs with after/nextAfter to the tail and resets on a new operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const model = status({
      lifecycleState: "starting",
      desiredState: "running",
      activeOperation: { operationId: OP_A, kind: "start", status: "running" },
    });
    fetchModels.mockResolvedValue({ models: [registryEntry(model)] });
    fetchStatuses.mockResolvedValue({ models: [model] });
    fetchOperation.mockRejectedValue(new Error("not needed"));
    fetchLogs
      .mockResolvedValueOnce(logsPage(OP_A, logLines("A", 1, 1000), { hasMore: true }))
      .mockResolvedValueOnce(logsPage(OP_A, logLines("A", 1001, 1500)))
      .mockResolvedValueOnce(logsPage(OP_A, logLines("A", 1501, 1502)))
      .mockResolvedValueOnce(logsPage(OP_B, logLines("B", 1503, 1504)))
      .mockResolvedValue(logsPage(OP_B, [], { nextAfter: 1504 }));

    const { container } = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
    await flush();
    await flush();
    await flush();
    await flush();

    const log = () => byTestId(container, "operation-log")?.textContent || "";
    expect(fetchLogs.mock.calls.slice(0, 2)).toEqual([
      ["spark-1", "DeepSeek-v4", 0, 1000],
      ["spark-1", "DeepSeek-v4", 1000, 1000],
    ]);
    expect(log()).toContain("A-1500");
    expect(log()).not.toContain("A-1000");
    expect(log().split("\n")).toHaveLength(200);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchLogs).toHaveBeenNthCalledWith(3, "spark-1", "DeepSeek-v4", 1500, 1000);
    expect(log()).toContain("A-1502");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchLogs).toHaveBeenNthCalledWith(4, "spark-1", "DeepSeek-v4", 1502, 1000);
    expect(log().split("\n")).toHaveLength(2);
    expect(log()).toContain("B-1503");
    expect(log()).toContain("B-1504");
    expect(log()).not.toContain("A-");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchLogs).toHaveBeenNthCalledWith(5, "spark-1", "DeepSeek-v4", 1504, 1000);
    expect(log()).toContain("B-1504");
  });

  it("shows the active operation, not the last one, in details", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-29T12:02:14.000Z"));
    const model = status({
      lifecycleState: "starting",
      desiredState: "running",
      activeOperation: { operationId: OP_B, kind: "start", status: "running" },
      lastOperation: { operationId: OP_A, kind: "stop", status: "succeeded" },
    });
    fetchModels.mockResolvedValue({ models: [registryEntry(model)] });
    fetchStatuses.mockResolvedValue({ models: [model] });
    fetchLogs.mockResolvedValue(logsPage(OP_B, []));
    fetchOperation.mockResolvedValue({ operation: {
      operationId: OP_B,
      kind: "start",
      displayName: "DeepSeek-v4",
      status: "running",
      requestId: "req-1",
      options: { switchRunning: false },
      createdAt: "2026-10-29T11:59:59.000Z",
      startedAt: "2026-10-29T12:00:00.000Z",
      finishedAt: null,
      command: null,
      error: null,
    } });

    const { container } = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
    await flush();
    await flush();
    await flush();

    expect(fetchOperation).toHaveBeenCalledWith("spark-1", OP_B);
    expect(fetchOperation).not.toHaveBeenCalledWith("spark-1", OP_A);
    expect(container.textContent).toContain(`Operation ${OP_B} · start · running · running for 2m 14s`);
    expect(container.textContent).toContain("Starting");
    expect(container.textContent).not.toContain(OP_A);
  });

  it.each([
    ["queued", { operationId: OP_A, kind: "start", status: "queued" }, "Stop"],
    ["starting", { operationId: OP_A, kind: "start", status: "running" }, "Stop"],
    ["queued", { operationId: OP_A, kind: "stop", status: "queued" }, "Stopping…"],
    ["stopping", { operationId: OP_A, kind: "stop", status: "running" }, "Stopping…"],
  ] as const)("disables the action button while %s (%o)", async (lifecycleState, activeOperation, label) => {
    const { container } = await renderPanel([status({ lifecycleState, activeOperation: { ...activeOperation } })]);

    const button = actionButton(container);
    expect(button.textContent).toBe(label);
    expect(button.disabled).toBe(true);
    button.click();
    await flush();
    expect(stopModel).not.toHaveBeenCalled();
    expect(startModel).not.toHaveBeenCalled();
  });

  it("surfaces a 409 refusal with its message and code", async () => {
    stopModel.mockRejectedValue(new ApiRequestError(
      "qwen3.8-27b already has an active operation.",
      409,
      "OPERATION_IN_PROGRESS",
      { activeOperationId: OP_A, activeModel: "qwen3.8-27b" }
    ));
    const { container } = await renderPanel([status({
      lifecycleState: "running",
      runtime: RUNNING_RUNTIME,
      readiness: readiness({ ready: true }),
    })]);

    const button = actionButton(container);
    expect(button.textContent).toBe("Stop");
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    await flush();

    expect(stopModel).toHaveBeenCalledWith("spark-1", "DeepSeek-v4");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Model action failed: qwen3.8-27b already has an active operation. (OPERATION_IN_PROGRESS)"
    );
  });

  it("offers a switch when Spark Manager answers MODEL_ALREADY_RUNNING", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    startModel
      .mockRejectedValueOnce(new ApiRequestError(
        "Another registered model is running. Retry with switchRunning set to true to stop it first.",
        409,
        "MODEL_ALREADY_RUNNING",
        { runningModels: [{ displayName: "Qwen", workspaceDirectory: "/models/qwen" }] }
      ))
      .mockResolvedValue({
        operationId: OP_A,
        kind: "start",
        model: "DeepSeek-v4",
        desiredState: "running",
        lifecycleState: "queued",
        operationStatus: "queued",
        statusUrl: `/operations/${OP_A}`,
        modelStatusUrl: "/models/DeepSeek-v4/status",
      });
    const { container } = await renderPanel([status()]);

    actionButton(container).click();
    await flush();
    await flush();

    expect(confirm).toHaveBeenCalledWith("Qwen is running. Stop it and start DeepSeek-v4?");
    expect(startModel).toHaveBeenNthCalledWith(1, "spark-1", "DeepSeek-v4", { switchRunning: false, launchOptionSelections: {} });
    expect(startModel).toHaveBeenNthCalledWith(2, "spark-1", "DeepSeek-v4", { switchRunning: true, launchOptionSelections: {} });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not switch when the MODEL_ALREADY_RUNNING prompt is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    startModel.mockRejectedValueOnce(new ApiRequestError("Another model is running.", 409, "MODEL_ALREADY_RUNNING", {
      runningModels: [{ displayName: "Qwen" }],
    }));
    const { container } = await renderPanel([status()]);

    actionButton(container).click();
    await flush();
    await flush();

    expect(startModel).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders registry launch options and sends the selected choice", async () => {
    const model = status();
    startModel.mockResolvedValue({
      operationId: OP_A,
      kind: "start",
      model: model.displayName,
      desiredState: "running",
      lifecycleState: "queued",
      operationStatus: "queued",
      statusUrl: `/operations/${OP_A}`,
      modelStatusUrl: `/models/${model.displayName}/status`,
    });

    const { container } = await renderPanel([model], [registryEntry(model, {
      launchOptions: [{
        id: "context-profile",
        label: "Context profile",
        defaultChoice: "recipe-default",
        choices: [
          { id: "compact", label: "Compact", environment: { MAX_MODEL_LEN: "65536" } },
          { id: "recipe-default", label: "Recipe default", environment: { MAX_MODEL_LEN: "384000" } },
        ],
      }],
    })]);

    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "compact";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
    start?.click();
    await flush();

    expect(startModel).toHaveBeenCalledWith("spark-1", "DeepSeek-v4", {
      switchRunning: false,
      launchOptionSelections: { "context-profile": "compact" },
    });
  });

  it("does not probe Spark Manager while the Spark is offline", async () => {
    const { container } = render(
      <ModelAvailabilityPanel sparkId="offline" servedModelIds={[]} online={false} />
    );
    await flush();

    expect(container.textContent).toContain("Spark is offline");
    expect(fetchModels).not.toHaveBeenCalled();
    expect(fetchStatuses).not.toHaveBeenCalled();
  });
});
