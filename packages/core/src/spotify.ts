import { browserUserAgent } from "./fingerprint";
import { asUrl, filename, number, object, PostfetchError, string, type Json, type PlatformResult, type ResolveContext, type SpotifyExtra } from "./internal";
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
  const youtubeUrl = await matchYoutube(input, track);
  // Keep YouTube's media, filenames, separate audio and client fallback intact.
  const youtube = await resolveYoutube({ ...input, url: youtubeUrl });
  return {
    archiveFilename: filename(`spotify_${id}.zip`),
    comments: [],
    id,
    items: youtube.items,
    platform: "spotify",
    metadata: {
      title: track.title,
      author: { name: track.artists.join(", ") },
      extra: { artists: track.artists, durationSeconds: track.durationSeconds, youtubeUrl },
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

async function matchYoutube(input: ResolveContext, track: Track): Promise<string> {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", `${track.artists.join(" ")} ${track.title} audio`);
  url.searchParams.set("hl", "en");
  const response = await input.net(url.href, {
    headers: { "accept-language": "en-US,en;q=0.9", cookie: "SOCS=CAI", "user-agent": browserUserAgent() },
  });
  if (!response.ok) {
    throw new PostfetchError(502, `YouTube search failed: ${response.status}`);
  }
  const html = await response.text();
  // Read the JSON assignment up to the end of its script, without evaluating JS.
  // The balanced JSON object is extracted before parsing; trailing JS is ignored.
  const raw = html.match(/(?:\bytInitialData|window\[["']ytInitialData["']\])\s*=\s*(\{[\s\S]*?)<\/script>/)?.[1];
  const payload = parseAssignment(raw);
  if (!payload || !object(payload.contents)) {
    throw new PostfetchError(502, "YouTube search results not found");
  }
  const candidates = videoRenderers(payload.contents);
  const ranked = candidates.map((candidate, index) => ({ candidate, score: matchScore(track, candidate) - index / 1000 }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score);
  const id = ranked[0]?.candidate.videoId;
  if (typeof id !== "string") {
    throw new PostfetchError(404, "No matching YouTube video found for this Spotify track", "notFound");
  }
  return `https://www.youtube.com/watch?v=${id}`;
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

function durationSeconds(value: string): number | null {
  if (!/^\d+(?::\d{2}){1,2}$/.test(value)) return null;
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function matchScore(track: Track, candidate: Json): number {
  if (typeof candidate.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(candidate.videoId)) return -Infinity;
  const title = normalize(text(candidate.title));
  const author = normalize(text(candidate.ownerText) || text(candidate.longBylineText) || text(candidate.shortBylineText));
  const expected = normalize(track.title.replace(/\s*[([](?:feat\.?|ft\.?).*?[)\]]/gi, ""));
  const tokens = expected.split(" ").filter(Boolean);
  if (tokens.length === 0) return -Infinity;
  const coverage = tokens.filter((token) => contains(title, token)).length / tokens.length;
  if (coverage < (tokens.length <= 3 ? 1 : 0.8)) return -Infinity;
  if (tokens.length <= 3 && !contains(title, expected)) return -Infinity;
  const artists = track.artists.map(normalize);
  if (!contains(`${title} ${author}`, artists[0])) return -Infinity;
  const duration = durationSeconds(text(candidate.lengthText));
  if (duration === null || duration <= 0) return -Infinity; // Excludes live streams and upcoming videos.
  const tolerance = Math.min(30, Math.max(12, (track.durationSeconds ?? duration) * 0.08));
  const delta = track.durationSeconds === undefined ? 0 : Math.abs(duration - track.durationSeconds);
  if (delta > tolerance) return -Infinity;
  // Do not silently substitute a different recording or speed edit. Artist names
  // are removed first so e.g. a band called "Live" is not treated as a live edit.
  let recordingTitle = title;
  for (const artist of artists) recordingTitle = recordingTitle.replace(artist, "");
  for (const version of [/\bremix\b/, /\bcover\b/, /\bkaraoke\b/, /\binstrumental\b/, /\bslowed\b/, /\b(?:sped|speed) up\b/, /\bnightcore\b/, /\blive\b/, /\bacoustic\b/]) {
    if (version.test(recordingTitle) !== version.test(expected)) return -Infinity;
  }
  const artistUpload = contains(author, artists[0]);
  const credited = artists.filter((artist) => contains(`${title} ${author}`, artist)).length / artists.length;
  return coverage * 10 + (artistUpload ? 8 : 0) + credited * 2 + (contains(title, "official") ? 2 : 0) + 3 * (1 - delta / tolerance);
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
