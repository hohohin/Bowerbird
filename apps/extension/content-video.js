(() => {
  "use strict";
  const S = globalThis.BowerbirdCollection;
  const V = globalThis.BowerbirdVideo;

  function trackVideoDrag(onUserAction) {
    let draggedVideo = null;
    let temporaryDraggable = null;

    function restoreVideoDraggable() {
      if(!temporaryDraggable)return;
      const {video,attribute}=temporaryDraggable;
      if(video.getAttribute("draggable")==="true") {
        if(attribute===null)video.removeAttribute("draggable");else video.setAttribute("draggable",attribute);
      }
      temporaryDraggable=null;
    }
    onUserAction(document, "pointerdown",e=>{
      restoreVideoDraggable();
      if(e.button!==0 || e.isPrimary===false || e.pointerType==="touch")return;
      const video=(e.composedPath?.() || [e.target]).find(node=>node?.tagName==="VIDEO");
      if(!video || video.draggable)return;
      // Leave the native control strip to seeking/volume/fullscreen; never prevent normal playback clicks.
      const rect=video.getBoundingClientRect();
      if(video.controls && e.clientY>=rect.bottom-Math.min(64,rect.height/2))return;
      temporaryDraggable={video,attribute:video.getAttribute("draggable")};
      video.draggable=true;
    },true);
    document.addEventListener("pointerup",restoreVideoDraggable,true);
    document.addEventListener("pointercancel",restoreVideoDraggable,true);
    window.addEventListener?.("blur",restoreVideoDraggable);
    onUserAction(document, "dragstart",e=>{
      const video=(e.composedPath?.() || [e.target]).find(node=>node?.tagName==="VIDEO");
      draggedVideo=video ? V.element(video,location.href) : null;
    },true);
    document.addEventListener("dragend",()=>{draggedVideo=null;restoreVideoDraggable();},true);

    function videoFromDrop(event) {
      if(draggedVideo) return draggedVideo;
      const html=event.dataTransfer.getData("text/html");
      // Preserve image drops even when a surrounding page/link happens to contain video markup or a video URL.
      if(/<(?:img|picture)\b/i.test(html))return null;
      if(/<video\b/i.test(html)) {
        const doc=new DOMParser().parseFromString(html,"text/html");
        const element=doc.querySelector("video");
        if(element) return V.element(element,location.href);
      }
      const raw=event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      const url=raw.split(/\r?\n/).find(line=>line && !line.startsWith("#"));
      return /\.(mp4|mov|m4v|webm|mkv|avi|m3u8|mpd)(?:$|[?#])/i.test(url || "") ? V.candidate(url,location.href,{source:"video-drop"}) : null;
    }

    return videoFromDrop;
  }

  async function collectVideos() {
    const items=[];
    for(const root of globalThis.BowerbirdScanner.collectRoots()) root.querySelectorAll?.("video").forEach(video=>items.push(V.element(video,location.href)));
    for(const meta of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')) {
      items.push(V.candidate(meta.getAttribute("content"),location.href,{source:"video-metadata",name:document.title || "页面视频"}));
    }
    let totalJson=0;
    for(const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text=script.textContent || ""; totalJson+=text.length;if(totalJson>1024*1024)break;
      try {
        const visit=(value,depth=0)=>{
          if(!value || depth>8)return;
          if(Array.isArray(value)) {value.slice(0,100).forEach(item=>visit(item,depth+1));return;}
          if(typeof value!=="object")return;
          if([value["@type"]].flat().includes("VideoObject")) items.push(V.candidate(value.contentUrl,location.href,{source:"video-jsonld",name:value.name || "页面视频"}));
          for(const key of ["@graph","mainEntity","itemListElement","video"])visit(value[key],depth+1);
        };
        visit(JSON.parse(text));
      }catch{}
    }
    const siteVideo = await globalThis.BowerbirdXiaohongshu.collectVideo();
    if (siteVideo) items.unshift(siteVideo);
    const unique = new Map();
    for (const item of items) {
      if (item?.media_url && !unique.has(item.media_url)) unique.set(item.media_url, item);
    }
    return Array.from(unique.values()).slice(0, 50);
  }

  async function savePageVideo(item) {
    const support=await S.checkVideoSupport();if(!support.ok)return support;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),S.VIDEO_FETCH_TIMEOUT_MS);
    try {
      const response=await fetch(item.media_url,{signal:controller.signal});
      if(!response.ok)return {ok:false,code:"unsupported_stream"};
      const metadata={media_kind:"video",requested_url:location.href,effective_url:location.href,page_url:item.source_url,
        url:location.href,content_type:response.headers.get("content-type") || "",candidate_source:"page-video"};
      if (support.streamUpload) {
        return await BowerbirdVideoUpload.streamResponse(response, support, metadata, controller.signal, () => clearTimeout(timer));
      }
      const bytes=await V.read(response,support.maxBytes);if(V.stream(bytes))return {ok:false,code:"unsupported_stream"};const ext=V.format(bytes);
      if(!ext)return {ok:false,code:"invalid_video"};
      clearTimeout(timer);
      return S.uploadBytes(bytes.buffer,{...metadata,file_name:`video.${ext}`});
    }catch(error){return {ok:false,code:error?.code || (error?.name==="AbortError" ? "fetch_timeout" : "unsupported_stream")};}
    finally {clearTimeout(timer);}
  }

  globalThis.BowerbirdContentVideo = { trackVideoDrag, collectVideos, savePageVideo };
})();
