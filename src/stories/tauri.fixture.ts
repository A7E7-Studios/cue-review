// Storybook's Vite configuration is the only consumer of this native guard.
export const isTauri = () => false;
export const invoke = async (): Promise<never> => { throw new Error('Native commands are disabled in the UI workshop.'); };
export const convertFileSrc = (path: string) => path;
export class Channel<T> { onmessage?: (message: T) => void; }
