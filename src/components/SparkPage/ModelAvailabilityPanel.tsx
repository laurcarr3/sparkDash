import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRegisteredModels,
  fetchRegisteredModelStatuses,
  startRegisteredModel,
  stopRegisteredModel,
} from "../../api/client";
import type {
  ModelLaunchOptionChoice,
  RegisteredModel,
  RegisteredModelStatus,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { BotIcon } from "../ui/icons";

const STATUS_POLL_MS = 15_000;

type DisplayState = "running" | "stopped" | "error" | "unknown";
type ModelSelections = Record<string, Record<string, string>>;

export function modelDisplayState(model?: RegisteredModelStatus): DisplayState {
  if (!model) return "unknown";
  if (model.error || (model.command && model.command.exitCode !== 0)) return "error";
  const output = (model.command?.stdout || "").trim().toLowerCase();
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (/\bnot running\b/.test(output)) return "unknown";
  if (lines.includes("running") || /\b(?:up|running|healthy)\b/.test(output)) return "running";
  if (
    !output ||
    lines.includes("stopped") ||
    /\b(?:stopped|exited)\b/.test(output) ||
    (/^name\s+image\s+command\s+service\s+created\s+status/m.test(output) && lines.length <= 1)
  ) {
    return "stopped";
  }
  return "unknown";
}

function stateLabel(model: RegisteredModelStatus | undefined, state: DisplayState) {
  if (state === "running") return "Running";
  if (state === "stopped") return "Stopped";
  if (state === "error") return "Status unavailable";
  const raw = model?.command?.stdout?.trim();
  return raw ? raw.split(/\r?\n/, 1)[0] : "Checking…";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultsFor(model: RegisteredModel) {
  return Object.fromEntries(
    (model.launchOptions || [])
      .filter((option) => option.defaultChoice)
      .map((option) => [option.id, option.defaultChoice as string])
  );
}

function selectedChoice(model: RegisteredModel, optionId: string, choiceId: string | undefined) {
  return model.launchOptions
    ?.find((option) => option.id === optionId)
    ?.choices.find((choice) => choice.id === choiceId);
}

function mergeModels(current: RegisteredModel[], incoming: RegisteredModel[]) {
  const existing = new Map(current.map((model) => [model.displayName, model]));
  return incoming.map((model) => ({ ...existing.get(model.displayName), ...model }));
}

export function ModelAvailabilityPanel({
  sparkId,
  servedModelIds,
  online = true,
}: {
  sparkId: string;
  servedModelIds: string[];
  online?: boolean;
}) {
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [statuses, setStatuses] = useState<Map<string, RegisteredModelStatus>>(new Map());
  const [selections, setSelections] = useState<ModelSelections>({});
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestSequence = useRef(0);

  const acceptModels = useCallback((incoming: RegisteredModel[]) => {
    setModels((current) => mergeModels(current, incoming));
    setSelections((current) => {
      const next = { ...current };
      for (const model of incoming) {
        next[model.displayName] = { ...defaultsFor(model), ...current[model.displayName] };
      }
      return next;
    });
  }, []);

  const loadStatuses = useCallback(async () => {
    const request = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await fetchRegisteredModelStatuses(sparkId);
      if (!mounted.current || request !== requestSequence.current) return;
      acceptModels(response.models);
      setStatuses(new Map(response.models.map((model) => [model.displayName, model])));
      setError(null);
    } catch (err) {
      if (mounted.current && request === requestSequence.current) setError(errorMessage(err));
    } finally {
      if (mounted.current && request === requestSequence.current) setLoading(false);
    }
  }, [acceptModels, sparkId]);

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

    const poll = async () => {
      await loadStatuses();
      if (!cancelled) timer = window.setTimeout(poll, STATUS_POLL_MS);
    };

    fetchRegisteredModels(sparkId)
      .then((response) => {
        if (!cancelled) acceptModels(response.models);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) void poll();
      });

    return () => {
      cancelled = true;
      mounted.current = false;
      requestSequence.current += 1;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [acceptModels, loadStatuses, online, sparkId]);

  const served = useMemo(
    () => [...new Set(servedModelIds.map((id) => id.trim()).filter(Boolean))],
    [servedModelIds]
  );

  const choose = (modelName: string, optionId: string, choiceId: string) => {
    setSelections((current) => ({
      ...current,
      [modelName]: { ...current[modelName], [optionId]: choiceId },
    }));
  };

  const runAction = async (model: RegisteredModel, state: DisplayState) => {
    setBusyModel(model.displayName);
    setActionError(null);
    try {
      if (state === "running") {
        await stopRegisteredModel(sparkId, model.displayName);
      } else {
        const runningOthers = models.filter(
          (candidate) =>
            candidate.displayName !== model.displayName &&
            modelDisplayState(statuses.get(candidate.displayName)) === "running"
        );
        const switchRunning =
          runningOthers.length > 0 &&
          window.confirm(
            `Stop ${runningOthers.map((candidate) => candidate.displayName).join(", ")} and start ${model.displayName}?`
          );
        if (runningOthers.length > 0 && !switchRunning) return;
        await startRegisteredModel(sparkId, model.displayName, {
          switchRunning,
          launchOptionSelections: selections[model.displayName] || {},
        });
      }
      await loadStatuses();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      if (mounted.current) setBusyModel(null);
    }
  };

  return (
    <Panel
      title="Model control"
      icon={<BotIcon className="h-3.5 w-3.5" />}
      className="md:col-span-2"
      actions={
        <button
          type="button"
          onClick={() => void loadStatuses()}
          disabled={loading || !online || busyModel !== null}
          className="rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      }
    >
      <div className="mb-3 rounded-md border border-border bg-surface-elevated px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-muted">Currently served by LLM API</p>
        <p className="mt-1 break-all text-sm font-medium text-text-strong">
          {served.length ? served.join(", ") : "No running model reported by the LLM probe"}
        </p>
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          Spark Manager unavailable: {error}
        </p>
      )}
      {actionError && (
        <p className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          Model action failed: {actionError}
        </p>
      )}

      {!models.length && !loading ? (
        <p className="text-sm text-muted">No models are registered in Spark Manager.</p>
      ) : (
        <ul className="divide-y divide-border" aria-live="polite">
          {models.map((model) => {
            const status = statuses.get(model.displayName);
            const state = modelDisplayState(status);
            const detail =
              status?.error?.message ||
              (status?.command?.exitCode !== 0 ? status?.command?.stderr?.trim() : "");
            const modelSelections = selections[model.displayName] || {};
            const missingSelection = (model.launchOptions || []).some(
              (option) => !modelSelections[option.id]
            );
            const busy = busyModel === model.displayName;
            return (
              <li key={model.displayName} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      state === "running"
                        ? "bg-success dot-glow-success"
                        : state === "error"
                          ? "bg-danger"
                          : "bg-muted"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-strong">{model.displayName}</p>
                    <p className="truncate font-tabular text-[10px] text-muted" title={model.workspaceDirectory}>
                      {model.workspaceDirectory}
                    </p>
                    {detail && <p className="mt-1 truncate text-[10px] text-danger" title={detail}>{detail}</p>}
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-1 text-[10px] font-medium ${
                      state === "running"
                        ? "bg-success/15 text-success"
                        : state === "error"
                          ? "bg-danger/15 text-danger"
                          : "bg-surface-elevated text-muted"
                    }`}
                  >
                    {stateLabel(status, state)}
                  </span>
                </div>

                {(model.launchOptions || []).length > 0 && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {model.launchOptions?.map((option) => {
                      const choice = selectedChoice(model, option.id, modelSelections[option.id]);
                      return (
                        <label key={option.id} className="block rounded border border-border bg-surface-elevated p-2.5">
                          <span className="mb-1 block text-[11px] font-medium text-text-strong">{option.label}</span>
                          {option.description && <span className="mb-2 block text-[10px] leading-relaxed text-muted">{option.description}</span>}
                          <select
                            aria-label={`${model.displayName} ${option.label}`}
                            value={modelSelections[option.id] || ""}
                            disabled={busy || state === "running"}
                            onChange={(event) => choose(model.displayName, option.id, event.target.value)}
                            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text outline-none focus:border-accent disabled:opacity-60"
                          >
                            {!option.defaultChoice && <option value="">Choose…</option>}
                            {option.choices.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                            ))}
                          </select>
                          <ChoiceDetails choice={choice} />
                        </label>
                      );
                    })}
                  </div>
                )}

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={!online || busyModel !== null || (state !== "running" && missingSelection)}
                    onClick={() => void runAction(model, state)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      state === "running"
                        ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15"
                        : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
                    }`}
                  >
                    {busy ? (state === "running" ? "Stopping…" : "Starting…") : state === "running" ? "Stop" : "Start"}
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

function ChoiceDetails({ choice }: { choice?: ModelLaunchOptionChoice }) {
  if (!choice) return null;
  const environment = Object.entries(choice.environment || {});
  return (
    <span className="mt-1.5 block text-[10px] leading-relaxed text-muted">
      {choice.description && <span className="block">{choice.description}</span>}
      {environment.length > 0 && (
        <span className="block break-all font-mono" title={environment.map(([key, value]) => `${key}=${value}`).join("\n")}>
          {environment.map(([key, value]) => `${key}=${value}`).join(" · ")}
        </span>
      )}
    </span>
  );
}
