import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  fetchRegisteredModelLogs,
  fetchRegisteredModelOperation,
  fetchRegisteredModels,
  fetchRegisteredModelStatuses,
  startRegisteredModel,
  stopRegisteredModel,
} from "../../api/client";
import type {
  ModelLaunchOptionChoice,
  ModelLifecycleError,
  ModelLifecycleLogLine,
  ModelLifecycleState,
  ModelLifecycleStatus,
  ModelOperationView,
  ModelReadinessStatus,
  RegisteredModel,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { BotIcon } from "../ui/icons";

const IDLE_POLL_MS = 15_000;
/** Spark Manager caches readiness probe results for ~2s, so polling faster gains nothing. */
const ACTIVE_POLL_MS = 3_000;
const LOG_POLL_MS = 2_000;
const LOG_PAGE_LIMIT = 1_000;
/** Spark Manager keeps at most 2,000 lines per operation, so this reaches the tail. */
const MAX_LOG_PAGES = 3;
const LOG_TAIL_LINES = 200;

type ModelSelections = Record<string, Record<string, string>>;
type ModelAction = "start" | "stop";
type Tone = "success" | "warning" | "danger" | "muted";

export function modelDisplayState(model?: ModelLifecycleStatus): ModelLifecycleState {
  return model?.lifecycleState ?? "unknown";
}

function isTransitioning(state: ModelLifecycleState) {
  return state === "queued" || state === "starting" || state === "stopping";
}

/**
 * A start that hit READINESS_TIMEOUT while the model's containers still run:
 * Spark Manager reports `failed`, but the model may still be loading and flips
 * to `running` on its own once the probe answers.
 */
export function mayStillBeLoading(status?: ModelLifecycleStatus) {
  return status?.lifecycleState === "failed" &&
    status.lastError?.code === "READINESS_TIMEOUT" &&
    status.runtime.present &&
    !status.readiness.ready;
}

/** Worth polling at the active cadence: something is expected to change soon. */
function needsWatching(status: ModelLifecycleStatus) {
  return isTransitioning(status.lifecycleState) || mayStillBeLoading(status);
}

/** lastError belongs to the model's most recent operation (not an older, superseded one). */
function hasRecentError(status?: ModelLifecycleStatus): status is ModelLifecycleStatus & { lastError: ModelLifecycleError } {
  return Boolean(status?.lastError && !status.activeOperation &&
    status.lastError.operationId === status.lastOperation?.operationId);
}

function formatElapsed(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateLabel(status: ModelLifecycleStatus | undefined, state: ModelLifecycleState) {
  if (!status) return "Checking…";
  if (mayStillBeLoading(status)) return "May still be loading";
  if (state === "queued") return "Queued";
  if (state === "starting") return "Starting";
  if (state === "stopping") return "Stopping";
  if (state === "running") return "Running";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Failed";
  return "Status unavailable";
}

function stateTone(status: ModelLifecycleStatus | undefined, state: ModelLifecycleState): Tone {
  if (mayStillBeLoading(status)) return "warning";
  if (state === "running") return "success";
  if (state === "failed" || state === "unknown") return "danger";
  if (isTransitioning(state)) return "warning";
  return "muted";
}

const TONE_CLASSES: Record<Tone, { dot: string; chip: string; text: string; box: string }> = {
  success: { dot: "bg-success dot-glow-success", chip: "bg-success/15 text-success", text: "text-success", box: "border-success/30 bg-success/10 text-success" },
  warning: { dot: "bg-warning", chip: "bg-warning/15 text-warning", text: "text-warning", box: "border-warning/30 bg-warning/10 text-warning" },
  danger: { dot: "bg-danger", chip: "bg-danger/15 text-danger", text: "text-danger", box: "border-danger/30 bg-danger/10 text-danger" },
  muted: { dot: "bg-muted", chip: "bg-surface-elevated text-muted", text: "text-muted", box: "border-border bg-surface text-muted" },
};

/** READINESS_TIMEOUT means "not confirmed ready yet", not a crash, so it never reads as a hard failure. */
function errorTone(error: ModelLifecycleError, state: ModelLifecycleState): Tone {
  if (error.code === "READINESS_TIMEOUT" || error.code === "MANAGER_INTERRUPTED") return "warning";
  return state === "failed" ? "danger" : "warning";
}

function errorHeadline(error: ModelLifecycleError) {
  if (error.code === "READINESS_TIMEOUT") {
    return "READINESS_TIMEOUT: the model may still be loading. It shows Running once its API answers.";
  }
  if (error.code === "MANAGER_INTERRUPTED") {
    return "MANAGER_INTERRUPTED: Spark Manager stopped while waiting for readiness. The model may still be loading.";
  }
  return `${error.code}: ${error.message}`;
}

function rowSummary(status: ModelLifecycleStatus | undefined, state: ModelLifecycleState): { text: string; tone: Tone } | null {
  if (!status) return null;
  if (!status.runtime.observed) {
    return { text: `Docker unavailable: ${status.runtime.error ?? "unknown error"}`, tone: "danger" };
  }
  if (hasRecentError(status)) {
    const prefix = state === "running" ? `Running, but the last ${status.lastError.kind} failed. ` : "";
    return { text: `${prefix}${errorHeadline(status.lastError)}`, tone: errorTone(status.lastError, state) };
  }
  return null;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiRequestError && error.code) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

/** MODEL_ALREADY_RUNNING names the models a switch would stop. */
function runningModelNames(error: unknown): string[] | null {
  if (!(error instanceof ApiRequestError) || error.code !== "MODEL_ALREADY_RUNNING") return null;
  const { runningModels } = error.details;
  if (!Array.isArray(runningModels)) return [];
  return runningModels.flatMap((model: unknown) =>
    typeof model === "object" && model !== null && "displayName" in model && typeof model.displayName === "string"
      ? [model.displayName]
      : []
  );
}

function defaultsFor(model: RegisteredModel) {
  return Object.fromEntries(
    (model.launchOptions || []).filter((option) => option.defaultChoice)
      .map((option) => [option.id, option.defaultChoice as string])
  );
}

function selectedChoice(model: RegisteredModel, optionId: string, choiceId: string | undefined) {
  return model.launchOptions?.find((option) => option.id === optionId)
    ?.choices.find((choice) => choice.id === choiceId);
}

function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

/** The action a row's button performs, or null while an operation is in flight. */
function rowAction(status: ModelLifecycleStatus | undefined, state: ModelLifecycleState): ModelAction | null {
  if (status?.activeOperation) return null;
  if (state === "running" || state === "starting") return "stop";
  // A failed start can leave containers behind (e.g. READINESS_TIMEOUT); stop them before retrying.
  if (state === "failed" && status?.runtime.present) return "stop";
  return "start";
}

export function ModelAvailabilityPanel({ sparkId, servedModelIds, online = true }: {
  sparkId: string;
  servedModelIds: string[];
  online?: boolean;
}) {
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [statuses, setStatuses] = useState<Map<string, ModelLifecycleStatus>>(new Map());
  const [selections, setSelections] = useState<ModelSelections>({});
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const knownModels = useRef<Set<string>>(new Set());
  const registryRefreshKey = useRef<string | null>(null);
  const previousStates = useRef<Map<string, ModelLifecycleState>>(new Map());

  const acceptModels = useCallback((incoming: RegisteredModel[]) => {
    knownModels.current = new Set(incoming.map((model) => model.displayName));
    setModels(incoming);
    setSelections((current) => {
      const next = { ...current };
      for (const model of incoming) next[model.displayName] = { ...defaultsFor(model), ...current[model.displayName] };
      return next;
    });
  }, []);

  const loadRegistry = useCallback(async () => {
    try {
      const response = await fetchRegisteredModels(sparkId);
      if (mounted.current) acceptModels(response.models);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    }
  }, [acceptModels, sparkId]);

  const loadStatuses = useCallback(async (showLoading = false) => {
    const request = ++requestSequence.current;
    if (showLoading) setLoading(true);
    try {
      const response = await fetchRegisteredModelStatuses(sparkId);
      if (!mounted.current || request !== requestSequence.current) return false;
      setStatuses(new Map(response.models.map((model) => [model.displayName, model])));
      // Expand details when a model enters a transition, a failure, or runs
      // with a fresh lastError (e.g. ready after READINESS_TIMEOUT), without
      // reopening rows the user collapsed while it stays there.
      setExpandedModels((current) => {
        const next = new Set(current);
        for (const model of response.models) {
          const state = modelDisplayState(model);
          const previous = previousStates.current.get(model.displayName);
          if (previous !== state && (isTransitioning(state) || state === "failed" || hasRecentError(model))) {
            next.add(model.displayName);
          }
          previousStates.current.set(model.displayName, state);
        }
        return next;
      });
      // A status for a model the registry list doesn't have means the registry changed.
      const unknown = response.models.map((model) => model.displayName).filter((name) => !knownModels.current.has(name));
      const unknownKey = unknown.sort().join("\n");
      if (unknown.length > 0 && registryRefreshKey.current !== unknownKey) {
        registryRefreshKey.current = unknownKey;
        void loadRegistry();
      }
      setError(null);
      return response.models.some(needsWatching);
    } catch (err) {
      if (mounted.current && request === requestSequence.current) setError(errorMessage(err));
      return false;
    } finally {
      if (showLoading && mounted.current && request === requestSequence.current) setLoading(false);
    }
  }, [loadRegistry, sparkId]);

  useEffect(() => {
    mounted.current = true;
    let timer: number | undefined;
    let cancelled = false;
    if (!online) {
      setModels([]);
      setStatuses(new Map());
      setLoading(false);
      setError("Spark is offline");
      return () => {
        mounted.current = false;
        requestSequence.current += 1;
      };
    }
    const poll = async (showLoading = false) => {
      const active = await loadStatuses(showLoading);
      if (!cancelled) timer = window.setTimeout(() => void poll(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    fetchRegisteredModels(sparkId)
      .then((response) => { if (!cancelled) acceptModels(response.models); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) void poll(true); });
    return () => {
      cancelled = true;
      mounted.current = false;
      requestSequence.current += 1;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [acceptModels, loadStatuses, online, pollEpoch, sparkId]);

  const served = useMemo(
    () => [...new Set(servedModelIds.map((id) => id.trim()).filter(Boolean))],
    [servedModelIds]
  );
  const choose = (modelName: string, optionId: string, choiceId: string) => {
    setSelections((current) => ({ ...current, [modelName]: { ...current[modelName], [optionId]: choiceId } }));
  };

  const startModel = async (model: RegisteredModel) => {
    // Spark Manager refuses a start with MODEL_ALREADY_RUNNING when another
    // workspace has a running container, whatever its lifecycle state.
    const runningOthers = models.filter((candidate) =>
      candidate.displayName !== model.displayName && statuses.get(candidate.displayName)?.runtime.present === true
    ).map((candidate) => candidate.displayName);
    const confirmSwitch = (names: string[]) => window.confirm(
      `${names.length ? names.join(", ") : "Another model"} is running. Stop it and start ${model.displayName}?`
    );
    if (runningOthers.length > 0 && !confirmSwitch(runningOthers)) return false;
    const request = (switchRunning: boolean) => startRegisteredModel(sparkId, model.displayName, {
      switchRunning,
      launchOptionSelections: selections[model.displayName] || {},
    });
    try {
      await request(runningOthers.length > 0);
    } catch (err) {
      // Our status was stale: offer the switch with the models Spark Manager named.
      const names = runningOthers.length === 0 ? runningModelNames(err) : null;
      if (names === null) throw err;
      if (!confirmSwitch(names)) return false;
      await request(true);
    }
    return true;
  };

  const runAction = async (model: RegisteredModel, action: ModelAction) => {
    setBusyModel(model.displayName);
    setActionError(null);
    setExpandedModels((current) => new Set(current).add(model.displayName));
    try {
      if (action === "stop") {
        await stopRegisteredModel(sparkId, model.displayName);
      } else if (!(await startModel(model))) {
        return;
      }
      // Restart the poll loop so it picks up the active cadence immediately.
      await loadStatuses();
      setPollEpoch((current) => current + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      if (mounted.current) setBusyModel(null);
    }
  };

  const refresh = () => {
    void loadRegistry();
    void loadStatuses(true);
  };

  const toggleDetails = (displayName: string) => {
    setExpandedModels((current) => {
      const next = new Set(current);
      if (next.has(displayName)) next.delete(displayName); else next.add(displayName);
      return next;
    });
  };

  return (
    <Panel title="Model control" icon={<BotIcon className="h-3.5 w-3.5" />} className="md:col-span-2"
      actions={<button type="button" onClick={refresh} disabled={loading || !online || busyModel !== null}
        className="rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50">
        {loading ? "Checking…" : "Refresh"}
      </button>}
    >
      <div className="mb-3 rounded-md border border-border bg-surface-elevated px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-muted">LLM API readiness</p>
        <p className="mt-1 break-all text-sm font-medium text-text-strong">
          {served.length ? served.join(", ") : "No model is currently reported by the LLM probe"}
        </p>
      </div>
      {error && <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">Spark Manager unavailable: {error}</p>}
      {actionError && <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">Model action failed: {actionError}</p>}
      {!models.length && !loading ? <p className="text-sm text-muted">No models are registered in Spark Manager.</p> : (
        <ul className="divide-y divide-border" aria-live="polite">
          {models.map((model) => {
            const status = statuses.get(model.displayName);
            const state = modelDisplayState(status);
            const tone = TONE_CLASSES[stateTone(status, state)];
            const summary = rowSummary(status, state);
            const modelSelections = selections[model.displayName] || {};
            const missingSelection = (model.launchOptions || []).some((option) => !modelSelections[option.id]);
            const busy = busyModel === model.displayName;
            const expanded = expandedModels.has(model.displayName);
            const transitioning = isTransitioning(state);
            const active = status?.activeOperation ?? null;
            const action = rowAction(status, state);
            const showReadiness = status != null &&
              (active?.kind === "start" || (state === "starting" && !active) || mayStillBeLoading(status));
            const buttonLabel = busy
              ? (action === "stop" ? "Stopping…" : "Starting…")
              : active?.kind === "stop" ? "Stopping…"
              : action === "stop" || active ? "Stop"
              : state === "failed" ? "Retry" : "Start";
            return (
              <li key={model.displayName} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-strong">{model.displayName}</span>
                      {status?.externallyManaged && <span data-testid="external-badge"
                        title="Containers are running that Spark Manager's API did not start (for example, via the CLI)."
                        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted">
                        External
                      </span>}
                    </p>
                    <p className="truncate font-tabular text-[10px] text-muted" title={model.workspaceDirectory}>{model.workspaceDirectory}</p>
                    {summary && <p data-testid="row-summary" className={`mt-1 truncate text-[10px] ${TONE_CLASSES[summary.tone].text}`} title={summary.text}>{summary.text}</p>}
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-medium ${tone.chip}`}>{stateLabel(status, state)}</span>
                </div>

                {showReadiness && status && <ReadinessProgress status={status} />}

                {(model.launchOptions || []).length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {model.launchOptions?.map((option) => {
                    const choice = selectedChoice(model, option.id, modelSelections[option.id]);
                    return <label key={option.id} className="block rounded border border-border bg-surface-elevated p-2.5">
                      <span className="mb-1 block text-[11px] font-medium text-text-strong">{option.label}</span>
                      {option.description && <span className="mb-2 block text-[10px] leading-relaxed text-muted">{option.description}</span>}
                      <select aria-label={`${model.displayName} ${option.label}`} value={modelSelections[option.id] || ""}
                        disabled={busy || action !== "start"}
                        onChange={(event) => choose(model.displayName, option.id, event.target.value)}
                        className="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text outline-none focus:border-accent disabled:opacity-60">
                        {!option.defaultChoice && <option value="">Choose…</option>}
                        {option.choices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                      </select>
                      <ChoiceDetails choice={choice} />
                    </label>;
                  })}
                </div>}

                {expanded && status && <ModelDiagnostics sparkId={sparkId} status={status} />}
                <div className="mt-3 flex items-center justify-between gap-2">
                  {status ? <button type="button" onClick={() => toggleDetails(model.displayName)}
                    className="text-[11px] font-medium text-accent hover:underline">{expanded ? "Hide details" : "View details"}</button> : <span />}
                  <button type="button"
                    disabled={!online || busyModel !== null || action === null || (action === "start" && missingSelection)}
                    title={active?.kind === "start" ? "A start in progress cannot be stopped. Stop the model once the start finishes." : undefined}
                    onClick={() => { if (action) void runAction(model, action); }}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${action === "stop" || active || transitioning ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15" : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"}`}>
                    {buttonLabel}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** What the start is waiting on, from status `readiness` and `runtime`. No progress percentages: none are reported. */
function readinessHeadline(status: ModelLifecycleStatus) {
  const { readiness, runtime, activeOperation } = status;
  if (activeOperation?.status === "queued") return "Queued behind another operation";
  if (!runtime.present) {
    return activeOperation?.kind === "start" ? "Running start.sh: no model containers yet" : "Waiting for model containers";
  }
  if (readiness.ready) return "Model API is answering; finishing start";
  if (readiness.source === "start-command") return "Waiting for start.sh to finish (no readiness probe configured)";
  if (readiness.source === "probe") {
    if (!readiness.checkedAt) return "Waiting for the first readiness check";
    return `Waiting for API: ${readiness.error ?? "not ready yet"}`;
  }
  return "Waiting for the model to become ready";
}

function readinessFacts(readiness: ModelReadinessStatus) {
  const facts: string[] = [];
  if (readiness.httpStatus != null) facts.push(`HTTP ${readiness.httpStatus}`);
  if (readiness.servedModelIds.length > 0) facts.push(`serving ${readiness.servedModelIds.join(", ")}`);
  if (readiness.checkedAt) facts.push(`checked ${formatRelativeTime(readiness.checkedAt)}`);
  return facts;
}

function ReadinessProgress({ status }: { status: ModelLifecycleStatus }) {
  const { readiness } = status;
  const facts = readinessFacts(readiness);
  return <div data-testid="readiness-progress" className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
    <p className="break-all text-[11px] font-medium text-warning">{readinessHeadline(status)}</p>
    {facts.length > 0 && <p className="mt-1 break-all text-[10px] text-muted">{facts.join(" · ")}</p>}
    {readiness.endpoint && <p className="mt-0.5 break-all font-mono text-[10px] text-muted">{readiness.endpoint}</p>}
  </div>;
}

function formatLogLine(line: ModelLifecycleLogLine) {
  const time = Date.parse(line.at);
  const stamp = Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : line.at;
  return `${stamp} ${line.stream.toUpperCase()} ${line.text}`;
}

function operationTiming(operation: ModelOperationView) {
  const started = operation.startedAt ? Date.parse(operation.startedAt) : NaN;
  if (operation.finishedAt) return `finished ${formatRelativeTime(operation.finishedAt)}`;
  if (Number.isFinite(started)) return `running for ${formatElapsed(Date.now() - started)}`;
  return "waiting to run";
}

function readinessSourceLabel(readiness: ModelReadinessStatus) {
  if (readiness.source === "probe") return "readiness probe";
  if (readiness.source === "start-command") return "start.sh result (no probe)";
  return "running containers (no probe, not started by the API)";
}

function ModelDiagnostics({ sparkId, status }: {
  sparkId: string;
  status: ModelLifecycleStatus;
}) {
  const [logs, setLogs] = useState<ModelLifecycleLogLine[]>([]);
  const [operation, setOperation] = useState<ModelOperationView | null>(null);
  const [logsUnavailable, setLogsUnavailable] = useState(false);
  const logAfter = useRef(0);
  const logOperationId = useRef<string | null | undefined>(undefined);
  const logView = useRef<HTMLPreElement>(null);
  const { displayName } = status;
  const activeOperationId = status.activeOperation?.operationId ?? null;
  const following = activeOperationId !== null;
  const shownOperation = status.activeOperation ?? status.lastOperation;

  useEffect(() => {
    logAfter.current = 0;
    logOperationId.current = undefined;
    setLogs([]);
    setLogsUnavailable(false);
  }, [displayName, sparkId]);

  // Follow the latest operation's log with after/nextAfter. Runs again (from
  // the last seq) whenever an operation starts or finishes, and polls while
  // one is active. A changed operationId resets the view.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
          const response = await fetchRegisteredModelLogs(sparkId, displayName, logAfter.current, LOG_PAGE_LIMIT);
          if (cancelled) return;
          const sameOperation = response.operationId === logOperationId.current;
          logOperationId.current = response.operationId;
          logAfter.current = response.nextAfter;
          setLogs((current) => [...(sameOperation ? current : []), ...response.lines].slice(-LOG_TAIL_LINES));
          if (!response.hasMore || response.lines.length === 0) break;
        }
        setLogsUnavailable(false);
      } catch {
        if (!cancelled) setLogsUnavailable(true);
      }
      if (!cancelled && following) timer = window.setTimeout(() => void load(), LOG_POLL_MS);
    };
    void load();
    return () => { cancelled = true; if (timer != null) window.clearTimeout(timer); };
  }, [activeOperationId, displayName, following, sparkId]);

  useEffect(() => {
    if (logView.current) logView.current.scrollTop = logView.current.scrollHeight;
  }, [logs]);

  const operationId = shownOperation?.operationId ?? null;
  const operationStatus = shownOperation?.status ?? null;
  useEffect(() => {
    if (!operationId) {
      setOperation(null);
      return;
    }
    let cancelled = false;
    fetchRegisteredModelOperation(sparkId, operationId)
      .then((response) => { if (!cancelled) setOperation(response.operation); })
      .catch(() => { if (!cancelled) setOperation(null); });
    return () => { cancelled = true; };
  }, [operationId, operationStatus, sparkId]);

  const detail = operation?.operationId === operationId ? operation : null;
  const { lastError, runtime, readiness } = status;
  const recentError = hasRecentError(status);
  const errorBox = lastError ? TONE_CLASSES[recentError ? errorTone(lastError, status.lifecycleState) : "muted"].box : "";
  const readinessLine = readiness.configured || runtime.present
    ? [`Readiness: ${readiness.ready ? "ready" : "not ready"} via ${readinessSourceLabel(readiness)}`, ...readinessFacts(readiness)]
    : [];
  return <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-elevated p-3">
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
      {shownOperation && <span>
        {status.activeOperation ? "Operation" : "Last operation"} <code>{shownOperation.operationId}</code> · {shownOperation.kind} · {shownOperation.status}
        {detail ? ` · ${operationTiming(detail)}` : ""}
      </span>}
      {runtime.containers.slice(0, 3).map((container) => <span key={container.id}>
        Container {container.name ?? container.id.slice(0, 12)} {container.status ?? (container.running ? "running" : "not running")}
        {container.exitCode != null ? ` · exit ${container.exitCode}` : ""}
        {container.restartCount > 0 ? ` · ${container.restartCount} restart(s)` : ""}
        {container.oomKilled && <span className="text-danger"> · OOM killed</span>}
      </span>)}
      {status.externallyManaged && <span>Started outside Spark Manager's API (e.g. the CLI)</span>}
      {readinessLine.length > 0 && <span>{readinessLine.join(" · ")}</span>}
    </div>
    {lastError && <div data-testid="last-error" className={`rounded border px-2.5 py-2 text-[11px] ${errorBox}`}>
      {!recentError && <span className="mb-1 block text-[10px] uppercase tracking-wide">Earlier failure</span>}
      <span className="font-medium">{lastError.code}</span> · {lastError.message}
      {lastError.code === "READINESS_TIMEOUT" && <span className="mt-1 block">
        The start script succeeded but the API did not answer in time. The model may still be loading.
      </span>}
      <span className="mt-1 block text-[10px]">
        {lastError.kind} failed {formatRelativeTime(lastError.at)}
        {lastError.exitCode != null ? ` · exit ${lastError.exitCode}` : ""}
        {lastError.signal ? ` · signal ${lastError.signal}` : ""}
        {` · retry ${lastError.retrySafe ? "safe" : "needs review"}`}
      </span>
      {lastError.logTail.length > 0 && <details className="mt-1.5">
        <summary className="cursor-pointer text-[10px] font-medium">Log tail ({lastError.logTail.length} lines)</summary>
        <pre data-testid="last-error-log-tail" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[10px] leading-relaxed text-text">
          {lastError.logTail.join("\n")}
        </pre>
      </details>}
    </div>}
    {logs.length > 0 && <pre ref={logView} data-testid="operation-log" className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[10px] leading-relaxed text-text">
      {logs.map(formatLogLine).join("\n")}
    </pre>}
    {logsUnavailable && logs.length === 0 && <p className="text-[10px] text-muted">Lifecycle logs are unavailable.</p>}
  </div>;
}

function ChoiceDetails({ choice }: { choice?: ModelLaunchOptionChoice }) {
  if (!choice) return null;
  const environment = Object.entries(choice.environment || {});
  return <span className="mt-1.5 block text-[10px] leading-relaxed text-muted">
    {choice.description && <span className="block">{choice.description}</span>}
    {environment.length > 0 && <span className="block break-all font-mono" title={environment.map(([key, value]) => `${key}=${value}`).join("\n")}>
      {environment.map(([key, value]) => `${key}=${value}`).join(" · ")}
    </span>}
  </span>;
}
