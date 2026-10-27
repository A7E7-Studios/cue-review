// Run against an installed test app with a dedicated data root and CDP enabled.
const {chromium}=require('playwright');
const {execFileSync}=require('child_process');
const fs=require('fs');
let browser,page,ownsRecording=false;
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
(async()=>{
 const pid=Number(process.env.CUEREVIEW_TEST_PID);
 if(!Number.isInteger(pid)||pid<=0)throw Error('Set CUEREVIEW_TEST_PID to the installed test application process ID.');
 const result={};
 try{
  browser=await chromium.connectOverCDP('http://127.0.0.1:9224');page=browser.contexts()[0].pages()[0];
  await page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});
  await page.locator('.side-tools').getByRole('button',{name:'New recording',exact:true}).click();
  await page.locator('.mic-trigger').click();
  await page.getByRole('group',{name:'Microphone options',exact:true}).getByRole('button',{name:'No microphone',exact:true}).click();
  await page.locator('.source-trigger').click();
  await page.getByLabel('Include system audio',{exact:true}).uncheck();
  await page.keyboard.press('Escape');
  ownsRecording=true;await page.getByRole('button',{name:'Record',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
  result.sessionId=(await invoke('get_recording_status')).sessionId;
  execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
  await page.getByRole('alert').filter({hasText:'Finish recording and processing before closing CueReview.'}).waitFor();
  if((await invoke('get_recording_status')).state!=='recording')throw Error('Close request interrupted recording');
  result.activeCloseBlocked=true;
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});ownsRecording=false;
  await page.locator('button[aria-label="Play"]:not([disabled])').waitFor();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
  result.video=await page.locator('video').evaluate(v=>({duration:v.duration,currentTime:v.currentTime,readyState:v.readyState,error:v.error?.message}));
  if(result.video.error)throw Error(result.video.error);
  if(await page.getByRole('button',{name:'Use light theme',exact:true}).count())await page.getByRole('button',{name:'Use light theme',exact:true}).click();
  result.lightPlayer=await page.locator('video').evaluate(v=>({background:getComputedStyle(v).backgroundColor,controls:getComputedStyle(document.querySelector('.player-controls')).backgroundColor,font:getComputedStyle(v).fontFamily}));
  if(result.lightPlayer.background!=='rgb(243, 244, 246)'||result.lightPlayer.controls!=='rgb(255, 255, 255)')throw Error('Light player does not follow theme');
  result.handoff=await invoke('get_agent_handoff',{id:result.sessionId});
  if(!result.handoff.includes('cue.exe'))throw Error('Installed CLI missing in handoff');
  result.setup=await invoke('get_setup_status');if(!result.setup.ready)throw Error('Installed setup is not ready');
  result.passed=true;fs.mkdirSync('test-results/ui',{recursive:true});fs.writeFileSync('test-results/ui/installed-verification.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,activeCloseBlocked:true,video:result.video,lightPlayer:result.lightPlayer},null,2));
 }finally{
  if(page&&ownsRecording)await invoke('get_recording_status').then(s=>s.state==='recording'?invoke('stop_recording'):undefined).catch(console.error);
  if(browser)await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
