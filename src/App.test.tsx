import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Marker, Project, RecordingStatus, Session, SetupStatus, Transcript } from './backend';

const mocks=vi.hoisted(()=>({backend:{projects:vi.fn(),sessions:vi.fn(),session:vi.fn(),transcript:vi.fn(),markers:vi.fn(),setup:vi.fn(),status:vi.fn(),sources:vi.fn(),microphones:vi.fn(),preview:vi.fn(),createProject:vi.fn(),renameProject:vi.fn(),renameSession:vi.fn(),moveSession:vi.fn(),start:vi.fn(),stop:vi.fn(),addMarker:vi.fn(),handoff:vi.fn(),openFolder:vi.fn(),mute:vi.fn(),retry:vi.fn(),installTranscription:vi.fn()},setTheme:vi.fn().mockResolvedValue(undefined),setAlwaysOnTop:vi.fn().mockResolvedValue(undefined),setSize:vi.fn().mockResolvedValue(undefined),setMinSize:vi.fn().mockResolvedValue(undefined)}));
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
  backend.sessions.mockImplementation(async(projectId?:string|null)=>sessions.filter(item=>!projectId||item.projectId===projectId).map(item=>({...item})));
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
  backend.moveSession.mockImplementation(async(id:string,projectId:string|null)=>{sessions=sessions.map(item=>item.id===id?{...item,projectId}:item);return sessions.find(item=>item.id===id)!;});
  backend.start.mockImplementation(async(projectId:string|null)=>{const session={...newSession('s2'),projectId,name:'New recording',autoTitle:true,status:'recording' as const};sessions.push(session);status={state:'recording',sessionId:'s2',elapsedMs:3000,audioLevel:.4};return session;});
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
type TestUser=ReturnType<typeof userEvent.setup>;
async function chooseMicrophone(user:TestUser,id:string) {
  const name=id==='mic2'?'Headset microphone':id==='mic1'?'Studio microphone':'No microphone';
  await user.click(within(screen.getByRole('group',{name:'Microphone options'})).getByRole('button',{name}));
}
async function chooseSource(user:TestUser,name:string) {
  await user.click(within(screen.getByRole('group',{name:'Capture sources'})).getByRole('button',{name}));
}

