import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayScrollArea } from '../../../src/components/CollectionScrollArea';
import { OverlayScrollbars } from '../../../src/components/OverlayScrollbars';
import '../../../src/styles.css';
import '../../../src/components/IndustrialTheme.css';

const w = window as any;
w.callbackView = null;
function Review() {
  const [root, setRoot] = useState(true), [one, setOne] = useState(true), [two, setTwo] = useState(true);
  const objectRef = useRef<HTMLDivElement>(null);
  w.objectRef = objectRef;
  w.removeRoot = () => setRoot(false); w.removeOne = () => setOne(false); w.removeTwo = () => setTwo(false);
  return <>
    {root && <OverlayScrollbars/>}
    {one && <OverlayScrollArea className="review-wrapper" viewportClassName="review-one" contentClassName="review-content" viewportStyle={{height:180,width:300,overflow:'auto'}}
      scrollRef={element => {w.callbackView=element;}} label="品牌素材滚动条"><div style={{height:900,width:600}}>素材区域</div></OverlayScrollArea>}
    {two && <OverlayScrollArea className="review-wrapper" viewportClassName="review-two" viewportStyle={{height:180,width:300,overflow:'auto'}} scrollRef={objectRef} label="项目素材滚动条"><div style={{height:900,width:600}}>项目区域</div></OverlayScrollArea>}
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Review/></StrictMode>);
