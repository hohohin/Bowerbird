import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowUpRight, ArrowUp, Plus, Minus, MousePointer2, Hand, Scan, Layers, Image, Video, MessageSquare, SlidersHorizontal, Maximize, PanelLeft, CornerDownRight, Sun, Moon } from 'lucide-react';
import { TacticalSelect } from '../../src/components/TacticalSelect';
import '../../src/styles.css';
import '../../src/components/TacticalMenus.css';
import './study.css';

function Cross({className=''}:{className?:string}) {return <i className={`calibration-cross ${className}`} aria-hidden="true"/>}
function App(){
 const [action,setAction]=useState('复用生成提示词');
 const [model,setModel]=useState('Seedream 5.0 Pro');
 const [ratio,setRatio]=useState('3:4');
 const [tool,setTool]=useState('选择');
 const [theme,setTheme]=useState<'light'|'dark'>(()=>new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');
 const [crosses,setCrosses]=useState(true);
 useLayoutEffect(()=>{
  document.documentElement.dataset.theme=theme;
  const url=new URL(location.href);url.searchParams.set('theme',theme);history.replaceState(null,'',url);
 },[theme]);
 const [mode,setMode]=useState('图片');
 const [expanded,setExpanded]=useState(true);
 const [prompt,setPrompt]=useState('以自然光和植物为线索，设计一张宁静、有留白的品牌海报。');
 const tools=[['选择',MousePointer2],['抓手',Hand],['分区',Scan],['内容卡片',Layers],['指令卡片',CornerDownRight],['图片卡片',Image],['视频卡片',Video],['气泡便签',MessageSquare]] as const;
 return <main className={`drawing-app ${crosses?'show-crosses':''}`}>
  <header className="topbar">
   <div className="topbar-left"><a href={`../canvas-structure-preview/index.html?theme=${theme}`} className="back"><ArrowLeft size={15}/>当前版本</a><span className="top-separator"/><span className="project-name">自然序章</span><span className="quiet">/</span><span className="quiet">画布</span></div>
   <div className="topbar-center" aria-label="视图"><button aria-pressed={crosses} onClick={()=>setCrosses(!crosses)}><Scan size={14}/>小叉背景</button><button className="theme-toggle" aria-label={theme==='light'?'切换深色模式':'切换浅色模式'} onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?<Moon size={14}/>:<Sun size={14}/>}<span>{theme==='light'?'深色':'浅色'}</span></button></div>
   <div className="account"><span className="credit-symbol">◈</span><span>1,230</span><span className="avatar">H</span></div>
  </header>
  <nav className="tool-rail" aria-label="画板工具"><button className="rail-library" aria-label="素材库（样式示意）" disabled><PanelLeft size={17}/></button><div className="rail-line"/>{tools.map(([label,Icon])=><button className="canvas-tool" key={label} title={label} aria-label={label} aria-pressed={tool===label} onClick={()=>setTool(label)}><Icon size={18}/></button>)}<div className="rail-spacer"/><button title="显示小叉背景" aria-label="显示小叉背景" aria-pressed={crosses} onClick={()=>setCrosses(!crosses)}><SlidersHorizontal size={17}/></button><span className="rail-end" aria-hidden="true">+</span></nav>
  <section className="drawing-stage" aria-label="单色工业制图画布">
   <Cross className="cross-one"/><Cross className="cross-two"/><Cross className="cross-three"/>
   <div className="local-matrix" aria-hidden="true"/>
   <div className="left-panels">
    <article className="instrument-panel command-panel">
     <div className="panel-ghost" aria-hidden="true"/><header><CornerDownRight size={15}/><h2>指令处理</h2><span className="panel-id">01</span><button aria-label="收起指令卡片" onClick={()=>setExpanded(!expanded)}><Minus size={14}/></button></header>
     <div className="command-body"><label>指令功能</label><TacticalSelect aria-label="指令功能" value={action} onValueChange={setAction}><option>反推</option><option>复用生成提示词</option><option>分层编辑</option></TacticalSelect>
     {expanded&&<div className="input-binding"><Image size={14}/><span>图片</span><span className="binding-line"/><span className="mono">01</span></div>}</div>
     <footer><span className="status"><i/>未运行</span><button className="run-button" onClick={()=>setExpanded(!expanded)} aria-label="展开或收起指令参数"><Maximize size={12}/>{expanded?'收起':'展开'}</button></footer>
     <i className="port port-in" aria-hidden="true"/><i className="port port-out" aria-hidden="true"/>
    </article>
    <article className="instrument-panel generation-panel">
     <div className="panel-ghost" aria-hidden="true"/><header><Image size={15}/><h2>{mode}生成</h2><span className="panel-id">02</span><span className="header-cross" aria-hidden="true">×</span></header>
     <div className="parameter-row"><TacticalSelect aria-label="生成类型" value={mode} onValueChange={setMode}><option>图片</option><option>视频</option></TacticalSelect><TacticalSelect aria-label="画面比例" value={ratio} onValueChange={setRatio}>{['自动','1:1','3:4','4:3','9:16','16:9'].map(r=><option key={r}>{r}</option>)}</TacticalSelect></div>
     <TacticalSelect className="model-control" aria-label="生成模型" value={model} onValueChange={setModel}><optgroup label="Bowerbird"><option>Seedream 5.0 Pro</option><option>Seedance 2.5</option></optgroup><optgroup label="自有订阅"><option>gpt-image-2</option></optgroup></TacticalSelect>
     <textarea aria-label="卡片指令" value={prompt} onChange={e=>setPrompt(e.target.value)}/>
     <div className="input-binding"><span className="input-square"/><span>参考图片</span><span className="binding-line"/><span className="mono">01</span></div>
     <footer><span className="status"><i/>未运行</span><span className="output-port"><ArrowUpRight size={13}/></span></footer>
     <i className="port port-in" aria-hidden="true"/><i className="port port-out" aria-hidden="true"/>
    </article>
   </div>
  </section>
  <section className="composer" aria-label="创作描述"><div className="composer-ghost" aria-hidden="true"/><div className="composer-mode"><button aria-pressed={mode==='图片'} onClick={()=>setMode('图片')}><Image size={13}/>图片</button><button aria-pressed={mode==='视频'} onClick={()=>setMode('视频')}><Video size={13}/>视频</button></div><textarea aria-label="创作描述" placeholder="描述你的意图，开始创作吧"/><div className="composer-bottom"><button className="add-reference" disabled title="样式示意"><Plus size={14}/>参考素材</button><span className="composer-rule"/><TacticalSelect aria-label="创作画面比例" value={ratio} onValueChange={setRatio}>{['自动','1:1','3:4','4:3','9:16','16:9'].map(r=><option key={r}>{r}</option>)}</TacticalSelect><button className="send" disabled aria-label="示意页不执行生成"><ArrowUp size={16}/></button></div></section>
 </main>
}
const root = createRoot(document.getElementById('root')!);
root.render(<App/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
