// Synthetic content in the verified public Pin/PinRep card structure.
export function pinMarkup(kind = 'hover') {
  const image = '<img id="pin-image" src="https://i.pinimg.com/236x/target.svg" srcset="https://i.pinimg.com/236x/target.svg 1x, https://i.pinimg.com/originals/target.svg 2x" alt="Synthetic target">';
  if (kind === 'detail-image') return `<article id="card">${image}</article>`;
  return `<div id="card" data-test-id="pin" data-test-pin-id="1001"><div role="group"><div data-test-id="pinWrapper">
    <a id="pin-link" href="/pin/1001/"><div class="PinCard__imageWrapper"><div data-test-id="pincard-1001">
      <div class="image-branch">${kind === 'nested-other-pin' ? `<div data-test-id="pinWrapper" data-other-pin>${image}</div>` : image}</div>
      <div id="shade" data-test-id="pin-card-hover-overlay"><div id="top-wash" data-test-id="pin-card-hover-overlay-top-wash"></div><div id="hover-hit" data-test-id="pin-card-hover-overlay-gradient-full"></div><span id="label">Visible overlay text</span></div>
    </div></div></a>
    <div class="pin-tools"><button id="save" type="button">Save</button></div>
    ${['opaque-panel', 'arbitrary-overlay'].includes(kind) ? '<div id="opaque-panel"></div>' : ''}
  </div></div></div>`;
}

export function cardCss(kind = 'hover') {
  const wash = kind === 'transparent' ? 'transparent' : 'rgba(17,17,17,.40)';
  const gradient = kind === 'transparent' ? 'none' : 'linear-gradient(180deg,rgba(17,17,17,.40) 0%,rgba(17,17,17,0) 100%)';
  return `*{box-sizing:border-box}body{margin:0;font:18px/28px Arial,sans-serif;background:white}
  #card{position:relative;left:60px;top:70px;width:260px;height:340px}
  [data-test-id="pinWrapper"],.PinCard__imageWrapper,[data-test-id="pincard-1001"]{position:relative}
  #pin-link{display:block;position:relative;width:260px;height:300px;color:black}
  #pin-image{display:block;width:260px;height:300px;object-fit:cover}
  #shade{position:absolute;inset:0;display:none}#card:hover #shade{display:block}
  #top-wash{position:absolute;top:0;left:0;right:0;height:48px;background:${wash}}
  #hover-hit{position:absolute;top:48px;bottom:0;left:0;right:0;background:${gradient}}
  .pin-tools{position:absolute;inset:0;pointer-events:none}#save{position:absolute;right:14px;top:14px;pointer-events:auto;z-index:2;background:#bd081c;color:white;padding:8px;border:0}
  #label{position:absolute;left:16px;bottom:18px;background:#fff;color:#111;z-index:2}
  #modal-shade{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10}
  #modal{position:fixed;left:40px;top:50px;width:360px;height:500px;background:#fff;z-index:11;padding:24px}
  #opaque-panel{position:absolute;inset:0;background:${kind === 'arbitrary-overlay' ? 'rgba(0,0,0,.25)' : 'white'};z-index:3}
  #drop{display:block!important;position:fixed;right:12px;bottom:12px;width:150px;height:100px;background:#eee;z-index:30}`;
}

export function feedFixture(kind = 'hover') {
  return `<!doctype html><meta charset="utf-8"><title>Synthetic Pin feed</title><style>${cardCss(kind)}</style>${pinMarkup(kind)}
  ${kind.startsWith('modal') || kind === 'backdrop' ? '<div id="modal-shade"></div>' : ''}
  ${kind.startsWith('modal') ? '<section id="modal" role="dialog"><p id="modal-text">This modal text must remain selectable without collecting the hidden feed image underneath.</p></section>' : ''}
  <div id="drop">Drop fixture</div><script>
  document.querySelector('#pin-link')?.addEventListener('click',event=>event.preventDefault());
  document.querySelector('#save')?.addEventListener('click',event=>event.preventDefault());
  ${kind === 'neighbor-pin' ? `const neighbor=document.createElement('div');neighbor.dataset.testId='pin';neighbor.dataset.testPinId='2002';neighbor.style.cssText='position:absolute;left:60px;top:70px;width:260px;height:300px;z-index:4';neighbor.innerHTML='<div data-test-id="pinWrapper" style="position:relative;height:100%"></div>';document.body.append(neighbor);const shade=document.querySelector('#shade');shade.style.display='block';neighbor.firstElementChild.append(shade);` : ''}
  const drop=document.querySelector('#drop');drop.addEventListener('dragover',event=>event.preventDefault());
  drop.addEventListener('drop',event=>{event.preventDefault();window.dropPayload=event.dataTransfer.getData('application/x-bowerbird-explorer');});
  </script>`;
}

export const syntheticImage = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="600"><rect width="520" height="600" fill="#628fa1"/><path d="M0 600 260 90 520 600" fill="#d6b98d"/></svg>';
