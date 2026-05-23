import { useEffect, useMemo, useState } from "react";
import { createDemoTaskRuntime, createInitialTaskSnapshot } from "@javis/core";
import { JavisWorkbench } from "@javis/ui";
import "./App.css";

function App() {
  const runtime = useMemo(() => createDemoTaskRuntime(), []);
  const [task, setTask] = useState(createInitialTaskSnapshot);
  const [draftGoal, setDraftGoal] = useState(
    "帮我找出当前项目中最近修改过的文档，并总结每个文档的用途",
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
