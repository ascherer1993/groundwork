import { useEffect, useRef } from "react";
import { createPageFrame } from "../lib/pages";

/** An HTML page (`.html` or `.page` bundle), live in a sandboxed frame. */
export function PageView({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = createPageFrame(path);
    ref.current!.append(frame);
    return () => frame.remove();
  }, [path]);

  return <div className="page-view" ref={ref} />;
}
