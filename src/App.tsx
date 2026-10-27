import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend, videoUrl } from './backend';
import type { CaptureSource, Marker, Microphone, Project, RecordingStatus, Session, SetupStatus, Transcript } from './backend';
import { activeSegment, activeWord, errorMessage, formatTime, seekTime, segmentSeekMs, wordSeekMs } from './review';
import { Icon } from './icons';

type Dialog = {kind:'project'|'renameProject'|'renameSession'|'recording'|'marker';id?:string;value:string};
const EMPTY_TRANSCRIPT: Transcript = {segments:[]};
function dateLabel(value: string) { return new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }

export default function App() {
  const [theme,setTheme] = useState(() => localStorage.getItem('cuereview.theme') || 'light');
  const [projects,setProjects] = useState<Project[]>([]);
  const [sessions,setSessions] = useState<Record<string,Session[]>>({});
  const [projectId,setProjectId] = useState('');
  const [session,setSession] = useState<Session|null>(null);
  const [draft,setDraft] = useState(true);
  const [draftName,setDraftName] = useState('New recording');
  const [sources,setSources] = useState<CaptureSource[]>([]);
  const [microphones,setMicrophones] = useState<Microphone[]>([]);
  const [sourceId,setSourceId] = useState('');
  const [microphoneId,setMicrophoneId] = useState<string|undefined>(undefined);
  const [systemAudio,setSystemAudio] = useState(false);
  const [muted,setMuted] = useState(false);
  const [status,setStatus] = useState<RecordingStatus>({state:'idle'});
  const [setup,setSetup] = useState<SetupStatus|null>(null);
  const [transcript,setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT);
  const [markers,setMarkers] = useState<Marker[]>([]);
  const [preview,setPreview] = useState('');
  const [previewError,setPreviewError] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [installing,setInstalling] = useState(false);
  const [menu,setMenu] = useState('');
  const [dialog,setDialog] = useState<Dialog|null>(null);
  const [collapsed,setCollapsed] = useState(()=>window.innerWidth<700);
  const [closedProjects,setClosedProjects] = useState<Set<string>>(new Set());
  const [compact,setCompact] = useState(false);
  const [follow,setFollow] = useState(true);
  const [time,setTime] = useState(0);
  const [duration,setDuration] = useState(0);
  const [playing,setPlaying] = useState(false);
  const [speed,setSpeed] = useState(1);
  const [focusVideo,setFocusVideo] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const currentLine = useRef<HTMLDivElement>(null);
  const selection = useRef(0);
  const actionEpoch = useRef(0);
  const restoredSize = useRef<{width:number;height:number}|null>(null);
  const recording = status.state === 'recording';
  const processing = session?.status === 'processing' || status.state === 'processing';
  const locked = recording || busy;
  const project = projects.find(item => item.id === projectId);
  const source:CaptureSource|undefined = sources.find(item => item.id === sourceId) || (sourceId ? {id:sourceId,name:'Previously selected source',kind:'display',available:false,detail:'The previously selected capture source is no longer available. Reconnect it and refresh, or choose another source.'} : undefined);
  const microphone = microphones.find(item => item.id === microphoneId);
  const microphoneUnavailable = !!microphoneId&&!microphone;
  const noAudio = !microphoneId&&!systemAudio;
  const deviceAudioOnly = (source?.kind==='android'||source?.kind==='quest')&&!microphoneId&&systemAudio;
  const displayedTranscript = recording ? status.liveTranscript || EMPTY_TRANSCRIPT : transcript;
  const transcriptTime = recording ? status.elapsedMs || 0 : time;
  const highlighted = activeSegment(displayedTranscript.segments,transcriptTime);
  const followIndex = recording ? displayedTranscript.segments.length - 1 : highlighted;

  const report = useCallback((problem:unknown) => {setError(errorMessage(problem));},[]);
  const refreshProjects = useCallback(async () => {
    const items = await backend.projects(); setProjects(items);
    const entries = await Promise.all(items.map(async item => [item.id,await backend.sessions(item.id)] as const));
    setSessions(Object.fromEntries(entries));
    setProjectId(current => current || items[0]?.id || '');
  },[]);
  const refreshDevices = useCallback(async () => {
    const [videoSources,audioSources] = await Promise.all([backend.sources(),backend.microphones()]);
    setSources(videoSources); setMicrophones(audioSources);
    setSourceId(current => current || videoSources.find(item=>item.available)?.id || '');
    setMicrophoneId(current => current ?? audioSources[0]?.id ?? '');
  },[]);
  const openSession = useCallback(async (id:string) => {
    const request = ++selection.current;
    setLoading(true); setMenu(''); setError('');
    try {
      const next = await backend.session(id);
      const [text,cues] = await Promise.all([backend.transcript(id),backend.markers(id)]);
      if(request !== selection.current) return;
      setSession(next);setProjectId(next.projectId);setTranscript(text);setMarkers(cues);setDraft(false);setTime(0);setPlaying(false);setDuration(next.durationMs);
      if(next.status==='recording'){if(next.sourceId)setSourceId(next.sourceId);setMicrophoneId(next.microphoneId||'');setSystemAudio(next.systemAudio||false);}
    } catch(problem) { if(request===selection.current) report(problem); }
    finally { if(request===selection.current) setLoading(false); }
  },[report]);

  useEffect(() => {
    let alive=true;
    (async()=>{
      try {
        await refreshProjects();
        const [health,recordingStatus] = await Promise.all([backend.setup(),backend.status()]);
        if(!alive) return;
        setSetup(health);setStatus(recordingStatus);
        if(recordingStatus.sessionId) await openSession(recordingStatus.sessionId);
        await refreshDevices();
      } catch(problem) {if(alive) report(problem);}
      finally {if(alive) setLoading(false);}
    })();
    return ()=>{alive=false;};
  },[refreshProjects,refreshDevices,openSession,report]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('cuereview.theme',theme);if(isTauri())getCurrentWindow().setTheme(theme==='dark'?'dark':'light').catch(report);},[theme,report]);
  useEffect(()=>{
    if(!isTauri())return;
    const subscription=listen<string>('close-blocked',event=>setError(event.payload));
    return()=>{void subscription.then(unlisten=>unlisten());};
  },[]);
  useEffect(()=>{
    if(!isTauri()) return;
    let alive=true;let polling=false;
    const poll=async()=>{
      if(polling)return;polling=true;
      const epoch=actionEpoch.current;
      try {
        const next=await backend.status();if(!alive||epoch!==actionEpoch.current)return;setStatus(next);
        if(next.error)setError(next.error);
        if(session && (session.status==='processing'||session.status==='recording') && next.state!=='recording') {
          const fresh=await backend.session(session.id);if(!alive||epoch!==actionEpoch.current)return;
          if(fresh.status==='ready'||fresh.status==='error') {
            const [text,cues]=await Promise.all([backend.transcript(fresh.id),backend.markers(fresh.id)]);
            if(!alive||epoch!==actionEpoch.current)return;setSession(fresh);setTranscript(text);setMarkers(cues);setDuration(fresh.durationMs);await refreshProjects();
          }else setSession(fresh);
        }
      }catch(problem){if(alive)report(problem);}finally{polling=false;}
    };
    const timer=setInterval(poll,700);return()=>{alive=false;clearInterval(timer);};
  },[session?.id,session?.status,refreshProjects,report]);
  useEffect(()=>{
    setPreview('');setPreviewError('');
    if(!projectId||!sourceId||(!draft&&!recording)||!source?.available)return;
    let alive=true;let polling=false;
    const poll=async()=>{if(polling)return;polling=true;try{const frame=await backend.preview(sourceId);if(alive){setPreview(frame);setPreviewError('');}}catch(problem){if(alive){setPreview('');setPreviewError(errorMessage(problem));}}finally{polling=false;}};
    void poll();const timer=setInterval(poll,1200);return()=>{alive=false;clearInterval(timer);};
  },[projectId,sourceId,draft,recording,source?.available]);
  useEffect(()=>{if(follow&&currentLine.current) currentLine.current.scrollIntoView({behavior:'smooth',block:'nearest'});},[followIndex,follow]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);

  const prepare = useCallback(()=>{if(locked)return;selection.current++;setLoading(false);setDraft(true);setSession(null);setTranscript(EMPTY_TRANSCRIPT);setMarkers([]);setPlaying(false);setTime(0);setMenu('');if(!projectId)setDialog({kind:'project',value:''});},[locked,projectId]);
  const seek=useCallback((ms:number)=>{const next=seekTime(ms,duration);if(video.current)video.current.currentTime=next/1000;setTime(next);},[duration]);
  const play=useCallback(async()=>{if(!video.current||draft||recording)return;try{if(video.current.paused)await video.current.play();else video.current.pause();}catch(problem){report(problem);}},[draft,recording,report]);
  const toggleCompact=useCallback(async()=>{
    try {
      if(isTauri()) {
        const win=getCurrentWindow();
        if(!compact){const size=await win.innerSize();const scale=await win.scaleFactor();restoredSize.current={width:size.width/scale,height:size.height/scale};await win.setMinSize(new LogicalSize(420,250));await win.setSize(new LogicalSize(520,320));await win.setAlwaysOnTop(true);}
        else {await win.setAlwaysOnTop(false);const size=restoredSize.current||{width:1200,height:780};await win.setSize(new LogicalSize(size.width,size.height));await win.setMinSize(new LogicalSize(640,480));}
      }
      setCompact(current=>!current);
    }catch(problem){report(problem);}
  },[compact,report]);
  const record=useCallback(async()=>{
    if(busy||processing||loading)return;actionEpoch.current++;setBusy(true);setError('');setMenu('');
    try {
      if(recording){const next=await backend.stop();setSession(next);setDraft(false);setStatus({state:next.status==='processing'?'processing':'idle'});setDuration(next.durationMs);await refreshProjects();if(compact)await toggleCompact();}
      else {
        if(!projectId){setDialog({kind:'project',value:''});return;}
        if(!source?.available)throw new Error(source?.detail||'Choose an available screen, window, or connected device first.');
        if(microphoneUnavailable)throw new Error('The selected microphone is unavailable. Reconnect it and refresh microphones, choose another input, or select No microphone.');
        const next=await backend.start(projectId,draft?draftName:'New recording',sourceId,microphoneId||null,systemAudio,muted);
        setSession(next);setDraft(false);setTranscript(EMPTY_TRANSCRIPT);setMarkers([]);setStatus({state:'recording',sessionId:next.id,elapsedMs:0});setTime(0);setPlaying(false);await refreshProjects();
      }
    }catch(problem){report(problem);}finally{setBusy(false);}
  },[busy,processing,loading,recording,projectId,sourceId,source?.available,source?.detail,draft,draftName,muted,microphoneId,microphoneUnavailable,systemAudio,refreshProjects,compact,toggleCompact,report]);
  const addMarker=useCallback(()=>{if(!session)return;setDialog({kind:'marker',id:session.id,value:''});},[session]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){setMenu('');setDialog(null);return;}
      if(dialog||menu==='setup')return;
      if(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)return;
      if(event.ctrlKey&&event.key.toLowerCase()==='r'){event.preventDefault();void record();}
      else if(event.ctrlKey&&event.key.toLowerCase()==='n'){event.preventDefault();prepare();}
      else if(event.code==='Space'){
        if(event.target instanceof Element && event.target.closest('button,a[href],[role="button"]'))return;
        event.preventDefault();void play();
      }
      else if(event.key==='ArrowLeft'){event.preventDefault();seek(time-5000);}
      else if(event.key==='ArrowRight'){event.preventDefault();seek(time+5000);}
      else if(event.key.toLowerCase()==='m'&&session){event.preventDefault();addMarker();}
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[record,prepare,play,seek,time,session,addMarker,dialog,menu]);
  const submitDialog=async(event:FormEvent)=>{
    event.preventDefault();if(!dialog)return;const name=dialog.value.trim();if(!name&&dialog.kind!=='marker')return;setBusy(true);setError('');
    try {
      if(dialog.kind==='project'){const next=await backend.createProject(name);setProjectId(next.id);await refreshProjects();}
      if(dialog.kind==='renameProject'){await backend.renameProject(dialog.id!,name);await refreshProjects();}
      if(dialog.kind==='renameSession'){await backend.renameSession(dialog.id!,name);if(session && session.id===dialog.id)setSession({...session,name});await refreshProjects();}
      if(dialog.kind==='recording')setDraftName(name);
      if(dialog.kind==='marker'){const marker=await backend.addMarker(dialog.id!,recording?status.elapsedMs||0:time,name||'Review this moment');setMarkers(items=>[...items,marker].sort((a,b)=>a.timeMs-b.timeMs));setNotice('Marker saved');}
      setDialog(null);
    }catch(problem){report(problem);}finally{setBusy(false);}
  };
  const copyHandoff=async()=>{if(!session)return;setBusy(true);try{const text=await backend.handoff(session.id);await navigator.clipboard.writeText(text);setNotice('Agent instructions copied');setMenu('');}catch(problem){report(problem);}finally{setBusy(false);}};
  const retry=async()=>{if(!session)return;setBusy(true);try{await backend.retry(session.id);setSession({...session,status:'processing',error:undefined});setStatus({state:'processing',sessionId:session.id});setError('');}catch(problem){report(problem);}finally{setBusy(false);}};
  const install=async()=>{setInstalling(true);setError('');try{await backend.installTranscription();setSetup(await backend.setup());setNotice('Local transcription tools installed');}catch(problem){report(problem);}finally{setInstalling(false);}};
  const selectTheme=()=>setTheme(current=>current==='dark'?'light':'dark');
  const utilityControls=<div className="utility-controls"><button title={`Use ${theme==='dark'?'light':'dark'} theme`} aria-label={`Use ${theme==='dark'?'light':'dark'} theme`} onClick={selectTheme}><Icon name={theme==='dark'?'sun':'moon'}/></button><button aria-label="Settings and setup" title="Settings and setup" onClick={()=>setMenu(menu==='setup'?'':'setup')}><Icon name="settings"/></button></div>;

  return <div className={`app ${compact?'compact':''}`}>
    <div className={`shell ${collapsed?'sidebar-collapsed':''}`}>
      <aside className="sidebar" aria-label="Projects and sessions">
        <div className="side-tools"><button aria-label="Collapse sidebar" onClick={()=>setCollapsed(true)}><Icon name="panel"/></button><button disabled={locked} onClick={prepare} title="New recording (Ctrl+N)"><Icon name="plus"/>New recording</button></div>
        <div className="project-list">
          {projects.map(item=><div className="project" key={item.id}>
            <div className="project-row"><button className="project-toggle" aria-expanded={!closedProjects.has(item.id)} onClick={()=>{if(draft)setProjectId(item.id);setClosedProjects(current=>{const next=new Set(current);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;});}}><Icon name="chevron" style={{transform:closedProjects.has(item.id)?'':'rotate(90deg)'}}/><span>{item.name}</span></button><button className="project-options" disabled={locked} aria-label={`Rename project ${item.name}`} onClick={()=>setDialog({kind:'renameProject',id:item.id,value:item.name})}><Icon name="more"/></button></div>
            {!closedProjects.has(item.id)&&<div>{sessions[item.id]?.map(itemSession=><button className={`session ${session?.id===itemSession.id&&!draft?'active':''}`} disabled={locked} key={itemSession.id} onClick={()=>void openSession(itemSession.id)} onDoubleClick={()=>setDialog({kind:'renameSession',id:itemSession.id,value:itemSession.name})}><span>{itemSession.name}</span><small>{dateLabel(itemSession.createdAt)} · {itemSession.status==='recording'?'Recording':itemSession.status==='processing'?'Processing…':formatTime(itemSession.durationMs)}</small></button>)}{sessions[item.id]?.length===0&&<p className="empty-project">No recordings yet</p>}</div>}
          </div>)}
          {!projects.length&&!loading&&<p className="side-empty">Create a project to keep your recordings together.</p>}
        </div>
        <div className="side-bottom"><button className="new-project" disabled={locked} onClick={()=>setDialog({kind:'project',value:''})}><Icon name="plus"/>New project</button>{!collapsed&&!compact&&utilityControls}</div>
      </aside>
      <main className="content">
        <header className="session-header"><div className="session-heading"><div className="title-row"><button className="show-sidebar" aria-label={collapsed?'Show sidebar':'Show projects'} onClick={()=>setCollapsed(!collapsed)}><Icon name="panel"/></button><h1><button title={recording?'Recording title':'Rename recording'} disabled={recording||busy} onClick={()=>setDialog({kind:draft?'recording':'renameSession',id:session?.id,value:draft?draftName:session?.name||''})}>{draft?draftName:session?.name||'Your workspace'}</button></h1>{recording&&<span className="live-dot"/>}</div><div className="meta">{draft?<><label className="project-select"><select aria-label="Recording project" disabled={locked} value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="" disabled>Select project</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>·</span><span>Ready when you are</span></>:<><span>{project?.name}</span><span>·</span><span>{session&&dateLabel(session.createdAt)}</span><span>·</span><span>{recording?formatTime(status.elapsedMs||0):formatTime(session?.durationMs||0)}</span></>}</div></div><div className="header-actions">{(collapsed||compact)&&utilityControls}{recording?<button title={compact?'Restore workspace':'Compact recording mode'} onClick={()=>void toggleCompact()}><Icon name="compact"/>{compact?'Expand':'Compact'}</button>:session&&<><button className="folder-button" title="Open recording folder" aria-label="Open recording folder" onClick={()=>void backend.openFolder(session.id).catch(report)}><Icon name="folder"/></button><button disabled={busy||processing} onClick={()=>void copyHandoff()}>Copy for agent<Icon name="arrow"/></button></>}</div></header>
        {error&&!dialog&&menu!=='setup'&&<div className="error-banner" role="alert"><Icon name="warning"/><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><Icon name="close"/></button></div>}
        {setup&&!setup.ready&&!recording&&<div className="setup-banner"><span>Local transcription needs setup.</span><button onClick={()=>setMenu('setup')}>Review setup<Icon name="arrow"/></button></div>}
        <div className={`review ${focusVideo?'focus-video':''}`}>
          <section className="player" aria-label={draft||recording?'Capture preview':'Recording video'}>
            <div className="video-surface">
              {draft||recording?<>{preview?<img className="preview-image" src={preview} alt={`Live preview of ${source?.name||'capture source'}`}/>:<div className="video-empty"><Icon name="monitor"/><h2>{loading?'Loading your workspace…':!projects.length?'Show it. Say it. Fix it.':source&&!source.available?'Capture source unavailable':sources.length?'Choose what to show':'Choose a capture source'}</h2><p>{loading?'':!projects.length?'Create a project to start your first recording.':source&&!source.available?source.detail||'Reconnect the selected source and refresh, or choose another source.':source?'Connecting to capture source…':'Select a screen, window, or connected device below.'}</p>{!loading&&!projects.length&&<button className="create-first-project" onClick={()=>setDialog({kind:'project',value:''})}><Icon name="plus"/>Create project</button>}</div>}{previewError&&<div className="preview-error">{previewError}</div>}{recording&&<div className="record-badge"><i/>Recording <span>{formatTime(status.elapsedMs||0)}</span></div>}</>:session?.videoPath?<video key={session.id} ref={video} src={videoUrl(session.videoPath)} playsInline preload="metadata" onTimeUpdate={event=>setTime(event.currentTarget.currentTime*1000)} onLoadedMetadata={event=>{setDuration(Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration*1000:session.durationMs);event.currentTarget.playbackRate=speed;}} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onClick={()=>void play()} onError={()=>setError('This recording could not be played. Open its folder to inspect the video file.')} />:<div className="video-empty"><Icon name="monitor"/><h2>{loading?'Opening recording…':processing?'Finishing your recording':'No video available'}</h2><p>{processing?'Your video and transcript are being saved locally.':'Open the session folder to inspect its files.'}</p></div>}
            </div>
            {!draft&&!recording&&<div className="player-controls"><button disabled={!session?.videoPath} title={playing?'Pause (Space)':'Play (Space)'} aria-label={playing?'Pause':'Play'} onClick={()=>void play()}><Icon name={playing?'pause':'play'}/></button><span className="time">{formatTime(time)}<span> / {formatTime(duration)}</span></span><input aria-label="Playback position" type="range" min="0" max={duration||1} value={Math.min(time,duration)} step="10" onChange={event=>seek(Number(event.target.value))}/><button title="Playback speed" aria-label={`Playback speed ${speed}×`} onClick={()=>{const next=speed===1?1.5:speed===1.5?2:speed===2?.75:1;setSpeed(next);if(video.current)video.current.playbackRate=next;}}>{speed}×</button><button title="Focus video" aria-label={focusVideo?'Restore transcript':'Focus video'} onClick={()=>setFocusVideo(!focusVideo)}><Icon name="expand"/></button></div>}
          </section>
          <section className="transcript" aria-label="Transcript"><div className="transcript-header"><h2>Transcript</h2><span>{recording?(noAudio?'No audio':status.liveTranscript?.error?'Needs attention':deviceAudioOnly?'After recording':'Listening…'):processing?'Transcribing…':transcript.error||session?.status==='error'?'Needs attention':transcript.segments.length?<><Icon name="check"/>Synced</>:draft?(noAudio?'Video only':'Local transcription'):'No speech'}</span></div>
            <div className="transcript-scroll">{recording&&status.liveTranscript?.error&&<p className="option-note" role="status">{status.liveTranscript.error}</p>}
              {displayedTranscript.segments.length?displayedTranscript.segments.map((segment,index)=>{const wordIndex=activeWord(segment.words,transcriptTime);return <div key={segment.id||index} className={`transcript-line ${highlighted===index?'current':''}`} ref={followIndex===index?currentLine:undefined}><button className="timestamp" disabled={recording} onClick={()=>seek(segmentSeekMs(segment))} aria-label={`Seek to ${formatTime(segmentSeekMs(segment))}`}>{formatTime(segmentSeekMs(segment))}</button><p>{segment.words.length?segment.words.map((word,indexWord)=><span key={indexWord}><button className={`word ${highlighted===index&&wordIndex===indexWord?'spoken':''}`} disabled={recording} onClick={()=>seek(wordSeekMs(word))} aria-label={`Seek to ${word.text} at ${formatTime(wordSeekMs(word))}`} aria-current={highlighted===index&&wordIndex===indexWord?'true':undefined}>{word.text}</button>{' '}</span>):<button className="segment-text" disabled={recording} onClick={()=>seek(segmentSeekMs(segment))}>{segment.text}</button>}</p></div>}):<div className="transcript-empty"><p>{recording?(noAudio?'No audio input was selected for this recording.':setup?.modelReady?(deviceAudioOnly?'Device audio is transcribed after recording.':'Listening… transcript updates in short batches.'):'Your voice is being recorded. Local transcription needs setup.'):processing?'Creating your local transcript…':draft?(noAudio?'Choose a microphone or enable source audio to add a transcript.':'Speak naturally. Your words will become a transcript linked to the recording.'):transcript.error||session?.error||'No speech was detected in this recording.'}</p><span>{recording?(noAudio?'Video recording continues without a transcript.':setup?.modelReady?(deviceAudioOnly?'Stop recording to create the final local transcript.':'The final transcript is refined after you stop.'):'Install local transcription in Settings to transcribe this recording.'):processing?'You can keep CueReview open while it finishes.':draft?(noAudio?'You can still record video without audio.':'Click a word later to replay that exact moment.'):''}</span></div>}
              {(session?.status==='error'||transcript.error)&&!processing&&<button className="retry-button" disabled={busy} onClick={()=>void retry()}><Icon name="refresh"/>Retry transcription</button>}
              {!!markers.length&&<div className="markers"><h3>Markers</h3>{markers.map(marker=><button key={marker.id} disabled={recording} onClick={()=>seek(marker.timeMs)}><Icon name="marker"/><time>{formatTime(marker.timeMs)}</time><span>{marker.label}</span></button>)}</div>}
            </div>
            <div className="transcript-foot"><span>{displayedTranscript.segments.reduce((sum,item)=>sum+item.words.length,0)||''}{displayedTranscript.segments.length?' words':''}</span><button className={follow?'following':''} onClick={()=>setFollow(!follow)} aria-pressed={follow}>Follow playback{follow&&<Icon name="check"/>}</button>{session&&<button title="Add marker (M)" aria-label="Add marker" onClick={addMarker}><Icon name="marker"/></button>}</div>
          </section>
        </div>
        <div className="capture-bar">
          <button className="capture-setting source-trigger" disabled={locked} aria-expanded={menu==='source'} onClick={()=>setMenu(menu==='source'?'':'source')}><Icon name="monitor"/><span>{source?.name||'Choose source'}</span><Icon name="chevron" style={{transform:'rotate(90deg)'}}/></button><span className="divider"/>
          <button className="capture-setting mic-trigger" title={microphoneUnavailable?'Selected microphone unavailable. Reconnect it or choose another input.':undefined} disabled={busy} aria-expanded={menu==='microphone'} onClick={()=>setMenu(menu==='microphone'?'':'microphone')}><Icon name="mic"/><span>{microphoneUnavailable?'Microphone unavailable':muted?'Muted':microphone?.name||'No microphone'}</span>{recording&&!muted&&microphoneId&&!microphoneUnavailable&&<meter className="audio-meter" min="0" max="1" value={status.audioLevel||0} aria-label="Microphone audio level"/>}<Icon name="chevron" style={{transform:'rotate(90deg)'}}/></button>
          <span className="capture-status" aria-live="polite">{recording?'Recording locally':processing?'Finishing local transcript…':''}</span>
          {recording&&<button className="capture-marker" aria-label="Add marker" title="Add marker (M)" onClick={addMarker}><Icon name="marker"/></button>}
          <button className={`record-button ${recording?'is-recording':''}`} disabled={busy||processing||loading||(!recording&&(!source?.available||!projectId||microphoneUnavailable))} onClick={()=>void record()} title="Start / stop recording (Ctrl+R)"><span className="record-dot"/>{busy?'Please wait…':recording?'Stop':processing?'Processing…':'Record'}</button>
          {menu==='source'&&<div className="popover source-menu"><div className="popover-title">Capture source<button aria-label="Refresh capture devices" onClick={()=>void refreshDevices().catch(report)}><Icon name="refresh"/></button></div><label>Screen, window, or device<select value={sourceId} onChange={event=>{setSourceId(event.target.value);if(!draft)prepare();}}><option value="" disabled>Select a source</option>{sourceId&&!sources.some(item=>item.id===sourceId)&&<option value={sourceId}>Previously selected source · unavailable</option>}{sources.map(item=><option key={item.id} value={item.id}>{item.name}{!item.available?' · unavailable':''}</option>)}</select></label><p className="option-note">{source?.detail||'Connected Android and Quest devices appear here when available.'}</p><label className="check"><input type="checkbox" checked={systemAudio} onChange={event=>setSystemAudio(event.target.checked)}/>{source?.kind==='android'||source?.kind==='quest'?'Include device audio':'Include system audio'}</label><button className="done" onClick={()=>setMenu('')}>Done</button></div>}
          {menu==='microphone'&&<div className="popover mic-menu"><div className="popover-title">Microphone<button disabled={recording} aria-label="Refresh microphones" onClick={()=>void refreshDevices().catch(report)}><Icon name="refresh"/></button></div><label>Input device<select disabled={recording} value={microphoneId??''} onChange={event=>setMicrophoneId(event.target.value)}><option value="">No microphone</option>{microphoneUnavailable&&<option value={microphoneId}>Previously selected microphone · unavailable</option>}{microphones.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="check"><input type="checkbox" checked={muted} onChange={async event=>{const next=event.target.checked;try{if(recording)await backend.mute(next);setMuted(next);}catch(problem){report(problem);}}}/>Mute microphone</label><p className="option-note">{microphoneUnavailable?'Reconnect the selected microphone and refresh microphones, choose another input, or select No microphone.':noAudio?'Choose a microphone or enable source audio for transcription.':deviceAudioOnly?'Device audio is transcribed after recording.':'Transcript updates locally in short batches.'}</p><button className="done" onClick={()=>setMenu('')}>Done</button></div>}
        </div>
      </main>
    </div>
    {menu==='setup'&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setMenu('');}}><section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div className="dialog-title"><h2 id="setup-title">Settings & local setup</h2><button aria-label="Close settings" onClick={()=>setMenu('')}><Icon name="close"/></button></div><label className="appearance">Appearance<select value={theme} onChange={event=>setTheme(event.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select></label><h3>Local transcription</h3>{error&&<p className="dialog-error" role="alert">{error}</p>}{setup?<><p>{setup.ready?'Ready to transcribe on this computer.':'Complete setup to transcribe recordings on this computer.'}</p>{setup.dependencies?.map(item=><div className="dependency" key={item.name}><Icon name={item.available?'check':'warning'}/><div><strong>{item.name}</strong><small>{item.detail||item.path||(item.available?'Available':'Missing')}</small></div></div>)}{setup.issues.map((issue,index)=><p className="setup-issue" key={index}>{issue}</p>)}{(!setup.modelReady||setup.dependencies?.some(item=>(item.name==='whisper-cli'||item.name==='whisper-vad-speech-segments')&&!item.available))&&<button className="primary" disabled={installing} onClick={()=>void install()}>{installing?'Downloading transcription tools…':'Install local transcription'}</button>}{installing&&<p className="option-note" role="status">Downloading the speech model and tools. This may take a few minutes.</p>}<button className="check-setup" onClick={()=>void backend.setup().then(setSetup).catch(report)}><Icon name="refresh"/>Check again</button></>:<p>Start the desktop app to inspect installed recording tools.</p>}<p className="settings-shortcuts">Ctrl+N new recording · Ctrl+R record / stop<br/>Space play / pause · ← → seek 5 seconds · M add marker</p></section></div>}
    {dialog&&<div className="modal-backdrop"><form className="name-dialog" role="dialog" aria-modal="true" aria-labelledby="name-title" onSubmit={event=>void submitDialog(event)}><h2 id="name-title">{dialog.kind==='project'?'New project':dialog.kind==='renameProject'?'Rename project':dialog.kind==='marker'?'Add marker':'Recording name'}</h2>{error&&<p className="dialog-error" role="alert">{error}</p>}<label>{dialog.kind==='marker'?'Note':'Name'}<input autoFocus maxLength={160} value={dialog.value} onChange={event=>setDialog({...dialog,value:event.target.value})} placeholder={dialog.kind==='marker'?'Review this moment':''}/></label><div className="dialog-actions"><button type="button" onClick={()=>setDialog(null)}>Cancel</button><button className="primary" disabled={busy||(!dialog.value.trim()&&dialog.kind!=='marker')} type="submit">{busy?'Saving…':'Save'}</button></div></form></div>}
    {notice&&<div className="toast" role="status">{notice}</div>}
  </div>;
}
