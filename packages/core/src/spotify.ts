import { browserUserAgent } from "./fingerprint";
import { asUrl, filename, number, object, PostfetchError, string, type Json, type PlatformResult, type PostfetchResult, type ResolveContext, type SpotifyExtra } from "./internal";
import { resolveYoutube } from "./youtube";

type Track = { title: string; artists: string[]; durationSeconds?: number };

/** Resolve Spotify track metadata and a matching video through YouTube. */
export async function resolveSpotify(input: ResolveContext): Promise<PlatformResult<"spotify", SpotifyExtra>> {
  const url = asUrl(input.url);
  const id = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/([A-Za-z0-9]{22})\/?$/i)?.[1];
  if (!id) {
    throw new PostfetchError(400, "Spotify requires an open.spotify.com track URL");
  }
  const track = await spotifyTrack(input, id);
  const { youtube, youtubeUrl, liveFallback } = await matchingYoutube(input, track);
  return {
    archiveFilename: filename(`spotify_${id}.zip`),
    comments: [],
    id,
    items: youtube.items,
    platform: "spotify",
    metadata: {
      title: track.title,
      author: { name: track.artists.join(", ") },
      extra: {
        artists: track.artists, durationSeconds: track.durationSeconds, youtubeUrl,
        ...(liveFallback ? { youtubeLiveFallback: true } : {}),
      },
    },
  };
}

async function spotifyTrack(input: ResolveContext, id: string): Promise<Track> {
  const response = await input.net(`https://open.spotify.com/embed/track/${id}`, {
    headers: { "user-agent": browserUserAgent() },
  });
  if (!response.ok) {
    throw new PostfetchError(response.status === 404 ? 404 : 502, `Spotify track lookup failed: ${response.status}`);
  }
  const html = await response.text();
  const raw = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  const payload = parseJson(raw);
  const props = payload && object(payload.props) ? payload.props : null;
  const page = props && object(props.pageProps) ? props.pageProps : null;
  const state = page && object(page.state) ? page.state : null;
  const data = state && object(state.data) ? state.data : null;
  const entity = data && object(data.entity) ? data.entity : null;
  const title = entity && (string(entity.title) ?? string(entity.name));
  const artists = entity && Array.isArray(entity.artists)
    ? entity.artists.filter(object).map((artist) => string(artist.name)).filter((name): name is string => name !== null)
    : [];
  if (!entity || entity.type !== "track" || entity.id !== id || !title || artists.length === 0) {
    throw new PostfetchError(502, "Spotify track metadata not found");
  }
  const duration = number(entity.duration);
  return { title, artists, durationSeconds: duration !== null && duration > 0 ? duration / 1000 : undefined };
}

async function matchingYoutube(input: ResolveContext, track: Track): Promise<{ youtube: PostfetchResult; youtubeUrl: string; liveFallback: boolean }> {
  const quotedTitle = `"${track.title.replace(/"/g, "")}"`;
  const primaryQuery = `${track.artists.join(" ")} ${track.title} audio`;
  const queries = new Set([
    primaryQuery,
    `${track.artists[0]} ${quotedTitle}`,
    track.title,
    `${track.artists[0]} ${track.title.replace(/\s+/g, "")}`,
  ]);
  const attempted = new Set<string>();
  const live = new Map<string, number>();
  let resolutionError: unknown;
  let searchError: unknown;
  for (const query of queries) {
    let candidates: Json[];
    try {
      candidates = await searchYoutube(input, query);
    } catch (error) {
      // A failed primary search is a technical failure, not a missing match.
      if (query === primaryQuery) throw error;
      searchError = error;
      continue;
    }
    const originals = candidates.map((candidate, index) => ({
      candidate, score: matchScore(track, candidate) - index / 1000,
    })).filter(({ score }) => Number.isFinite(score)).sort((left, right) => right.score - left.score);
    for (const candidate of candidates) {
      if (Number.isFinite(matchScore(track, candidate))) continue;
      const score = matchScore(track, candidate, true);
      if (Number.isFinite(score)) {
        const url = `https://www.youtube.com/watch?v=${candidate.videoId}`;
        live.set(url, Math.max(live.get(url) ?? -Infinity, score));
      }
    }
    for (const { candidate } of originals) {
      const youtubeUrl = `https://www.youtube.com/watch?v=${candidate.videoId}`;
      if (attempted.has(youtubeUrl) || attempted.size >= 3) continue;
      attempted.add(youtubeUrl);
      try {
        // Keep YouTube's separate streams and client fallback intact for each upload.
        const youtube = await resolveYoutube({ ...input, url: youtubeUrl });
        return { youtube, youtubeUrl, liveFallback: false };
      } catch (error) {
        resolutionError = error;
      }
    }
  }
  // Try at most two live performances, after all searches for the original.
  const performances = [...live].sort((left, right) => right[1] - left[1]).slice(0, 2);
  for (const [youtubeUrl] of performances) {
    try {
      const youtube = await resolveYoutube({ ...input, url: youtubeUrl });
      return { youtube, youtubeUrl, liveFallback: true };
    } catch (error) {
      resolutionError = error;
    }
  }
  if (resolutionError) throw resolutionError;
  if (searchError) throw searchError;
  throw new PostfetchError(404, "No matching YouTube video found for this Spotify track", "noMatch");
}

