import { createInitialTaskSnapshot } from "@javis/core";
import { JavisWorkbench } from "@javis/ui";
import "./App.css";

const initialTask = createInitialTaskSnapshot();

function App() {
  return <JavisWorkbench task={initialTask} />;
}

export default App;
