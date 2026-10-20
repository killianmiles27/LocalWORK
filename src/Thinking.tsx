import { useLayoutEffect, useRef } from "react";

/** Live reasoning follows new tokens until the reader scrolls away from the bottom. */
export default function Thinking({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll() {
    const el = ref.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return <div ref={ref} role="region" aria-label="Assistant thinking" onScroll={onScroll} className="text-xs text-muted italic whitespace-pre-wrap max-h-24 overflow-auto">{text}</div>;
}
