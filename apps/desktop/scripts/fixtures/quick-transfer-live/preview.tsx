// Actual App/Toolbar and receive component; only native IPC is synthetic.
import '../home-navigation-live/preview';
const w = window as any;
const previousInvoke = w.__TAURI_INTERNALS__.invoke;
const receivedPhoto = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#c64b37"/><circle cx="20" cy="18" r="8" fill="#f1cb82"/></svg>');
w.transferCalls = [];
const builtin = { kind: 'default', name: '默认快传', directory: 'D:\\BowerbirdLibrary\\快传' };
w.transferFolders = [
  { id: 'inbox', root_id: 'inbox', parent_id: null, name: '素材收件', path: 'D:\\素材收件', available: true },
  { id: 'mobile', root_id: 'inbox', parent_id: 'inbox', name: '手机', path: 'D:\\素材收件\\手机', available: true },
];
w.transferDefaultFolderId = null;
w.transferSnapshot = { revision: 0, active: false, directory: null, destination: null, url: null, transfers: [] };
function destination(target: any) {
  if (target.kind === 'folder') {
    const folder = w.transferFolders.find((item: any) => item.id === target.folderId && item.available);
    if (!folder) throw '接收文件夹不可用';
    return { ...target, name: folder.name, directory: folder.path };
  }
  if (target.kind === 'project') {
    const project = w.homeProjects.find((item: any) => item.id === target.projectId);
    if (!project) throw '接收项目已不存在';
    return { ...target, name: project.name, directory: `D:\\BowerbirdLibrary\\项目\\${project.name}-${project.id}` };
  }
  return builtin;
}
function defaultDestination() {
  const folder = w.transferFolders.find((item: any) => item.id === w.transferDefaultFolderId);
  const savedFolder = folder ? { folderId: folder.id, name: folder.name, path: folder.path } : null;
  return { builtin, savedFolder,
    effective: folder?.available ? destination({ kind: 'folder', folderId: folder.id }) : builtin,
    warning: folder && !folder.available ? `默认接收文件夹「${folder.name}」不可用，已回退到默认「快传」。` : null };
}
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
  if (command === 'folder_connections') return structuredClone(w.transferFolders);
  if (command === 'quick_transfer_default_destination') return defaultDestination();
  if (command === 'quick_transfer_preview_destination') return destination(args.destination);
  if (command === 'quick_transfer_set_default_folder') {
    w.transferDefaultFolderId = args.folderId;
    return defaultDestination();
  }
  if (command === 'quick_transfer_start') {
    const location = destination(args.destination);
    await w.transferUpdate({ active: true, destination: location, directory: location.directory, url: `http://${args.address}:53317/?pin=01234567` });
    return structuredClone(w.transferSnapshot);
  }
  if (command === 'quick_transfer_stop') {
    await w.transferUpdate({ active: false, destination: null, url: null }); return structuredClone(w.transferSnapshot);
  }
  if (command === 'quick_transfer_retry') {
    await w.transferUpdate({ transfers: w.transferSnapshot.transfers.map((file: any) => file.id === args.id ? { ...file, status: 'complete', error: null, retryable: false, assetId: 'incoming' } : file) });
    return structuredClone(w.transferSnapshot);
  }
  return previousInvoke(command, args);
};
