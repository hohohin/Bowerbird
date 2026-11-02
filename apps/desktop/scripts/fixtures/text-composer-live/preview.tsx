if (new URLSearchParams(location.search).has('conversation')) await import('../canvas-reference/preview');
else await import('../library-composer/preview');
const w = window as any;
const previous = w.__TAURI_INTERNALS__.invoke;
w.textAsset = { id: 'text-reference', name: '文本参考图片', ext: 'png', store_path: '/fixture/text-reference.png', thumb_path: '/fixture/text-reference.png', sections: [] };
w.textAssets = [w.textAsset, { ...w.textAsset, id: 'alias-a', name: '图片2' }, { ...w.textAsset, id: 'alias-b', name: '其他' }];
w.textCalls = []; w.slowTextRefs = false;
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  w.textCalls.push({ command, args });
  if (command === 'catalog_page' && document.querySelector('.text-workspace')) return args.offset ? [] : [w.textAsset];
  if (command === 'get_assets_by_ids' && w.textAssets.some((asset: any) => args.assetIds.includes(asset.id))) return w.textAssets.filter((asset: any) => args.assetIds.includes(asset.id));
  const requested = w.textAssets.find((asset: any) => asset.id === (args.assetId ?? args.id));
  if (command === 'get_prompted_asset' && requested) {
    if (w.slowTextRefs) await new Promise(resolve => { w.releaseTextRefs = resolve; });
    return requested;
  }
  return previous(command, args);
};
