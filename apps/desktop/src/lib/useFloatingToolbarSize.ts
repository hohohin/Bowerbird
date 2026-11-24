import { useLayoutEffect, useState, type RefObject } from "react";
import type { ToolbarSize } from "./floatingToolbar";

export function useFloatingToolbarSize(ref: RefObject<HTMLElement>, mounted: boolean) {
  const [size, setSize] = useState<ToolbarSize | null>(null);
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!mounted || !toolbar) return;
    const measure = () => {
      const { width, height } = toolbar.getBoundingClientRect();
      setSize(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar, { box: "border-box" });
    return () => observer.disconnect();
  }, [ref, mounted]);
  return size;
}