describe('keyboard interaction',()=>{
  it('opens device choices directly, focuses the selected option, and restores focus on Escape',async()=>{
    const user=await ready();
    const mic=screen.getByRole('button',{name:'Studio microphone'});
    await user.click(mic);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group',{name:'Microphone options'})).getByRole('button',{name:'Studio microphone'})).toHaveFocus();
    await user.keyboard('{Escape}');expect(mic).toHaveFocus();
    expect(screen.queryByRole('group',{name:'Microphone options'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await chooseSource(user,'Quest USB');
    expect(screen.queryByRole('group',{name:'Capture sources'})).not.toBeInTheDocument();
    await user.click(mic);await chooseMicrophone(user,'');
    expect(screen.queryByRole('group',{name:'Microphone options'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith(null,null,'quest1',null,false,false);
  });
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
    await user.click(screen.getByRole('button',{name:'Settings'}));
    screen.getByRole('button',{name:'Close settings'}).focus();
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Control>}r{/Control}');
    expect(await screen.findByRole('button',{name:'Stop'})).toBeEnabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
});

describe('project and session workflows',()=>{
  it('lets a first-time user record immediately without a project or a name',async()=>{
    projects=[];sessions=[];
    const user=await ready();
    expect(screen.queryByText('CueReview',{exact:true})).not.toBeInTheDocument();
    expect(await screen.findByRole('img',{name:'Live preview of Display 1'})).toBeVisible();
    expect(screen.queryByRole('textbox',{name:'Name'})).not.toBeInTheDocument();
    expect(screen.queryByText('Ready when you are')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Follow playback'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith(null,null,'display1','mic1',false,false);
  });
  it('lists all recordings in newest-first Recents regardless of optional projects',async()=>{
    sessions=[newSession(),{...newSession('s2'),projectId:null,name:'Recent ungrouped',createdAt:'2026-10-28T10:00:00Z'}];
    await ready();
    const sidebar=within(screen.getByLabelText('Projects and sessions'));
    expect(sidebar.getByRole('button',{name:'Recents'})).toHaveAttribute('aria-pressed','true');
    const buttons=sidebar.getAllByRole('button',{name:/Review Alpha|Recent ungrouped/});
    expect(buttons[0]).toHaveTextContent('Recent ungrouped');expect(buttons[1]).toHaveTextContent('Review Alpha');
    expect(backend.sessions).toHaveBeenCalledWith();
  });
  it('groups and ungroups an existing recording without changing its transcript',async()=>{
    sessions=[{...newSession(),projectId:null}];
    const user=await review();
    await user.click(screen.getByRole('button',{name:'Project: No project'}));
    await user.click(within(screen.getByRole('group',{name:'Project options'})).getByRole('button',{name:'Project Alpha'}));
    await screen.findByRole('button',{name:'Project: Project Alpha'});
    expect(backend.moveSession).toHaveBeenLastCalledWith('s1','p1');
    await user.click(screen.getByRole('button',{name:'Project: Project Alpha'}));
    await user.click(within(screen.getByRole('group',{name:'Project options'})).getByRole('button',{name:'No project'}));
    await screen.findByRole('button',{name:'Project: No project'});
    expect(backend.moveSession).toHaveBeenLastCalledWith('s1',null);
    expect(screen.getByRole('button',{name:'Seek to here at 0:02'})).toBeVisible();
  });
  it('keeps theme and settings available when the project sidebar is collapsed',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Collapse sidebar'}));
    await user.click(screen.getByRole('button',{name:'Use dark theme'}));
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByRole('button',{name:'Use light theme'})).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Settings'}));
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeVisible();
  });
  it('creates a project, keeps it selected, and renames it through the tree',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'New project'}));
    await user.type(screen.getByLabelText('Name'),'Beta product');await user.click(screen.getByRole('button',{name:'Save'}));
    await screen.findByRole('button',{name:'Project: Beta product'});
    expect(backend.createProject).toHaveBeenCalledWith('Beta product');
    await user.click(screen.getByRole('button',{name:'Rename project Beta product'}));
    await user.clear(screen.getByLabelText('Name'));await user.type(screen.getByLabelText('Name'),'Beta review');await user.click(screen.getByRole('button',{name:'Save'}));
    await screen.findByRole('button',{name:'Rename project Beta review'});
    expect(backend.renameProject).toHaveBeenCalledWith('p2','Beta review');
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith('p2',null,'display1','mic1',false,false);
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
  it('updates background completion and automatic names in Recents once while another recording is open',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    await user.click(screen.getByRole('button',{name:'Stop'}));await screen.findByRole('button',{name:'Transcribing…'});
    const sidebar=within(screen.getByLabelText('Projects and sessions'));
    await user.click(sidebar.getByRole('button',{name:/Review Alpha/}));
    await screen.findByRole('button',{name:'Seek to here at 0:02'});
    sessions=sessions.map(item=>item.id==='s2'?{...item,name:'Background transcript title',status:'ready'}:item);status={state:'idle'};
    const before=backend.sessions.mock.calls.length;
    await poll();
    expect(await sidebar.findByRole('button',{name:/Background transcript title/})).toBeVisible();
    expect(screen.getByRole('heading',{level:1})).toHaveTextContent('Review Alpha');
    expect(backend.sessions.mock.calls.length).toBe(before+1);
    await poll();expect(backend.sessions.mock.calls.length).toBe(before+1);
  });
  it('preserves no microphone on refresh and describes the resulting video-only recording honestly',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Studio microphone'}));
    await chooseMicrophone(user,'');await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    await user.click(screen.getByRole('button',{name:'Refresh capture devices'}));
    await waitFor(()=>expect(backend.microphones).toHaveBeenCalledTimes(2));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button',{name:'No microphone'})).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith(null,null,'display1',null,false,false);
    expect(screen.getByText('No audio',{exact:true})).toBeVisible();
    expect(screen.getByText('No audio input was selected for this recording.')).toBeVisible();
    expect(screen.queryByText('Listening… transcript updates in short batches.')).not.toBeInTheDocument();
  });
  it('preserves no microphone when restoring an active video-only recording before device enumeration',async()=>{
    sessions=[{...newSession(),status:'recording',microphoneId:undefined}];status={state:'recording',sessionId:'s1',elapsedMs:3000};
    render(<App/>);
    await screen.findByRole('button',{name:'Stop'});
    await waitFor(()=>expect(backend.microphones).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button',{name:'No microphone'})).toBeVisible();
  });
  it('describes device-only audio as post-recording transcription',async()=>{
    const user=await ready();
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    expect(screen.getByLabelText('Include system audio')).toBeVisible();
    await chooseSource(user,'Quest USB');
    await user.click(screen.getByRole('button',{name:'Quest USB'}));
    await user.click(screen.getByLabelText('Include device audio'));await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Studio microphone'}));
    await chooseMicrophone(user,'');await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(screen.getByText('Device audio is transcribed after recording.')).toBeVisible();
    expect(backend.start).toHaveBeenCalledWith(null,null,'quest1',null,true,false);
  });
  it('clears compact always-on-top mode on both manual restore and stopping',async()=>{
    const user=await ready();await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    await user.click(screen.getByRole('button',{name:'Compact'}));await screen.findByRole('button',{name:'Expand'});
    expect(mocks.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button',{name:'Expand'}));await screen.findByRole('button',{name:'Compact'});
    expect(mocks.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button',{name:'Compact'}));await screen.findByRole('button',{name:'Expand'});
    await user.click(screen.getByRole('button',{name:'Stop'}));await screen.findByRole('button',{name:'Transcribing…'});
    expect(mocks.setAlwaysOnTop.mock.calls.map(call=>call[0])).toEqual([true,false,true,false]);
  });
  it('explains missing transcription setup while still showing the actual recording state',async()=>{
    setup={ready:false,issues:['Local speech model is missing'],modelReady:false,dependencies:[]};
    const user=await ready();await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(screen.getByText('Transcription needs setup.')).toBeVisible();
    expect(screen.queryByText('Listening… transcript updates in short batches.')).not.toBeInTheDocument();
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
    await chooseSource(user,'Quest USB');
    await user.click(screen.getByRole('button',{name:'Quest USB'}));
    await user.click(screen.getByLabelText('Include device audio'));await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Studio microphone'}));
    await chooseMicrophone(user,'mic2');await user.click(screen.getByRole('button',{name:'Headset microphone'}));await user.click(screen.getByLabelText('Mute microphone'));await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Record'}));
    await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith(null,null,'quest1','mic2',true,true);
    expect(screen.getByText('Listening… transcript updates in short batches.')).toBeVisible();
    await user.click(screen.getByRole('button',{name:'Muted'}));await user.click(screen.getByLabelText('Mute microphone'));
    expect(backend.mute).toHaveBeenCalledWith(false);await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button',{name:'Stop'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Transcribing…'})).toBeDisabled());
    fireEvent.keyDown(window,{key:'r',ctrlKey:true});expect(backend.start).toHaveBeenCalledTimes(1);
    let completeTranscript!:(value:Transcript)=>void;
    backend.transcript.mockImplementationOnce(()=>new Promise<Transcript>(resolve=>{completeTranscript=resolve;}));
    sessions=sessions.map(item=>item.id==='s2'?{...item,name:'Details panel does not update',status:'ready'}:item);status={state:'idle'};
    await poll();
    await act(async()=>completeTranscript(transcript));
    expect(await screen.findByRole('button',{name:'Seek to here at 0:02'})).toBeVisible();
    expect(screen.getByRole('heading',{level:1})).toHaveTextContent('Details panel does not update');
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
  it('seeks and highlights an aligned word after leading silence instead of its coarse legacy interval',async()=>{
    sessions=[{...newSession(),durationMs:20000}];
    transcript={segments:[{id:'aligned',text:'When',startMs:0,endMs:1300,words:[{text:'When',startMs:0,endMs:1300,seekMs:10220}]}]};
    const user=await ready();await user.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button',{name:/Review Alpha/}));
    const word=await screen.findByRole('button',{name:'Seek to When at 0:10'});
    expect(word).not.toHaveAttribute('aria-current');
    const media=document.querySelector('video')!;
    media.currentTime=.7;fireEvent.timeUpdate(media);
    expect(word).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('button',{name:'Seek to 0:10'}));
    expect(media.currentTime).toBe(10.22);
    expect(word).toHaveAttribute('aria-current','true');
    media.currentTime=11;fireEvent.timeUpdate(media);
    expect(word).not.toHaveAttribute('aria-current');
    await user.click(word);
    expect(media.currentTime).toBe(10.22);
    expect(word).toHaveAttribute('aria-current','true');
  });
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
    expect(screen.getByRole('button',{name:'Transcribing…'})).toBeDisabled();
    sessions=[newSession()];transcript={segments:[{startMs:0,endMs:1000,text:'Restored',words:[{text:'Restored',startMs:0,endMs:1000}]}]};status={state:'idle'};
    await poll();expect(await screen.findByRole('button',{name:'Seek to Restored at 0:00'})).toBeVisible();
  });
});

