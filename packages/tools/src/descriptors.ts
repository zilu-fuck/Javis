import type { ToolDescriptor } from "./types";

export const initialToolDescriptors: ToolDescriptor[] = [
  {
    name: "commander.plan",
    permissionLevel: "read",
    summary: "Analyze a user goal and produce a task plan with assigned agent steps.",
  },
  {
    name: "verifier.check",
    permissionLevel: "read",
    summary: "Check collected evidence against success criteria and produce a verdict.",
  },
  {
    name: "file.scanMarkdownDocuments",
    permissionLevel: "read",
    summary: "Scan Markdown documents inside the active workspace.",
  },
  {
    name: "shell.runReadOnlyCommand",
    permissionLevel: "read",
    summary: "Run an allowlisted read-only shell command in the workspace.",
  },
  {
    name: "shell.run",
    permissionLevel: "preview",
    summary: "Preview shell commands before execution.",
  },
  {
    name: "web.fetchSource",
    permissionLevel: "read",
    summary: "Fetch a user-provided public web source URL.",
  },
  {
    name: "web.search",
    permissionLevel: "read",
    summary: "Search public web sources through a configured provider.",
  },
  {
    name: "project.inspect",
    permissionLevel: "read",
    summary: "Inspect package scripts and recommend start/test commands.",
  },
  {
    name: "code.inspectRepository",
    permissionLevel: "preview",
    summary: "Collect changed files, diff summary, and diff preview without applying edits.",
  },
  {
    name: "code.proposeEdit",
    permissionLevel: "preview",
    summary: "Produce a patch proposal for user review without modifying files.",
  },
  {
    name: "code.applyProposedEdit",
    permissionLevel: "confirmed_write",
    summary: "Apply only the approved Code Agent patch proposal.",
  },
  {
    name: "file.planPdfOrganization",
    permissionLevel: "preview",
    summary: "Create a dry-run plan for organizing PDF files without moving them.",
  },
  {
    name: "file.executePdfOrganization",
    permissionLevel: "confirmed_write",
    summary: "Move PDF files exactly as listed in an approved dry-run plan.",
  },
  {
    name: "file.scanInstalledApps",
    permissionLevel: "read",
    summary: "Scan installed desktop applications from Start Menu and Desktop shortcuts.",
  },
  {
    name: "file.scanUserDocuments",
    permissionLevel: "read",
    summary: "Scan user document files across Desktop, Documents, and Downloads.",
  },
  {
    name: "file.scanUserImages",
    permissionLevel: "read",
    summary: "Scan user image files across common user directories.",
  },
  {
    name: "file.listDirectory",
    permissionLevel: "read",
    summary: "List direct children of a directory for file explorer browsing.",
  },
  {
    name: "file.classifyDocuments",
    permissionLevel: "read",
    summary: "Classify scanned local documents into predefined categories using AI.",
  },
  {
    name: "computer.openPath",
    permissionLevel: "read",
    summary: "Open a file or directory path in the native OS shell.",
  },
  {
    name: "scheduler.createTask",
    permissionLevel: "confirmed_write",
    summary: "Create a durable local scheduled task or reminder.",
  },
  {
    name: "scheduler.updateTask",
    permissionLevel: "confirmed_write",
    summary: "Update a previously created local scheduled task.",
  },
  {
    name: "scheduler.deleteTask",
    permissionLevel: "confirmed_write",
    summary: "Delete a previously created local scheduled task.",
  },
  {
    name: "workspace.list",
    permissionLevel: "read",
    summary: "List installed custom workspace definitions.",
  },
  {
    name: "workspace.scaffold",
    permissionLevel: "preview",
    summary: "Generate a workspace definition JSON from a natural language description.",
  },
  {
    name: "workspace.create",
    permissionLevel: "confirmed_write",
    summary: "Save a new workspace definition to disk.",
  },
  {
    name: "workspace.delete",
    permissionLevel: "confirmed_write",
    summary: "Remove a workspace definition from disk.",
  },
];
