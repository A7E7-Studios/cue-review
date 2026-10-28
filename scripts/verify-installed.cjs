// Run against an installed test app with a dedicated data root and CDP enabled (9224).
// It records the default source briefly to prove that closing is blocked while recording.
// Controls are found by the accessible names in src/workspace/types.ts (NAMES) and its HOOKS.
const {chromium}=require('playwright');
const {execFileSync}=require('child_process');
const fs=require('fs');
const CLOSE_GUARD='Finish recording and processing before closing CueReview.';
let browser,page,ownsRecording=false;
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const idle=()=>page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});
const titleBar=()=>page.locator('[aria-label="Title bar"]');
// The theme lives in Settings → Appearance, opened from the title bar (decision 14).
async function setTheme(theme){
 await titleBar().getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await dialog.getByLabel('Appearance',{exact:true}).selectOption(theme);
 await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
 await dialog.getByRole('button',{name:'Close settings',exact:true}).click();await dialog.waitFor({state:'detached'});
}
(async()=>{
 const pid=Number(process.env.CUEREVIEW_TEST_PID);
 if(!Number.isInteger(pid)||pid<=0)throw Error('Set CUEREVIEW_TEST_PID to the installed test application process ID.');
 const result={};
 try{
  browser=await chromium.connectOverCDP('http://127.0.0.1:9224');page=browser.contexts()[0].pages()[0];
  await idle();
  await page.getByRole('complementary',{name:'Recordings',exact:true}).getByRole('button',{name:'New recording',exact:true}).click();
  await page.locator('.mic-trigger').click();
  await page.getByRole('group',{name:'Microphone options',exact:true}).getByRole('button',{name:'No microphone',exact:true}).click();
  await page.locator('.source-trigger').click();
  await page.getByLabel('Include system audio',{exact:true}).uncheck();
  await page.keyboard.press('Escape');
  ownsRecording=true;await page.getByRole('button',{name:'Record',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
  result.sessionId=(await invoke('get_recording_status')).sessionId;
  // Close stays guarded while recording (decision 9): the native close message and the custom Close window button.
  const guard=page.getByRole('alert').filter({hasText:CLOSE_GUARD});
  execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
  await guard.waitFor();
  if((await invoke('get_recording_status')).state!=='recording')throw Error('Close request interrupted recording');
  const dismiss=page.getByRole('button',{name:'Dismiss error',exact:true});
  if(await dismiss.count()){await dismiss.first().click();await guard.waitFor({state:'detached'});}
  await titleBar().getByRole('button',{name:'Close window',exact:true}).click();
  await guard.waitFor();
  if((await invoke('get_recording_status')).state!=='recording')throw Error('Close window interrupted recording');
  result.activeCloseBlocked={nativeClose:true,closeWindowButton:true};
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await idle();ownsRecording=false;
  await page.locator('button[aria-label="Play"]:not([disabled])').waitFor();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
  result.video=await page.locator('video').evaluate(v=>({duration:v.duration,currentTime:v.currentTime,readyState:v.readyState,error:v.error?.message}));
  if(result.video.error)throw Error(result.video.error);
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!=='light')await setTheme('light');
  // Float v2 light player: the media box shows the neutral pill surface behind a transparent video, with one
  // ring (box-shadow) and no CSS border; the bundled Figtree font is loaded (no Google Fonts under the CSP).
  result.lightPlayer=await page.getByRole('region',{name:'Recording video',exact:true}).evaluate(async media=>{
   const video=media.querySelector('video');const probe=document.createElement('span');probe.style.color='var(--color-pill)';media.append(probe);const pill=getComputedStyle(probe).color;probe.remove();
   await document.fonts.ready;
   const style=getComputedStyle(media),videoStyle=getComputedStyle(video);
   return{background:style.backgroundColor,pill,ring:style.boxShadow,mediaBorder:style.borderTopWidth,videoBorder:videoStyle.borderTopWidth,videoBackground:videoStyle.backgroundColor,font:getComputedStyle(document.body).fontFamily,figtreeLoaded:[...document.fonts].some(face=>/figtree/i.test(face.family)&&face.status==='loaded')};
  });
  const player=result.lightPlayer;
  if(player.background!==player.pill||player.ring==='none'||player.mediaBorder!=='0px'||player.videoBorder!=='0px'||player.videoBackground!=='rgba(0, 0, 0, 0)')throw Error('Light player does not follow the Float v2 tokens');
  if(!/figtree/i.test(player.font)||!player.figtreeLoaded)throw Error('The bundled Figtree font is not in use');
  result.handoff=await invoke('get_agent_handoff',{id:result.sessionId});
  if(!result.handoff.includes('cue.exe'))throw Error('Installed CLI missing in handoff');
  if(!result.handoff.includes('--segments')||!result.handoff.includes('--per-segment'))throw Error('Handoff lacks the recommended agent workflow');
  result.setup=await invoke('get_setup_status');if(!result.setup.ready)throw Error('Installed setup is not ready');
  result.passed=true;fs.mkdirSync('test-results/ui',{recursive:true});fs.writeFileSync('test-results/ui/installed-verification.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,activeCloseBlocked:result.activeCloseBlocked,video:result.video,lightPlayer:result.lightPlayer},null,2));
 }finally{
  if(page&&ownsRecording)await invoke('get_recording_status').then(s=>s.state==='recording'?invoke('stop_recording'):undefined).catch(console.error);
  if(browser)await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