describe('local setup recovery and request races',()=>{
  it.each(['mic2',''])('preserves a vanished microphone, blocks recording, and allows explicit recovery with %s',async(replacement)=>{
    const user=await ready();
    backend.microphones.mockResolvedValue([{id:'mic2',name:'Headset microphone'}]);
    await user.click(screen.getByRole('button',{name:'Display 1'}));
    await user.click(screen.getByRole('button',{name:'Refresh capture devices'}));
    await screen.findByRole('button',{name:'Microphone unavailable'});
    expect(screen.getByRole('button',{name:'Record'})).toBeDisabled();
    expect(screen.queryByRole('button',{name:'No microphone'})).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('selected microphone is unavailable');
    await user.click(screen.getByRole('button',{name:'Microphone unavailable'}));
    expect(within(screen.getByRole('group',{name:'Microphone options'})).getByRole('button',{name:'Previously selected microphone · unavailable'})).toHaveAttribute('aria-pressed','true');
    expect(screen.getByRole('button',{name:'Previously selected microphone · unavailable'})).toBeInTheDocument();
    expect(screen.getByText('Reconnect the selected microphone and refresh microphones, choose another input, or select No microphone.')).toBeVisible();
    await chooseMicrophone(user,replacement);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button',{name:'Record'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'Record'}));await screen.findByRole('button',{name:'Stop'});
    expect(backend.start).toHaveBeenCalledWith(null,null,'display1',replacement||null,false,false);
  });
  it('keeps Stop available when a restored recording microphone is unavailable',async()=>{
    sessions=[{...newSession(),status:'recording'}];status={state:'recording',sessionId:'s1',elapsedMs:3000};
    backend.microphones.mockResolvedValue([]);
    backend.stop.mockResolvedValue({...sessions[0],status:'processing'});
    const user=userEvent.setup();render(<App/>);
    await screen.findByRole('button',{name:'Microphone unavailable'});
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'Stop'}));
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });
  it('removes the last preview frame after a failed poll instead of presenting stale imagery as live',async()=>{
    await ready();
    expect(await screen.findByRole('img',{name:'Live preview of Display 1'})).toBeVisible();
    backend.preview.mockRejectedValue(new Error('Preview connection lost. Reconnect the selected device.'));
    expect(await screen.findByText('Preview connection lost. Reconnect the selected device.',{}, {timeout:2200})).toBeVisible();
    expect(screen.queryByRole('img',{name:'Live preview of Display 1'})).not.toBeInTheDocument();
  });
  it('allows selecting an offline device to read its recovery guidance without starting capture',async()=>{
    backend.sources.mockResolvedValue([{id:'display1',name:'Display 1',kind:'display',available:true},{id:'quest-offline',name:'Quest disconnected',kind:'quest',available:false,detail:'Reconnect the USB cable and authorize USB debugging on the headset, then refresh.'}]);
    const user=await ready();await user.click(screen.getByRole('button',{name:'Display 1'}));
    await chooseSource(user,'Quest disconnected · unavailable');
    expect(screen.getByRole('button',{name:'Quest disconnected'})).toBeVisible();
    expect(screen.getAllByText('Reconnect the USB cable and authorize USB debugging on the headset, then refresh.').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading',{name:'Capture source unavailable'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Record'})).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('authorize USB debugging');
  });
  it('keeps a vanished selected source unavailable instead of silently recording the first monitor',async()=>{
    const user=await ready();await user.click(screen.getByRole('button',{name:'Display 1'}));
    await chooseSource(user,'Quest USB');
    backend.sources.mockResolvedValue([{id:'display1',name:'Display 1',kind:'display',available:true}]);
    await user.click(screen.getByRole('button',{name:'Quest USB'}));
    await user.click(screen.getByRole('button',{name:'Refresh capture devices'}));
    await screen.findByRole('button',{name:'Previously selected source · unavailable'});
    expect(screen.getByRole('button',{name:'Previously selected source · unavailable'})).toHaveAttribute('aria-pressed','true');
    expect(screen.getByRole('heading',{name:'Capture source unavailable'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Record'})).toBeDisabled();
    expect(screen.queryByRole('img',{name:'Live preview of Display 1'})).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}r{/Control}');
    expect(backend.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect it and refresh');
  });
  it.each(['whisper-cli','whisper-vad-speech-segments'])('lets installation fail, retry, and recover when models exist but %s is absent',async(dependency)=>{
    setup={ready:false,issues:[`${dependency} is missing`],modelReady:true,dependencies:[{name:dependency,available:false}]};
    backend.installTranscription.mockRejectedValueOnce('Download failed. Check your connection and retry.').mockImplementationOnce(async()=>{setup={...readySetup};});
    const user=await ready();await user.click(screen.getByRole('button',{name:'Review setup'}));
    await user.click(screen.getByRole('button',{name:'Install transcription'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await user.click(screen.getByRole('button',{name:'Install transcription'}));
    expect(await screen.findByText('Ready to transcribe on this computer.')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Install transcription'})).not.toBeInTheDocument();
    expect(backend.installTranscription).toHaveBeenCalledTimes(2);
  });
  it('ignores an old source preview that arrives after the user selects another source',async()=>{
    let resolveOld!:(value:string)=>void;
    backend.preview.mockImplementation((sourceId:string)=>sourceId==='display1'?new Promise<string>(resolve=>{resolveOld=resolve;}):Promise.resolve('data:image/png;base64,cXVlc3Q='));
    const user=await ready();await user.click(screen.getByRole('button',{name:'Display 1'}));await chooseSource(user,'Quest USB');
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
