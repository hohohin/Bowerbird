import '../canvas-reference/preview';
const w = window as any;
const invoke = w.__TAURI_INTERNALS__.invoke;
w.__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
  const result = await invoke(command, args);
  // Real document resolution uses registered file paths; the base fixture uses data URLs.
  return command === 'get_assets_by_ids' ? result.map((asset: any) => ({ ...asset, store_path: '/fixture/document.png', ext: 'png' })) : result;
};
