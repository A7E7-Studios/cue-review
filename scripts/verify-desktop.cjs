const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{
 fs.mkdirSync('test-results/ui',{recursive:true});
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9224');const page=browser.contexts()[0].pages()[0];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let ownsRecording=false;
 try {
 await page.waitForFunction(async()=>(await window.__TAURI_INTERNALS__.invoke('get_recording_status')).state==='idle',undefined,{timeout:60000});
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await page.getByRole('textbox',{name:'Name',exact:true}).fill('Native UI verification');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 ownsRecording=true;await page.getByRole('button',{name:'Record',exact:true}).click();
 await page.getByRole('button',{name:'Stop',exact:true}).waitFor({timeout:20000});
 await page.waitForTimeout(3100);
 await page.screenshot({path:'test-results/ui/recording.png'});
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 await page.locator('button[aria-label="Play"]:not([disabled])').waitFor({timeout:60000});
 await page.waitForFunction(async()=>{const i=window.__TAURI_INTERNALS__.invoke;return (await i('get_recording_status')).state==='idle';},{},{timeout:60000});
 ownsRecording=false;
 const result=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const projects=await invoke('list_projects');const p=projects.findLast(p=>p.name==='Native UI verification');const sessions=await invoke('list_sessions',{projectId:p.id});return {project:p,session:sessions[0],status:await invoke('get_recording_status')};});
 if(!result.session.videoPath)throw Error('Final recording has no video path');
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForTimeout(400);
 const video=await page.locator('video').evaluate(v=>({readyState:v.readyState,currentTime:v.currentTime,error:v.error?.message,duration:v.duration}));
 if(video.error||video.readyState<2||video.currentTime<=0)throw Error('Native video playback failed: '+JSON.stringify(video));
 await page.screenshot({path:'test-results/ui/review.png'});
 fs.writeFileSync('test-results/ui/verification.json',JSON.stringify({result,video,errors},null,2));
 console.log(JSON.stringify({sessionId:result.session.id,video,errors},null,2));if(errors.length)throw Error('WebView script errors');
 } finally {
 if(ownsRecording)await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;if((await invoke('get_recording_status')).state==='recording')await invoke('stop_recording');}).catch(e=>console.error('Recording cleanup failed:',e));
 await browser.close();
 }
})().catch(e=>{console.error(e);process.exit(1)});
