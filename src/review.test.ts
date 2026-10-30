import { describe, expect, it } from 'vitest';
import { activeSegment, activeWord, errorMessage, findMatches, formatTime, formatTimer, playheadSegment, seekTime, segmentSeekMs, segmentText, transcriptItems, wordSeekMs } from './review';
import type { Segment } from './backend';
describe('transcript and video synchronization', () => {
  it('uses a bounded point highlight for alignment anchors without treating coarse raw bounds as speech',()=>{
    const anchored=[{text:'When',startMs:0,endMs:1300,seekMs:10220}];
    expect(wordSeekMs(anchored[0])).toBe(10220);
    expect(activeWord(anchored,0)).toBe(-1);
    expect(activeWord(anchored,1000)).toBe(-1);
    expect(activeWord(anchored,10220)).toBe(0);
    expect(activeWord(anchored,10401)).toBe(-1);
    expect(anchored[0].startMs).toBe(0);
    expect(anchored[0].endMs).toBe(1300);
  });
  it('selects anchored lines near the point even outside coarse segment bounds and leaves silence clear',()=>{
    const segments=[{startMs:0,endMs:1300,text:'When',words:[{text:'When',startMs:0,endMs:1300,seekMs:10220}]}];
    expect(segmentSeekMs(segments[0])).toBe(10220);
    expect(activeSegment(segments,0)).toBe(-1);
    expect(activeSegment(segments,10220)).toBe(0);
    expect(activeSegment(segments,11000)).toBe(-1);
  });
  it('places the playhead in the sentence it last passed during a pause, and nowhere before the first',()=>{
    const segments=[
      {startMs:0,endMs:1300,text:'When',words:[{text:'When',startMs:0,endMs:1300,seekMs:10220}]},
      {startMs:1300,endMs:2000,text:'then',words:[{text:'then',startMs:1300,endMs:2000,seekMs:12000}]},
    ];
    expect(playheadSegment(segments,0)).toBe(-1);
    expect(playheadSegment(segments,10220)).toBe(0);
    expect(playheadSegment(segments,11000)).toBe(0);
    expect(playheadSegment(segments,12000)).toBe(1);
    expect(playheadSegment(segments,60000)).toBe(1);
    expect(playheadSegment([],5000)).toBe(-1);
  });
  it('chooses the nearest overlapping anchor within a line and across adjacent lines',()=>{
    const words=[{text:'first',startMs:0,endMs:100,seekMs:10000},{text:'second',startMs:100,endMs:200,seekMs:10100}];
    expect(activeWord(words,10090)).toBe(1);
    expect(activeWord(words,10010)).toBe(0);
    const segments=words.map(word=>({startMs:word.startMs,endMs:word.endMs,text:word.text,words:[word]}));
    expect(activeSegment(segments,10090)).toBe(1);
    expect(activeSegment(segments,10010)).toBe(0);
  });
  it('preserves real legacy word intervals inside a segment containing other anchored words',()=>{
    const segment={startMs:0,endMs:2000,text:'Legacy aligned',words:[{text:'Legacy',startMs:1000,endMs:1400},{text:'aligned',startMs:0,endMs:1000,seekMs:10220}]};
    expect(activeWord(segment.words,1100)).toBe(0);
    expect(activeSegment([segment],1100)).toBe(0);
    expect(activeWord(segment.words,100)).toBe(-1);
    expect(activeSegment([segment],100)).toBe(-1);
    expect(activeWord(segment.words,10220)).toBe(1);
    expect(activeSegment([segment],10220)).toBe(0);
  });
  it('keeps old transcript seek and interval behavior when anchors are absent or invalid',()=>{
    const word={text:'Legacy',startMs:500,endMs:900};
    expect(wordSeekMs(word)).toBe(500);
    expect(wordSeekMs({...word,seekMs:NaN})).toBe(500);
    const segment={startMs:400,endMs:1000,text:'Legacy',words:[word]};
    expect(segmentSeekMs(segment)).toBe(400);
    expect(activeWord([word],600)).toBe(0);
    expect(activeSegment([segment],450)).toBe(0);
  });
  const words = [{text:'one', startMs:100,endMs:300}, {text:'two',startMs:500,endMs:800}];
  it('does not highlight a spoken word during silence or after its end', () => {
    expect(activeWord(words, 200)).toBe(0);
    expect(activeWord(words, 300)).toBe(-1);
    expect(activeWord(words, 400)).toBe(-1);
    expect(activeWord(words, 500)).toBe(1);
    expect(activeWord(words, 900)).toBe(-1);
  });
  it('selects the next segment at a shared boundary', () => {
    const segments = [{startMs:0,endMs:1000,text:'a',words:[]},{startMs:1000,endMs:2000,text:'b',words:[]}];
    expect(activeSegment(segments,1000)).toBe(1);
    expect(activeSegment(segments,2000)).toBe(-1);
  });
  it('clamps timestamp seeks to available video and rejects invalid values', () => {
    expect(seekTime(-500,2000)).toBe(0);
    expect(seekTime(2500,2000)).toBe(2000);
    expect(seekTime(NaN,2000)).toBe(0);
    expect(seekTime(500,NaN)).toBe(0);
    expect(formatTime(134000)).toBe('2:14');
  });
});
describe('takes and transcript layout', () => {
  const line = (startMs: number, text: string): Segment => ({ startMs, endMs: startMs + 1000, text, words: [] });
  const segments = [line(0, 'one'), line(5000, 'two'), line(81000, 'three'), line(90000, 'four')];
  it('formats the recording clock with leading minutes and hours after an hour', () => {
    expect(formatTimer(8000)).toBe('00:08');
    expect(formatTimer(754000)).toBe('12:34');
    expect(formatTimer(3723000)).toBe('1:02:03');
    expect(formatTimer(-1)).toBe('00:00');
    expect(formatTimer(NaN)).toBe('00:00');
  });
  it('puts a divider before the first segment of each later take and none for take 1', () => {
    expect(transcriptItems(segments, [{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }])).toEqual([
      { kind: 'segment', index: 0, live: false, tail: false },
      { kind: 'segment', index: 1, live: false, tail: false },
      { kind: 'divider', take: 2, startMs: 80000, live: false },
      { kind: 'segment', index: 2, live: false, tail: false },
      { kind: 'segment', index: 3, live: false, tail: false },
    ]);
  });
  it('keeps the divider of a take without speech at the end', () => {
    expect(transcriptItems(segments.slice(0, 2), [{ index: 2, startMs: 80000 }]).at(-1)).toEqual({ kind: 'divider', take: 2, startMs: 80000, live: false });
  });
  it('marks the recording take live, its last row as the tail, and shows its divider before it has words', () => {
    const items = transcriptItems(segments, [{ index: 1, startMs: 0 }, { index: 2, startMs: 80000 }], { index: 2, startMs: 80000 });
    expect(items.filter(item => item.kind === 'divider')).toEqual([{ kind: 'divider', take: 2, startMs: 80000, live: true }]);
    expect(items.slice(-2)).toEqual([{ kind: 'segment', index: 2, live: true, tail: false }, { kind: 'segment', index: 3, live: true, tail: true }]);
    expect(transcriptItems(segments.slice(0, 2), [], { index: 2, startMs: 80000 }).at(-1)).toEqual({ kind: 'divider', take: 2, startMs: 80000, live: true });
  });
  it('treats a first recording as one live take without a divider', () => {
    const items = transcriptItems(segments.slice(0, 2), undefined, { index: 1, startMs: 0 });
    expect(items).toEqual([{ kind: 'segment', index: 0, live: true, tail: false }, { kind: 'segment', index: 1, live: true, tail: true }]);
  });
  it('finds segments by their words or text, ignoring case and surrounding space', () => {
    const worded: Segment = { startMs: 0, endMs: 1000, text: 'stale text', words: [{ text: 'Push', startMs: 0, endMs: 500 }, { text: 'the grid', startMs: 500, endMs: 1000 }] };
    expect(segmentText(worded)).toBe('Push the grid');
    expect(findMatches([worded, line(2000, 'A grid view'), line(3000, 'Other')], '  GRID ')).toEqual([0, 1]);
    expect(findMatches([worded], 'stale')).toEqual([]);
    expect(findMatches([worded], '   ')).toEqual([]);
  });
});
describe('actionable backend errors', () => {
  it('preserves device and dependency recovery details', () => {
    expect(errorMessage('FFmpeg missing. Choose an executable in Settings.')).toContain('Choose an executable');
    expect(errorMessage(new Error('USB disconnected; reconnect your headset.'))).toContain('reconnect');
    expect(errorMessage({message:'Microphone unavailable'})).toBe('Microphone unavailable');
    expect(errorMessage(null)).toContain('try again');
  });
});
