import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {LibraryHome} from '../../src/components/LibraryHome';
import {Toolbar} from '../../src/components/Toolbar';
import {ToastViewport} from '../../src/components/ToastViewport';
import {useStore} from '../../src/store';
import {useLocalFileMode} from '../../src/lib/localFileMode';
import {installCatalogPagingMock} from '../../scripts/fixtures/catalogPagingMock';
import '../../src/styles.css';
import '../../src/components/LocalFileWorkspace.css';
import './study.css';

// Isolated presentation only: actual production components, synthetic IPC and local demo images.
const w=window as any;
const images: string[]=w.demoImages;
const sizes=await Promise.all(images.map(src=>new Promise<{width:number;height:number}>(resolve=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.src=src;})));
const names=['林间来信','花的几何','花瓣与微光','字体研究','月下礼序','澄澈','植物与光','自然构成','纯净之形','兰花物语','午后的陪伴','日常片段'];
const tags=[{id:'brand',name:'品牌视觉'},{id:'graphic',name:'平面设计'},{id:'illustration',name:'插画艺术'}];
const sequence=[4,5,6,7,8,6,7,8,1,2,3,9,2,1,9,3,0,10,11,0,10,11,0,10];
const assets=sequence.map((image,index)=>({id:'study-'+index,name:names[image]+' '+String(index%8+1).padStart(2,'0'),ext:'jpg',source:'imported',width:sizes[image].width,height:sizes[image].height,store_path:images[image],thumb_path:images[image],created_at:1729700000-index*100,tag:tags[Math.floor(index/8)].id,generation_session_id:index%5===0?'generated':null}));
const videos=[{...assets[6],id:'video-1',name:'植物与光 · 动态',ext:'mp4',store_path:'/demo-video-1.mp4'},{...assets[9],id:'video-2',name:'花的秩序 · 动态',ext:'mp4',store_path:'/demo-video-2.mp4'}];
const catalog={tags:tags.map(t=>({...t,count:8,projectCount:0,description:''})),prompts:[],collections:[{id:'collection',name:'灵感收藏',kind:'collection',parent_id:null}],tag_asset_ids:Object.fromEntries(tags.map(t=>[t.id,assets.filter(a=>a.tag===t.id).map(a=>a.id)]))};
const callbacks=new Map<number,(e:unknown)=>void>();let callbackId=0;
w.calls=[];w.store=useStore;w.mode=useLocalFileMode;
w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:(fn:(e:unknown)=>void)=>{callbacks.set(++callbackId,fn);return callbackId;},convertFileSrc:(path:string)=>path,invoke:async(command:string,args:any={})=>{
 w.calls.push({command});
 if(command==='plugin:event|listen')return args.handler;
 if(command==='plugin:event|unlisten'){callbacks.delete(args.eventId);return;}
 if(command==='material_catalog')return catalog;
 if(command==='material_catalog_assets')return args.kind==='collections'?assets.slice(0,8):[...assets,...videos];
 if(command==='get_assets_by_ids')return [...assets,...videos].filter(a=>args.assetIds.includes(a.id));
 if(command==='external_file_media')return args.path?.startsWith('data:')?args.path:videos.find(a=>a.store_path===args.path)?.thumb_path??images[0];
 if(command==='file_colors')return ['#e9d7d0','#9db0c2','#73835e'];
 if(command==='get_projects'||command==='list_projects'||command==='get_folders'||command==='get_collections')return [];
 if(command==='get_settings')return {};
 if(command==='set_setting')return;
 if(command.startsWith('plugin:dialog|'))return null;
 if(command==='get_asset')return assets.find(a=>a.id===args.id)||assets[0];
 if(command==='list_directory')return {path:'',entries:[],roots:[]};
 return null;
}};
installCatalogPagingMock(w);
useStore.setState({activeProjectId:null,libraryThumbnailWidth:210,loading:false,assets:assets as any,mode:'browse',cloudAuth:{logged_in:true,display_name:'Hins',cloud_available:true} as any,cloudEntitlement:{tier:'pro',balances:{daily:30,sub:1100,topup:100},policy:{can_use_cloud:true,can_use_byo:true},recent_transactions:[],generation_services:[],prompt_configs:[]} as any});
useLocalFileMode.setState({mode:'tags',views:{global:'tags',project:'tags'},query:''});
function TacticalMarks(){
 return <div className="study-tactical-marks" aria-hidden="true"/>;
}
function Study(){
 const [styled,setStyled]=useState(true),[dark,setDark]=useState(new URLSearchParams(location.search).get('theme')==='dark'),[paused,setPaused]=useState(false),[layers,setLayers]=useState<Element[]>([]),[notice,setNotice]=useState('');
 useEffect(()=>{document.documentElement.dataset.study=styled?'terminal':'original';},[styled]);
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';},[dark]);
 useEffect(()=>{const sync=()=>{document.documentElement.dataset.studyPaused=String(paused||document.hidden);};sync();document.addEventListener('visibilitychange',sync);return()=>document.removeEventListener('visibilitychange',sync);},[paused]);
 useEffect(()=>{const update=()=>setLayers(old=>{const next=[...document.querySelectorAll('.catalog-gallery')];return next.length===old.length&&next.every((e,i)=>e===old[i])?old:next;});const observer=new MutationObserver(update);observer.observe(document.getElementById('root')!,{childList:true,subtree:true});update();return()=>observer.disconnect();},[]);
 return <><div className="app-shell flex h-full w-full flex-col">
   <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={()=>{}} onRefresh={async()=>{}} onCreateCreative={()=>{}} onExplore={()=>setNotice('此示意页仅演示素材库样式。')}/>
   <div className="app-shell-hatch" aria-hidden="true"><span/></div>
   <div className="relative flex flex-1 overflow-hidden"><main className="app-workspace relative flex flex-1 flex-col overflow-hidden bg-canvas"><div className="relative min-h-0 flex-1 overflow-clip"><LibraryHome/></div></main></div>
 </div>{layers.map((layer,i)=>createPortal(<div className="study-gallery-decoration" aria-hidden="true"><TacticalMarks/></div>,layer,String(i)))}
 <div className="study-tools" aria-label="示意页对比工具"><small>TACTICAL · 04 + 05</small><button id="compare" aria-pressed={styled} onClick={()=>setStyled(v=>!v)}>{styled?'查看原样式':'查看新样式'}</button><button id="theme" onClick={()=>setDark(v=>!v)}>{dark?'浅色':'深色'}</button><button id="motion" aria-pressed={!paused} onClick={()=>setPaused(v=>!v)}>{paused?'播放':'暂停'}闪动</button></div>
 {notice&&<div className="study-notice" role="status" onClick={()=>setNotice('')}>{notice}　×</div>}<ToastViewport/>
 </>;
}
createRoot(document.getElementById('root')!).render(<Study/>);
