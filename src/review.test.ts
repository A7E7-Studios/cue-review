import { describe, expect, it } from 'vitest';
import { activeSegment, activeWord, errorMessage, formatTime, seekTime } from './review';
describe('transcript and video synchronization', () => {
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
describe('actionable backend errors', () => {
  it('preserves device and dependency recovery details', () => {
    expect(errorMessage('FFmpeg missing. Choose an executable in Settings.')).toContain('Choose an executable');
    expect(errorMessage(new Error('USB disconnected; reconnect your headset.'))).toContain('reconnect');
    expect(errorMessage({message:'Microphone unavailable'})).toBe('Microphone unavailable');
    expect(errorMessage(null)).toContain('try again');
  });
});
