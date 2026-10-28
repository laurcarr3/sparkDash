import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { RegisteredModelStatus } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchRegisteredModels: vi.fn(),
  fetchRegisteredModelStatuses: vi.fn(),
  startRegisteredModel: vi.fn(),
  stopRegisteredModel: vi.fn(),
}));

import {
  fetchRegisteredModels,
  fetchRegisteredModelStatuses,
  startRegisteredModel,
} from "../../api/client";
import { ModelAvailabilityPanel, modelDisplayState } from "./ModelAvailabilityPanel";

const fetchModels = vi.mocked(fetchRegisteredModels);
const fetchStatuses = vi.mocked(fetchRegisteredModelStatuses);
const startModel = vi.mocked(startRegisteredModel);

function status(stdout: string, exitCode = 0): RegisteredModelStatus {
  return {
    displayName: "DeepSeek-v4",
    workspaceDirectory: "/models/deepseek",
    command: { exitCode, signal: null, stdout, stderr: exitCode ? "failed" : "" },
  };
}

describe("ModelAvailabilityPanel", () => {
  it("only normalizes explicit status lines", () => {
    expect(modelDisplayState(status("running\n"))).toBe("running");
    expect(modelDisplayState(status("stopped\n"))).toBe("stopped");
    expect(modelDisplayState(status("not running\n"))).toBe("unknown");
    expect(modelDisplayState(status("running\n", 1))).toBe("error");
  });

  it("shows registered status alongside sparkDash's served model id", async () => {
    fetchModels.mockResolvedValue({
      models: [
        { displayName: "DeepSeek-v4", workspaceDirectory: "/models/deepseek" },
        { displayName: "Qwen", workspaceDirectory: "/models/qwen" },
      ],
    });
    fetchStatuses.mockResolvedValue({
      models: [
        status("running\n"),
        {
          displayName: "Qwen",
          workspaceDirectory: "/models/qwen",
          command: { exitCode: 0, signal: null, stdout: "stopped\n", stderr: "" },
        },
      ],
    });

    const { container } = render(
      <ModelAvailabilityPanel sparkId="spark-1" servedModelIds={["org/deepseek-v4"]} />
    );
    await flush();
    await flush();

    expect(container.textContent).toContain("org/deepseek-v4");
    expect(container.textContent).toContain("DeepSeek-v4");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Qwen");
    expect(container.textContent).toContain("Stopped");
  });

  it("renders registry launch options and sends the selected choice", async () => {
    const model = {
      displayName: "DeepSeek-v4",
      workspaceDirectory: "/models/deepseek",
      launchOptions: [{
        id: "context-profile",
        label: "Context profile",
        defaultChoice: "recipe-default",
        choices: [
          { id: "compact", label: "Compact", environment: { MAX_MODEL_LEN: "65536" } },
          { id: "recipe-default", label: "Recipe default", environment: { MAX_MODEL_LEN: "384000" } },
        ],
      }],
    };
    fetchModels.mockResolvedValue({ models: [model] });
    fetchStatuses.mockResolvedValue({
      models: [{ ...model, command: { exitCode: 0, signal: null, stdout: "stopped\n", stderr: "" } }],
    });
    startModel.mockResolvedValue({
      model: { displayName: model.displayName },
      command: { exitCode: 0, signal: null, stdout: "started", stderr: "" },
    });

    const { container } = render(<ModelAvailabilityPanel sparkId="spark-1" servedModelIds={[]} />);
    await flush();
    await flush();

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
