import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Marker, Project, RecordingStatus, Session, SetupStatus, Transcript } from './backend';

const mocks=vi.hoisted(()=>({backend:{projects:vi.fn(),sessions:vi.fn(),session:vi.fn(),transcript:vi.fn(),markers:vi.fn(),setup:vi.fn(),status:vi.fn(),sources:vi.fn(),microphones:vi.fn(),preview:vi.fn(),createProject:vi.fn(),renameProject:vi.fn(),renameSession:vi.fn(),start:vi.fn(),stop:vi.fn(),addMarker:vi.fn(),handoff:vi.fn(),openFolder:vi.fn(),mute:vi.fn(),retry:vi.fn(),installTranscription:vi.fn()},setTheme:vi.fn().mockResolvedValue(undefined),setAlwaysOnTop:vi.fn().mockResolvedValue(undefined),setSize:vi.fn().mockResolvedValue(undefined),setMinSize:vi.fn().mockResolvedValue(undefined)}));
vi.mock('./backend',()=>({backend:mocks.backend,videoUrl:(path:string)=>`asset://${path}`}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({setTheme:mocks.setTheme,setAlwaysOnTop:mocks.setAlwaysOnTop,setSize:mocks.setSize,setMinSize:mocks.setMinSize,innerSize:async()=>({width:1280,height:820}),scaleFactor:async()=>1})}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn().mockResolvedValue(()=>{})}));

let projects:Project[];
let sessions:Session[];
let status:RecordingStatus;
let setup:SetupStatus;
let transcript:Transcript;
let markers:Marker[];
const backend=mocks.backend;
const timestamp='2026-10-27T10:42:00Z';
const newSession=(id='s1'):Session=>({id,projectId:'p1',name:'Review Alpha',createdAt:timestamp,durationMs:10000,status:'ready',videoPath:'C:/recordings/video.mp4',sourceId:'display1',microphoneId:'mic1'});
const readySetup:SetupStatus={ready:true,issues:[],modelReady:true,dependencies:[{name:'whisper-cli',available:true}]};

beforeEach(()=>{
  vi.clearAllMocks();
  projects=[{id:'p1',name:'Project Alpha',createdAt:timestamp}];sessions=[newSession()];status={state:'idle'};setup={...readySetup};markers=[];
  transcript={segments:[{id:'line1',text:'Look here',startMs:1000,endMs:4000,words:[{text:'Look',startMs:1000,endMs:1800},{text:'here',startMs:2500,endMs:3500}]}]};
  backend.projects.mockImplementation(async()=>projects.map(item=>({...item})));
  backend.sessions.mockImplementation(async(projectId:string)=>sessions.filter(item=>item.projectId===projectId).map(item=>({...item})));
  backend.session.mockImplementation(async(id:string)=>({...sessions.find(item=>item.id===id)!}));
  backend.status.mockImplementation(async()=>({...status}));
  backend.setup.mockImplementation(async()=>({...setup}));
  backend.sources.mockResolvedValue([{id:'display1',name:'Display 1',kind:'display',available:true},{id:'quest1',name:'Quest USB',kind:'quest',available:true}]);
  backend.microphones.mockResolvedValue([{id:'mic1',name:'Studio microphone'},{id:'mic2',name:'Headset microphone'}]);
  backend.preview.mockResolvedValue('data:image/png;base64,cHJldmlldw==');
  backend.transcript.mockImplementation(async()=>structuredClone(transcript));
  backend.markers.mockImplementation(async()=>markers.map(item=>({...item})));
  backend.createProject.mockImplementation(async(name:string)=>{const project={id:'p2',name,createdAt:timestamp};projects.push(project);return project;});
  backend.renameProject.mockImplementation(async(id:string,name:string)=>{projects=projects.map(item=>item.id===id?{...item,name}:item);});
  backend.renameSession.mockImplementation(async(id:string,name:string)=>{sessions=sessions.map(item=>item.id===id?{...item,name}:item);});
  backend.start.mockImplementation(async()=>{const session={...newSession('s2'),name:'New recording',status:'recording' as const};sessions.push(session);status={state:'recording',sessionId:'s2',elapsedMs:3000,audioLevel:.4};return session;});
  backend.stop.mockImplementation(async()=>{const next={...sessions.find(item=>item.id==='s2')!,status:'processing' as const};sessions=sessions.map(item=>item.id===next.id?next:item);status={state:'processing',sessionId:next.id};return next;});
  backend.addMarker.mockImplementation(async(_id:string,timeMs:number,label:string)=>{const marker={id:'m1',timeMs,label};markers.push(marker);return marker;});
  backend.handoff.mockResolvedValue('Review local session s1. Transcript and frame instructions.');
  backend.openFolder.mockResolvedValue(undefined);backend.mute.mockResolvedValue(undefined);backend.retry.mockResolvedValue(undefined);backend.installTranscription.mockResolvedValue(undefined);
});

