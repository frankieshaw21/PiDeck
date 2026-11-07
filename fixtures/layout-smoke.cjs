// Isolated renderer integration check. Run after build: npx electron fixtures/layout-smoke.cjs
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = mkdtempSync(join(tmpdir(), 'pideck-layout-'));
app.setPath('userData', join(root, 'profile'));
const preload = join(root, 'preload.cjs');
writeFileSync(preload, `
const {contextBridge}=require('electron');
const metadata=(id)=>({id,piSessionId:id,projectDir:'project',name:id==='a'?'整理桌面端界面':'检查设备状态',createdAt:'',updatedAt:''});
const state=(id)=>({sessionId:id,model:{provider:'test',id:models[id],name:models[id]==='plain'?'Plain model':'Reasoning model'},thinkingLevel:levels[id],isStreaming:false,isCompacting:false,messageCount:2,pendingMessageCount:0});
const levels={a:'medium',b:'low'},models={a:'reasoner',b:'reasoner'};let calls=[];
contextBridge.exposeInMainWorld('piHarness',{
 listDevices:async()=>[],onDeviceChanged:()=>()=>{},listDeviceProfiles:async()=>[],
 listSessions:async()=>['a','b'].map(id=>({...metadata(id),status:'Idle'})),listProjects:async()=>[{path:'project',name:'PiDeck'}],
 onSessionsChanged:()=>()=>{},onRuntimeEvent:()=>()=>{},
 openSession:async(id)=>({metadata:metadata(id),state:state(id),messages:[{role:'user',content:'帮我梳理一下当前项目的界面结构，看看哪些地方可以优化。'},{role:'assistant',content:'我看了当前界面，建议从三个方面整理：\\n\\n### 让对话成为视觉中心\\n统一消息与输入框宽度，给内容留出呼吸空间。\\n\\n### 把相关操作放在一起\\n项目与会话在左侧；模型、思考级别与模式集中在输入区。\\n\\n### 设备面板按需展开\\n在需要时打开连接详情和终端。'}],status:'Idle'}),
 listModels:async()=>[{provider:'test',id:'reasoner',name:'Reasoning model'},{provider:'test',id:'plain',name:'Plain model'}],
 getThinkingSettings:async(id)=>({level:levels[id],levels:models[id]==='plain'?['off']:['off','low','medium','high']}),
 setModel:async(id,provider,model)=>{models[id]=model;if(model==='plain')levels[id]='off'},
 setThinkingLevel:async(id,level)=>{calls.push([id,level]);levels[id]=level;return state(id)},
 getContextUsage:async()=>({tokens:24600,contextWindow:200000,percent:12.3}),
 discoverWorkspace:async()=>({connections:[],instructions:[],warnings:[],skills:[]}),listExtensions:async()=>[],
 testCalls:()=>calls,
});
`);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(resolve('dist-renderer/index.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const q=s=>document.querySelector(s);
   const wait=async(check)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('UI timed out');};
   const change=(el,value)=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
   await wait(()=>q('.project select option[value="project"]'));change(q('.project select'),'project');
   await wait(()=>q('.session-open'));q('.session-open').click();
   await wait(()=>q('[aria-label="Think level"]')?.value==='medium');
   if(q('.chat-header .model-select'))throw Error('Model picker remained in header');
   change(q('[aria-label="Think level"]'),'high');
   await wait(()=>q('[aria-label="Think level"]').value==='high'&&!q('[aria-label="Think level"]').disabled);
   document.querySelectorAll('.session-open')[1].click();
   await wait(()=>q('[aria-label="Think level"]')?.value==='low');
   q('.session-open').click();await wait(()=>q('[aria-label="Think level"]')?.value==='high');
   change(q('.model-select'),'test/plain');
   await wait(()=>q('[aria-label="Think level"]')?.value==='off'&&q('[aria-label="Think level"]').disabled);
   change(q('.model-select'),'test/reasoner');
   await wait(()=>q('[aria-label="Think level"]')?.value==='off'&&!q('[aria-label="Think level"]').disabled);
   q('.device-heading button').click();await wait(()=>q('.device-drawer'));
   q('.device-drawer-heading button').click();await wait(()=>!q('.device-drawer'));
   q('.context-toggle').click();await wait(()=>q('.context-popover progress'));
   q('.context-toggle').click();
   q('.workspace-link').click();await wait(()=>q('.workspace-tabs'));
   q('.session-open').click();await wait(()=>q('.composer-controls .thinking-control'));
   const calls=await window.piHarness.testCalls();if(JSON.stringify(calls)!=='[["a","high"]]')throw Error('Wrong thinking-level RPC: '+JSON.stringify(calls));
   return {thinkingLevelUpdate:true,sessionIsolation:true,modelCapabilities:true,deviceDrawer:true,context:true,workspace:true};
  })()`);
  await new Promise(r=>setTimeout(r,250));
  if(process.env.PIDECK_LAYOUT_SCREENSHOT){
   await win.webContents.executeJavaScript(`document.querySelector('.device-heading button').click()`);
   await new Promise(r=>setTimeout(r,150));
   writeFileSync(process.env.PIDECK_LAYOUT_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
   await win.webContents.executeJavaScript(`document.querySelector('.device-drawer-heading button').click()`);
   await new Promise(r=>setTimeout(r,100));
  }
  for(const [width,height] of [[820,560],[1180,780]]){
   win.setSize(width,height);
   await new Promise(r=>setTimeout(r,150));
   const overflow=await win.webContents.executeJavaScript(`(()=>{const box=document.querySelector('.composer-box'),send=document.querySelector('.send');return {body:document.body.scrollWidth>innerWidth,composer:box.scrollWidth>box.clientWidth+1,send:send.getBoundingClientRect().bottom>innerHeight};})()`);
   if(Object.values(overflow).some(Boolean))throw Error('Layout overflow at '+width+'x'+height+': '+JSON.stringify(overflow));
   for(const sidebarWidth of [222,480]){
    const docked=await win.webContents.executeJavaScript(`(async()=>{
     const q=s=>document.querySelector(s);document.querySelector('.shell').style.setProperty('--sidebar-width','${sidebarWidth}px');
     const closedWidth=q('.messages').getBoundingClientRect().width;
     q('.device-heading button').click();
     await new Promise(r=>setTimeout(r,100));
     const panel=q('.device-drawer'),p=panel.getBoundingClientRect(),chat=q('.chat').getBoundingClientRect();
     const clear=['.chat-header','.messages','.composer','.device-heading'].every(s=>q(s).getBoundingClientRect().right<=p.left+1);
     const fits=p.right<=innerWidth+1&&Math.abs(p.top-chat.top)<1&&Math.abs(p.bottom-chat.bottom)<1&&panel.scrollWidth<=panel.clientWidth+1;
     const usable=q('.messages').getBoundingClientRect().width>=300;
     const composer=q('.composer-box');const inputFits=composer.scrollWidth<=composer.clientWidth+1;
     q('.device-drawer-heading button').click();await new Promise(r=>setTimeout(r,100));
     return {clear,fits,usable,inputFits,restored:Math.abs(q('.messages').getBoundingClientRect().width-closedWidth)<1};
    })()`);
    if(Object.values(docked).some(value=>!value))throw Error('Docked sidebar failed at '+width+'x'+height+' / sidebar '+sidebarWidth+': '+JSON.stringify(docked));
   }
   await win.webContents.executeJavaScript(`document.querySelector('.shell').style.setProperty('--sidebar-width','222px')`);
  }
  console.log('LAYOUT_SMOKE',JSON.stringify({...result,deviceDocking:true,wideNavigation:true,sizes:['820x560','1180x780']}));
 }catch(error){console.error(error);process.exitCode=1;}
 finally{win.destroy();app.quit();}
});
// Chromium may hold profile files until process exit on Windows. Do not block shutdown retrying them.
app.on('quit',()=>{try{rmSync(root,{recursive:true,force:true});}catch{}});
