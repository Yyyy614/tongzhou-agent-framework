// Files are treated as data. No package entry, dependency installer or Skill script runs here.
export async function packageFiles(fileList){
    const files=[...fileList];if(!files.length||files.length>128)throw Error('请选择一个包含 SKILL.md 或 agent-plugin.json 的目录（最多128个文件）');
    if(files.reduce((n,f)=>n+f.size,0)>5000000)throw Error('能力包最多5MB，请移除依赖、构建产物和私有文件');
    return Promise.all(files.map(async file=>{let path=file.webkitRelativePath||file.name;if(file.webkitRelativePath)path=path.split('/').slice(1).join('/');let binary='';for(const byte of new Uint8Array(await file.arrayBuffer()))binary+=String.fromCharCode(byte);return{path,contentBase64:btoa(binary)};}));
}
export function markdownFile(markdown){const bytes=new TextEncoder().encode(markdown);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return[{path:'SKILL.md',contentBase64:btoa(binary)}];}
export const marketStates={submitted:'待审核',approved:'审核通过',rejected:'审核未通过',published:'已发布',suspended:'已撤回'};
export const eventStates={pending:'等待归属',routing:'正在判断',observed:'仅观察',needs_attention:'需要人工确认',routed:'已派发',attached:'已加入原工作',waiting_work:'等待当前轮次',blocked:'已阻止',ignored:'已忽略'};