async function ready() {
  const user=userEvent.setup();render(<App/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Record'})).toBeEnabled());
  return user;
}
async function review() {
  const user=await ready();
  await user.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button',{name:/Review Alpha/}));
  await screen.findByRole('button',{name:'Seek to here at 0:02'});
  return user;
}
async function poll() {await act(async()=>{await new Promise(resolve=>setTimeout(resolve,760));});}

describe('keyboard interaction',()=>{
  it('lets Space activate the focused theme and recording buttons',async()=>{
    const user=await ready();
    screen.getByRole('button',{name:'Use dark theme'}).focus();
    await user.keyboard(' ');
    expect(mocks.setTheme).toHaveBeenLastCalledWith('dark');
    expect(screen.getByRole('button',{name:'Use light theme'})).toHaveFocus();
    screen.getByRole('button',{name:'Record'}).focus();
    await user.keyboard(' ');
    expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
  it('scopes recording shortcuts outside naming and settings dialogs while allowing Escape',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'New project'}));
    screen.getByRole('button',{name:'Cancel'}).focus();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog',{name:'New project'})).toBeVisible();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Settings and setup'}));
    screen.getByRole('button',{name:'Close settings'}).focus();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog',{name:'Settings & local setup'})).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
});

describe('project and session workflows',()=>{
  it('gives a first-time user a project action before starting a live preview',async()=>{
    projects=[];sessions=[];
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Create project'}));
    expect(screen.queryByText('CueReview',{exact:true})).not.toBeInTheDocument();
    expect(backend.preview).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'),'First review');await user.click(screen.getByRole('button',{name:'Save'}));
    expect(await screen.findByRole('img',{name:'Live preview of Display 1'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Record'})).toBeEnabled();
  });
  it('keeps theme and settings available when the project sidebar is collapsed',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Collapse sidebar'}));
    await user.click(screen.getByRole('button',{name:'Use dark theme'}));
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByRole('button',{name:'Use light theme'})).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Settings and setup'}));
    expect(screen.getByRole('dialog',{name:'Settings & local setup'})).toBeVisible();
  });
  it('creates a project, keeps it selected, and renames it through the tree',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'New project'}));
    await user.type(screen.getByLabelText('Name'),'Beta product');await user.click(screen.getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(screen.getByLabelText('Recording project')).toHaveValue('p2'));
    expect(backend.createProject).toHaveBeenCalledWith('Beta product');
    await user.click(screen.getByRole('button',{name:'Rename project Beta product'}));
    await user.clear(screen.getByLabelText('Name'));await user.type(screen.getByLabelText('Name'),'Beta review');await user.click(screen.getByRole('button',{name:'Save'}));
    await screen.findByRole('button',{name:'Rename project Beta review'});
    expect(backend.renameProject).toHaveBeenCalledWith('p2','Beta review');
  });
  it('loads and renames an existing session without losing its transcript',async()=>{
    const user=await review();
    await user.click(within(screen.getByRole('heading',{level:1})).getByRole('button',{name:'Review Alpha'}));
    await user.clear(screen.getByLabelText('Name'));await user.type(screen.getByLabelText('Name'),'Playback regression');await user.click(screen.getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(screen.getByRole('heading',{level:1})).toHaveTextContent('Playback regression'));
    expect(backend.renameSession).toHaveBeenCalledWith('s1','Playback regression');
    expect(screen.getByRole('button',{name:'Seek to here at 0:02'})).toBeVisible();
  });
});

