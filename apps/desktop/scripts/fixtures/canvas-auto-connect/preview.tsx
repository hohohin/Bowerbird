import '../canvas-reference/preview';
const w = window as any;
const invoke = w.__TAURI_INTERNALS__.invoke;
w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
  const result = await invoke(command, args);
  // Keep video identity while giving document images registered file paths.
  return command === 'get_assets_by_ids' ? result.map((asset: any) => asset.ext === 'mp4' ? asset : { ...asset, store_path: '/fixture/document.png', ext: 'png' }) : result;
};
