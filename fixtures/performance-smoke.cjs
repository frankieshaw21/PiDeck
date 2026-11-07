// Run after npm run build: npx electron fixtures/performance-smoke.cjs
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = mkdtempSync(join(tmpdir(), 'pideck-ui-perf-'));
app.setPath('userData', join(root, 'profile'));
const preload = join(root, 'preload.cjs');
writeFileSync(preload, `
const {contextBridge} = require('electron');
const metadata = {id:'test', piSessionId:'pi', projectDir:'project', name:'Long conversation', createdAt:'', updatedAt:''};
const messages = Array.from({length:1200}, (_,i) => ({role:i%2?'assistant':'user', content:i%2?[{type:'thinking',thinking:'Hidden thinking '+i},{type:'text',text:'Reply **'+i+'**'}]:'Question '+i}));
let opens = 0;
contextBridge.exposeInMainWorld('piHarness', {
 listDevices:async()=>[], onDeviceChanged:()=>()=>{},
 listSessions:async()=>[{...metadata,status:'Idle'}], listProjects:async()=>[{path:'project',name:'Project'}],
 onSessionsChanged:()=>()=>{}, onRuntimeEvent:()=>()=>{},
 openSession:async()=>{opens++;return {metadata,state:{sessionId:'pi',isStreaming:false,isCompacting:false,messageCount:1200,pendingMessageCount:0},messages,status:'Idle'};},
 listModels:async()=>[], listDeviceProfiles:async()=>[], testOpenCount:()=>opens
});
`);
app.whenReady().then(async () => {
 const window = new BrowserWindow({show:false, webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 try {
  await window.loadFile(resolve('dist-renderer/index.html'));
  const result = await window.webContents.executeJavaScript(`(async()=>{
   const wait = async (check) => { for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('UI timed out'); };
   const count = () => document.querySelectorAll('.messages article').length;
   await wait(()=>document.querySelector('.project select option[value="project"]'));
   const project=document.querySelector('.project select'); project.value='project'; project.dispatchEvent(new Event('change',{bubbles:true}));
   await wait(()=>document.querySelector('.session-open'));
   const start=performance.now(); document.querySelector('.session-open').click();
   await wait(()=>count()===30);
   const openMs=Math.round(performance.now()-start);
   if(document.querySelector('.work-log-entries'))throw Error('Collapsed work log rendered its contents');
   const log=document.querySelector('.work-log'); log.open=true;
   await wait(()=>log.querySelector('.work-log-entries'));
   document.querySelector('.messages > button').click();
   await wait(()=>count()===60);
   document.querySelector('.session-open').click();
   await new Promise(r=>setTimeout(r,100));
   if(window.piHarness.testOpenCount()!==1)throw Error('Repeated open reloaded history');
   return {historyMessages:1200,initialRenderedGroups:30,expandedGroups:count(),historyRequests:window.piHarness.testOpenCount(),openMs};
  })()`);
  console.log('PERFORMANCE_SMOKE',JSON.stringify(result));
 } catch(error) { console.error(error); process.exitCode=1; }
 finally { window.destroy(); app.quit(); }
});
app.on('quit',()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
