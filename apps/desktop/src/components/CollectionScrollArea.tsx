import { useId, useLayoutEffect, type CSSProperties, type ReactNode, type Ref } from "react";
import { enableOverlayScrollbars } from "./OverlayScrollbars";

export function CollectionScrollArea({ children }: { children: ReactNode }) {
  return <OverlayScrollArea contentClassName="collection-scroll-content" label="文件夹素材滚动条">{children}</OverlayScrollArea>;
}

/** 保留素材区的布局与引用；悬浮滚动条由全局共用管理器绘制。 */
export function OverlayScrollArea({ children, className = "", viewportClassName = "", contentClassName,
  viewportStyle, scrollRef, label = "素材滚动条" }: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  viewportStyle?: CSSProperties;
  scrollRef?: Ref<HTMLDivElement>;
  label?: string;
}) {
  const id = useId();
  useLayoutEffect(enableOverlayScrollbars, []);
  return <div className={`collection-scroll-area ${className}`}>
    <div id={id} ref={scrollRef} className={`collection-scroll-viewport ${viewportClassName}`} style={viewportStyle}
      data-overlay-scroll-label={label}>
      <div className={contentClassName}>{children}</div>
    </div>
  </div>;
}
