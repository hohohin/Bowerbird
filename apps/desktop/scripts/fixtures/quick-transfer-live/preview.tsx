// Actual App/Toolbar and receive component; only native IPC is synthetic.
import '../home-navigation-live/preview';
const w = window as any;
const previousInvoke = w.__TAURI_INTERNALS__.invoke;
w.transferCalls = [];
w.transferSnapshot = { revision: 0, active: false, directory: null, url: null, transfers: [] };
w.transferUpdate = async (patch: any) => {
  w.transferSnapshot = { ...w.transferSnapshot, ...patch, revision: w.transferSnapshot.revision + 1 };
  await previousInvoke('plugin:event|emit', { event: 'quick-transfer://changed', payload: structuredClone(w.transferSnapshot) });
};
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
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
