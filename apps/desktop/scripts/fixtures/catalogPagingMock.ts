// Compatibility for small legacy UI fixtures. Production never falls back to
// all-assets reads; catalog-paging/preview.tsx tests the new protocol directly.
export function installCatalogPagingMock(w: any) {
  const known = new Map<string, any>();
  function wrap(base: (command: string, args?: any) => Promise<any>) {
    async function read(filter: any) {
      if (filter.kind === "collections" && !filter.id) return [];
      const assets = await base("material_catalog_assets", {kind: filter.kind === "all" ? "tags" : filter.kind, id: filter.kind === "collections" ? filter.id : null, projectId:filter.projectId});
      let result=(assets ?? []).filter((a: any)=> {
        known.set(a.id,a);
        const video=/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(`file.${a.ext ?? ""}`)||/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(a.store_path??"");
        return video===(filter.media==="videos") && (!filter.query||a.name.toLocaleLowerCase().includes(filter.query.toLocaleLowerCase()))
          && (filter.generated==null||(a.generation_session_id!=null)===filter.generated);
      });
      if(filter.color) {
        const matches=await Promise.all(result.map(async(a:any)=>{try{return (await base("file_colors",{path:a.store_path})).includes(filter.color);}catch{return false;}}));
        result=result.filter((_:any,i:number)=>matches[i]);
      }
      if(filter.kind==="tags"&&filter.id) {
        const catalog=await base("material_catalog",{projectId:filter.projectId});
        const members=new Set<string>(filter.id==="__catalog_untagged__" ? Object.values(catalog.tag_asset_ids??{}).flat() as string[] : catalog.tag_asset_ids?.[filter.id]??[]);
        result=result.filter((a:any)=>members.has(a.id)!==(filter.id==="__catalog_untagged__"));
      }
      return result;
    }
    return async (command: string,args: any={}) => {
      if(command==="canvas_frequent_assets") return await base(command,args) ?? {frequent:[],pinned:[],threshold:10};
      if(command==="catalog_overview") {
        const catalog=await base("material_catalog",{projectId:args.contextProject});
        const assets=await read(args.filter), ids=new Set(assets.map((a:any)=>a.id));
        const tagged=new Set(Object.values(catalog.tag_asset_ids??{}).flat());
        return {total:assets.length,untagged:assets.filter((a:any)=>!tagged.has(a.id)).length,
          catalog:{...catalog,tag_asset_ids:{},tags:catalog.tags.map((t:any)=>({...t,count:(catalog.tag_asset_ids?.[t.id]??[]).filter((id:string)=>ids.has(id)).length}))}};
      }
      if(command==="catalog_page"||command==="catalog_ids") {
        const page=(await read(args.filter)).slice(args.offset,args.offset+args.limit);
        return command==="catalog_ids"?page.map((a:any)=>a.id):page;
      }
      if(command==="catalog_prepare_colors") return {after:null,more:false,failed:0,updated:0};
      if(command==="get_assets_by_ids"&&args.assetIds.every((id:string)=>known.has(id))) return args.assetIds.map((id:string)=>known.get(id));
      return base(command,args);
    };
  }
  let invoke=wrap(w.__TAURI_INTERNALS__.invoke);
  Object.defineProperty(w.__TAURI_INTERNALS__,"invoke",{configurable:true,get:()=>invoke,set:(base)=>{invoke=wrap(base);}});
}