describe('recording and processing',()=>{
  it('describes device-only audio as post-recording transcription',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    expect(screen.getByLabelText('Include system audio')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Screen, window, or device'),'quest1');
    await user.click(screen.getByLabelText('Include device audio'));await user.click(screen.getByRole('button',{name:'Done'}));
    await user.click(screen.getByRole('button',{name:'Studio microphone'}));
    await user.selectOptions(screen.getByLabelText('Input device'),'');await user.click(screen.getByRole('button',{name:'Done'}));
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(screen.getByText('Device audio is transcribed after recording.')).toBeVisible();
    expect(backend.start).toHaveBeenCalledWith('p1','New recording','quest1',null,true,false);
  });
  it('clears compact always-on-top mode on both manual restore and stopping',async()=>{
    const user=await ready();await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    await user.click(screen.getByRole('button',{name:'Compact'}));await screen.findByRole('button',{name:'Expand'});
    expect(mocks.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button',{name:'Expand'}));await screen.findByRole('button',{name:'Compact'});
    expect(mocks.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button',{name:'Compact'}));await screen.findByRole('button',{name:'Expand'});
    await user.click(screen.getByRole('button',{name:'Stop'}));await screen.findByRole('button',{name:'Processing…'});
    expect(mocks.setAlwaysOnTop.mock.calls.map(call=>call[0])).toEqual([true,false,true,false]);
  });
  it('explains missing transcription setup while still showing the actual recording state',async()=>{
    setup={ready:false,issues:['Local speech model is missing'],modelReady:false,dependencies:[]};
    const user=await ready();await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(screen.getByText('Your voice is being recorded. Local transcription needs setup.')).toBeVisible();
    expect(screen.getByText('Install local transcription in Settings to transcribe this recording.')).toBeVisible();
  });
  it('shows progressive transcript batches while preserving active capture when words are clicked',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(screen.getByText('Listening… transcript updates in short batches.')).toBeVisible();
    const liveTranscript:Transcript={segments:[{...transcript.segments[0],startMs:7000,endMs:9000,words:[{text:'Look',startMs:7000,endMs:7500},{text:'here',startMs:7500,endMs:8500}]}]};
    status={state:'recording',sessionId:'s2',elapsedMs:8000,liveTranscript};
    await poll();
    const liveWord=await screen.findByRole('button',{name:'Seek to here at 0:07'});
    expect(liveWord).toBeDisabled();
    expect(liveWord).toHaveAttribute('aria-current','true');
    await user.click(liveWord);
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
    expect(document.querySelector('video')).toBeNull();
    expect(backend.stop).not.toHaveBeenCalled();
    expect(backend.start).toHaveBeenCalledTimes(1);
    status={...status,elapsedMs:16000,liveTranscript:{segments:[...liveTranscript.segments,{startMs:12000,endMs:14000,text:'Next batch',words:[{text:'Next',startMs:12000,endMs:13000},{text:'batch',startMs:13000,endMs:14000}]}]}};
    await poll();
    expect(await screen.findByRole('button',{name:'Seek to batch at 0:13'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
  });
  it('passes selected USB source, selected microphone, system audio and mute independently, then loads the completed transcript',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    await user.selectOptions(screen.getByLabelText('Screen, window, or device'),'quest1');
    await user.click(screen.getByLabelText('Include device audio'));await user.click(screen.getByRole('button',{name:'Done'}));
    await user.click(screen.getByRole('button',{name:'Studio microphone'}));
    await user.selectOptions(screen.getByLabelText('Input device'),'mic2');await user.click(screen.getByLabelText('Mute microphone'));await user.click(screen.getByRole('button',{name:'Done'}));
    await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith('p1','New recording','quest1','mic2',true,true);
    expect(screen.getByText('The final transcript is refined after you stop.')).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Muted'}));await user.click(screen.getByLabelText('Mute microphone'));
    expect(backend.mute).toHaveBeenCalledWith(false);await user.click(screen.getByRole('button',{name:'Done'}));
    await user.click(screen.getByRole('button',{name:'Stop'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Processing…'})).toBeDisabled());
    fireEvent.keyDown(window,{key:'r',ctrlKey:true});expect(backend.start).toHaveBeenCalledTimes(1);
    let completeTranscript!:(value:Transcript)=>void;
    backend.transcript.mockImplementationOnce(()=>new Promise<Transcript>(resolve=>{completeTranscript=resolve;}));
    sessions=sessions.map(item=>item.id==='s2'?{...item,status:'ready'}:item);status={state:'idle'};
    await poll();
    await act(async()=>completeTranscript(transcript));
    expect(await screen.findByRole('button',{name:'Seek to here at 0:02'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Record'})).toBeEnabled();
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });
  it('keeps a capture failure actionable and allows a second recording attempt',async()=>{
    const user=await ready();backend.start.mockRejectedValueOnce('USB device disconnected. Reconnect Quest and try again.');
    await user.click(screen.getByRole('button',{name:'Record'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect Quest');
    expect(screen.getByRole('button',{name:'Record'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'Record'}));
    expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
  });
});

describe('review handoff',()=>{
  it('seeks the real media time from a word, persists a marker there, and copies the backend handoff',async()=>{
    const user=await review();
    await user.click(screen.getByRole('button',{name:'Seek to here at 0:02'}));
    const media=document.querySelector('video')!;
    expect(media.currentTime).toBe(2.5);expect(screen.getByLabelText('Playback position')).toHaveValue('2500');
    expect(screen.getByRole('button',{name:'Seek to here at 0:02'})).toHaveAttribute('aria-current','true');
    await user.click(screen.getByRole('button',{name:'Add marker'}));await user.type(screen.getByLabelText('Note'),'Panel is stale');await user.click(screen.getByRole('button',{name:'Save'}));
    expect(backend.addMarker).toHaveBeenCalledWith('s1',2500,'Panel is stale');
    await screen.findByRole('button',{name:/Panel is stale/});
    const clipboard=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button',{name:'Copy for agent'}));
    await waitFor(()=>expect(clipboard).toHaveBeenCalledWith('Review local session s1. Transcript and frame instructions.'));
    await user.click(screen.getByRole('button',{name:'Open recording folder'}));expect(backend.openFolder).toHaveBeenCalledWith('s1');
  });
  it('retries a failed transcript and returns to usable review after processing',async()=>{
    sessions=[{...newSession(),status:'error',error:'Speech model not found'}];transcript={segments:[],error:'Speech model not found'};
    const user=await ready();await user.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button',{name:/Review Alpha/}));
    await user.click(await screen.findByRole('button',{name:'Retry transcription'}));
    expect(backend.retry).toHaveBeenCalledWith('s1');
    expect(screen.getByRole('button',{name:'Processing…'})).toBeDisabled();
    sessions=[newSession()];transcript={segments:[{startMs:0,endMs:1000,text:'Restored',words:[{text:'Restored',startMs:0,endMs:1000}]}]};status={state:'idle'};
    await poll();expect(await screen.findByRole('button',{name:'Seek to Restored at 0:00'})).toBeVisible();
  });
});

describe('local setup recovery and request races',()=>{
  it('lets installation fail, retry, and recover even when the model exists but the CLI is absent',async()=>{
    setup={ready:false,issues:['whisper-cli is missing'],modelReady:true,dependencies:[{name:'whisper-cli',available:false}]};
    backend.installTranscription.mockRejectedValueOnce('Download failed. Check your connection and retry.').mockImplementationOnce(async()=>{setup={...readySetup};});
    const user=await ready();await user.click(screen.getByRole('button',{name:'Review setup'}));
    await user.click(screen.getByRole('button',{name:'Install local transcription'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await user.click(screen.getByRole('button',{name:'Install local transcription'}));
    expect(await screen.findByText('Ready to transcribe on this computer.')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Install local transcription'})).not.toBeInTheDocument();
    expect(backend.installTranscription).toHaveBeenCalledTimes(2);
  });
  it('ignores an old source preview that arrives after the user selects another source',async()=>{
    let resolveOld!:(value:string)=>void;
    backend.preview.mockImplementation((sourceId:string)=>sourceId==='display1'?new Promise<string>(resolve=>{resolveOld=resolve;}):Promise.resolve('data:image/png;base64,cXVlc3Q='));
    const user=await ready();await user.click(screen.getByRole('button',{name:'Display 1'}));await user.selectOptions(screen.getByLabelText('Screen, window, or device'),'quest1');
    const image=await screen.findByRole('img',{name:'Live preview of Quest USB'});
    expect(image).toHaveAttribute('src','data:image/png;base64,cXVlc3Q=');
    await act(async()=>resolveOld('data:image/png;base64,b2xk'));
    expect(image).toHaveAttribute('src','data:image/png;base64,cXVlc3Q=');
  });
  it('does not let an old session response replace a newly prepared recording',async()=>{
    let resolveOld!:(value:Session)=>void;backend.session.mockImplementationOnce(()=>new Promise<Session>(resolve=>{resolveOld=resolve;}));
    const user=await ready();await user.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button',{name:/Review Alpha/}));
    await user.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button',{name:'New recording'}));
    await act(async()=>resolveOld(newSession()));
    expect(screen.getByRole('heading',{level:1})).toHaveTextContent('New recording');
    expect(screen.getByRole('button',{name:'Record'})).toBeEnabled();
  });
});
