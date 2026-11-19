import type { AudioTrack, Project, Segment, Session, SpeechLanguage, Transcript } from '../backend';

export const date = '2026-10-28T09:00:00.000Z';
export const sections: Project[] = [
  { id: 'interface', name: 'Interface', createdAt: date },
  { id: 'headset', name: 'Headset testing', createdAt: date },
];
/** The speech model's 99 languages as `get_languages` serves them: whisper.cpp's order, English names. */
export const SPEECH_LANGUAGES: SpeechLanguage[] = [
  { code: 'en', name: 'English' }, { code: 'zh', name: 'Chinese' }, { code: 'de', name: 'German' }, { code: 'es', name: 'Spanish' }, { code: 'ru', name: 'Russian' },
  { code: 'ko', name: 'Korean' }, { code: 'fr', name: 'French' }, { code: 'ja', name: 'Japanese' }, { code: 'pt', name: 'Portuguese' }, { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' }, { code: 'ca', name: 'Catalan' }, { code: 'nl', name: 'Dutch' }, { code: 'ar', name: 'Arabic' }, { code: 'sv', name: 'Swedish' },
  { code: 'it', name: 'Italian' }, { code: 'id', name: 'Indonesian' }, { code: 'hi', name: 'Hindi' }, { code: 'fi', name: 'Finnish' }, { code: 'vi', name: 'Vietnamese' },
  { code: 'he', name: 'Hebrew' }, { code: 'uk', name: 'Ukrainian' }, { code: 'el', name: 'Greek' }, { code: 'ms', name: 'Malay' }, { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' }, { code: 'da', name: 'Danish' }, { code: 'hu', name: 'Hungarian' }, { code: 'ta', name: 'Tamil' }, { code: 'no', name: 'Norwegian' },
  { code: 'th', name: 'Thai' }, { code: 'ur', name: 'Urdu' }, { code: 'hr', name: 'Croatian' }, { code: 'bg', name: 'Bulgarian' }, { code: 'lt', name: 'Lithuanian' },
  { code: 'la', name: 'Latin' }, { code: 'mi', name: 'Maori' }, { code: 'ml', name: 'Malayalam' }, { code: 'cy', name: 'Welsh' }, { code: 'sk', name: 'Slovak' },
  { code: 'te', name: 'Telugu' }, { code: 'fa', name: 'Persian' }, { code: 'lv', name: 'Latvian' }, { code: 'bn', name: 'Bengali' }, { code: 'sr', name: 'Serbian' },
  { code: 'az', name: 'Azerbaijani' }, { code: 'sl', name: 'Slovenian' }, { code: 'kn', name: 'Kannada' }, { code: 'et', name: 'Estonian' }, { code: 'mk', name: 'Macedonian' },
  { code: 'br', name: 'Breton' }, { code: 'eu', name: 'Basque' }, { code: 'is', name: 'Icelandic' }, { code: 'hy', name: 'Armenian' }, { code: 'ne', name: 'Nepali' },
  { code: 'mn', name: 'Mongolian' }, { code: 'bs', name: 'Bosnian' }, { code: 'kk', name: 'Kazakh' }, { code: 'sq', name: 'Albanian' }, { code: 'sw', name: 'Swahili' },
  { code: 'gl', name: 'Galician' }, { code: 'mr', name: 'Marathi' }, { code: 'pa', name: 'Punjabi' }, { code: 'si', name: 'Sinhala' }, { code: 'km', name: 'Khmer' },
  { code: 'sn', name: 'Shona' }, { code: 'yo', name: 'Yoruba' }, { code: 'so', name: 'Somali' }, { code: 'af', name: 'Afrikaans' }, { code: 'oc', name: 'Occitan' },
  { code: 'ka', name: 'Georgian' }, { code: 'be', name: 'Belarusian' }, { code: 'tg', name: 'Tajik' }, { code: 'sd', name: 'Sindhi' }, { code: 'gu', name: 'Gujarati' },
  { code: 'am', name: 'Amharic' }, { code: 'yi', name: 'Yiddish' }, { code: 'lo', name: 'Lao' }, { code: 'uz', name: 'Uzbek' }, { code: 'fo', name: 'Faroese' },
  { code: 'ht', name: 'Haitian Creole' }, { code: 'ps', name: 'Pashto' }, { code: 'tk', name: 'Turkmen' }, { code: 'nn', name: 'Nynorsk' }, { code: 'mt', name: 'Maltese' },
  { code: 'sa', name: 'Sanskrit' }, { code: 'lb', name: 'Luxembourgish' }, { code: 'my', name: 'Myanmar' }, { code: 'bo', name: 'Tibetan' }, { code: 'tl', name: 'Tagalog' },
  { code: 'mg', name: 'Malagasy' }, { code: 'as', name: 'Assamese' }, { code: 'tt', name: 'Tatar' }, { code: 'haw', name: 'Hawaiian' }, { code: 'ln', name: 'Lingala' },
  { code: 'ha', name: 'Hausa' }, { code: 'ba', name: 'Bashkir' }, { code: 'jw', name: 'Javanese' }, { code: 'su', name: 'Sundanese' },
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

// "Library selection and details" after Record more, as in the Float v2 mocks:
// take 1 runs to 1:20 and take 2 adds 54 seconds.
export const takeTwoStartMs = 80000;
export const twoTakeSession: Session = {
  ...sessions[0], sourceId: 'monitor:1', microphoneId: 'microphone', systemAudio: false,
  // A Windows display id, as the session stored it at its first capture.
  sourceIdentity: { kind: 'display', device: '\\\\.\\DISPLAY1', left: 0, top: 0, right: 1920, bottom: 1080 },
  takes: [
    { index: 1, offsetMs: 0, durationMs: takeTwoStartMs, status: 'ready', folder: '.', microphoneId: 'microphone', systemAudio: false },
    { index: 2, offsetMs: takeTwoStartMs, durationMs: 54000, status: 'ready', folder: 'takes/2', sourceId: 'window:design', microphoneId: 'microphone', systemAudio: false },
  ],
  // No `videos`: the workshop has one sample video, so the session plays it for its whole timeline, as a joined session does.
};
const line = (id: string, startMs: number, endMs: number, text: string) => ({ id, startMs, endMs, text, words: [] });
export const twoTakeTranscript: Transcript = {
  status: 'complete', language: 'en',
  takes: [{ index: 1, startMs: 0 }, { index: 2, startMs: takeTwoStartMs }],
  segments: [
    line('segment-0', 0, 4000, 'The library feels clear and easy to navigate.'),
    line('segment-1', 5000, 11000, 'When I select this model, the details should update alongside it.'),
    line('segment-2', 12000, 17000, 'The import action could be closer to the search field.'),
    line('segment-3', 19000, 23000, 'Everything else is working as expected.'),
    line('segment-4', 24000, 30000, 'Now if I open the filters, the panel covers the first row of results.'),
    { id: 'segment-5', startMs: 31000, endMs: 36500, text: "I'd expect it to push the grid down instead of overlapping.", words: [
      { text: "I'd", startMs: 31000, endMs: 31400 }, { text: 'expect', startMs: 31400, endMs: 31900 }, { text: 'it', startMs: 31900, endMs: 32100 },
      { text: 'to', startMs: 32100, endMs: 32300 }, { text: 'push', startMs: 32300, endMs: 32700 }, { text: 'the', startMs: 32700, endMs: 32900 },
      { text: 'grid', startMs: 32900, endMs: 33600, seekMs: 33200 }, { text: 'down', startMs: 33600, endMs: 34100 }, { text: 'instead', startMs: 34100, endMs: 34800 },
      { text: 'of', startMs: 34800, endMs: 35000 }, { text: 'overlapping.', startMs: 35000, endMs: 36500 },
    ] },
    line('segment-6', 38000, 45000, 'The empty state just says “No items”. It should say how to add one.'),
    line('segment-7', 46000, 53000, 'Scrolling is smooth, but the header loses its shadow when you scroll back up.'),
    line('segment-8', 54000, 60000, 'Hovering a card shows the preview, which is great.'),
    line('segment-9', 62000, 69000, 'The preview takes a second to load, so a placeholder would help.'),
    line('segment-10', 70000, 78000, "Last thing: the import dialog doesn't remember the folder I used."),
    line('t2-segment-0', 81000, 86000, 'Picking this up again: the export dialog needs a progress state.'),
    line('t2-segment-1', 88000, 95000, 'The cancel button should stay available while it exports.'),
    line('t2-segment-2', 97000, 104000, 'And the finished toast could link straight to the file.'),
  ],
};
/** The backend's refusal when a window chosen in the recording bar has closed since it was listed (src-tauri/src/capture.rs). */
export const WINDOW_CLOSED = 'This window is no longer available';
// The same session while take 2 records, timed on the combined timeline: a finished stretch,
// then the words still being heard (the `live-` segment, see `Segment`).
export const takeTwoLiveTranscript: Transcript = {
  status: 'provisional',
  segments: [
    line('stretch-81000', 81000, 86000, 'Picking this up again: the export dialog needs a default folder.'),
    line('live-87000', 87000, 90000, 'Right now it always opens in Documents, and'),
  ],
};

// The same review spoken in German, then continued in English, as Auto transcribed it (the look's
// sample): each take carries the language it was detected in.
const GERMAN = [
  [0, 4000, 'Die Bibliothek wirkt klar und leicht zu bedienen.'],
  [5000, 11000, 'Wenn ich dieses Modell auswähle, sollten sich die Details daneben aktualisieren.'],
  [12000, 17000, 'Der Import könnte näher am Suchfeld sein.'],
  [19000, 23000, 'Alles andere funktioniert wie erwartet.'],
  [24000, 30000, 'Wenn ich jetzt die Filter öffne, verdeckt das Panel die erste Ergebniszeile.'],
  [31000, 36500, 'Ich würde erwarten, dass es das Raster nach unten schiebt, statt es zu überdecken.'],
  [38000, 45000, 'Der leere Zustand sagt nur „Keine Einträge“. Er sollte sagen, wie man einen anlegt.'],
  [46000, 53000, 'Das Scrollen ist flüssig, aber die Kopfzeile verliert beim Zurückscrollen ihren Schatten.'],
  [54000, 60000, 'Beim Überfahren einer Karte erscheint die Vorschau, das ist super.'],
  [62000, 69000, 'Die Vorschau braucht eine Sekunde, ein Platzhalter würde helfen.'],
  [70000, 78000, 'Letzter Punkt: Der Importdialog merkt sich den Ordner nicht.'],
] as const;
const germanTakeOne = GERMAN.map(([startMs, endMs, text], index) => line(`de-segment-${index}`, startMs, endMs, text));
export const germanTwoTakeTranscript: Transcript = {
  status: 'complete',
  takes: [{ index: 1, startMs: 0, language: 'de', languageDetected: true }, { index: 2, startMs: takeTwoStartMs, language: 'en', languageDetected: true }],
  segments: [...germanTakeOne, ...twoTakeTranscript.segments.filter(segment => segment.startMs >= takeTwoStartMs)],
};
/** One take transcribed as German because German was chosen in Settings. */
export const germanChosenTranscript: Transcript = { status: 'complete', language: 'de', segments: germanTakeOne };
/** Take 2 of the German session while it records under Auto, its language not decided yet. */
export const germanRecordingTranscript: Transcript = {
  takes: [{ index: 1, startMs: 0, language: 'de', languageDetected: true }],
  segments: [...germanTakeOne, ...takeTwoLiveTranscript.segments],
};

// A review over a call, recorded with the microphone and the computer's audio and transcribed from
// both (the both-audio-tracks look's sample): the call's rows are `system`, the reviewer's `microphone`.
/** A row whose words are spread evenly over it, so the spoken word moves with playback. */
function timed(id: string, startMs: number, endMs: number, text: string, track?: AudioTrack): Segment {
  const list = text.split(' ');
  const step = (endMs - startMs) / list.length;
  const words = list.map((word, at) => ({ text: word, startMs: Math.round(startMs + at * step), endMs: Math.round(startMs + (at + 1) * step) }));
  return track ? { id, startMs, endMs, text, words, track } : { id, startMs, endMs, text, words };
}
const CALL: [number, AudioTrack, string, string?][] = [
  [0, 'system', "Okay, I'm sharing the new library screen now.", 'Ich teile jetzt den neuen Bibliotheksbildschirm.'],
  [4, 'system', 'The left column lists the albums, and the grid shows the photos in the selected one.', 'Links stehen die Alben, daneben das Raster mit den Fotos des gewählten Albums.'],
  [11, 'system', 'Selecting a photo opens the details panel on the right.', 'Wenn man ein Foto auswählt, öffnet sich rechts das Detailfenster.'],
  [16, 'microphone', 'The details panel covers the last column of the grid.'],
  [21, 'microphone', "I'd expect the grid to shrink instead of being covered."],
  [27, 'system', 'Good point. It used to shrink before we added the filters.', 'Guter Punkt. Früher wurde das Raster schmaler, das war vor den Filtern.'],
  [33, 'system', 'Let me open the filters so you can see the problem.', 'Ich öffne mal die Filter, dann sieht man das Problem.'],
  [38, 'microphone', 'Now the panel and the filters both cover the grid.'],
  [43, 'system', 'Right, only one of them should be open at a time.', 'Stimmt, es sollte immer nur eins von beiden offen sein.'],
  [49, 'system', 'The export button is at the top right, next to search.', 'Der Export-Knopf ist oben rechts, neben der Suche.'],
  [54, 'microphone', 'Export should say how many photos it will include.'],
  [59, 'system', 'That number is in the dialog, but not on the button.', 'Die Zahl steht im Dialog, aber nicht auf dem Knopf.'],
  [64, 'microphone', 'Then put it on the button too.'],
];
const callRows = (german = false, shiftMs = 0, prefix = 'call') => CALL.map(([at, track, english, deutsch], index) =>
  timed(`${prefix}-${index}`, at * 1000 + shiftMs, at * 1000 + shiftMs + 4500, german && deutsch ? deutsch : english, track));
const ENGLISH = { language: 'en', languageDetected: true };
const GERMAN_DETECTED = { language: 'de', languageDetected: true };
/** A take transcribed from two tracks, both heard as English. */
export const twoTrackTranscript: Transcript = { status: 'complete', ...ENGLISH, trackLanguages: { system: ENGLISH, microphone: ENGLISH }, segments: callRows() };
/** On the word "grid" in the reviewer's second row. */
export const twoTrackSpokenMs = 22700;
/** The same call in German with the reviewer's remarks in English: Auto detected each track on its own. */
export const twoLanguageTranscript: Transcript = { ...twoTrackTranscript, trackLanguages: { system: GERMAN_DETECTED, microphone: ENGLISH }, segments: callRows(true) };
const RUN = [
  'The grid should keep its column count when the panel opens.', 'Right now it drops from five columns to three.', 'That moves every photo, so I lose my place.',
  'I would rather the panel overlay only the last column.', 'Or the panel could be narrower, about a third of the width.', 'The close button on the panel is very small.',
  'It is also too close to the scrollbar.', 'Escape should close the panel as well.', 'And the arrow keys should still move through the grid.', 'Those are the main points for this screen.',
];
/** Ten rows in a row from the microphone between the call's rows. */
export const runOfTenTranscript: Transcript = {
  ...twoTrackTranscript,
  segments: [...callRows().slice(0, 3), ...RUN.map((text, index) => timed(`run-${index}`, 16000 + index * 5000, 20500 + index * 5000, text, 'microphone')),
    timed('run-after', 66000, 70500, 'Good point. It used to shrink before we added the filters.', 'system')],
};
/** On "place." in the third row of the run. */
export const runOfTenSpokenMs = 30200;
/** Take 1 recorded with the microphone alone, take 2 with the computer's audio too. */
export const oneThenTwoTracksTranscript: Transcript = {
  status: 'complete',
  takes: [{ index: 1, startMs: 0, ...ENGLISH }, { index: 2, startMs: 24000, ...ENGLISH, trackLanguages: { system: ENGLISH, microphone: ENGLISH } }],
  segments: [
    timed('one-0', 0, 4000, 'The library feels clear and easy to navigate.'), timed('one-1', 5000, 11000, 'When I select this album the grid should update alongside it.'),
    timed('one-2', 12000, 17000, 'The import action could be closer to the search field.'), timed('one-3', 19000, 23000, 'Everything else is working as expected.'),
    ...callRows(false, 26000, 'two').slice(0, 9),
  ],
};
/** On "grid" in take 2's second microphone row. */
export const oneThenTwoTracksSpokenMs = 48700;
/** A first recording of the call while both tracks produce live words: one segment still being heard per track. */
export const twoTrackRecordingTranscript: Transcript = {
  status: 'provisional', ...ENGLISH, trackLanguages: { system: ENGLISH, microphone: ENGLISH },
  segments: [
    ...callRows(false, 0, 'stretch').slice(0, 10),
    { ...timed('live-system-59000', 59000, 62000, 'That number is in the dialog, but not on', 'system'), words: [] },
    { ...timed('live-microphone-61000', 61000, 63000, 'Then put it on the', 'microphone'), words: [] },
  ],
};
