export function workspaceCatalogResponse(command: string, args: any, assets: any[]) {
  const filtered = (filter = args.filter ?? {}) => assets.filter(asset => {
    const kind = /^(mp4|mov)$/.test(asset.ext) ? 'videos' : /^(wav|mp3)$/.test(asset.ext) ? 'audios' : 'images';
    return (!filter.media || filter.media === kind) && (!filter.query || asset.name.includes(filter.query)) && (!filter.projectId || !asset.id.startsWith('page-'));
  });
  if (command === 'catalog_overview') { const count = filtered().length; return { total: count, untagged: 0, catalog: { tags: [{ id: 'scene', name: '场景', description: '', count, projectCount: count }], collections: [], prompts: [], tag_asset_ids: {} } }; }
  if (command === 'catalog_page') return filtered().slice(args.offset, args.offset + args.limit);
  if (command === 'catalog_ids') return filtered().slice(args.offset, args.offset + args.limit).map(asset => asset.id);
  if (command === 'catalog_prepare_colors') return { after: null, more: false, failed: 0, updated: 0 };
  if (command === 'canvas_frequent_assets') return { threshold: 10, frequent: [assets[0]], pinned: [] };
  if (command === 'connection_entries') return filtered({ media: args.media }).slice(0, 1).map(asset => ({ id: 'entry-' + asset.id, folder_id: 'f', asset_id: asset.id, name: asset.name, path: asset.store_path, is_reference: false, available: true, asset }));
  if (command === 'connection_entry_ids') return ['entry-' + assets[0].id];
  if (command === 'resolve_connection_entries') return assets.filter(asset => args.ids.includes('entry-' + asset.id)).map(asset => ({ id: 'entry-' + asset.id, folder_id: 'f', asset_id: asset.id, name: asset.name, path: asset.store_path, is_reference: false, available: true, asset }));
  if (command === 'external_files_preview') return assets[0].thumb_path;
  if (command === 'external_files_media') return args.path;
  if (command === 'video_media_info') return { duration: 4, width: 400, height: 200 };
  if (['list_analyses_by_asset', 'list_asset_tags', 'list_asset_collections'].includes(command)) return [];
  if (command === 'codex_health') return { installed: false, logged_in: false };
  return undefined;
}
