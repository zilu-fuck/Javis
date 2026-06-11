import { describe, expect, it } from "vitest";
import appTsx from "./App.tsx?raw";

describe("terminal approval contract", () => {
  it("keeps interactive terminal operations behind visible plan and native approval execution methods", () => {
    expect(appTsx).toContain("async planCreate");
    expect(appTsx).toContain('"terminal_plan_create"');
    expect(appTsx).toContain("createTerminalPlanAuditRecord(session, plan)");
    expect(appTsx).toContain("async executeCreate");
    expect(appTsx).toContain('"terminal_approve"');
    expect(appTsx).toContain('"terminal_create"');
    expect(appTsx).toContain("async planInput");
    expect(appTsx).toContain('"terminal_plan_input"');
    expect(appTsx).toContain("async executeInput");
    expect(appTsx).toContain('"terminal_input"');
  });
});
