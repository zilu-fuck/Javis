import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createFileScanTaskRuntime, createInitialTaskSnapshot } from "@javis/core";
import type { MarkdownDocument, ShellCommandOutput, ShellCommandRequest } from "@javis/tools";
import { JavisWorkbench } from "@javis/ui";
import "./App.css";

function App() {
  const runtime = useMemo(
    () =>
      createFileScanTaskRuntime({
        fileTool: {
          scanMarkdownDocuments: () =>
            invoke<MarkdownDocument[]>("scan_markdown_documents", { workspacePath: null }),
        },
        shellTool: {
          runReadOnlyCommand: (request: ShellCommandRequest) =>
            invoke<ShellCommandOutput>("run_read_only_command", { request }),
        },
      }),
    [],
  );
  const [task, setTask] = useState(createInitialTaskSnapshot);
  const [draftGoal, setDraftGoal] = useState(
    "检查当前项目，告诉我怎么启动，并尝试跑一次测试",
  );

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setTask);
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [runtime]);

  function submitGoal() {
    const goal = draftGoal.trim();
    if (!goal) {
      return;
    }
    runtime.start(goal);
  }

  return (
    <JavisWorkbench
      draftGoal={draftGoal}
      onDraftGoalChange={setDraftGoal}
      onSubmitGoal={submitGoal}
      task={task}
    />
  );
}

export default App;
