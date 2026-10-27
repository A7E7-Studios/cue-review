import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(()=>{cleanup();localStorage.clear();});
Element.prototype.scrollIntoView=vi.fn();
Object.defineProperty(HTMLMediaElement.prototype,'play',{configurable:true,value:vi.fn().mockResolvedValue(undefined)});
Object.defineProperty(HTMLMediaElement.prototype,'pause',{configurable:true,value:vi.fn()});
