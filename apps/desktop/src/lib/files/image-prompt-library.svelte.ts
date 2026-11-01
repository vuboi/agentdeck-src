import { getPref, setPref } from '../app/platform/prefs';

export type ImagePrompt = {
  id: string;
  prompt: string;
  createdAt: number;
};

const KEY = 'image.prompt-history';
const LIMIT = 100;

export async function loadImagePrompts(): Promise<ImagePrompt[]> {
  const saved = await getPref<ImagePrompt[]>(KEY);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((item): item is ImagePrompt => typeof item?.id === 'string' && typeof item?.prompt === 'string' && typeof item?.createdAt === 'number')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIMIT);
}

export async function saveImagePrompt(prompt: string): Promise<ImagePrompt[]> {
  const value = prompt.trim();
  if (!value) return loadImagePrompts();
  const current = await loadImagePrompts();
  const next: ImagePrompt[] = [{ id: crypto.randomUUID(), prompt: value, createdAt: Date.now() }, ...current].slice(0, LIMIT);
  await setPref(KEY, next);
  return next;
}

export async function removeImagePrompt(id: string): Promise<ImagePrompt[]> {
  const next = (await loadImagePrompts()).filter((item) => item.id !== id);
  await setPref(KEY, next);
  return next;
}
