export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";

export interface ToolDescriptor {
  name: string;
  permissionLevel: PermissionLevel;
  summary: string;
}

export const initialToolDescriptors: ToolDescriptor[] = [
  {
    name: "file.search",
    permissionLevel: "read",
    summary: "Search files inside the active workspace.",
  },
  {
    name: "shell.run",
    permissionLevel: "preview",
    summary: "Preview shell commands before execution.",
  },
];
