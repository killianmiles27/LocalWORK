import { useState } from "react";
import { createRoot } from "react-dom/client";
import Thinking from "../../src/Thinking";
import "../../src/index.css";

function Fixture() {
  const [text, setText] = useState("Initial line\n".repeat(30));
  const [mounted, setMounted] = useState(true);
  return <>
    <button id="append" onClick={() => setText(value => value + "Appended line\n")}>Append</button>
    <button id="toggle" onClick={() => setMounted(value => !value)}>Toggle mount</button>
    {mounted && text && <Thinking text={text} />}
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
