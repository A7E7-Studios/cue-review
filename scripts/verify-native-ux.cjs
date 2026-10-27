const {chromium}=require('playwright');
const fs=require('fs');
const {execFileSync}=require('child_process');
const compactOnly=process.argv.includes('--compact-only');
const reviewOnly=process.argv.includes('--review-only');
const result={checks:{},screenshots:[],errors:[]};
let browser,page,ownsRecording=false,recordingId,restoreSession,restoreProject;
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const shot=async name=>{const path=`test-results/ui/${name}.png`;await page.screenshot({path});result.screenshots.push(path);};
const idle=()=>page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});
async function compact(){
 await idle();await page.locator('.side-tools').getByRole('button',{name:'New recording',exact:true}).click();
 const initial=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 ownsRecording=true;
 await page.getByRole('button',{name:'Record',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor();recordingId=(await invoke('get_recording_status')).sessionId;
 await page.getByRole('button',{name:'Compact',exact:true}).click();await page.getByRole('button',{name:'Expand',exact:true}).waitFor();
 await page.waitForFunction(()=>innerHeight<400&&innerWidth<650);
 result.checks.compact=await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Stop');const r=b.getBoundingClientRect();return{width:innerWidth,height:innerHeight,stopTop:r.top,stopBottom:r.bottom,stopVisible:r.top>=0&&r.bottom<=innerHeight};});
 if(!result.checks.compact.stopVisible)throw Error('Compact Stop falls outside viewport');await shot('compact');
 await page.getByRole('button',{name:'Expand',exact:true}).click();await page.getByRole('button',{name:'Compact',exact:true}).waitFor();
 await page.waitForFunction(s=>Math.abs(innerWidth-s.width)<3&&Math.abs(innerHeight-s.height)<3,initial);
 result.checks.restored=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
 await page.getByRole('button',{name:'Stop',exact:true}).click();await idle();ownsRecording=false;result.checks.recordingStopped=true;
}
async function review(){
 const sid=JSON.parse(fs.readFileSync('test-results/pipeline-verification.json','utf8')).sessionId;
 const original=await invoke('get_session',{id:sid});const project=(await invoke('list_projects')).find(p=>p.id===original.projectId);
 await page.locator('.session').filter({hasText:original.name}).click();await page.locator('.word').filter({hasText:/^here,$/}).click();
 const transcript=await invoke('get_transcript',{id:sid});const here=transcript.segments.flatMap(s=>s.words).find(w=>/^here,$/.test(w.text));if(!here)throw Error('Fixture has no expected here word');const expectedSeekMs=here.seekMs??here.startMs;
 const seek=await page.locator('video').evaluate(v=>v.currentTime);if(Math.abs(seek*1000-expectedSeekMs)>100)throw Error('Seek failed '+seek);result.checks.seek=seek;
 await page.getByRole('button',{name:'Add marker',exact:true}).click();await page.getByRole('textbox',{name:'Note'}).fill('Inspect details panel');await page.getByRole('button',{name:'Save',exact:true}).click();
 const markers=await invoke('get_markers',{id:sid});if(!markers.some(m=>m.label==='Inspect details panel'&&Math.abs(m.timeMs-expectedSeekMs)<100))throw Error('Marker persistence failed');result.checks.marker=true;
 await page.getByRole('button',{name:'Copy for agent',exact:true}).click();await page.getByText('Agent instructions copied',{exact:true}).last().waitFor();
 const clipboard=execFileSync('powershell.exe',['-NoProfile','-Command','Get-Clipboard -Raw'],{encoding:'utf8',windowsHide:true});const handoff=await invoke('get_agent_handoff',{id:sid});if(clipboard.replace(/\r\n/g,'\n').trim()!==handoff.replace(/\r\n/g,'\n').trim())throw Error('Native clipboard handoff mismatch');result.checks.clipboard=true;
 const rateButton=page.getByRole('button',{name:/^Playback speed /});while((await page.locator('video').evaluate(v=>v.playbackRate))!==1)await rateButton.click();await rateButton.click();result.checks.playbackRate=await page.locator('video').evaluate(v=>v.playbackRate);if(result.checks.playbackRate!==1.5)throw Error('Speed failed');
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForTimeout(350);await page.getByRole('button',{name:'Pause',exact:true}).click();if((await page.locator('video').evaluate(v=>v.currentTime))<=seek)throw Error('Playback did not advance');result.checks.playback=true;
 restoreSession=original;restoreProject=project;const newSession=original.name+' [UX checked]',newProject=project.name+' [UX checked]';
 await page.locator('h1 button').click();await page.getByRole('textbox',{name:'Name',exact:true}).fill(newSession);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('heading',{level:1,name:newSession}).waitFor();
 await page.locator('.recording-section').filter({has:page.locator('.session').filter({hasText:newSession})}).getByRole('button',{name:'Rename section '+project.name,exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).fill(newProject);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:'Rename section '+newProject,exact:true}).waitFor();
 await page.reload();await page.locator('.session').filter({hasText:newSession}).click();await page.getByRole('heading',{level:1,name:newSession}).waitFor();if((await invoke('get_session',{id:sid})).name!==newSession||(await invoke('list_projects')).find(p=>p.id===project.id).name!==newProject)throw Error('Rename persistence failed');result.checks.renamePersistence=true;
 await invoke('rename_session',{id:sid,name:original.name});await invoke('rename_project',{id:project.id,name:project.name});restoreSession=restoreProject=null;
 await page.reload();await page.locator('.session').filter({hasText:original.name}).click();await page.locator('.word').filter({hasText:/^here,$/}).click();
 if(await page.getByRole('button',{name:'Use light theme',exact:true}).count())await page.getByRole('button',{name:'Use light theme',exact:true}).click();await shot('light-review');await page.getByRole('button',{name:'Use dark theme',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await shot('dark-review');await page.getByRole('button',{name:'Use light theme',exact:true}).click();result.checks.themes=true;result.checks.nativeTitleOnly=await page.locator('.app-header').count()===0;
}
(async()=>{fs.mkdirSync('test-results/ui',{recursive:true});try{
 browser=await chromium.connectOverCDP(process.env.CUEREVIEW_CDP||'http://127.0.0.1:9224');page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(20000);page.on('pageerror',e=>result.errors.push(e.message));await idle();if(!compactOnly)await review();if(!reviewOnly)await compact();result.passed=!result.errors.length;if(!result.passed)process.exitCode=1;
}catch(e){result.passed=false;result.failure=e.stack||String(e);if(page)await shot('native-ux-failure').catch(()=>{});process.exitCode=1;}finally{
 if(page){if(ownsRecording)try{const s=await invoke('get_recording_status');if(s.state==='recording'&&(!recordingId||s.sessionId===recordingId))await invoke('stop_recording');result.cleanupRecordingStatus=await invoke('get_recording_status');}catch(e){result.cleanupError=String(e);process.exitCode=1;}
 if(restoreSession)await invoke('rename_session',{id:restoreSession.id,name:restoreSession.name}).catch(e=>result.renameCleanupError=String(e));if(restoreProject)await invoke('rename_project',{id:restoreProject.id,name:restoreProject.name}).catch(e=>result.renameCleanupError=String(e));}
 fs.writeFileSync('test-results/ui/native-ux-verification'+(compactOnly?'-compact':reviewOnly?'-review':'')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(browser)await browser.close();}})();
