import axios from 'axios';
import baileysPackageJson from 'baileys/package.json';

export interface BaileysVersionInfo {
  current: string;
  latest: string | null;
  outdated: boolean;
  error?: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours - avoid hitting the npm registry on every request

let cache: { data: BaileysVersionInfo; fetchedAt: number } | null = null;

export const checkBaileysVersion = async (): Promise<BaileysVersionInfo> => {
  const current = baileysPackageJson.version;

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  try {
    const { data } = await axios.get('https://registry.npmjs.org/baileys/latest', { timeout: 5000 });
    const latest = data?.version as string;

    const result: BaileysVersionInfo = {
      current,
      latest: latest ?? null,
      outdated: !!latest && latest !== current,
    };

    cache = { data: result, fetchedAt: Date.now() };
    return result;
  } catch (error) {
    // Registry unreachable (offline/air-gapped deploy): don't fail the caller, just report unknown.
    return {
      current,
      latest: null,
      outdated: false,
      error: error?.message,
    };
  }
};
