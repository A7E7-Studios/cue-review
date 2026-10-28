import type { Project, Session, Transcript } from '../backend';

export const date = '2026-10-28T09:00:00.000Z';
export const sections: Project[] = [
  { id: 'interface', name: 'Interface', createdAt: date },
  { id: 'headset', name: 'Headset testing', createdAt: date },
];
export const sessions: Session[] = [
  { id: 'library', projectId: 'interface', name: 'Library selection and details', createdAt: date, durationMs: 134000, status: 'ready' },
  { id: 'empty', projectId: 'interface', name: 'Empty states', createdAt: date, durationMs: 42000, status: 'ready' },
  { id: 'quest', projectId: 'headset', name: 'Quest navigation', createdAt: date, durationMs: 78000, status: 'ready' },
  { id: 'recent', projectId: null, name: 'A small adjustment to the toolbar', createdAt: date, durationMs: 31000, status: 'ready' },
];
export const transcript: Transcript = {
  segments: [
    { id: 'a', startMs: 0, endMs: 4000, text: 'The library feels clear and easy to navigate.', words: [] },
    { id: 'b', startMs: 5000, endMs: 11000, text: 'When I select this model, the details should update alongside it.', words: [
      { text: 'When I select', startMs: 5000, endMs: 6500 },
      { text: 'this model,', startMs: 6500, endMs: 8000 },
      { text: 'the details should update alongside it.', startMs: 8000, endMs: 11000 },
    ] },
    { id: 'c', startMs: 12000, endMs: 17000, text: 'The import action could be closer to the search field.', words: [] },
    { id: 'd', startMs: 19000, endMs: 23000, text: 'Everything else is working as expected.', words: [] },
  ],
};
export const previewImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="730" viewBox="0 0 1200 730"><rect width="1200" height="730" fill="#edf0f4"/><rect x="135" y="90" width="930" height="550" rx="12" fill="#fff" stroke="#dce0e6"/><text x="177" y="146" font-family="sans-serif" font-size="22" fill="#343b48">Library</text><rect x="177" y="172" width="846" height="1" fill="#e5e8ed"/><g fill="#f3f5f8" stroke="#e0e5ec"><rect x="177" y="205" width="260" height="225" rx="6"/><rect x="470" y="205" width="260" height="225" rx="6"/><rect x="763" y="205" width="260" height="225" rx="6"/></g><g fill="#aab5c8"><rect x="272" y="260" width="70" height="105" rx="8"/><circle cx="600" cy="310" r="50"/><path d="M850 362l40-105 40 105z"/></g><g font-family="sans-serif" font-size="15" fill="#626d7e"><text x="177" y="465">Component library</text><text x="470" y="465">Preview options</text><text x="763" y="465">Import assets</text><text x="177" y="578" font-size="13">Illustrative preview · no screen or microphone access</text></g></svg>`);
