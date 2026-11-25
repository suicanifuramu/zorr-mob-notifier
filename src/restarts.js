// Server restart display helpers. Restart announcements carry one map list per
// region; the map badges follow the in-game gallery order rather than the
// arbitrary order used in each Discord embed.

export const MAP_ORDER = ['Plains', 'Desert', 'Ocean', 'Jungle', 'Arctic', 'Bio', 'Void', 'Hel', 'Sewers', 'Jurassic'];
export const REGION_ORDER = ['AS', 'US', 'EU'];
const mapRank = new Map(MAP_ORDER.map((name, index) => [name.toLowerCase(), index]));
const regionRank = new Map(REGION_ORDER.map((name, index) => [name, index]));

export function isRestart(event) {
  return event?.type === 'restart';
}

function canonicalMap(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return MAP_ORDER.find(name => name.toLowerCase() === raw.toLowerCase()) || raw;
}

function compareMaps(a, b) {
  const ai = mapRank.get(a.toLowerCase()), bi = mapRank.get(b.toLowerCase());
  if (ai !== undefined && bi !== undefined) return ai - bi;
  if (ai !== undefined) return -1;
  if (bi !== undefined) return 1;
  return a.localeCompare(b);
}

function compareRegions(a, b) {
  const ai = regionRank.get(a), bi = regionRank.get(b);
  if (ai !== undefined && bi !== undefined) return ai - bi;
  if (ai !== undefined) return -1;
  if (bi !== undefined) return 1;
  return a.localeCompare(b);
}

export function validRestart(event) {
  if (!isRestart(event) || typeof event.key !== 'string' || !event.key) return false;
  if (!Number.isFinite(Date.parse(event.createdAt || ''))) return false;
  if (!event.servers || typeof event.servers !== 'object' || Array.isArray(event.servers)) return false;
  let maps = 0;
  for (const [region, names] of Object.entries(event.servers)) {
    if (typeof region !== 'string' || !region || !Array.isArray(names)) return false;
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim() || name.length > 40) return false;
      maps++;
    }
  }
  return maps > 0;
}

export function restartCount(event) {
  const total = Object.values(event?.servers || {}).reduce((sum, names) => sum + (Array.isArray(names) ? names.length : 0), 0);
  const count = Number(event?.count);
  return Number.isInteger(count) && count > 0 && count <= 10000 ? count : total;
}

export function restartRegions(event) {
  return Object.keys(event?.servers || {}).map(region => String(region).toUpperCase()).sort(compareRegions);
}

export function restartMaps(event) {
  const maps = new Set();
  for (const names of Object.values(event?.servers || {}))
    for (const name of names || []) {
      const map = canonicalMap(name);
      if (map) maps.add(map);
    }
  return [...maps].sort(compareMaps);
}

export function restartMapRows(event) {
  const rows = new Map();
  for (const [region, names] of Object.entries(event?.servers || {})) {
    const label = String(region).toUpperCase();
    for (const name of names || []) {
      const map = canonicalMap(name);
      if (!map) continue;
      if (!rows.has(map)) rows.set(map, new Set());
      rows.get(map).add(label);
    }
  }
  return [...rows].map(([map, regions]) => ({ map, regions: [...regions].sort(compareRegions) }))
    .sort((a, b) => compareMaps(a.map, b.map));
}

// Combine the most recent restart per map and region. A later single-region
// announcement must not hide the other regions that restarted just before it:
// Plains AS (new) and Plains US/EU (older) become one row with three regions.
export function restartMapSummary(restarts, { now = Date.now(), windowMs = 7 * 86400000 } = {}) {
  const rows = new Map();
  for (const event of Array.isArray(restarts) ? restarts : []) {
    if (!validRestart(event)) continue;
    const time = Date.parse(event.createdAt);
    if (now - time > windowMs) continue;
    for (const [region, names] of Object.entries(event.servers)) {
      const label = String(region).toUpperCase();
      for (const name of names) {
        const map = canonicalMap(name);
        if (!map) continue;
        if (!rows.has(map)) rows.set(map, { map, regions: new Map() });
        const regions = rows.get(map).regions;
        const previous = regions.get(label);
        if (!previous || Date.parse(previous.createdAt) < time)
          regions.set(label, { createdAt: event.createdAt, sourceUrl: event.sourceUrl || '' });
      }
    }
  }
  return [...rows.values()].map(({ map, regions }) => {
    const ordered = [...regions.keys()].sort(compareRegions);
    const times = Object.fromEntries(ordered.map(region => [region, regions.get(region).createdAt]));
    const createdAt = ordered.map(region => regions.get(region).createdAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return { map, regions: ordered, createdAt, regionTimes: times };
  }).sort((a, b) => compareMaps(a.map, b.map));
}

function compareRestarts(a, b) {
  const time = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (time) return time;
  const sequence = (Number(b.sequence) || 0) - (Number(a.sequence) || 0);
  return sequence || String(a.key).localeCompare(String(b.key));
}

export function latestRestarts(list, limit = 100) {
  return (Array.isArray(list) ? list : []).filter(validRestart).sort(compareRestarts).slice(0, Math.max(1, limit));
}

// Upsert a live restart by stable message key. An edited announcement may add
// regions or maps, but older revisions must not replace the projection.
export function mergeRestart(list, event, { limit = 100 } = {}) {
  if (!validRestart(event)) return { restarts: list, action: 'ignored' };
  const index = list.findIndex(item => item.key === event.key);
  const sequence = Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : 0;
  if (index < 0)
    return { restarts: [...list, event].sort(compareRestarts).slice(0, Math.max(1, limit)), action: 'insert' };
  const existing = list[index];
  const previous = Number.isSafeInteger(existing.sequence) && existing.sequence > 0 ? existing.sequence : 0;
  if (previous && sequence && sequence <= previous) return { restarts: list, action: 'stale' };
  const next = list.slice();
  next[index] = { ...existing, ...event, key: existing.key };
  return { restarts: next.sort(compareRestarts).slice(0, Math.max(1, limit)), action: 'update' };
}

export function relativeAge(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours % 24) parts.push(`${hours % 24}h`);
  if (minutes % 60) parts.push(`${minutes % 60}m`);
  if (!parts.length) parts.push(`${minutes}m`);
  return `${parts.join('')} ago`;
}

export function restartTitle(event) {
  const count = restartCount(event);
  return count === 1 ? '1 server restarted' : `${count} servers restarted`;
}

export function restartBody(event) {
  const regions = restartRegions(event), maps = restartMaps(event);
  return [regions.join('/'), maps.join(', ')].filter(Boolean).join(' · ');
}
