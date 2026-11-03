// Actual App/Toolbar and receive component; only native IPC is synthetic.
import '../home-navigation-live/preview';
const w = window as any;
const previousInvoke = w.__TAURI_INTERNALS__.invoke;
const receivedPhoto = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#c64b37"/><circle cx="20" cy="18" r="8" fill="#f1cb82"/></svg>');
w.transferCalls = [];
w.transferSnapshot = { revision: 0, active: false, directory: null, url: null, transfers: [] };
w.transferUpdate = async (patch: any) => {
  w.transferSnapshot = { ...w.transferSnapshot, ...patch, revision: w.transferSnapshot.revision + 1 };
  await previousInvoke('plugin:event|emit', { event: 'quick-transfer://changed', payload: structuredClone(w.transferSnapshot) });
};
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  if (command === 'get_assets_by_ids' && args.assetIds.includes('incoming')) {
    const assets = await previousInvoke(command, args);
    return [...assets, { id: 'incoming', name: '手机照片.heic', ext: 'heic', store_path: 'D:\\BowerbirdLibrary\\快传\\手机照片.heic', thumb_path: null, width: 80, height: 60, size: 4096, source: 'external' }];
  }
  if (command === 'external_files_preview' && args.path === 'D:\\BowerbirdLibrary\\快传\\手机照片.heic') return receivedPhoto;
  if (command.startsWith('quick_transfer_')) w.transferCalls.push({ command, args });
  if (command === 'quick_transfer_status') return structuredClone(w.transferSnapshot);
  if (command === 'quick_transfer_addresses') return ['192.168.1.23'];
  if (command === 'quick_transfer_directory') return 'D:\\BowerbirdLibrary\\快传';
  if (command === 'quick_transfer_start') {
    await w.transferUpdate({ active: true, directory: 'D:\\BowerbirdLibrary\\快传', url: `http://${args.address}:53317/?pin=01234567` });
    return structuredClone(w.transferSnapshot);
  }
  if (command === 'quick_transfer_stop') {
    await w.transferUpdate({ active: false, url: null }); return structuredClone(w.transferSnapshot);
  }
  if (command === 'quick_transfer_retry') {
    await w.transferUpdate({ transfers: w.transferSnapshot.transfers.map((file: any) => file.id === args.id ? { ...file, status: 'complete', error: null, retryable: false, assetId: 'incoming' } : file) });
    return structuredClone(w.transferSnapshot);
  }
  return previousInvoke(command, args);
};