async function searchYoutube(input: ResolveContext, query: string): Promise<Json[]> {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  url.searchParams.set("hl", "en");
  const response = await input.net(url.href, {
    headers: { "accept-language": "en-US,en;q=0.9", cookie: "SOCS=CAI", "user-agent": browserUserAgent() },
  });
  if (!response.ok) {
    throw new PostfetchError(502, `YouTube search failed: ${response.status}`);
  }
  const html = await response.text();
  // Read the JSON script or legacy assignment without evaluating JavaScript.
  // Assignment parsing balances the object and ignores trailing statements.
  const raw = html.match(/(?:\bytInitialData|window\[["']ytInitialData["']\])\s*=\s*(\{[\s\S]*?)<\/script>/)?.[1];
  const jsonScript = html.match(/<script\b[^>]*\bid=["']yt-initial-data["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  const payload = parseJson(jsonScript) ?? parseAssignment(raw);
  if (!payload || !object(payload.contents)) {
    throw new PostfetchError(502, "YouTube search results not found");
  }
  return videoRenderers(payload.contents);
}

function videoRenderers(value: unknown): Json[] {
  if (Array.isArray(value)) return value.flatMap(videoRenderers);
  if (!object(value)) return [];
  if (object(value.videoRenderer)) return [value.videoRenderer];
  return Object.values(value).flatMap(videoRenderers);
}

function text(value: unknown): string {
  if (!object(value)) return "";
  return string(value.simpleText) ?? (Array.isArray(value.runs)
    ? value.runs.filter(object).map((run) => typeof run.text === "string" ? run.text : "").join("")
    : "");
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function contains(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function artistMatches(value: string, artist: string): boolean {
  if (contains(value, artist)) return true;
  // Recognize long, vowel-free abbreviations such as Chkbns / Cheekbones.
  // Match whole words, never a short/common acronym or arbitrary edit distance.
  return /^[bcdfghjklmnpqrstvwxyz]{6,}$/.test(artist) && value.split(" ").some((word) =>
    /^[a-z]+$/.test(word) && word.replace(/[aeiou]/g, "") === artist
  );
}

function durationSeconds(value: string): number | null {
  if (!/^\d+(?::\d{2}){1,2}$/.test(value)) return null;
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

// Some auto-generated Topic channels transpose adjacent letters in an artist's
// name. Allow one such typo in a long word only, with every other word exact.
function topicArtistMatch(author: string, artist: string): boolean {
  if (!author.endsWith(" topic")) return false;
  const actual = author.slice(0, -6).trim().split(" ");
  const expected = artist.split(" ");
  if (actual.length !== expected.length) return false;
  let typos = 0;
  return expected.every((word, index) => {
    const candidate = actual[index];
    if (candidate === word) return true;
    if (word.length < 6 || candidate.length !== word.length || ++typos > 1) return false;
    for (let offset = 0; offset < word.length - 1; offset += 1) {
      const swapped = word.slice(0, offset) + word[offset + 1] + word[offset] + word.slice(offset + 2);
      if (candidate === swapped) return true;
    }
    return false;
  });
}

function matchScore(track: Track, candidate: Json, allowLive = false): number {
  if (typeof candidate.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(candidate.videoId)) return -Infinity;
  const title = normalize(text(candidate.title));
  const author = normalize(text(candidate.ownerText) || text(candidate.longBylineText) || text(candidate.shortBylineText));
  const trackTitle = track.title.replace(/\s*[([](?:feat\.?|ft\.?).*?[)\]]/gi, "");
  const expected = normalize(trackTitle);
  const artists = track.artists.map(normalize);
  const artistUpload = artistMatches(author, artists[0]) || topicArtistMatch(author, artists[0]);
  const credited = artists.map((artist, index) => artistMatches(`${title} ${author}`, artist) || (index === 0 && artistUpload));
  if (!credited[0]) return -Infinity;
  const tokens = expected.split(" ").filter(Boolean);
  if (tokens.length === 0) return -Infinity;
  let coverage = tokens.filter((token) => contains(title, token)).length / tokens.length;
  const joinedTitle = expected.replace(/ /g, "");
  const joinedMatch = tokens.length > 1 && joinedTitle.length >= 6 && contains(title, joinedTitle);
  if (joinedMatch) coverage = 1;
  if (coverage < (tokens.length <= 3 ? 1 : 0.8) || (tokens.length <= 3 && !contains(title, expected) && !joinedMatch)) {
    // A soundtrack title may prefix the song and its show/version with project
    // context, e.g. "Project: Subtitle - Song - Show". Require the complete
    // remaining phrase and every credited artist before accepting its omission.
    const parts = trackTitle.split(/\s+[-–—|]\s+/);
    if (parts.length < 3 || !parts[0].includes(":") || artists.length < 2 || !credited.every(Boolean) || !contains(title, normalize(parts.slice(1).join(" ")))) {
      return -Infinity;
    }
    coverage = 1;
  }
  const duration = durationSeconds(text(candidate.lengthText));
  if (duration === null || duration <= 0) return -Infinity; // Excludes live streams and upcoming videos.
  const tolerance = Math.min(30, Math.max(12, (track.durationSeconds ?? duration) * 0.08));
  const delta = track.durationSeconds === undefined ? 0 : Math.abs(duration - track.durationSeconds);
  if (delta > tolerance) return -Infinity;
  // Do not silently substitute a different recording or speed edit. Artist names
  // are removed first so e.g. a band called "Live" is not treated as a live edit.
  let recordingTitle = title;
  for (const artist of artists) recordingTitle = recordingTitle.replace(artist, "");
  const isLive = /\blive\b/.test(recordingTitle);
  const requestedLive = /\blive\b/.test(expected);
  if (isLive !== requestedLive && !(allowLive && isLive && !requestedLive)) return -Infinity;
  for (const version of [/\bremix\b/, /\bcover\b/, /\bkaraoke\b/, /\binstrumental\b/, /\bslowed\b/, /\b(?:sped|speed) up\b/, /\bnightcore\b/, /\bacoustic\b/]) {
    if (version.test(recordingTitle) !== version.test(expected)) return -Infinity;
  }
  const creditCoverage = credited.filter(Boolean).length / artists.length;
  return coverage * 10 + (artistUpload ? 8 : 0) + creditCoverage * 2 + (contains(title, "official") ? 2 : 0) + 3 * (1 - delta / tolerance);
}

function parseJson(value: string | undefined): Json | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseAssignment(value: string | undefined): Json | null {
  if (!value) return null;
  // Balance braces outside JSON strings so titles containing `};` cannot truncate
  // the payload, and trailing statements in the same script are ignored.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return parseJson(value.slice(0, index + 1));
  }
  return null;
}
