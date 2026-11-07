const { app, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const root = mkdtempSync(join(tmpdir(), 'pideck-navigation-'));
app.setPath('userData', join(root, 'profile'));
const preload = join(root, 'preload.cjs');
writeFileSync(preload, `
const {contextBridge} = require('electron');
const metadata = {id:'saved',piSessionId:'pi',projectDir:'project',name:'Saved conversation',createdAt:'',updatedAt:''};
const state = {sessionId:'pi',isStreaming:false,isCompacting:false,messageCount:1,pendingMessageCount:0};
let creates=0,opens=0,prompts=0,listener=()=>{}, release, fail=false;
const rows=[{...metadata,status:'Idle'}];
const check=id=>{if(id.startsWith('draft-'))throw Error('Draft reached backend');};
contextBridge.exposeInMainWorld('piHarness', {
 listDevices:async()=>[],onDeviceChanged:()=>()=>{},listProjects:async()=>[{path:'project',name:'Project'}],
 listSessions:async()=>rows,onSessionsChanged:fn=>{listener=fn;return()=>{};},onRuntimeEvent:()=>()=>{},
 listModels:async id=>{check(id);return[];},getThinkingSettings:async id=>{check(id);return{level:'off',levels:['off']};},listDeviceProfiles:async id=>{check(id);return[];},
 createSession:async()=>{creates++;await new Promise(r=>setTimeout(r,250));if(fail)throw Error('Simulated startup failure');const meta={...metadata,id:'created-'+creates,name:'New session'};rows.push({...meta,status:'Idle'});listener(rows);return{metadata:meta,state,messages:[],status:'Idle'};},
 prompt:async(id,text)=>{check(id);if(text!=='First message')throw Error('Wrong prompt');prompts++;return{runId:'run',taskId:'task'};},
 previewSession:async()=>({metadata,state,messages:[{role:'user',content:'Preview history'}],preview:true,status:'Idle'}),
 openSession:async()=>{opens++;await new Promise(r=>release=r);return{metadata,state,messages:[{role:'user',content:'Ready history'}],status:'Idle'};},
 release:()=>release(),setFail:value=>{fail=value;},counts:()=>({creates,opens,prompts})
});
`);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 try {
  await window.loadFile(resolve('dist-renderer/index.html'));
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const wait=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timed out');};
   const assert=(ok,text)=>{if(!ok)throw Error(text);};
   const type=text=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
   await wait(()=>document.querySelector('.project select option[value="project"]'));
   const project=document.querySelector('.project select');project.value='project';project.dispatchEvent(new Event('change',{bubbles:true}));
   await wait(()=>document.querySelector('.session-open'));
   const start=performance.now();document.querySelector('.new-session').click();
   await wait(()=>document.querySelector('.composer textarea'));
   const newMs=Math.round(performance.now()-start);
   assert(window.piHarness.counts().creates===0,'New persisted an empty session');
   assert(document.querySelectorAll('.session-open').length===1,'Draft in history');
   document.querySelector('.session-open').click();
   await wait(()=>document.querySelector('.messages').textContent.includes('Preview history'));
   assert(!document.querySelector('.composer textarea').disabled,'Cannot type during load');
   window.piHarness.release();
   await wait(()=>document.querySelector('.messages').textContent.includes('Ready history'));
   document.querySelector('.new-session').click();
   await wait(()=>document.querySelector('.messages .empty'));
   type('First message');await wait(()=>!document.querySelector('.send').disabled);
   document.querySelector('.send').click();document.querySelector('.send').click();
   await wait(()=>window.piHarness.counts().prompts===1);
   assert(window.piHarness.counts().creates===1,'Double-send created duplicate sessions');
   await wait(()=>document.querySelectorAll('.session-open').length===2);
   document.querySelector('.session-open').click();
   await wait(()=>document.querySelector('.messages').textContent.includes('Ready history'));
   assert(window.piHarness.counts().opens===1,'Cached switch reopened runtime');
   window.piHarness.setFail(true);document.querySelector('.new-session').click();
   await wait(()=>document.querySelector('.messages .empty'));
   type('First message');await wait(()=>!document.querySelector('.send').disabled);document.querySelector('.send').click();
   await wait(()=>document.querySelector('.delivery-status button'));
   document.querySelector('.delivery-status button').click();
   await wait(()=>document.querySelector('.composer textarea').value==='First message');
   assert(document.querySelectorAll('.session-open').length===2,'Failed startup persisted a session');
   return{newMs,...window.piHarness.counts(),draftSavedBeforeSend:false,previewBeforeReady:true,retryPreserved:true};
  })()`);
  console.log('SESSION_NAVIGATION_SMOKE',JSON.stringify(result));
 }catch(error){console.error(error);process.exitCode=1;}
 finally{window.destroy();app.quit();}
});
app.on('quit',()=>{try{rmSync(root,{recursive:true,force:true});}catch{}});
