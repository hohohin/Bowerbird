import { useLayoutEffect } from "react";

const GAP = 8;

/** Keep keyed cards under one parent so reflow never reloads their images. */
export function useMasonryLayout(element: HTMLDivElement | null, targetWidth: number, items: readonly unknown[], inset = GAP) {
  useLayoutEffect(() => {
    if (!element) return;
    const cells = Array.from(element.children) as HTMLElement[];
    if (!cells.length) return;
    let frame = 0;
    let disposed = false;
    function layout() {
      frame = 0;
      if (disposed || !element) return;
      const available = element.clientWidth - inset * 2;
      if (available <= 0) return;
      const targetColumns = Math.max(1, Math.floor((available + GAP) / (targetWidth + GAP)));
      const target = (available - GAP * (targetColumns - 1)) / targetColumns;
      for (const cell of cells) cell.style.width = `${target}px`;

      // CSS interpolates the width. Add/remove a column only when the currently
      // visible cards fit, rather than switching columns before the size changes.
      const width = cells[0].getBoundingClientRect().width;
      const columns = Math.max(1, Math.floor((available + GAP + 0.1) / (width + GAP)));
      const heights = new Array<number>(columns).fill(inset);
      const sizes = cells.map(cell => cell.getBoundingClientRect().height);
      cells.forEach((cell, index) => {
        let column = 0;
        for (let i = 1; i < columns; i++) if (heights[i] < heights[column]) column = i;
        cell.style.transform = `translate3d(${inset + column * (width + GAP)}px, ${heights[column]}px, 0)`;
        heights[column] += sizes[index] + GAP;
      });
      element.style.height = `${Math.max(...heights) - GAP + inset}px`;
      element.dataset.columns = String(columns);
      const fresh = cells.filter(cell => !cell.dataset.positioned);
      if (fresh.length) {
        // Commit the first placement before enabling transitions. Newly loaded
        // cards should appear in place, never fly in from the grid's origin.
        fresh[0].getBoundingClientRect();
        fresh.forEach(cell => { cell.dataset.positioned = "true"; });
      }
    }
    function schedule() {
      if (!frame && !disposed) frame = requestAnimationFrame(layout);
    }
    // Also follows carousel aspect-ratio changes and each width-transition frame.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    cells.forEach(cell => observer.observe(cell));
    layout();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element, targetWidth, items, inset]);
}
