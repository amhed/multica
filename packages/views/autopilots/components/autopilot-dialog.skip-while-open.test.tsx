import { useImperativeHandle, useRef, useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutopilotExecutionMode } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

const mockCreateAutopilot = vi.hoisted(() => vi.fn());
const mockUpdateAutopilot = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-test" }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ name: "Acme" }) }));

vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: (wsId: string) => ({
    queryKey: ["agents", wsId],
    queryFn: async () => [
      {
        id: "agent-1",
        name: "Scout",
        description: "Researches things",
        archived_at: null,
        runtime_id: "runtime-1",
      },
    ],
  }),
  squadListOptions: (wsId: string) => ({
    queryKey: ["squads", wsId],
    queryFn: async () => [],
  }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: (wsId: string) => ({
    queryKey: ["projects", wsId],
    queryFn: async () => [{ id: "proj-1", title: "Fleet", icon: null }],
  }),
}));

vi.mock("@multica/core/autopilots/queries", () => ({
  cronPreviewOptions: (wsId: string, expr: string, tz: string) => ({
    queryKey: ["cron-preview", wsId, expr, tz],
    queryFn: async () => ({ next_runs: ["2126-07-14T01:00:00Z"] }),
    retry: false,
  }),
}));

vi.mock("@multica/core/autopilots/mutations", () => ({
  useCreateAutopilot: () => ({ mutateAsync: mockCreateAutopilot }),
  useCreateAutopilotTrigger: () => ({ mutateAsync: vi.fn().mockResolvedValue({ id: "trg-new" }) }),
  useUpdateAutopilot: () => ({ mutateAsync: mockUpdateAutopilot }),
  useUpdateAutopilotTrigger: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("../../editor", () => ({
  TitleEditor: ({ ref, defaultValue, placeholder, onChange, onSubmit }: any) => {
    const [value, setValue] = useState(defaultValue ?? "");
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
      getText: () => value,
      focus: () => inputRef.current?.focus(),
      focusAtCoords: () => inputRef.current?.focus(),
    }));
    return (
      <input
        ref={inputRef}
        aria-label="title"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.();
        }}
      />
    );
  },
  ContentEditor: ({ placeholder }: any) => <textarea aria-label="runbook" placeholder={placeholder} />,
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="actor-avatar">{actorId}</span>,
}));

vi.mock("./subscriber-multi-select", () => ({
  SubscriberMultiSelect: () => <div data-testid="subscriber-multi-select" />,
}));

vi.mock("../../projects/components/project-picker", () => ({
  ProjectPicker: ({ triggerRender }: { triggerRender: React.ReactElement }) => triggerRender,
}));

vi.mock("./pickers/timezone-picker", () => ({
  TimezonePicker: ({ value }: { value: string }) => <div data-testid="timezone-picker">{value}</div>,
}));

import { AutopilotDialog } from "./autopilot-dialog";

const AUTOPILOT_ID = "ap-1";
const TOGGLE = "Skip while an issue is open";

function renderEditDialog(mode: AutopilotExecutionMode, skipWhileOpen?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <AutopilotDialog
        mode="edit"
        open
        onOpenChange={vi.fn()}
        autopilotId={AUTOPILOT_ID}
        initial={{
          title: "Dependency fixes",
          description: "",
          project_id: null,
          assignee_type: "agent",
          assignee_id: "agent-1",
          execution_mode: mode,
          subscriber_user_ids: [],
          skip_while_open: skipWhileOpen,
        }}
        triggers={[]}
        collaborators={[]}
        canManageAccess={false}
      />
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

describe("AutopilotDialog skip-while-open toggle", () => {
  beforeEach(() => {
    mockCreateAutopilot.mockReset().mockResolvedValue({ id: AUTOPILOT_ID });
    mockUpdateAutopilot.mockReset().mockResolvedValue({ id: AUTOPILOT_ID });
  });

  it("is hidden for run_only autopilots, which create no issue", () => {
    renderEditDialog("run_only");

    expect(screen.queryByRole("switch", { name: TOGGLE })).not.toBeInTheDocument();
  });

  it("keeps an enabled flag on save", async () => {
    const user = userEvent.setup();
    renderEditDialog("create_issue", true);

    expect(screen.getByRole("switch", { name: TOGGLE })).toBeChecked();
    await user.click(saveButton());

    await waitFor(() => expect(mockUpdateAutopilot).toHaveBeenCalledTimes(1));
    expect(mockUpdateAutopilot.mock.calls[0]?.[0]).toMatchObject({ pstack_skip_while_open: true });
  });

  it("sends the toggled value", async () => {
    const user = userEvent.setup();
    renderEditDialog("create_issue");

    await user.click(screen.getByRole("switch", { name: TOGGLE }));
    await user.click(saveButton());

    await waitFor(() => expect(mockUpdateAutopilot).toHaveBeenCalledTimes(1));
    expect(mockUpdateAutopilot.mock.calls[0]?.[0]).toMatchObject({ pstack_skip_while_open: true });
  });
});
