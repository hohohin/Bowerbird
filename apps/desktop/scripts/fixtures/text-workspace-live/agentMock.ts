import { useStore } from '../../../src/store';
const w=window as any;
export function setupAgentMock(){
 if(!new URLSearchParams(location.search).has('agent'))return;
 w.agentHold=false;
 w.agentReadError=false;w.agentMismatch=false;w.agentStartDelay=0;
 useStore.setState({codexHealth:{ok:true},cloudAuth:{logged_in:true,cloud_available:true,user_id:'test'},cloudEntitlement:{user_id:'test',is_test_account:true,balances:{daily:23,sub:100,topup:0},policy:{can_use_byo:true,can_use_agent_runs:true,max_parallel_agent_runs:3,allowed_agent_skills:['bowerbird-unified-agent'],agent_budget_options:['controlled-min']}}} as any);
}
export function agentMock(command:string,args:any):unknown{
 if(!new URLSearchParams(location.search).has('agent'))return undefined;
 if(command==='agent_ds_workflow_start')return new Promise(resolve=>setTimeout(()=>resolve({autoDelivered:!w.agentDeliveryFailed,path:'/fixture/request'}),w.agentStartDelay));
 if(command==='agent_ds_workflow_result'){
   if(w.agentReadError)throw Error('暂时无法读取回复，请继续取回。');
   return w.agentHold?null:{schemaVersion:1,requestId:w.agentMismatch?'other-request':args.requestId,text:w.agentText??'雨落在空荡的街道。'};
 }
 if(command==='agent_ds_workflow_cancel'){if(w.agentCancelError)throw Error('尚未确认停止，请检查原任务。');return true;}
 if(command==='project_thread_create')return args.value;
 if(command==='cloud_agent_start'||command==='cloud_agent_get'||command==='cloud_agent_cancel')return {runId:command==='cloud_agent_get'&&w.cloudMismatch?'other-run':'cloud-text',projectId:'p',status:command==='cloud_agent_cancel'?'cancelled':w.cloudStatus??(w.agentHold?'running':'succeeded'),updatedAt:1,snapshot:{run:{},events:[{type:'text.result',display_payload:w.cloudPayload??{schemaVersion:1,text:'雨落在空荡的街道。'}}],artifacts:[]}};
 return undefined;
}
