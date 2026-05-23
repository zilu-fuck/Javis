import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createFileScanTaskRuntime, createInitialTaskSnapshot } from "@javis/core";
import { JavisWorkbench } from "@javis/ui";
import "./App.css";

function App() {
  const runtime = useMemo(
    () =>
      createFileScanTaskRuntime({
        fileTool: {
          scanMarkdownDocuments: () => invoke("scan_markdown_documents"),
        },
      }),
    [],
  );
  const [task, setTask] = useState(createInitialTaskSnapshot);
  const [draftGoal, setDraftGoal] = useState(
    "Find the Markdown documents in the current workspace and summarize what each one is for.",
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
