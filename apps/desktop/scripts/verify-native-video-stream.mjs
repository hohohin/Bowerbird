// Isolated WebView2 transport verification; no production database or account.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const directory=path.resolve('.tmp/video-stream-native-'+Date.now());
await mkdir(directory,{recursive:true});
const bytes=await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
const ffmpeg=path.resolve(process.env.BOWERBIRD_FFMPEG_BINARY||'../../.tmp/video-integration/tools/local/ffmpeg.exe');
const ffprobe=path.resolve(process.env.BOWERBIRD_FFPROBE_BINARY||'../../.tmp/video-integration/tools/local/ffprobe.exe');
const research=path.join(directory,'media');
await mkdir(path.join(research,'hls'),{recursive:true});await mkdir(path.join(research,'dash'),{recursive:true});
const generate=(args,cwd)=>execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{cwd,windowsHide:true,timeout:30000});
generate(['-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-g','25','-keyint_min','25','-sc_threshold','0','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k',path.join(research,'source.mp4')]);
generate(['-i',path.join(research,'source.mp4'),'-c','copy','-hls_time','1','-hls_playlist_type','vod','-hls_segment_filename',path.join(research,'hls','segment_%03d.ts'),path.join(research,'hls','index.m3u8')]);
generate(['-i',path.join(research,'source.mp4'),'-map','0','-c','copy','-seg_duration','1','-use_template','1','-use_timeline','1','-f','dash','manifest.mpd'],path.join(research,'dash'));
const separate=path.join(directory,'separate');await mkdir(separate,{recursive:true});
for(const [kind,map] of [['video','0:v:0'],['audio','0:a:0']])execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',path.join(research,'source.mp4'),'-map',map,'-c','copy','-hls_time','1','-hls_playlist_type','vod','-hls_segment_filename',path.join(separate,kind+'-%03d.ts'),path.join(separate,kind+'.m3u8')],{windowsHide:true});
await writeFile(path.join(separate,'master.m3u8'),'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="sound"\nvideo.m3u8\n');
const resources=new Map();
for(const [prefix,folder] of [['hls',path.join(research,'hls')],['dash',path.join(research,'dash')],['separate',separate]])for(const name of await readdir(folder))resources.set('/'+prefix+'/'+name,await readFile(path.join(folder,name)));
const type=url=>/\.m3u8$/.test(url)?'application/vnd.apple.mpegurl':/\.mpd$/.test(url)?'application/dash+xml':'application/octet-stream';
const servers=[];const timers=new Set();const requests=[],crossRequests=[];let slowStarted=0,slowClosed=0,guardRequests=0,guardClosed=0;
async function serve(port,handler){const server=createServer(handler);servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
await serve(1557,(_,res)=>{res.setHeader('content-type','text/html');res.end('<body>isolated main</body>');});
await serve(1558,(req,res)=>{
  requests.push(req.url);
  if(req.url==='/redirect.mp4'){res.writeHead(302,{location:'http://127.0.0.1:1559/clip.mp4'});res.end();return;}
  if(req.url==='/gzip.mp4'){const zipped=gzipSync(bytes);res.writeHead(200,{'content-type':'video/mp4','content-encoding':'gzip','content-length':zipped.length});res.end(zipped);return;}
  if(req.url==='/gzip/index.m3u8'){const zipped=gzipSync(resources.get('/hls/index.m3u8'));res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','content-encoding':'gzip','content-length':zipped.length});res.end(zipped);return;}
  if(req.url?.startsWith('/gzip/')){const item=resources.get(req.url.replace('/gzip/','/hls/'));res.writeHead(item?200:404,{'content-type':type(req.url)});res.end(item);return;}
  if(req.url?.startsWith('/missing/')){const item=req.url.includes('segment_001')?null:resources.get(req.url.replace('/missing/','/hls/'));res.writeHead(item?200:404,{'content-type':type(req.url)});res.end(item);return;}
  if(resources.has(req.url)){res.setHeader('content-type',type(req.url));res.end(resources.get(req.url));return;}
  if(req.url==='/slow.mp4'){
    slowStarted++;res.once('close',()=>slowClosed++);
    const timer=setTimeout(()=>{timers.delete(timer);res.setHeader('content-type','video/mp4');res.end(bytes);},15000);timers.add(timer);return;
  }
  if(req.url==='/clip.mp4'){res.setHeader('content-type','video/mp4');res.end(bytes);return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.setHeader('content-type','text/html');res.setHeader('set-cookie','nativeVideo=allowed; HttpOnly; Path=/; SameSite=Lax');res.end('<video id="target"></video>');
});
await serve(1559,(req,res)=>{
  crossRequests.push(req.url);
  if(!req.headers.cookie?.includes('nativeVideo=allowed')){res.writeHead(401);res.end();return;}
  if(req.url==='/guard-slow/index.m3u8'){
    guardRequests++;res.setHeader('cache-control','no-store');res.setHeader('content-type','application/vnd.apple.mpegurl');res.setHeader('access-control-allow-origin','http://127.0.0.1:1558');res.setHeader('access-control-allow-credentials','true');
    if(guardRequests===1){res.end(resources.get('/hls/index.m3u8'));return;}
    res.once('close',()=>guardClosed++);const timer=setTimeout(()=>{timers.delete(timer);res.end(resources.get('/hls/index.m3u8'));},15000);timers.add(timer);return;
  }
  if(/^\/(?:old|new|cors)\//.test(req.url)){
    res.setHeader('access-control-allow-origin','http://127.0.0.1:1558');res.setHeader('access-control-allow-credentials','true');
    if(req.url==='/old/index.m3u8'){res.writeHead(302,{location:'/new/index.m3u8'});res.end();return;}
    const item=resources.get(req.url.replace(/^\/(?:old|new|cors)\//,'/hls/'));res.writeHead(item?200:404,{'content-type':type(req.url)});res.end(item);return;
  }
  if(req.url?.startsWith('/no-cors/')){const item=resources.get(req.url.replace('/no-cors/','/hls/'));res.writeHead(item?200:404,{'content-type':type(req.url)});res.end(item);return;}
  if(req.url==='/partial.mp4'){res.writeHead(206,{'content-type':'video/mp4','content-range':`bytes 0-99/${bytes.length}`});res.end(bytes.subarray(0,100));return;}
  if(req.url==='/gzip.mp4'){const zipped=gzipSync(bytes);res.writeHead(200,{'content-type':'video/mp4','content-encoding':'gzip','content-length':zipped.length});res.end(zipped);return;}
  res.setHeader('content-type','video/mp4');res.end(bytes);
});
let child,browser,sourceBrowser;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let i=0;i<100;i++){const value=await predicate();if(value)return value;await pause(100);}throw new Error('native fixture timeout');};
try{
  child=spawn(path.resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))||'src-tauri/target-local-classification/debug/examples/explorer_smoke.exe'),[],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:path.resolve('src-tauri/target-local-classification/debug')+';'+process.env.PATH,
      BOWERBIRD_FFMPEG_BINARY:ffmpeg,BOWERBIRD_FFPROBE_BINARY:ffprobe,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'',BOWERBIRD_EXPLORER_TEST_DEBUG_PORT:'9558',BOWERBIRD_EXPLORER_TEST_DATA_DIR:path.join(directory,'source'),BOWERBIRD_EXPLORER_TEST_MAIN_DATA_DIR:path.join(directory,'main')}
  });
  let output='';child.stderr.on('data',data=>output+=data);
  browser=await until(async()=>{if(child.exitCode!==null)throw new Error(output);try{return await chromium.connectOverCDP('http://127.0.0.1:9557');}catch{return null;}});
  const main=await until(()=>browser.contexts()[0].pages().find(page=>page.url().startsWith('http://127.0.0.1:1557')));
  await main.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
  await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('open_source_browser',{url:'http://127.0.0.1:1558/',bounds:{x:300,y:100,width:750,height:600}}));
  sourceBrowser=await until(async()=>{try{return await chromium.connectOverCDP('http://127.0.0.1:9558');}catch{return null;}});
  const source=await until(()=>sourceBrowser.contexts()[0].pages().find(page=>page.url().startsWith('http://127.0.0.1:1558')));
  await source.waitForFunction(()=>window.__bbSourceVideo);
  const url=await source.evaluate(base64=>{
    const value=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([value],{type:'video/mp4'}));
    target.src=url;window.__bbSourceVideo.remember(target,url,location.href);return url;
  },bytes.toString('base64'));
  const capture=(url,captureId)=>main.evaluate(({url,captureId})=>window.__TAURI_INTERNALS__.invoke('smoke_capture_resource',{url,pageUrl:'http://127.0.0.1:1558/',captureId}),{url,captureId});
  assert.deepEqual(Buffer.from(await capture(url,'blob-native'),'base64'),bytes);
  assert.deepEqual(Buffer.from(await capture('http://127.0.0.1:1559/clip.mp4','cookie-native'),'base64'),bytes);
  assert.deepEqual(Buffer.from(await capture('http://127.0.0.1:1558/redirect.mp4','redirect-native'),'base64'),bytes,'same-origin entry redirected across origins preserves native authenticated download');
  for(const port of [1558,1559])assert.deepEqual(Buffer.from(await capture(`http://127.0.0.1:${port}/gzip.mp4`,'gzip-'+port),'base64'),bytes,'gzip content length differs from decoded bytes');
  await assert.rejects(capture('http://127.0.0.1:1559/partial.mp4','partial-native'),/完整|部分/);
  await assert.rejects(capture('http://127.0.0.1:1559/old/index.m3u8','redirect-manifest-native'),/清单.*(?:跳转|确认)/,'a redirected manifest must not read valid same-name segments from its old directory');
  assert.equal(crossRequests.filter(url=>url.startsWith('/old/segment_')).length,0);
  await assert.rejects(capture('http://127.0.0.1:1559/no-cors/index.m3u8','opaque-manifest-native'),/清单.*确认|确认.*清单/);
  for(const [name,relative] of process.argv.includes('--transport-only')?[]:[['hls','/hls/index.m3u8'],['audio','/separate/master.m3u8'],['dash','/dash/manifest.mpd'],['gzip-hls','/gzip/index.m3u8'],['cors-hls','http://127.0.0.1:1559/cors/index.m3u8']]){
    const output=path.join(directory,name+'.mp4');await writeFile(output,Buffer.from(await capture(relative.startsWith('http')?relative:'http://127.0.0.1:1558'+relative,name+'-native'),'base64'));
    const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',output],{encoding:'utf8',windowsHide:true}));
    assert.ok(Number(probe.format.duration)>3.8&&Number(probe.format.duration)<4.2,name+' keeps complete duration');
    assert.deepEqual(new Set(probe.streams.map(stream=>stream.codec_type)),new Set(['video','audio']),name+' keeps video and audio');
    execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',output,'-f','null','-'],{windowsHide:true});
    console.log('native stream passed: '+name);
  }
  await main.evaluate(()=>{
    window.guardResult=null;
    void window.__TAURI_INTERNALS__.invoke('smoke_capture_resource',{url:'http://127.0.0.1:1559/guard-slow/index.m3u8',pageUrl:'http://127.0.0.1:1558/',captureId:'cancel-guard-native'}).then(()=>window.guardResult='saved',error=>window.guardResult=String(error));
  });
  await until(()=>guardRequests===2);const guardStarted=Date.now();
  assert.equal(await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('cancel_source_browser_capture',{captureId:'cancel-guard-native'})),true);
  await main.waitForFunction(()=>window.guardResult!==null,{},{timeout:3000});
  assert.match(await main.evaluate(()=>window.guardResult),/取消/);await until(()=>guardClosed===1);
  assert.ok(Date.now()-guardStarted<3000,'manifest base confirmation is abortable while waiting for headers');
  const cspSegments=crossRequests.filter(url=>url.startsWith('/cors/segment_')).length;
  await source.evaluate(()=>{const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="connect-src 'self'";document.head.append(policy);});
  await assert.rejects(capture('http://127.0.0.1:1559/cors/index.m3u8','csp-manifest-native'),/清单.*确认|确认.*清单|浏览器无法读取视频/);
  assert.equal(crossRequests.filter(url=>url.startsWith('/cors/segment_')).length,cspSegments,'CSP rejection never proceeds to any segment');
  await assert.rejects(capture('http://127.0.0.1:1558/missing/index.m3u8','missing-native'),/完整|片段|读取/);
  await main.evaluate(()=>{
    window.captureResult=null;
    void window.__TAURI_INTERNALS__.invoke('smoke_capture_resource',{url:'http://127.0.0.1:1558/slow.mp4',pageUrl:'http://127.0.0.1:1558/',captureId:'cancel-native'}).then(()=>window.captureResult='saved',error=>window.captureResult=String(error));
  });
  await until(()=>slowStarted===1);const started=Date.now();
  assert.equal(await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('cancel_source_browser_capture',{captureId:'cancel-native'})),true);
  await main.waitForFunction(()=>window.captureResult!==null,{},{timeout:3000});
  assert.match(await main.evaluate(()=>window.captureResult),/取消/);
  await until(()=>slowClosed===1);assert.ok(Date.now()-started<3000,'cancelling pending headers aborts the renderer request');
  await source.evaluate(()=>history.pushState({},'','/changed'));
  await assert.rejects(capture(url,'stale-native'),/切换/);
  for(const [site,origin,detail,record] of [
    ['xhs','https://www.xiaohongshu.com','/explore/note-a',{id:'note-a',note_card:{video:{media:{stream:{EF7:[],EF4:[{videoCodec:'EF4',master_url:'/clip.mp4'}],EF6:[]}}}}}],
    ['pin','https://www.pinterest.com','/pin/123456789/',{id:'123456789',videos:{video_list:{V_HLS:{url:'/hls/index.m3u8'}}}}],
  ]){
    await source.route(origin+'/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/feed')return route.fulfill({headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'40'},body:JSON.stringify({data:{items:[record]}})});
      if(pathname==='/clip.mp4')return route.fulfill({contentType:'video/mp4',body:bytes});
      if(resources.has(pathname))return route.fulfill({contentType:type(pathname),body:resources.get(pathname)});
      return route.fulfill({contentType:'text/html',body:'<video id="target"></video>'});
    });
    for(const mode of ['response','index']){
      await main.evaluate(url=>window.__TAURI_INTERNALS__.invoke('navigate_source_browser',{url}),origin+'/');
      await source.waitForURL(origin+'/');
      const sourceUrl=await source.evaluate(async({detail,site,record,mode})=>{
        if(mode==='response')await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/feed');xhr.responseType='json';xhr.onload=resolve;xhr.send();});
        else{
          const noise=Object.fromEntries(Array.from({length:100},(_,i)=>['r'+i,{dep:{subs:Array.from({length:100},()=>({sub:{active:true}}))}}]));
          const ref=value=>({__v_isRef:true,dep:noise,value});
          if(site==='xhs')window.__INITIAL_STATE__={global:noise,note:ref({noteDetailMap:ref({'note-a':{note:record.note_card}})})};
          else window.__PWS_DATA__={context:noise,props:{initialReduxState:{pins:{[record.id]:record}}}};
        }
        history.pushState({},'',detail);
        target.src=URL.createObjectURL(new MediaSource());
        window.__bbSourceVideo.remember(target,target.src,location.href);return target.src;
      },{detail,site,record,mode});
      const captured=Buffer.from(await main.evaluate(({url,pageUrl,captureId})=>window.__TAURI_INTERNALS__.invoke('smoke_capture_resource',{url,pageUrl,captureId}),{url:sourceUrl,pageUrl:origin+detail,captureId:site+'-'+mode+'-native'}),'base64');
      if(site==='xhs')assert.deepEqual(captured,bytes,'Xiaohongshu blob resolves to complete original MP4 bytes');
      else{
        const output=path.join(directory,'pin-spa.mp4');await writeFile(output,captured);
        const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',output],{encoding:'utf8',windowsHide:true}));
        assert.ok(Number(probe.format.duration)>3.8&&Number(probe.format.duration)<4.2);
        assert.deepEqual(new Set(probe.streams.map(stream=>stream.codec_type)),new Set(['video','audio']));
        execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',output,'-f','null','-'],{windowsHide:true});
      }
      console.log('native site source passed: '+site+' '+mode+' blob → metadata → full video');
    }
  }
  console.log(JSON.stringify({ok:true,blobBytes:true,crossOriginCookiesWithoutCors:true,gzipDecodedLength:true,hls:!process.argv.includes('--transport-only'),separateAudio:!process.argv.includes('--transport-only'),dash:!process.argv.includes('--transport-only'),manifestBaseVerified:true,redirectedManifestRejected:true,unverifiedManifestRejected:true,manifestGuardCancelled:true,missingSegmentRejected:true,partialRejected:true,pendingHeadersCancelled:true,staleDocumentRejected:true,profiles:directory}));
}catch(error){console.error(JSON.stringify({recentRequests:requests.slice(-18),directory}));throw error;}finally{
  if(child&&child.exitCode===null)await new Promise(resolve=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('exit',resolve));
  await browser?.close().catch(()=>{});await sourceBrowser?.close().catch(()=>{});
  for(const timer of timers)clearTimeout(timer);
  for(const server of servers)server.closeAllConnections();
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
}
