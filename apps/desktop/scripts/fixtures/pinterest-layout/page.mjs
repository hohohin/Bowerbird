// Structural fixture from Pinterest's public LensImage/LensPageContent modules.
// Images, Pin records and interaction handlers are synthetic; no account is used.
export function lensFixture() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic Lens results</title>
<style>
*{box-sizing:border-box}body{margin:0;overflow-y:scroll;background:white;font:14px Arial,sans-serif;color:#111}
#site-header{height:72px;position:relative;padding:22px;background:white;z-index:3;border-bottom:1px solid #eee}
#lens-content{display:flex;flex-direction:row;gap:0;padding-top:16px}
[data-test-id="visual-search-image-container"]{position:fixed;top:88px;margin-inline-start:16px;width:536px;height:calc(100vh - 104px)}
[data-test-id="visual-search-image-container-placeholder"]{min-width:536px;height:1px;margin-inline-start:16px}
#source-relative{position:relative}
#source-mask{position:relative;width:520px;height:2080px;overflow:hidden;border-radius:16px}
#source-aspect{position:relative;width:100%;padding-bottom:400%}
#source-image{position:absolute;top:0;left:0;display:block;width:100%;height:100%;object-fit:cover}
[data-test-id="visual-search-cropper"]{position:absolute;inset:0;width:520px;border:2px solid #eee;background:transparent}
#results{flex:1 1 auto;min-width:0}
[data-test-id="masonry-container"]{width:100%}
[data-test-id="max-width-container"]{max-width:2360px;margin-inline:auto;padding-inline:8px}
#native-grid-wrapper{width:100%}#native-grid{position:relative;width:100%;min-height:400px}
[data-grid-item]{position:absolute;left:0;top:0;width:236px;will-change:transform}
[data-grid-item] a{display:block;color:inherit;text-decoration:none}
[data-grid-item] img{display:block;width:100%;height:auto;border-radius:12px}
[data-grid-item] p{margin:8px 0 16px}
#detail{position:relative;display:none;background:white;padding:16px;min-height:800px}
#detail img{display:block;max-width:100%;max-height:400px}
#drop{display:none;position:fixed;bottom:0;left:0;right:0;height:40px;background:#eee;z-index:99}
</style></head><body><header id="site-header">Pinterest</header>
<main id="lens-content">
 <div data-test-id="visual-search-image-container"><div id="source-relative"><div id="source-mask"><div id="source-aspect"><img id="source-image" class="img_F" width="640" height="2560" src="https://i.pinimg.com/originals/source.svg" alt="Synthetic long source"></div><div data-test-id="visual-search-cropper"></div></div></div><div data-source-action><button>Search area</button></div><div data-source-action><button>Search similar</button></div></div>
 <div data-test-id="visual-search-image-container-placeholder"></div>
 <div id="results"><div data-test-id="masonry-container" class="masonryContainer"><div class="dynamic-style"><div data-test-id="max-width-container"><div id="native-grid-wrapper"><div id="native-grid" role="list"></div></div></div></div></div></div>
</main><article id="detail"><button id="back">Back to results</button><h1>Synthetic Pin</h1><img src="https://i.pinimg.com/originals/detail.svg"><p id="detail-text">Original Pin details remain readable and selectable.</p></article><div id="drop">Drop fixture</div>
<script>
window.layoutRuns=[];window.pinClicks=[];window.originalPins=[];window.appendCount=0;
const grid=document.querySelector('#native-grid');
function positionItems(){
 const width=document.querySelector('#native-grid-wrapper').clientWidth, columns=Math.max(1,Math.floor(width/237)), cellWidth=Math.max(1,width/columns-16), heights=Array(columns).fill(0);
 for(const item of grid.children){const column=heights.indexOf(Math.min(...heights));item.style.width=cellWidth+'px';item.style.transform='translate('+column*(cellWidth+16)+'px, '+heights[column]+'px)';heights[column]+=item.offsetHeight+16;}
 grid.style.height=Math.max(...heights,0)+'px';window.layoutRuns.push({width,columns,items:grid.children.length});
}
window.appendPins=(count=6)=>{
 for(let n=0;n<count;n++){const index=++window.appendCount, item=document.createElement('div');item.dataset.gridItem=String(index);item.setAttribute('role','listitem');item.innerHTML='<div data-grid-item-idx="'+(index-1)+'"><a href="/pin/'+(1000+index)+'/" data-pin-link><img alt="Synthetic result '+index+'" width="236" height="'+([300,180,380][index%3])+'" src="https://i.pinimg.com/236x/result-'+index+'.svg" srcset="https://i.pinimg.com/236x/result-'+index+'.svg 1x, https://i.pinimg.com/originals/result-'+index+'.svg 2x"><p>Result '+index+'</p></a></div>';
  const link=item.querySelector('a');link.addEventListener('click',event=>{event.preventDefault();window.pinClicks.push(link.getAttribute('href'));history.pushState({},'',link.getAttribute('href'));syncRoute();});
  item.querySelector('img').addEventListener('load',positionItems);grid.append(item);window.originalPins.push(item);
 }positionItems();
};
function syncRoute(){const detail=location.pathname.startsWith('/pin/');document.querySelector('#lens-content').hidden=detail;document.querySelector('#lens-content').style.display=detail?'none':'flex';document.querySelector('#detail').style.display=detail?'block':'none';}
window.addEventListener('popstate',()=>{syncRoute();positionItems();});document.querySelector('#back').addEventListener('click',()=>history.back());
window.addEventListener('resize',positionItems);new ResizeObserver(positionItems).observe(document.querySelector('#native-grid-wrapper'));
window.addEventListener('scroll',()=>{if(window.scrollY+innerHeight>=document.body.scrollHeight-160&&window.appendCount<12)window.appendPins();});
window.appendPins();syncRoute();
document.querySelector('#drop').addEventListener('dragover',event=>event.preventDefault());
document.querySelector('#drop').addEventListener('drop',event=>{event.preventDefault();window.dropPayload=event.dataTransfer.getData('application/x-bowerbird-explorer');});
</script></body></html>`;
}

export function imageFor(url) {
  const source = url.includes('/source.svg');
  const landscape = url.includes('/source-landscape.svg');
  const index = Number(url.match(/result-(\d+)/)?.[1] || 1);
  const width = source || landscape ? 640 : 236, height = source ? 2560 : landscape ? 160 : [300, 180, 380][index % 3];
  const color = ['#7499a8', '#c49a78', '#8e9b72'][index % 3];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><rect width="100%" height="12" fill="#111"/><rect y="${height - 12}" width="100%" height="12" fill="#fff"/></svg>`;
}
