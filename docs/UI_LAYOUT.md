# UI Layout

The desktop UI is a workbench, not a landing page. Its job is to make the task
loop visible and controllable.

## Current Regions

```text
Sidebar | Main Thread | Agent Inspector / Activity
```

### Sidebar

The sidebar provides application identity and high-level task context. It should
stay compact and avoid becoming the primary task surface.

### Main Thread

The main thread contains:

- Current task title and status.
- Commander message.
- Step plan.
- Task-specific results such as documents, project checks, source reports, and
  PDF move summaries.
- Permission cards when a confirmed write is waiting for user action.
- Composer for the next user goal.

### Agent Inspector

The inspector shows the built-in agent roles and their current status. It helps
users understand which part of the system is working or waiting.

### Activity Log

The activity log records task events, tool calls, permission changes, and
verification results. It is the audit trail for the current in-memory task.

## Interaction Rules

- Risky actions must surface as confirmation cards before execution.
- Permission cards must show the dry-run and affected paths.
- Denying a permission should produce a clear no-op result.
- Completed tasks should include verification evidence.
- Failed tasks should show the failing phase and a useful message.

## Design Constraints

- Keep controls predictable and compact.
- Avoid marketing-style hero sections.
- Prefer dense, readable operational UI over decorative layout.
- Avoid nested cards.
- Ensure text does not overflow buttons, panels, or status labels.
- Keep accessibility basics: visible focus, readable contrast, and clear
  disabled states.

## Future UI Work

- Add component tests for confirmation cards.
- Add workspace selection.
- Add empty and error states for each task type.
- Add persistent task history once storage exists.
- Add screenshots from the manual QA checklist to `docs/qa/`.
