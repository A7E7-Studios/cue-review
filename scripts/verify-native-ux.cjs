// Attended review and compact-mode checks in a running test app with the local CDP port (9224).
// Launch the app with a dedicated CUEREVIEW_DATA_DIR that holds the verify-pipeline.ps1 fixture.
// The compact check records the default source for a few seconds.
// The clipboard check copies the agent handoff to the Windows clipboard. The clipboard's text is saved
// before and put back afterwards, also when the check fails; other content (an image, files) cannot be
// put back and is replaced, and an empty clipboard is cleared again.
// Controls are found by the accessible names in src/workspace/types.ts (NAMES) and its HOOKS.
//   node scripts/verify-native-ux.cjs [--review-only | --compact-only]
const {chromium}=require('playwright');
const fs=require('fs');
const {execFileSync}=require('child_process');
const compactOnly=process.argv.includes('--compact-only');
const reviewOnly=process.argv.includes('--review-only');
const result={checks:{},screenshots:[],errors:[]};
let browser,page,ownsRecording=false,recordingId,restoreSession,restoreProject;
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const shot=async name=>{const path=`test-results/ui/${name}.png`;await page.screenshot({path});result.screenshots.push(path);};
const idle=()=>page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});
const titleBar=()=>page.locator('[aria-label="Title bar"]');
const sidebar=()=>page.getByRole('complementary',{name:'Recordings',exact:true});
const size=()=>page.evaluate(()=>({width:innerWidth,height:innerHeight}));
const near=(a,b,tolerance=1)=>Math.abs(a-b)<=tolerance;
// The clipboard's text through PowerShell, as base64 UTF-8 so no console code page alters it.
// null when the clipboard holds no text.
const powershell=(command,input)=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,input});
function readClipboard(){
 const encoded=powershell('$t=Get-Clipboard -Raw;if($null -eq $t){"none"}else{"text:"+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))}').trim();
 return encoded.startsWith('text:')?Buffer.from(encoded.slice(5),'base64').toString('utf8'):null;
}
function writeClipboard(text){
 if(!text)powershell('Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::Clear()');
 else powershell('$b=[Console]::In.ReadToEnd().Trim();Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))',Buffer.from(text,'utf8').toString('base64'));
}
// The theme lives in Settings → Appearance, opened from the title bar (decision 14).
async function setTheme(theme){
 await titleBar().getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await dialog.getByLabel('Appearance',{exact:true}).selectOption(theme);
 await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
 await dialog.getByRole('button',{name:'Close settings',exact:true}).click();await dialog.waitFor({state:'detached'});
}
// Windows has no native decorations: a 40px custom title bar with 46×40 window controls, and
// drag regions only on empty bar areas, never on a control or the search field (decision 9).
async function windowChrome(){
 const bar=titleBar();await bar.waitFor();
 for(const name of ['Minimize window','Close window','Settings'])await bar.getByRole('button',{name,exact:true}).waitFor();
 await bar.getByRole('button',{name:/^(Hide|Show) sidebar$/}).waitFor();await bar.getByRole('searchbox',{name:'Search recordings',exact:true}).waitFor();
 const layout=await bar.evaluate(header=>{
  const box=header.getBoundingClientRect();
  const controls=[...header.querySelectorAll('button')].filter(button=>/ window$/.test(button.getAttribute('aria-label')||'')).map(button=>{const r=button.getBoundingClientRect();return{name:button.getAttribute('aria-label'),width:r.width,height:r.height,right:innerWidth-r.right};});
  const regions=[header,...header.querySelectorAll('*')].filter(node=>node.hasAttribute('data-tauri-drag-region'));
  return{top:box.top,height:box.height,controls,dragRegions:regions.length,barIsDragRegion:header.hasAttribute('data-tauri-drag-region'),interactiveDragRegions:regions.filter(node=>node.matches('button,input,select,textarea,a,[role=button],[tabindex]')).length};
 });
 assert(near(layout.top,0)&&near(layout.height,40),`Title bar is not a 40px bar at the top: ${JSON.stringify(layout)}`);
 assert(layout.controls.length===3&&layout.controls.every(control=>near(control.width,46)&&near(control.height,40)),`Window controls are not three 46×40 buttons: ${JSON.stringify(layout.controls)}`);
 assert(layout.controls.at(-1).name==='Close window'&&near(layout.controls.at(-1).right,0),'Close window is not at the right edge.');
 assert(layout.barIsDragRegion&&layout.interactiveDragRegions===0,`Drag regions are wrong: ${JSON.stringify(layout)}`);
 // Maximize and restore through the custom control; the name follows the window state.
 const initial=await size();const toggle=bar.getByRole('button',{name:/^(Maximize|Restore) window$/});
 const before=await toggle.getAttribute('aria-label'),after=before==='Maximize window'?'Restore window':'Maximize window';
 await toggle.click();await bar.getByRole('button',{name:after,exact:true}).waitFor();
 await bar.getByRole('button',{name:after,exact:true}).click();await bar.getByRole('button',{name:before,exact:true}).waitFor();
 await page.waitForFunction(s=>Math.abs(innerWidth-s.width)<3&&Math.abs(innerHeight-s.height)<3,initial);
 result.checks.customTitleBar={...layout,maximizeToggle:[before,after,before]};
}
// Shortcut hints stay hidden until hover; the name is unchanged and aria-keyshortcuts carries the key (decision 7).
async function shortcutHint(){
 const button=sidebar().getByRole('button',{name:'New recording',exact:true});const hint=button.locator('kbd');
 await page.getByRole('heading',{level:1}).hover();await page.waitForTimeout(250);
 const hidden=await hint.evaluate(kbd=>getComputedStyle(kbd).opacity);
 await button.hover();await page.waitForTimeout(250);
 const shown=await hint.evaluate(kbd=>getComputedStyle(kbd).opacity);
 const keys=await button.getAttribute('aria-keyshortcuts'),ariaHidden=await hint.getAttribute('aria-hidden');
 assert(hidden==='0'&&shown==='1'&&keys==='Control+N'&&ariaHidden==='true',`Shortcut hint: ${JSON.stringify({hidden,shown,keys,ariaHidden})}`);
 result.checks.shortcutHint={hidden,shown,keys,label:(await hint.textContent()).trim()};
}
async function compact(){
 await idle();await sidebar().getByRole('button',{name:'New recording',exact:true}).click();
 const initial=await size();
 ownsRecording=true;
 await page.getByRole('button',{name:'Record',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor();recordingId=(await invoke('get_recording_status')).sessionId;
 await page.getByRole('timer',{name:'Take 1 elapsed time',exact:true}).waitFor();
 await page.getByRole('button',{name:'Compact',exact:true}).click();await page.getByRole('button',{name:'Expand',exact:true}).waitFor();
 await page.waitForFunction(()=>innerHeight<400&&innerWidth<650);
 result.checks.compact=await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Stop');const r=b.getBoundingClientRect();return{width:innerWidth,height:innerHeight,stopTop:r.top,stopBottom:r.bottom,stopVisible:r.top>=0&&r.bottom<=innerHeight};});
 if(!result.checks.compact.stopVisible)throw Error('Compact Stop falls outside viewport');
 // The compact strip keeps Minimize and Close, without Maximize (decision 9).
 const strip=titleBar();await strip.getByRole('button',{name:'Close window',exact:true}).waitFor();
 result.checks.compact.stripControls=await strip.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')).filter(Boolean));
 assert(result.checks.compact.stripControls.includes('Minimize window')&&!result.checks.compact.stripControls.some(name=>/^(Maximize|Restore) window$/.test(name)),'Compact strip window controls are wrong');
 await shot('compact');
 await page.getByRole('button',{name:'Expand',exact:true}).click();await page.getByRole('button',{name:'Compact',exact:true}).waitFor();
 await page.waitForFunction(s=>Math.abs(innerWidth-s.width)<3&&Math.abs(innerHeight-s.height)<3,initial);
 result.checks.restored=await size();
 await page.getByRole('button',{name:'Stop',exact:true}).click();await idle();ownsRecording=false;result.checks.recordingStopped=true;
}
async function review(){
 const sid=JSON.parse(fs.readFileSync('test-results/pipeline-verification.json','utf8')).sessionId;
 const original=await invoke('get_session',{id:sid});const project=(await invoke('list_projects')).find(p=>p.id===original.projectId);
 await windowChrome();
 await sidebar().getByRole('button',{name:original.name,exact:true}).click();await page.locator('video').waitFor();
 await shortcutHint();
 const transcript=await invoke('get_transcript',{id:sid});const here=transcript.segments.flatMap(s=>s.words).find(w=>/^here,$/.test(w.text));if(!here)throw Error('Fixture has no expected here word');const expectedSeekMs=here.seekMs??here.startMs;
 await page.getByRole('button',{name:/^Seek to here, at \d+:\d{2}$/}).click();
 const seek=await page.locator('video').evaluate(v=>v.currentTime);if(Math.abs(seek*1000-expectedSeekMs)>100)throw Error('Seek failed '+seek);result.checks.seek=seek;
 // Markers are out of the UI (decision 5): no Add marker control, and M opens nothing.
 await page.keyboard.press('m');await page.waitForTimeout(300);
 assert(!await page.getByRole('button',{name:'Add marker',exact:true}).count()&&!await page.getByRole('dialog').count(),'Marker UI is still present');result.checks.markersRemoved=true;
 // Keep the user's clipboard text and put it back, whatever the check finds.
 const savedClipboard=readClipboard();let clipboard;
 try{
  await page.getByRole('button',{name:'Copy for agent',exact:true}).click();await page.getByText('Agent instructions copied',{exact:true}).last().waitFor();
  clipboard=readClipboard()??'';
 }finally{
  try{writeClipboard(savedClipboard);const lines=text=>(text||'').replace(/\r\n/g,'\n');result.checks.clipboardRestored=lines(readClipboard())===lines(savedClipboard);}catch(e){result.clipboardRestoreError=String(e);}
 }
 const handoff=await invoke('get_agent_handoff',{id:sid});if(clipboard.replace(/\r\n/g,'\n').trim()!==handoff.replace(/\r\n/g,'\n').trim())throw Error('Native clipboard handoff mismatch');
 assert(result.checks.clipboardRestored,'The clipboard text was not restored: '+(result.clipboardRestoreError||'it differs'));
 assert(handoff.includes('--segments')&&handoff.includes('--per-segment'),'Handoff lacks the recommended workflow');result.checks.clipboard=true;
 const rateButton=page.getByRole('button',{name:/^Playback speed /});while((await page.locator('video').evaluate(v=>v.playbackRate))!==1)await rateButton.click();await rateButton.click();result.checks.playbackRate=await page.locator('video').evaluate(v=>v.playbackRate);if(result.checks.playbackRate!==1.5)throw Error('Speed failed');
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForTimeout(350);await page.getByRole('button',{name:'Pause',exact:true}).click();if((await page.locator('video').evaluate(v=>v.currentTime))<=seek)throw Error('Playback did not advance');result.checks.playback=true;
 restoreSession=original;restoreProject=project;const newSession=original.name+' [UX checked]',newProject=project.name+' [UX checked]';
 await page.getByRole('heading',{level:1}).getByRole('button').click();await page.getByRole('textbox',{name:'Name',exact:true}).fill(newSession);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('heading',{level:1,name:newSession}).waitFor();
 await page.getByRole('region',{name:'Section: '+project.name,exact:true}).getByRole('button',{name:'Section options for '+project.name,exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).fill(newProject);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:'Section options for '+newProject,exact:true}).waitFor();
 await page.reload();await sidebar().getByRole('button',{name:newSession,exact:true}).click();await page.getByRole('heading',{level:1,name:newSession}).waitFor();if((await invoke('get_session',{id:sid})).name!==newSession||(await invoke('list_projects')).find(p=>p.id===project.id).name!==newProject)throw Error('Rename persistence failed');result.checks.renamePersistence=true;
 await invoke('rename_session',{id:sid,name:original.name});await invoke('rename_project',{id:project.id,name:project.name});restoreSession=restoreProject=null;
 await page.reload();await sidebar().getByRole('button',{name:original.name,exact:true}).click();await page.getByRole('button',{name:/^Seek to here, at \d+:\d{2}$/}).click();
 if(await page.evaluate(()=>document.documentElement.dataset.theme)!=='light')await setTheme('light');await shot('light-review');
 await setTheme('dark');await shot('dark-review');await setTheme('light');result.checks.themes=true;
}
(async()=>{fs.mkdirSync('test-results/ui',{recursive:true});try{
 browser=await chromium.connectOverCDP(process.env.CUEREVIEW_CDP||'http://127.0.0.1:9224');page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(20000);page.on('pageerror',e=>result.errors.push(e.message));await idle();if(!compactOnly)await review();if(!reviewOnly)await compact();result.passed=!result.errors.length;if(!result.passed)process.exitCode=1;
}catch(e){result.passed=false;result.failure=e.stack||String(e);if(page)await shot('native-ux-failure').catch(()=>{});process.exitCode=1;}finally{
 if(page){if(ownsRecording)try{const s=await invoke('get_recording_status');if(s.state==='recording'&&(!recordingId||s.sessionId===recordingId))await invoke('stop_recording');result.cleanupRecordingStatus=await invoke('get_recording_status');}catch(e){result.cleanupError=String(e);process.exitCode=1;}
 if(restoreSession)await invoke('rename_session',{id:restoreSession.id,name:restoreSession.name}).catch(e=>result.renameCleanupError=String(e));if(restoreProject)await invoke('rename_project',{id:restoreProject.id,name:restoreProject.name}).catch(e=>result.renameCleanupError=String(e));}
 fs.writeFileSync('test-results/ui/native-ux-verification'+(compactOnly?'-compact':reviewOnly?'-review':'')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(browser)await browser.close();}})();
