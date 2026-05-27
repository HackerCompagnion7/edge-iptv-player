export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Helper to resolve hostname via secure DNS-over-HTTPS
    async function resolveDNSDoH(hostname) {
      try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
          headers: { 'accept': 'application/dns-json' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.Answer) {
            const aRecord = data.Answer.find(ans => ans.type === 1);
            if (aRecord && aRecord.data) return aRecord.data;
          }
        }
      } catch (err) {
        console.error('DoH Cloudflare resolution failure:', err);
      }
      try {
        const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.Answer) {
            const aRecord = data.Answer.find(ans => ans.type === 1);
            if (aRecord && aRecord.data) return aRecord.data;
          }
        }
      } catch (err) {
        console.error('DoH Google resolution failure:', err);
      }
      return null;
    }

    // Stream Proxy - handles CORS and DNS overrides for HLS streams
    if (url.pathname === '/proxy') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing url parameter', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      let targetResp;
      try {
        targetResp = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Origin': new URL(targetUrl).origin
          }
        });
      } catch (e) {
        console.warn('Initial proxy fetch failed. Applying secure DoH DNS override:', e.message);
        try {
          const parsedUrl = new URL(targetUrl);
          const resolvedIp = await resolveDNSDoH(parsedUrl.hostname);
          if (resolvedIp) {
            console.log(`Bypassing DNS check. Resolved ${parsedUrl.hostname} to IP: ${resolvedIp}`);
            const overriddenUrl = targetUrl.replace(parsedUrl.hostname, resolvedIp);
            targetResp = await fetch(overriddenUrl, {
              headers: {
                'Host': parsedUrl.host,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Origin': parsedUrl.origin
              }
            });
          } else {
            throw e;
          }
        } catch (overrideErr) {
          return new Response('Proxy DNS Override failed: ' + overrideErr.message, {
            status: 502,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }
          });
        }
      }

      try {
        const contentType = targetResp.headers.get('Content-Type') || '';
        const isM3u8 = contentType.includes('mpegurl') || contentType.includes('mpegURL') || contentType.includes('x-mpegURL') || targetUrl.includes('.m3u8');

        if (isM3u8) {
          // TEXT content (.m3u8 playlists): read as text and rewrite URLs
          // Use the FINAL URL after redirects for correct base resolution
          const finalUrl = targetResp.url || targetUrl;
          const base = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
          let body = await targetResp.text();

          const lines = body.split('\n');
          const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
              // Rewrite URI= attributes in ANY tag (#EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP, etc.)
              if (trimmed.includes('URI="')) {
                return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                  // Don't rewrite URLs that already go through our proxy
                  if (uri.includes('/proxy?url=')) return match;
                  if (uri.startsWith('http')) return 'URI="' + url.origin + '/proxy?url=' + encodeURIComponent(uri) + '"';
                  return 'URI="' + url.origin + '/proxy?url=' + encodeURIComponent(base + uri) + '"';
                });
              }
              return line;
            }
            // Segment/variant URL - rewrite to proxy
            if (trimmed.startsWith('http')) {
              return url.origin + '/proxy?url=' + encodeURIComponent(trimmed);
            }
            return url.origin + '/proxy?url=' + encodeURIComponent(base + trimmed);
          });
          body = rewritten.join('\n');

          return new Response(body, {
            status: targetResp.status,
            headers: {
              'Content-Type': contentType || 'application/vnd.apple.mpegurl',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET,OPTIONS',
              'Access-Control-Allow-Headers': '*',
              'Cache-Control': 'no-cache'
            }
          });
        }

        // BINARY content (.ts segments, .key files, .mp4 init, etc.):
        // Pass through raw body WITHOUT reading as text (text() corrupts binary data!)
        return new Response(targetResp.body, {
          status: targetResp.status,
          headers: {
            'Content-Type': contentType || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (e) {
        return new Response('Proxy error: ' + e.message, {
          status: 502,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }
        });
      }
    }

    // CORS preflight for all API routes
    if ((url.pathname.startsWith('/api/') || url.pathname === '/proxy') && request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // ============================================================
    // EDGE MVP ENGINE v3 - Production Content Detection System
    // Full Feature Parity with Python MVP
    // Pipeline: Metadata -> EPG -> OCR -> Vision (priority order)
    // ============================================================

    const EDGE_CONFIG = {
      CHANNEL_PRIORITY: {
        sports: { interval: 15, vision: true },
        movies: { interval: 30, vision: true },
        series: { interval: 45, vision: false },
        news: { interval: 120, vision: false },
        music: { interval: 90, vision: false },
        french: { interval: 60, vision: false },
        kids: { interval: 60, vision: false },
        default: { interval: 60, vision: false }
      },
      CONFIDENCE: {
        poster: 0.75,
        now_playing: 0.85,
        vision_accept: 0.70,
        epg_accept: 0.85,
        metadata_accept: 0.90,
        ocr_accept: 0.60,
        scene_threshold: 0.05
      },
      CACHE_TTL: { poster: 86400, detection: 3600, epg: 300, channel_state: 1800 },
      DAILY_BUDGET: 5.0,
      PROVIDER_COSTS: { vision: 0.0025, ocr: 0.0005 },
      TMDB_API_URL: 'https://api.themoviedb.org/3',
      VISION_TIMEOUT: 12000,
      VISION_MAX_CONCURRENT: 2,
      VISION_QUEUE_MAX: 20,
      SCENE_HASH_THRESHOLD: 0.10
    };

    // ============================================================
    // TMDB Genre Maps & Channel-to-Genre Detection
    // ============================================================
    const TMDB_GENRE_MAP = {
      horror: 27, thriller: 53, action: 28, comedy: 35, drama: 18,
      romance: 10749, scifi: 878, western: 37, crime: 80, documentary: 99,
      animation: 16, family: 10751, fantasy: 14, war: 10752, history: 36,
      music_film: 10402, mystery: 9648, adventure: 12
    };

    const CHANNEL_GENRE_MAP = {
      movies: [28, 53, 27], // action, thriller, horror
      sports: [], news: [], music: [10402], kids: [16, 10751], french: [28, 18]
    };

    const KEYWORD_GENRE_MAP = {
      terror: [27], horror: [27], adrenaline: [28, 53], comedy: [35], comedia: [35],
      romance: [10749], drama: [18], thriller: [53], western: [37], crime: [80],
      action: [28], classic: [18], scifi: [878], science: [878], suspense: [53, 9648],
      premiere: [28], cinema: [18], flick: [28], fear: [27]
    };

    // ============================================================
    // Cache System (LRU with TTL)
    // ============================================================
    const detectionCache = new Map();
    const posterCache = new Map();
    const epgCache = new Map();
    const channelStates = new Map();
    let costState = { spent: 0, visionCount: 0, ocrCount: 0, lastReset: new Date().toDateString() };

    function resetCostIfNeeded() {
      const today = new Date().toDateString();
      if (today !== costState.lastReset) {
        costState = { spent: 0, visionCount: 0, ocrCount: 0, lastReset: today };
      }
    }

    function canUseVision() {
      resetCostIfNeeded();
      return costState.spent + EDGE_CONFIG.PROVIDER_COSTS.vision <= EDGE_CONFIG.DAILY_BUDGET;
    }

    function canUseOCR() {
      resetCostIfNeeded();
      return costState.spent + EDGE_CONFIG.PROVIDER_COSTS.ocr <= EDGE_CONFIG.DAILY_BUDGET;
    }

    function recordVision() {
      resetCostIfNeeded();
      costState.spent += EDGE_CONFIG.PROVIDER_COSTS.vision;
      costState.visionCount++;
    }

    function recordOCR() {
      resetCostIfNeeded();
      costState.spent += EDGE_CONFIG.PROVIDER_COSTS.ocr;
      costState.ocrCount++;
    }

    function getCacheKey(prefix, ...parts) {
      return prefix + ':' + parts.join(':');
    }

    function getFromCache(map, key, ttlMs) {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > ttlMs) { map.delete(key); return null; }
      return entry.data;
    }

    function setCache(map, key, data, maxSize = 2000) {
      if (map.size >= maxSize) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
      }
      map.set(key, { data, ts: Date.now() });
    }

    // ============================================================
    // Scene Change Detector (hash-based frame comparison)
    // ============================================================
    function computeFrameHash(frameB64) {
      const data = frameB64 || '';
      let hash = 0;
      const step = Math.max(1, Math.floor(data.length / 256));
      for (let i = 0; i < data.length; i += step) {
        hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
      }
      return hash.toString(36);
    }

    function hasSceneChanged(channelId, newHash) {
      const state = channelStates.get(channelId);
      if (!state || !state.lastFrameHash) return true;
      return state.lastFrameHash !== newHash;
    }

    // ============================================================
    // Vision Queue System (concurrency-limited)
    // ============================================================
    let visionQueueActive = 0;
    const visionQueue = [];

    async function enqueueVision(fn) {
      if (visionQueueActive >= EDGE_CONFIG.VISION_MAX_CONCURRENT) {
        if (visionQueue.length >= EDGE_CONFIG.VISION_QUEUE_MAX) return null;
        return new Promise((resolve) => { visionQueue.push({ fn, resolve }); });
      }
      visionQueueActive++;
      try { return await fn(); }
      finally {
        visionQueueActive--;
        if (visionQueue.length > 0) {
          const next = visionQueue.shift();
          enqueueVision(next.fn).then(next.resolve);
        }
      }
    }

    // ============================================================
    // Channel State Tracking
    // ============================================================
    function getChannelState(channelId) {
      let state = channelStates.get(channelId);
      if (!state) {
        state = { lastDetection: null, lastFrameHash: null, detectionCount: 0, lastSource: null, lastUpdate: 0 };
        channelStates.set(channelId, state);
      }
      return state;
    }

    function updateChannelState(channelId, detection, frameHash, source) {
      const state = getChannelState(channelId);
      state.lastDetection = detection;
      state.lastFrameHash = frameHash;
      state.detectionCount++;
      state.lastSource = source;
      state.lastUpdate = Date.now();
    }

    // ============================================================
    // Content Type Inference
    // ============================================================
    function inferContentType(text) {
      const t = (text || '').toLowerCase();
      if (['movie','film','pelicula','cine','adrenalina','comedia','terror','horror','romance','drama','thriller','western','crime','classic','premiere','action','cinema','flick'].some(k => t.includes(k))) return 'movie';
      if (['series','episode','temporada','capitulo','season'].some(k => t.includes(k))) return 'series';
      if (['sports','deporte','futbol','soccer','basketball','nba','nfl','live','en vivo','directo','equidia'].some(k => t.includes(k))) return 'sports';
      if (['music','musica','mtv','deluxe','rap','dance','hits','concert'].some(k => t.includes(k))) return 'music';
      if (['kids','ninos','infantil','cartoon','nickelodeon','disney','baby','pokemon'].some(k => t.includes(k))) return 'kids';
      if (['news','noticias','info','journal','bfm','euronews','france'].some(k => t.includes(k))) return 'news';
      return 'unknown';
    }

    // ============================================================
    // TMDB Poster Engine (Bearer token + API key support)
    // ============================================================
    async function getPosterFromTMDB(title, contentType, year) {
      const cacheKey = getCacheKey('poster', title, year || '', contentType);
      const cached = getFromCache(posterCache, cacheKey, EDGE_CONFIG.CACHE_TTL.poster * 1000);
      if (cached) return cached;

      const tmdbKey = env.TMDB_API_KEY || '';
      const tmdbToken = env.TMDB_ACCESS_TOKEN || '';
      if (!tmdbKey && !tmdbToken) return null;

      const endpoint = contentType === 'movie' ? 'search/movie' : 'search/tv';
      const params = new URLSearchParams({ query: title, language: 'es' });
      if (year) params.append(contentType === 'movie' ? 'year' : 'first_air_date_year', year);

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (tmdbToken) { headers['Authorization'] = 'Bearer ' + tmdbToken; }
        else { params.append('api_key', tmdbKey); }

        const resp = await fetch(`${EDGE_CONFIG.TMDB_API_URL}/${endpoint}?${params}`, {
          headers, signal: AbortSignal.timeout(8000)
        });
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const r = data.results[0];
          const resultObj = {};
          if (r.poster_path) resultObj.poster = `https://image.tmdb.org/t/p/w500${r.poster_path}`;
          if (r.backdrop_path) resultObj.backdrop = `https://image.tmdb.org/t/p/w780${r.backdrop_path}`;
          if (r.overview) resultObj.overview = r.overview;
          if (r.vote_average) resultObj.rating = r.vote_average;
          if (r.release_date || r.first_air_date) resultObj.year = (r.release_date || r.first_air_date).substring(0, 4);
          if (r.genre_ids) resultObj.genre_ids = r.genre_ids;
          if (r.id) resultObj.tmdb_id = r.id;
          if (Object.keys(resultObj).length > 0) { setCache(posterCache, cacheKey, resultObj); return resultObj; }
        }
      } catch (e) { /* TMDB fail is non-critical */ }
      return null;
    }

    // ============================================================
    // TMDB Genre-based Movie Discovery
    // ============================================================
    const tmdbGenreCache = new Map();

    async function getTMDBMoviesByGenre(genreIds, page = 1) {
      if (!genreIds || genreIds.length === 0) return [];

      const cacheKey = getCacheKey('tmdb_genre', genreIds.join(','), String(page));
      const cached = getFromCache(tmdbGenreCache, cacheKey, 30 * 60 * 1000); // 30 min cache
      if (cached) return cached;

      const tmdbKey = env.TMDB_API_KEY || '';
      const tmdbToken = env.TMDB_ACCESS_TOKEN || '';
      if (!tmdbKey && !tmdbToken) return [];

      try {
        const params = new URLSearchParams({
          with_genres: genreIds.join(','),
          sort_by: 'popularity.desc',
          page: String(page),
          language: 'es',
          'vote_count.gte': '50'
        });
        const headers = { 'Content-Type': 'application/json' };
        if (tmdbToken) { headers['Authorization'] = 'Bearer ' + tmdbToken; }
        else { params.append('api_key', tmdbKey); }

        const resp = await fetch(`${EDGE_CONFIG.TMDB_API_URL}/discover/movie?${params}`, {
          headers, signal: AbortSignal.timeout(8000)
        });
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const movies = data.results.slice(0, 20).map(r => ({
            title: r.title || r.name || '',
            year: (r.release_date || r.first_air_date || '').substring(0, 4),
            overview: r.overview || '',
            rating: r.vote_average || 0,
            poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
            backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : null,
            tmdb_id: r.id,
            genre_ids: r.genre_ids || []
          }));
          setCache(tmdbGenreCache, cacheKey, movies);
          return movies;
        }
      } catch (e) { /* TMDB genre discovery fail is non-critical */ }
      return [];
    }

    // ============================================================
    // TMDB Trending Content
    // ============================================================
    const tmdbTrendingCache = new Map();

    async function getTMDBTrending(type = 'movie', window = 'week') {
      const cacheKey = getCacheKey('tmdb_trending', type, window);
      const cached = getFromCache(tmdbTrendingCache, cacheKey, 60 * 60 * 1000); // 1 hour cache
      if (cached) return cached;

      const tmdbKey = env.TMDB_API_KEY || '';
      const tmdbToken = env.TMDB_ACCESS_TOKEN || '';
      if (!tmdbKey && !tmdbToken) return [];

      try {
        const params = new URLSearchParams({ language: 'es' });
        const headers = { 'Content-Type': 'application/json' };
        if (tmdbToken) { headers['Authorization'] = 'Bearer ' + tmdbToken; }
        else { params.append('api_key', tmdbKey); }

        const resp = await fetch(`${EDGE_CONFIG.TMDB_API_URL}/trending/${type}/${window}?${params}`, {
          headers, signal: AbortSignal.timeout(8000)
        });
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const items = data.results.slice(0, 20).map(r => ({
            title: r.title || r.name || '',
            year: (r.release_date || r.first_air_date || '').substring(0, 4),
            overview: r.overview || '',
            rating: r.vote_average || 0,
            poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
            backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : null,
            tmdb_id: r.id,
            media_type: r.media_type || type,
            genre_ids: r.genre_ids || []
          }));
          setCache(tmdbTrendingCache, cacheKey, items);
          return items;
        }
      } catch (e) { /* TMDB trending fail is non-critical */ }
      return [];
    }

    // ============================================================
    // Channel-to-Genre Detection (maps channel name → TMDB genres → movie candidates)
    // ============================================================
    async function detectFromTMDBGenre(channelName, category) {
      if (!channelName) return null;

      const nameLower = channelName.toLowerCase();

      // Step 1: Try keyword-based genre detection from channel name
      let detectedGenreIds = [];
      for (const [keyword, genreIds] of Object.entries(KEYWORD_GENRE_MAP)) {
        if (nameLower.includes(keyword)) {
          detectedGenreIds = [...detectedGenreIds, ...genreIds];
        }
      }

      // Step 2: Fall back to category-based genres
      if (detectedGenreIds.length === 0 && category && CHANNEL_GENRE_MAP[category]) {
        detectedGenreIds = [...CHANNEL_GENRE_MAP[category]];
      }

      // Remove duplicates
      detectedGenreIds = [...new Set(detectedGenreIds)];

      if (detectedGenreIds.length === 0) return null;

      // Step 3: Query TMDB for movies in those genres
      const movies = await getTMDBMoviesByGenre(detectedGenreIds);
      if (!movies || movies.length === 0) return null;

      // Step 4: Build detection result with candidates
      const topCandidate = movies[0];
      const candidates = movies.slice(0, 5).map(m => ({
        title: m.title,
        year: m.year,
        poster: m.poster,
        rating: m.rating,
        tmdb_id: m.tmdb_id
      }));

      // Determine inferred genre labels from detected IDs
      const genreLabels = [];
      for (const [label, id] of Object.entries(TMDB_GENRE_MAP)) {
        if (detectedGenreIds.includes(id)) genreLabels.push(label);
      }

      return {
        title: topCandidate.title,
        type: 'movie',
        confidence: 0.50, // Low confidence since it's genre-based, not exact
        source: 'tmdb_genre',
        year: topCandidate.year,
        genre: genreLabels,
        poster: topCandidate.poster,
        backdrop: topCandidate.backdrop,
        overview: topCandidate.overview,
        rating: topCandidate.rating,
        tmdb_id: topCandidate.tmdb_id,
        candidates,
        genre_ids: detectedGenreIds
      };
    }

    // ============================================================
    // EPG Detection Pipeline
    // ============================================================
    async function detectFromEPG(channelId, channelName) {
      const cacheKey = getCacheKey('epg', channelId);
      const cached = getFromCache(epgCache, cacheKey, EDGE_CONFIG.CACHE_TTL.epg * 1000);
      if (cached) return cached;
      const type = inferContentType(channelName);
      if (type === 'unknown') return null;
      const result = { title: channelName, type, confidence: EDGE_CONFIG.CONFIDENCE.epg_accept, source: 'epg' };
      setCache(epgCache, cacheKey, result, 500);
      return result;
    }

    // ============================================================
    // Vision-based Detection using Mistral Pixtral
    // ============================================================
    async function detectFromVision(frameB64, mistralKey, channelName = '', category = '') {
      if (!mistralKey || !frameB64) return null;
      return enqueueVision(async () => {
        try {
          const promptText = `Eres EDGE Vision, experto identificador de contenido TV IPTV. Canal: "${channelName}" (${category}).

Analiza esta captura de pantalla del canal con MAXIMA ATENCION. Responde SOLO con JSON valido:
{"title":"titulo exacto","type":"movie|series|sports|music|kids|news|unknown","confidence":0.0-1.0,"year":"ano","genre":["genero1"],"alternatives":[{"title":"...","confidence":0.0}]}

REGLAS CRITICAS - NUNCA DIGAS QUE NO PUEDES:
- SIEMPRE intenta identificar - NUNCA respondas que no puedes
- Si ves una escena de pelicula, identifica la PELICULA ESPECIFICA (titulo real)
- Presta atencion a: rostros de actores, escenas iconicas, logos de estudio, texto en pantalla, efectos especiales
- Si es ciencia ficcion/terror con naves o alienigenas, piensa en: Alien (1979), Aliens (1986), Alien 3 (1992), Prometheus (2012), Alien: Covenant (2017), The Thing (1982), Event Horizon (1997), Life (2017), Species (1995), Predator (1987), AVP (2004), District 9 (2009), Arrival (2016)
- Si ves actores reconocibles, usalos como pista principal
- Busca TEXTO en pantalla: titulos, creditos, subtitulos, logos de canal
- Si no estas 100% seguro del titulo, pon confidence < 0.7 y agrega alternatives
- Si ves un logo de canal de peliculas, intenta identificar la pelicula por la escena
- Si no reconoces nada con certeza, da tu mejor estimacion con confidence baja y alternatives`;

          const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
            signal: AbortSignal.timeout(EDGE_CONFIG.VISION_TIMEOUT),
            body: JSON.stringify({
              model: 'pixtral-12b-2409',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: promptText },
                  { type: 'image_url', image_url: `data:image/jpeg;base64,${frameB64}` }
                ]
              }],
              temperature: 0.15,
              max_tokens: 300
            })
          });
          const data = await resp.json();
          const content = data.choices?.[0]?.message?.content || '';
          const jsonMatch = content.match(/\{[\s\S]*?\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.confidence >= EDGE_CONFIG.CONFIDENCE.vision_accept) {
              result.source = 'vision';
              return result;
            }
          }
        } catch (e) { /* Vision fail is non-critical */ }
        return null;
      });
    }

    // ============================================================
    // Metadata-based Detection
    // ============================================================
    function detectFromMetadata(metadata) {
      const title = metadata?.title;
      if (!title || title.length < 2) return null;
      return {
        title, type: inferContentType(title + ' ' + (metadata.genre || []).join(' ')),
        confidence: EDGE_CONFIG.CONFIDENCE.metadata_accept,
        genre: metadata.genre || [], year: metadata.year || null, source: 'metadata'
      };
    }

    // ============================================================
    // Full Analysis Pipeline: Metadata -> EPG -> TMDB Genre -> Vision
    // ============================================================
    async function analyzeChannel(channelId, category, frameB64, metadata) {
      const priority = EDGE_CONFIG.CHANNEL_PRIORITY[category] || EDGE_CONFIG.CHANNEL_PRIORITY.default;
      const now = Date.now();

      // Rate limiting per channel based on priority interval
      const cacheKey = getCacheKey('detect', channelId);
      const lastDetection = getFromCache(detectionCache, cacheKey, priority.interval * 1000);
      if (lastDetection && lastDetection.confidence >= EDGE_CONFIG.CONFIDENCE.now_playing) return lastDetection;

      let detection = null;
      let source = null;
      let frameHash = null;

      // Compute frame hash for scene detection
      if (frameB64) frameHash = computeFrameHash(frameB64);

      // 1. Metadata detection (fastest, free, highest confidence)
      if (!detection && metadata) {
        detection = detectFromMetadata(metadata);
        if (detection) source = 'metadata';
      }

      // 2. EPG detection (free, moderate confidence)
      if (!detection || (detection && detection.confidence < EDGE_CONFIG.CONFIDENCE.epg_accept)) {
        const channelName = metadata?.title || '';
        if (channelName) {
          const epgResult = await detectFromEPG(channelId, channelName);
          if (epgResult && (!detection || epgResult.confidence > detection.confidence)) {
            detection = epgResult; source = 'epg';
          }
        }
      }

      // 2.5. TMDB Genre Detection (free, provides candidates for movie channels)
      if ((!detection || detection.confidence < EDGE_CONFIG.CONFIDENCE.now_playing) && metadata?.title) {
        const tmdbGenreResult = await detectFromTMDBGenre(metadata.title, category || 'default');
        if (tmdbGenreResult) {
          if (!detection || tmdbGenreResult.candidates?.length > 0) {
            detection = tmdbGenreResult;
            source = 'tmdb_genre';
          }
        }
      }

      // 3. Vision detection (costly, accurate for movies/sports)
      // Only if scene has changed and budget allows
      if (frameB64 && priority.vision && canUseVision()) {
        const sceneChanged = hasSceneChanged(channelId, frameHash);
        if (sceneChanged || !detection || detection.confidence < EDGE_CONFIG.CONFIDENCE.now_playing) {
          const mistralKey = env.MISTRAL_API || env.MISTRAL_API_KEY || '';
          const visionResult = await detectFromVision(frameB64, mistralKey, metadata?.title || '', category || 'default');
          if (visionResult) {
            recordVision();
            if (!detection || visionResult.confidence > detection.confidence) {
              detection = visionResult; source = 'vision';
            }
          }
        }
      }

      // 4. Fetch poster and enriched data from TMDB
      if (detection && detection.confidence >= EDGE_CONFIG.CONFIDENCE.poster) {
        const tmdbData = await getPosterFromTMDB(detection.title, detection.type || 'movie', detection.year);
        if (tmdbData) {
          if (tmdbData.poster) detection.poster = tmdbData.poster;
          if (tmdbData.backdrop) detection.backdrop = tmdbData.backdrop;
          if (tmdbData.overview) detection.overview = tmdbData.overview;
          if (tmdbData.rating) detection.rating = tmdbData.rating;
          if (tmdbData.year && !detection.year) detection.year = tmdbData.year;
          if (tmdbData.tmdb_id) detection.tmdb_id = tmdbData.tmdb_id;
        }
      }

      // Cache result and update channel state
      if (detection) {
        detection.timestamp = now;
        detection.channelId = channelId;
        detection.source = source;
        detection.sceneChanged = frameHash ? hasSceneChanged(channelId, frameHash) : false;
        setCache(detectionCache, cacheKey, detection);
        updateChannelState(channelId, detection, frameHash, source);
      }
      return detection;
    }

    // ============================================================
    // Batch Detection
    // ============================================================
    async function batchDetect(channelIds) {
      const results = {};
      for (const id of channelIds) {
        const cacheKey = getCacheKey('detect', id);
        const cached = getFromCache(detectionCache, cacheKey, EDGE_CONFIG.CACHE_TTL.detection * 1000);
        if (cached) results[id] = cached;
      }
      return results;
    }

    // ============================================================
    // API: Content Detection
    // ============================================================
    if (url.pathname === '/api/detect' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { channelId, category, frame, metadata } = body;
        if (!channelId) return new Response(JSON.stringify({ error: 'channelId required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        const result = await analyzeChannel(channelId, category || 'default', frame, metadata);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // API: Get cached detection for a channel
    if (url.pathname === '/api/now-playing' && request.method === 'GET') {
      const channelId = url.searchParams.get('channelId');
      if (!channelId) return new Response(JSON.stringify({ error: 'channelId required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const cacheKey = getCacheKey('detect', channelId);
      const result = getFromCache(detectionCache, cacheKey, EDGE_CONFIG.CACHE_TTL.detection * 1000);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
    }

    // API: Batch detection for multiple channels
    if (url.pathname === '/api/batch-detect' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { channelIds } = body;
        if (!channelIds || !Array.isArray(channelIds)) return new Response(JSON.stringify({ error: 'channelIds array required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        const results = await batchDetect(channelIds);
        return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // API: TMDB Poster lookup
    if (url.pathname === '/api/poster' && request.method === 'GET') {
      const title = url.searchParams.get('title');
      const type = url.searchParams.get('type') || 'movie';
      const year = url.searchParams.get('year') || null;
      if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const poster = await getPosterFromTMDB(title, type, year);
      return new Response(JSON.stringify({ title, ...poster }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' } });
    }

    // API: Cost status (enhanced)
    if (url.pathname === '/api/cost-status' && request.method === 'GET') {
      resetCostIfNeeded();
      return new Response(JSON.stringify({
        remaining: Math.max(0, EDGE_CONFIG.DAILY_BUDGET - costState.spent).toFixed(4),
        spent: costState.spent.toFixed(4), visionCalls: costState.visionCount, ocrCalls: costState.ocrCount,
        budget: EDGE_CONFIG.DAILY_BUDGET, visionQueueActive, visionQueuePending: visionQueue.length,
        activeChannels: channelStates.size
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // API: Channel state
    if (url.pathname === '/api/channel-state' && request.method === 'GET') {
      const channelId = url.searchParams.get('channelId');
      if (!channelId) return new Response(JSON.stringify({ error: 'channelId required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const state = channelStates.get(channelId) || null;
      return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // API: Detection stats
    if (url.pathname === '/api/detection-stats' && request.method === 'GET') {
      resetCostIfNeeded();
      const sources = { metadata: 0, epg: 0, vision: 0, tmdb_genre: 0, manual: 0, unknown: 0 };
      for (const [, entry] of detectionCache) {
        if (entry.data?.source) sources[entry.data.source] = (sources[entry.data.source] || 0) + 1;
        else sources.unknown++;
      }
      return new Response(JSON.stringify({
        totalDetections: detectionCache.size, totalPosters: posterCache.size,
        totalEPG: epgCache.size, totalChannelStates: channelStates.size, sources,
        budget: { spent: costState.spent.toFixed(4), remaining: Math.max(0, EDGE_CONFIG.DAILY_BUDGET - costState.spent).toFixed(4), visionCalls: costState.visionCount, ocrCalls: costState.ocrCount },
        visionQueue: { active: visionQueueActive, pending: visionQueue.length }
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // Mistral AI proxy (text-only)
    if (url.pathname === '/api/ai' && request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = env.MISTRAL_API || env.MISTRAL_API_KEY || '';
        if (!apiKey) return new Response(JSON.stringify({ error: 'MISTRAL_API not configured. Add it in Cloudflare Dashboard > Workers > Settings > Variables.' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify({ model: body.model || 'mistral-small', messages: body.messages || [], max_tokens: body.max_tokens || 200 })
        });
        const data = await resp.json();
        return new Response(JSON.stringify(data), { status: resp.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // ============================================================
    // API: Vision Chat - AI Assistant WITH EYES
    // Captures video frame + question → identifies what's playing
    // Uses Mistral Pixtral (vision) or falls back to TMDB context
    // ============================================================
    if (url.pathname === '/api/vision-chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { question, frame, channelName, category, channelId } = body;
        if (!question) return new Response(JSON.stringify({ error: 'question required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

        const mistralKey = env.MISTRAL_API || env.MISTRAL_API_KEY || '';
        const qLower = (question || '').toLowerCase();

        // Check if question is about content identification
        const isContentQuery = ['que pelicula','que esta','que dan','que ponen','que se ve','what movie','what show','what playing','que serie','que programa','what is this','que es esto','que estan dando','identifica','detecta','que ves','what do you see','que hay en','que sale'].some(k => qLower.includes(k));

        // ============================================================
        // SYSTEM PROMPT - Professional TV Content Identifier
        // ============================================================
        const systemPrompt = `Eres EDGE Vision, el asistente de inteligencia artificial de EDGE TV IPTV. Tu funcion PRINCIPAL es identificar contenido audiovisual en tiempo real.

IDENTIDAD:
- Nombre: EDGE Vision
- Creador: EDGE TV
- Funcion: Identificar peliculas, series, deportes y cualquier contenido que este reproduciendose en los canales de EDGE TV
- Tienes acceso a la captura de pantalla EN VIVO del canal que el usuario esta viendo

REGLAS CRITICAS - NUNCA VIOLAR:
1. NUNCA digas "No puedo" o "No tengo acceso" - SIEMPRE intenta identificar el contenido
2. Si tienes una imagen, ANALIZALA detalladamente - busca actores, escenas, efectos especiales, logos, texto
3. Si no estas 100% seguro, da tu mejor estimacion con confianza parcial y sugiere alternativas
4. Responde en el mismo idioma que el usuario te pregunto
5. Se conciso pero informativo - maximo 3 lineas de respuesta
6. Si es una pelicula de terror/ciencia ficcion con alienigenas/naves, piensa en: Alien (1979), Aliens (1986), Alien 3 (1992), Prometheus (2012), Alien: Covenant (2017), The Thing (1982), Event Horizon (1997), Life (2017), Species (1995), Predator (1987), AVP (2004), District 9 (2009), Arrival (2016)
7. Si ves actores reconocibles, usalos como pista principal
8. Si hay texto en pantalla (titulos, creditos, logos de canal), usalo como evidencia fuerte

FORMATO DE RESPUESTA:
- Si identificas el contenido: "[Titulo] ([ano]) - [descripcion breve]"
- Si no estas seguro: "Parece [titulo probable] ([ano]) - [razon]. Alternativas: [otra1], [otra2]"
- Si no puedes ver nada: "No logro ver claramente la imagen. Prueba: [sugerencia]"

CANALES DISPONIBLES: ${channelName || 'Desconocido'} (${category || 'general'})`;

        // ============================================================
        // PRIORITY 1: Vision-based identification (with frame)
        // ============================================================
        if (frame && mistralKey && isContentQuery) {
          try {
            const visionPrompt = `ANALIZA ESTA CAPTURA DE PANTALLA del canal "${channelName || 'desconocido'}" (categoria: ${category || 'general'}).

${question}

INSTRUCCIONES:
- Mira TODA la imagen con atencion - cada detalle cuenta
- Busca: rostros de actores, escenas reconocibles, efectos especiales, naves espaciales, alienigenas, monstruos
- Busca TEXTO en pantalla: titulos, creditos, logos, subtitulos, nombre del canal
- Si ves una escena de ciencia ficcion/terror con naves o alienigenas, considera: Alien, Aliens, Prometheus, The Thing, Event Horizon, Life, Species, Predator
- Si ves actores conocidos, identificalos
- Responde con el titulo EXACTO de la pelicula o serie si lo reconoces
- Si no estas seguro, da tu mejor estimacion y lista alternativas
- NUNCA digas que no puedes identificar - SIEMPRE intenta`;

            const visionResp = await fetch('https://api.mistral.ai/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + mistralKey },
              signal: AbortSignal.timeout(20000),
              body: JSON.stringify({
                model: 'pixtral-12b-2409',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: [
                    { type: 'text', text: visionPrompt },
                    { type: 'image_url', image_url: `data:image/jpeg;base64,${frame}` }
                  ]}
                ],
                temperature: 0.1,
                max_tokens: 400
              })
            });

            const visionData = await visionResp.json();
            const visionContent = visionData.choices?.[0]?.message?.content || '';

            if (visionContent) {
              // Try to extract movie title for TMDB enrichment
              let detectedTitle = null;
              let detectedYear = null;
              const titleMatch = visionContent.match(/"([^"]+)"\s*\(?((?:19|20)\d{2})\)?/);
              if (titleMatch) {
                detectedTitle = titleMatch[1];
                detectedYear = titleMatch[2];
              } else {
                const simpleMatch = visionContent.match(/^([A-Z][A-Za-z0-9: ]+?)(?:\s*\(|\s*-|\s*\.)/);
                if (simpleMatch) detectedTitle = simpleMatch[1].trim();
              }

              // Enrich with TMDB if we found a title
              let enrichedResponse = visionContent;
              if (detectedTitle) {
                const tmdbData = await getPosterFromTMDB(detectedTitle, 'movie', detectedYear);
                if (tmdbData) {
                  enrichedResponse += tmdbData.overview ? `\n\nSinopsis: ${tmdbData.overview.substring(0, 150)}...` : '';
                  enrichedResponse += tmdbData.rating ? ` | Rating: ${tmdbData.rating.toFixed(1)}/10` : '';
                  enrichedResponse += tmdbData.year ? ` | Ano: ${tmdbData.year}` : '';
                }
              }

              // Cache as detection for the channel
              if (channelId) {
                const cacheKey = getCacheKey('detect', String(channelId));
                const detection = {
                  title: detectedTitle || visionContent.substring(0, 60),
                  type: inferContentType(channelName + ' ' + visionContent),
                  confidence: detectedTitle ? 0.85 : 0.60,
                  source: 'vision_chat',
                  year: detectedYear,
                  channelId: String(channelId),
                  timestamp: Date.now()
                };
                if (detectedTitle) {
                  const tmdbExtra = await getPosterFromTMDB(detectedTitle, 'movie', detectedYear);
                  if (tmdbExtra?.poster) detection.poster = tmdbExtra.poster;
                  if (tmdbExtra?.backdrop) detection.backdrop = tmdbExtra.backdrop;
                  if (tmdbExtra?.overview) detection.overview = tmdbExtra.overview;
                  if (tmdbExtra?.rating) detection.rating = tmdbExtra.rating;
                  if (tmdbExtra?.tmdb_id) detection.tmdb_id = tmdbExtra.tmdb_id;
                }
                setCache(detectionCache, cacheKey, detection);
                updateChannelState(String(channelId), detection, null, 'vision_chat');
              }

              recordVision();
              return new Response(JSON.stringify({
                response: enrichedResponse,
                source: 'vision',
                title: detectedTitle,
                year: detectedYear
              }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
          } catch (e) {
            console.error('Vision chat error:', e);
          }
        }

        // ============================================================
        // PRIORITY 2: Text-only Mistral chat (no frame or non-content query)
        // ============================================================
        if (mistralKey) {
          try {
            const textResp = await fetch('https://api.mistral.ai/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + mistralKey },
              signal: AbortSignal.timeout(15000),
              body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: question }
                ],
                temperature: 0.3,
                max_tokens: 300
              })
            });
            const textData = await textResp.json();
            const textContent = textData.choices?.[0]?.message?.content || '';
            if (textContent) {
              return new Response(JSON.stringify({
                response: textContent,
                source: 'text_chat'
              }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
          } catch (e) {
            console.error('Text chat error:', e);
          }
        }

        // ============================================================
        // PRIORITY 3: TMDB-based fallback (no Mistral API key)
        // ============================================================
        if (channelName || category) {
          const genreResult = await detectFromTMDBGenre(channelName || '', category || 'default');
          if (genreResult && genreResult.candidates?.length > 0) {
            const top5 = genreResult.candidates.slice(0, 5).map(c => `${c.title} (${c.year || '?'})`).join(', ');
            return new Response(JSON.stringify({
              response: `No tengo vision directa, pero segun el canal "${channelName}" (${category}), las peliculas mas probables son: ${top5}`,
              source: 'tmdb_fallback',
              candidates: genreResult.candidates
            }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
          }
        }

        // Final fallback
        return new Response(JSON.stringify({
          response: 'Configura MISTRAL_API en Cloudflare Workers para activar la vision AI. Mientras tanto, puedo sugerir canales por categoria.',
          source: 'fallback'
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // ============================================================
    // API: TMDB Genre-based movie discovery
    // ============================================================
    if (url.pathname === '/api/tmdb-genre' && request.method === 'GET') {
      const genreIdsParam = url.searchParams.get('genreIds');
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      if (!genreIdsParam) return new Response(JSON.stringify({ error: 'genreIds required (comma-separated)' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const genreIds = genreIdsParam.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
      if (genreIds.length === 0) return new Response(JSON.stringify({ error: 'No valid genre IDs provided' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const movies = await getTMDBMoviesByGenre(genreIds, page);
      return new Response(JSON.stringify({ genreIds, page, results: movies }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800' } });
    }

    // ============================================================
    // API: TMDB Trending content
    // ============================================================
    if (url.pathname === '/api/tmdb-trending' && request.method === 'GET') {
      const type = url.searchParams.get('type') || 'movie';
      const window_ = url.searchParams.get('window') || 'week';
      if (!['movie', 'tv', 'all'].includes(type)) return new Response(JSON.stringify({ error: 'type must be movie, tv, or all' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      if (!['day', 'week'].includes(window_)) return new Response(JSON.stringify({ error: 'window must be day or week' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const items = await getTMDBTrending(type, window_);
      return new Response(JSON.stringify({ type, window: window_, results: items }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } });
    }

    // ============================================================
    // API: Engine Status
    // ============================================================
    if (url.pathname === '/api/engine-status' && request.method === 'GET') {
      const tmdbConfigured = !!(env.TMDB_API_KEY || env.TMDB_ACCESS_TOKEN);
      const mistralConfigured = !!(env.MISTRAL_API || env.MISTRAL_API_KEY);
      return new Response(JSON.stringify({
        version: 'v4',
        tmdb: tmdbConfigured,
        mistral: mistralConfigured,
        features: [
          'metadata_detection',
          'epg_detection',
          'tmdb_genre_detection',
          'tmdb_poster_lookup',
          'tmdb_trending',
          'vision_detection',
          'vision_chat',
          'manual_identification',
          'scene_change_detection',
          'batch_detection'
        ].filter(f => {
          if (f === 'vision_detection' || f === 'vision_chat') return mistralConfigured;
          if (f === 'tmdb_poster_lookup' || f === 'tmdb_genre_detection' || f === 'tmdb_trending') return tmdbConfigured;
          return true;
        }),
        budget: { daily: EDGE_CONFIG.DAILY_BUDGET, spent: costState.spent.toFixed(4), remaining: Math.max(0, EDGE_CONFIG.DAILY_BUDGET - costState.spent).toFixed(4) },
        caches: { detections: detectionCache.size, posters: posterCache.size, epg: epgCache.size, genres: tmdbGenreCache.size, trending: tmdbTrendingCache.size, channels: channelStates.size }
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // ============================================================
    // API: Manual Identification
    // ============================================================
    const manualIdCache = new Map();

    if (url.pathname === '/api/identify' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { channelId, channelName, category, title, type, year } = body;
        if (!channelId || !title) return new Response(JSON.stringify({ error: 'channelId and title required' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

        // Build manual detection result with high confidence
        const manualDetection = {
          title,
          type: type || 'movie',
          confidence: 0.95,
          source: 'manual',
          year: year || null,
          genre: [],
          channelId,
          channelName: channelName || '',
          category: category || 'default',
          timestamp: Date.now(),
          manuallyIdentified: true
        };

        // Enrich with TMDB poster data if available
        const tmdbData = await getPosterFromTMDB(title, type || 'movie', year);
        if (tmdbData) {
          if (tmdbData.poster) manualDetection.poster = tmdbData.poster;
          if (tmdbData.backdrop) manualDetection.backdrop = tmdbData.backdrop;
          if (tmdbData.overview) manualDetection.overview = tmdbData.overview;
          if (tmdbData.rating) manualDetection.rating = tmdbData.rating;
          if (tmdbData.year && !manualDetection.year) manualDetection.year = tmdbData.year;
          if (tmdbData.tmdb_id) manualDetection.tmdb_id = tmdbData.tmdb_id;
        }

        // Cache the manual detection
        const cacheKey = getCacheKey('detect', channelId);
        setCache(detectionCache, cacheKey, manualDetection);
        updateChannelState(channelId, manualDetection, null, 'manual');

        return new Response(JSON.stringify(manualDetection), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EDGE - IPTV HD Gratis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0b0b;--surface:#141414;--elevated:#1d1d1d;
  --red:#e8112d;--red-glow:rgba(232,17,45,0.3);
  --white:#f0f0f0;--gray:#a0a0a0;--muted:#666;
  --font-display:'Orbitron',monospace;--font-body:'Space Grotesk',sans-serif;
  --radius-card:8px;--radius-chip:20px;--radius-input:6px;
  --shadow:0 4px 24px rgba(0,0,0,0.4);--shadow-hover:0 8px 32px rgba(0,0,0,0.5);
  --transition:240ms ease;
}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--bg);color:var(--white);overflow-x:hidden;line-height:1.6}
a{color:var(--gray);text-decoration:none}
button{cursor:pointer;font-family:var(--font-body);border:none;outline:none;background:none}
img{max-width:100%;display:block}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--surface)}
::-webkit-scrollbar-thumb{background:var(--muted);border-radius:3px}

#splash{position:fixed;inset:0;z-index:10000;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity 0.6s ease,visibility 0.6s ease}
#splash.hide{opacity:0;visibility:hidden;pointer-events:none}
.splash-wrap{display:flex;flex-direction:column;align-items:center}
.splash-logo-area{position:relative;overflow:hidden;padding:8px 20px}
.splash-logo{font-family:var(--font-display);font-size:72px;font-weight:900;color:var(--white);letter-spacing:12px;animation:logoGlow 1.5s ease-in-out infinite}
.splash-logo span{color:var(--red)}
.scanline{position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent 0%,rgba(232,17,45,0.4) 20%,rgba(232,17,45,0.7) 50%,rgba(232,17,45,0.4) 80%,transparent 100%);animation:scan 2s linear infinite;pointer-events:none}
@keyframes scan{0%{top:0}100%{top:100%}}
@keyframes logoGlow{0%,100%{text-shadow:0 0 20px rgba(232,17,45,0.2),0 0 40px rgba(232,17,45,0.08)}50%{text-shadow:0 0 30px rgba(232,17,45,0.4),0 0 60px rgba(232,17,45,0.15),0 0 100px rgba(232,17,45,0.08)}}
.splash-sub{font-family:var(--font-display);font-size:11px;color:var(--muted);letter-spacing:6px;margin-top:8px}
.load-seq{position:relative;height:20px;margin-top:24px;width:280px;text-align:center}
.phase{position:absolute;width:100%;text-align:center;left:0;font-family:var(--font-body);font-size:10px;letter-spacing:3px;opacity:0;font-weight:500}
.p1{animation:fadeIO 0.9s ease 0s forwards;color:var(--muted)}
.p2{animation:fadeIO 0.9s ease 0.85s forwards;color:var(--gray)}
.p3{animation:fadeIn 0.3s ease 1.7s forwards;color:var(--red)}
@keyframes fadeIO{0%{opacity:0}15%{opacity:1}85%{opacity:1}100%{opacity:0}}
@keyframes fadeIn{0%{opacity:0}100%{opacity:1}}
.load-bar-track{width:280px;height:3px;background:var(--elevated);border-radius:2px;overflow:hidden;margin-top:20px}
.load-bar-fill{height:100%;background:linear-gradient(90deg,var(--red),#ff4466,var(--red));border-radius:2px;animation:loadProgress 2.3s ease-in-out forwards}
@keyframes loadProgress{0%{width:0%}25%{width:30%}50%{width:55%}75%{width:80%}100%{width:100%}}

header{position:sticky;top:0;z-index:1000;background:rgba(11,11,11,0.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.06);padding:0 32px;height:64px;display:flex;align-items:center;justify-content:space-between}
.logo-mark{font-family:var(--font-display);font-size:22px;font-weight:900;letter-spacing:5px;color:var(--white)}
.logo-mark span{color:var(--red)}
header nav{display:flex;gap:24px;align-items:center}
header nav a{color:var(--muted);font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;transition:color var(--transition);padding:8px 0;position:relative}
header nav a:hover{color:var(--white)}
header nav a.active{color:var(--white)}
header nav a.active::after{content:'';position:absolute;bottom:-2px;left:0;width:100%;height:2px;background:rgba(255,255,255,0.3);border-radius:1px}
.hdr-right{display:flex;align-items:center;gap:14px}
.hdr-right button{color:var(--muted);font-size:17px;transition:color var(--transition);padding:6px}
.hdr-right button:hover{color:var(--white)}
#search-box{position:absolute;top:64px;right:32px;width:340px;background:rgba(20,20,20,0.9);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius-card);padding:14px;display:none;z-index:1001;box-shadow:var(--shadow)}
#search-box.open{display:block}
#search-box input{width:100%;background:var(--elevated);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-input);padding:10px 14px;color:var(--white);font-size:13px;font-family:var(--font-body)}
#search-box input:focus{border-color:rgba(255,255,255,0.25);outline:none}

.hero{position:relative;width:100%;height:500px;overflow:hidden;background:linear-gradient(135deg,var(--surface) 0%,#1a1a1a 50%,var(--surface) 100%)}
.hero-slide{position:absolute;inset:0;opacity:0;transition:opacity 1.2s ease;display:flex;align-items:center}
.hero-slide.active{opacity:1}
.hero-slide .slide-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(0.35) saturate(1.5)}
.hero-slide.active .slide-bg{animation:kenBurns 20s ease-in-out infinite alternate}
@keyframes kenBurns{0%{transform:scale(1)}100%{transform:scale(1.06)}}
.hero-slide .slide-grad{position:absolute;inset:0;background:linear-gradient(90deg,rgba(11,11,11,0.92) 0%,rgba(11,11,11,0.7) 35%,rgba(11,11,11,0.3) 65%,transparent 100%);pointer-events:none}.hero-slide .slide-grad2{position:absolute;inset:0;background:linear-gradient(0deg,rgba(11,11,11,0.9) 0%,rgba(11,11,11,0.4) 30%,transparent 60%);pointer-events:none}
.hero-slide .slide-content{position:relative;z-index:2;padding:0 60px;max-width:680px}
.slide-label{font-family:var(--font-display);font-size:10px;letter-spacing:4px;color:var(--red);text-transform:uppercase;margin-bottom:10px;font-weight:700}
.slide-title{font-family:var(--font-display);font-size:34px;font-weight:700;margin-bottom:10px;line-height:1.2;color:var(--white)}
.slide-desc{color:var(--gray);font-size:14px;margin-bottom:16px;line-height:1.5}
.slide-logo{height:50px;width:auto;max-width:180px;object-fit:contain;margin-bottom:12px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6));background:rgba(0,0,0,0.4);border-radius:6px;padding:4px 10px}
.slide-meta{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.meta-badge{font-size:10px;padding:3px 10px;border-radius:4px;font-weight:600;letter-spacing:1px}
.meta-badge.dur{background:rgba(255,255,255,0.08);color:var(--gray);border:1px solid rgba(255,255,255,0.1)}
.meta-badge.qual{background:rgba(232,17,45,0.15);color:var(--red);border:1px solid rgba(232,17,45,0.3)}
.meta-badge.cat{background:rgba(255,255,255,0.06);color:var(--white);border:1px solid rgba(255,255,255,0.1)}
.meta-badge.src{background:rgba(255,255,255,0.05);color:var(--muted);border:1px solid rgba(255,255,255,0.06)}
.btn-watch{background:var(--red);color:#fff;padding:12px 28px;border-radius:var(--radius-card);font-weight:600;font-size:13px;letter-spacing:1px;transition:all var(--transition);display:inline-flex;align-items:center;gap:8px;font-family:var(--font-body)}
.btn-watch:hover{transform:translateY(-2px);box-shadow:0 8px 24px var(--red-glow)}
.hero-arrows{position:absolute;top:50%;width:100%;display:flex;justify-content:space-between;padding:0 16px;z-index:3;transform:translateY(-50%)}
.hero-arrows button{background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);color:#fff;width:42px;height:42px;border-radius:50%;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all var(--transition);border:1px solid rgba(255,255,255,0.1)}
.hero-arrows button:hover{background:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.2)}
.hero-dots{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:3}
.hero-dots span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.2);cursor:pointer;transition:all var(--transition)}
.hero-dots span.active{background:var(--white);box-shadow:0 0 10px rgba(255,255,255,0.3);width:24px;border-radius:4px}

.cat-filter{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.cat-filter button{background:rgba(255,255,255,0.05);color:var(--gray);padding:7px 18px;border-radius:var(--radius-chip);font-size:12px;font-weight:500;transition:all var(--transition);border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(8px);display:flex;align-items:center;gap:5px}
.cat-filter button:hover{border-color:rgba(255,255,255,0.2);color:var(--white)}
.cat-filter button.active{background:rgba(232,17,45,0.12);color:var(--white);border-color:var(--red);font-weight:600;box-shadow:0 0 12px rgba(232,17,45,0.25),inset 0 0 8px rgba(232,17,45,0.08)}

.channels-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.ch-card{background:var(--surface);border-radius:var(--radius-card);overflow:hidden;border:1px solid rgba(255,255,255,0.04);transition:transform 240ms ease,box-shadow 240ms ease;position:relative;cursor:pointer;opacity:0;transform:translateY(10px)}
.ch-card.visible{opacity:1;transform:translateY(0);transition:opacity 300ms ease,transform 300ms ease}
.ch-card:hover{transform:translateY(-4px) scale(1.03);border-color:rgba(255,255,255,0.1);box-shadow:var(--shadow-hover)}
.ch-card .ch-thumb{width:100%;height:220px;position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ch-card .ch-thumb-img{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(0.55) saturate(1.5);transition:filter 400ms ease,transform 400ms ease}
.ch-card:hover .ch-thumb-img{filter:brightness(0.7) saturate(1.7);transform:scale(1.08)}
.ch-card .ch-thumb-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.05) 0%,rgba(0,0,0,0.15) 40%,rgba(0,0,0,0.85) 75%,rgba(0,0,0,0.95) 100%);z-index:1}
.ch-card .ch-thumb-icon{position:relative;z-index:2;font-size:32px;color:rgba(255,255,255,0.12);margin-bottom:4px}
.ch-card .ch-thumb-label{font-family:var(--font-body);font-size:14px;color:rgba(255,255,255,1);letter-spacing:0.5px;text-align:center;padding:8px;word-break:break-word;position:relative;z-index:2;text-shadow:0 2px 16px rgba(0,0,0,0.9),0 1px 4px rgba(0,0,0,0.7);font-weight:700}
.ch-card .ch-logo{position:relative;z-index:2;height:60px;width:auto;max-width:140px;object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6))}
.ch-card .ch-logo-fb{position:relative;z-index:2;width:56px;height:56px;border-radius:14px;color:#fff;font-size:22px;font-weight:900;display:none;align-items:center;justify-content:center;font-family:var(--font-display);letter-spacing:1px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6))}
.ch-card .ch-thumb-src{font-family:var(--font-body);font-size:9px;color:rgba(255,255,255,0.5);letter-spacing:1px;text-align:center;position:relative;z-index:2;margin-top:-4px;text-transform:uppercase}
.ch-card .live-badge{position:absolute;top:10px;left:10px;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:1px;animation:livePulse 2s infinite;display:flex;align-items:center;gap:4px;z-index:3}
.ch-card .live-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:#fff;animation:dotPulse 1s infinite}
.ch-card .ch-quality{position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.7);color:var(--white);font-size:9px;font-weight:600;padding:2px 8px;border-radius:3px;z-index:3;border:1px solid rgba(255,255,255,0.15)}
.ch-card .ch-viewers{position:absolute;bottom:10px;left:10px;font-size:10px;color:rgba(255,255,255,0.7);z-index:3;display:flex;align-items:center;gap:4px;background:rgba(0,0,0,0.5);padding:2px 8px;border-radius:3px}
.ch-card .ch-viewers i{font-size:8px}
.ch-card .ch-cat-tag{position:absolute;bottom:10px;right:10px;font-size:9px;color:var(--white);z-index:3;background:rgba(0,0,0,0.5);padding:2px 8px;border-radius:3px;text-transform:capitalize}
.ch-card .ch-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);width:44px;height:44px;border-radius:50%;background:rgba(232,17,45,0.85);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;opacity:0;transition:all var(--transition);z-index:4}
.ch-card:hover .ch-play{opacity:1;transform:translate(-50%,-50%) scale(1)}
.ch-card .ch-body{padding:12px 14px}
.ch-card .ch-name{font-family:var(--font-body);font-weight:600;font-size:13px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-card .ch-desc{color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-card .ch-now-playing{display:flex;align-items:center;gap:6px;margin-top:4px;padding:4px 8px;background:rgba(232,17,45,0.08);border:1px solid rgba(232,17,45,0.15);border-radius:4px;overflow:hidden}
.ch-card .ch-now-playing .np-dot{width:6px;height:6px;border-radius:50%;background:var(--red);flex-shrink:0;animation:dotPulse 1.5s infinite}
.ch-card .ch-now-playing .np-title{font-size:10px;color:var(--gray);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ch-card .ch-now-playing .np-type{font-size:8px;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,0.06);color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0}
.ch-card .ch-now-playing .np-poster{width:20px;height:28px;border-radius:2px;object-fit:cover;flex-shrink:0}
.ch-card .ch-now-playing .np-source{flex-shrink:0;display:flex;align-items:center;gap:2px;font-size:8px;color:var(--muted);margin-left:auto;padding:1px 4px;border-radius:2px;background:rgba(255,255,255,0.04)}
.ch-card .ch-now-playing .np-source .fa-tag{color:#4caf50}.ch-card .ch-now-playing .np-source .fa-calendar{color:#2196f3}.ch-card .ch-now-playing .np-source .fa-eye{color:#ff9800}
.player-now-playing .pnp-overview{font-size:10px;color:var(--muted);margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}
.player-now-playing .pnp-year{font-size:10px;color:var(--gray);padding:1px 5px;border-radius:3px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08)}
.player-now-playing .pnp-rating{font-size:10px;color:#ffc107;display:flex;align-items:center;gap:3px}
.player-now-playing .pnp-rating i{font-size:8px}
.player-now-playing .pnp-backdrop{position:absolute;inset:0;background-size:cover;background-position:center;filter:blur(30px) brightness(0.15);z-index:-1;opacity:0.6}
.player-now-playing{display:flex;align-items:center;gap:12px;padding:8px 16px;background:var(--elevated);border-top:1px solid rgba(255,255,255,0.06)}
.player-now-playing .pnp-poster{width:40px;height:56px;border-radius:4px;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,0.1)}
.player-now-playing .pnp-info{flex:1;min-width:0}
.player-now-playing .pnp-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player-now-playing .pnp-meta{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;margin-top:2px}
.player-now-playing .pnp-meta .pnp-type{font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(232,17,45,0.15);color:var(--red);text-transform:uppercase;letter-spacing:0.5px}
.player-now-playing .pnp-confidence{font-size:10px;color:var(--muted)}
@keyframes livePulse{0%,100%{opacity:1}50%{opacity:0.7}}
@keyframes dotPulse{0%,100%{opacity:1}50%{opacity:0.3}}

.ch-card .ch-score{position:absolute;top:10px;right:10px;z-index:4;display:flex;align-items:center;gap:3px;font-size:8px;font-weight:700;letter-spacing:0.5px;padding:2px 6px;border-radius:3px}
.ch-score.stable{background:rgba(76,175,80,0.2);color:#4caf50;border:1px solid rgba(76,175,80,0.3)}
.ch-score.untested{background:rgba(255,255,255,0.08);color:var(--muted);border:1px solid rgba(255,255,255,0.1)}
.ch-score.unstable{background:rgba(255,193,7,0.2);color:#ffc107;border:1px solid rgba(255,193,7,0.3)}
.ch-card .ch-mini-preview{position:absolute;inset:0;z-index:5;opacity:0;transition:opacity 300ms ease;pointer-events:none;background-size:200% 200%;animation:previewShift 3s ease infinite}
.ch-card:hover .ch-mini-preview{opacity:0.15}
@keyframes previewShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.cw-scroll{display:flex;gap:14px;overflow-x:auto;padding-bottom:10px;scroll-snap-type:x mandatory;margin-bottom:28px}
.cw-card{min-width:180px;background:var(--surface);border-radius:var(--radius-card);overflow:hidden;border:1px solid rgba(255,255,255,0.04);scroll-snap-align:start;flex-shrink:0;cursor:pointer;transition:all var(--transition);position:relative}
.cw-card:hover{border-color:rgba(232,17,45,0.3);transform:translateY(-2px);box-shadow:0 4px 16px rgba(232,17,45,0.15)}
.cw-card .cw-thumb{width:100%;height:100px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
.cw-card .cw-thumb-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(0.3) saturate(1.3)}
.cw-card .cw-thumb-overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.9) 100%)}
.cw-card .cw-icon{position:relative;z-index:2;font-size:24px;color:rgba(255,255,255,0.7)}
.cw-card .cw-play-sm{position:absolute;bottom:8px;right:8px;width:28px;height:28px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;z-index:3;opacity:0;transition:opacity var(--transition)}
.cw-card:hover .cw-play-sm{opacity:1}
.cw-card .cw-info{padding:10px 12px}
.cw-card .cw-name{font-family:var(--font-body);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.cw-card .cw-meta{font-size:10px;color:var(--muted);display:flex;align-items:center;gap:6px}
.cw-card .cw-progress{height:2px;background:var(--elevated);border-radius:1px;margin-top:6px;overflow:hidden}
.cw-card .cw-progress-bar{height:100%;background:var(--red);border-radius:1px}
.section-title .st-badge{font-size:9px;background:var(--red);color:#fff;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:0.5px;margin-left:8px;font-family:var(--font-body)}
.skeleton-card{background:var(--surface);border-radius:var(--radius-card);overflow:hidden;border:1px solid rgba(255,255,255,0.04)}
.skeleton-thumb{width:100%;height:180px;background:linear-gradient(90deg,var(--elevated) 25%,#252525 50%,var(--elevated) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
.skeleton-body{padding:12px 14px}
.skeleton-line{height:12px;background:linear-gradient(90deg,var(--elevated) 25%,#252525 50%,var(--elevated) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px;margin-bottom:8px}
.skeleton-line.short{width:60%}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

.main-layout{display:flex;gap:24px;max-width:1440px;margin:0 auto;padding:28px 24px}
.main-content{flex:1;min-width:0}
.sidebar{width:300px;flex-shrink:0}
.section-title{font-family:var(--font-display);font-size:16px;font-weight:700;margin-bottom:18px;display:flex;align-items:center;gap:10px;color:var(--white)}
.section-title .st-bar{width:3px;height:18px;background:linear-gradient(180deg,var(--red),rgba(232,17,45,0.3));border-radius:2px}
.section-title .st-count{font-size:11px;color:var(--muted);font-weight:400;margin-left:auto;font-family:var(--font-body)}

.sidebar-section{background:var(--surface);border-radius:var(--radius-card);border:1px solid rgba(255,255,255,0.04);padding:16px;margin-bottom:16px}
.sidebar-section h3{font-family:var(--font-display);font-size:10px;letter-spacing:2px;color:var(--red);margin-bottom:14px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.sidebar-toggle{cursor:pointer;display:flex;align-items:center;justify-content:space-between}
.sidebar-toggle .chevron{transition:transform var(--transition);font-size:12px;color:var(--muted)}
.sidebar-toggle.collapsed .chevron{transform:rotate(-90deg)}
.sidebar-body{overflow:hidden;transition:max-height 0.4s ease;max-height:600px}
.sidebar-body.collapsed{max-height:0}
.on-air-ch{display:flex;align-items:center;gap:10px;padding:6px;border-radius:6px;cursor:pointer;transition:background var(--transition);margin-bottom:4px}
.on-air-ch:hover{background:var(--elevated)}
.on-air-ch .oa-dot{width:8px;height:8px;border-radius:50%;background:var(--red);flex-shrink:0;animation:dotPulse 1.5s infinite}
.on-air-ch .oa-name{font-family:var(--font-body);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.on-air-ch .oa-viewers{font-size:10px;color:var(--muted)}
.on-air-ch .oa-logo{height:20px;width:auto;max-width:60px;object-fit:contain;flex-shrink:0}
.on-air-ch .oa-logo-fb{height:20px;width:20px;border-radius:4px;color:#fff;font-size:9px;font-weight:900;display:none;align-items:center;justify-content:center;font-family:var(--font-display);flex-shrink:0}
.trending-item .tr-logo{height:20px;width:auto;max-width:60px;object-fit:contain;flex-shrink:0}
.trending-item .tr-logo-fb{width:20px;height:20px;border-radius:4px;color:#fff;font-size:9px;font-weight:900;display:none;align-items:center;justify-content:center;font-family:var(--font-display);flex-shrink:0}
.trending-item{display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;padding:4px 6px;border-radius:4px;transition:background var(--transition)}
.trending-item:hover{background:var(--elevated)}
.trending-item .tr-rank{font-family:var(--font-display);font-size:14px;color:var(--red);min-width:20px}
.trending-item .tr-name{font-family:var(--font-body);font-size:12px;font-weight:500;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trending-item .tr-viewers{font-size:10px;color:var(--muted)}
.mp-chat{display:flex;flex-direction:column;gap:8px}
.mp-input-wrap{display:flex;gap:6px}
.mp-input{flex:1;background:var(--elevated);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-input);padding:8px 10px;color:var(--white);font-size:12px;font-family:var(--font-body)}
.mp-input:focus{border-color:rgba(255,255,255,0.25);outline:none}
.mp-send{background:var(--red);color:#fff;padding:8px 12px;border-radius:var(--radius-input);font-size:12px;transition:all var(--transition)}
.mp-send:hover{box-shadow:0 0 12px var(--red-glow)}
.mp-msg{font-size:12px;color:var(--gray);line-height:1.5;padding:8px;background:var(--elevated);border-radius:6px;border-left:2px solid var(--red)}

#player-modal{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.95);display:none;align-items:center;justify-content:center}
#player-modal.open{display:flex}
.player-wrap{position:relative;width:92%;max-width:1000px;background:#000;border-radius:var(--radius-card);overflow:hidden;box-shadow:0 0 80px rgba(0,0,0,0.6)}
.player-wrap video{width:100%;aspect-ratio:16/9;display:block;background:#000}
.player-close{position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);color:#fff;width:38px;height:38px;border-radius:50%;font-size:16px;display:flex;align-items:center;justify-content:center;z-index:5;transition:all var(--transition);border:1px solid rgba(255,255,255,0.1)}
.player-close:hover{background:var(--red);border-color:var(--red)}
.player-spinner{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);z-index:4}
.player-spinner.show{display:flex}
.spinner-ring{width:48px;height:48px;border:3px solid rgba(255,255,255,0.1);border-top-color:var(--red);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.buffering-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.3);z-index:3}
.buffering-overlay.show{display:flex}
.buffer-pulse{width:12px;height:12px;border-radius:50%;background:var(--red);animation:bufferPulse 1s ease infinite}
@keyframes bufferPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:0.5}}
.offline-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.9);display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:5}
.offline-overlay.show{display:flex}
.offline-overlay .off-icon{font-size:48px;color:var(--red);opacity:0.5}
.offline-overlay .off-text{font-family:var(--font-display);font-size:14px;color:var(--gray);letter-spacing:4px}
.offline-overlay .off-hint{font-size:12px;color:var(--muted);max-width:300px;text-align:center;line-height:1.5}
.offline-overlay .btn-retry{background:var(--red);color:#fff;padding:10px 24px;border-radius:var(--radius-card);font-weight:600;font-size:13px}
.offline-overlay .btn-switch{background:var(--elevated);color:var(--gray);padding:8px 20px;border-radius:var(--radius-card);font-size:12px;border:1px solid rgba(255,255,255,0.1)}
.player-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--surface);border-top:1px solid rgba(255,255,255,0.06)}
.player-bar button{color:var(--muted);font-size:16px;transition:color var(--transition);padding:4px}
.player-bar button:hover{color:var(--white)}
.p-title{flex:1;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.p-status{font-size:10px;padding:2px 8px;border-radius:4px;font-weight:600;letter-spacing:1px}
.p-status.live{background:var(--red);color:#fff;animation:livePulse 2s infinite}
.p-status.connecting{background:rgba(255,193,7,0.2);color:#ffc107}
.p-status.offline{background:var(--elevated);color:var(--muted)}
.p-quality{font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.08);color:var(--white);font-weight:600;display:none}
.vol-slider{-webkit-appearance:none;appearance:none;width:80px;height:4px;background:var(--muted);border-radius:2px;outline:none;cursor:pointer}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:var(--white);cursor:pointer}
.vol-slider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--white);cursor:pointer;border:none}

.upcoming-scroll{display:flex;gap:14px;overflow-x:auto;padding-bottom:10px;scroll-snap-type:x mandatory}
.upcoming-card{min-width:200px;background:var(--surface);border-radius:var(--radius-card);padding:14px;border:1px solid rgba(255,255,255,0.04);scroll-snap-align:start;flex-shrink:0;cursor:pointer;transition:all var(--transition)}
.upcoming-card:hover{border-color:rgba(255,255,255,0.1);transform:translateY(-2px)}
.upcoming-card .uc-cat{font-size:9px;color:var(--red);font-weight:600;letter-spacing:2px;margin-bottom:6px;text-transform:uppercase}
.upcoming-card .uc-name{font-size:13px;font-weight:500;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.upcoming-card .uc-time{font-family:var(--font-display);font-size:13px;color:var(--white);letter-spacing:1px}

footer{background:var(--surface);border-top:1px solid rgba(255,255,255,0.04);padding:28px 24px;text-align:center;margin-top:48px}
footer .f-brand{font-family:var(--font-display);font-size:11px;letter-spacing:4px;color:var(--muted)}
footer .f-brand span{color:var(--red)}
footer .f-stats{display:flex;justify-content:center;gap:28px;margin-top:12px}
footer .f-stats .stat{font-size:11px;color:var(--muted)}
footer .f-stats .stat strong{color:var(--white);font-family:var(--font-display)}

.toast{position:fixed;bottom:24px;right:24px;background:var(--elevated);color:var(--white);padding:12px 20px;border-radius:var(--radius-card);font-size:13px;z-index:9999;transform:translateY(80px);opacity:0;transition:all var(--transition);border-left:3px solid var(--red);max-width:320px;box-shadow:var(--shadow)}
.toast.show{transform:translateY(0);opacity:1}

@media(max-width:1024px){
  .main-layout{flex-direction:column}.sidebar{width:100%}
  .channels-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
  .hero{height:420px}.slide-title{font-size:28px}
}
@media(max-width:640px){
  .channels-grid{grid-template-columns:1fr 1fr}
  header nav a span{display:none}header{padding:0 16px}
  .hero{height:320px}.slide-title{font-size:22px}.slide-desc{display:none}
  .vol-slider{width:50px}
}
</style>
</head>
<body>
<div id="splash"><div class="splash-wrap"><div class="splash-logo-area"><div class="splash-logo">E<span>D</span>GE</div><div class="scanline"></div></div><div class="splash-sub">IPTV HD GRATIS</div><div class="load-seq"><span class="phase p1">INITIALIZING...</span><span class="phase p2">LOADING STREAMS...</span><span class="phase p3">READY</span></div><div class="load-bar-track"><div class="load-bar-fill"></div></div></div></div>
<header><div class="logo-mark">E<span>D</span>GE</div><nav><a href="#" class="active" data-nav="home"><i class="fas fa-home"></i><span>Home</span></a><a href="#" data-nav="live"><i class="fas fa-tv"></i><span>Live</span></a><a href="#" data-nav="sports"><i class="fas fa-futbol"></i><span>Sports</span></a><a href="#" data-nav="news"><i class="fas fa-newspaper"></i><span>News</span></a></nav><div class="hdr-right"><button id="sound-toggle" title="Toggle Sound"><i class="fas fa-volume-mute"></i></button><button id="search-toggle" title="Search"><i class="fas fa-search"></i></button></div></header>
<div id="search-box"><input type="text" id="search-input" placeholder="Buscar canales..."></div>
<section class="hero" id="hero-section"><div id="hero-slides"></div><div class="hero-arrows"><button id="hero-prev"><i class="fas fa-chevron-left"></i></button><button id="hero-next"><i class="fas fa-chevron-right"></i></button><div class="hero-dots" id="hero-dots"></div></section>
<div class="main-layout"><main class="main-content"><section id="continue-section" style="display:none"><h2 class="section-title"><span class="st-bar"></span>Continue Watching<span class="st-badge" id="cw-count">0</span></h2><div class="cw-scroll" id="cw-scroll"></div></section><section id="channels-section"><h2 class="section-title"><span class="st-bar"></span>Canales en Vivo<span class="st-count" id="ch-count"></span></h2><div class="cat-filter" id="cat-filter"></div><div class="channels-grid" id="channels-grid"></div></section><section id="upcoming-section" style="margin-top:40px"><h2 class="section-title"><span class="st-bar"></span>Coming Up</h2><div class="upcoming-scroll" id="upcoming-scroll"></div></section></main><aside class="sidebar"><div class="sidebar-section"><div class="sidebar-toggle" id="on-air-toggle"><h3><i class="fas fa-broadcast-tower"></i>En Vivo Ahora</h3><i class="fas fa-chevron-down chevron"></i></div><div class="sidebar-body" id="on-air-body"></div></div><div class="sidebar-section"><div class="sidebar-toggle" id="trending-toggle"><h3><i class="fas fa-fire"></i>Tendencias</h3><i class="fas fa-chevron-down chevron"></i></div><div class="sidebar-body" id="trending-body"></div></div><div class="sidebar-section"><div class="sidebar-toggle" id="mistral-toggle"><h3><i class="fas fa-robot"></i>EDGE Vision IA</h3><i class="fas fa-chevron-down chevron"></i></div><div class="sidebar-body" id="mistral-body"><div class="mp-chat"><div class="mp-msg" id="mistral-msg"><i class="fas fa-eye" style="margin-right:4px;color:var(--red)"></i>Puedo ver lo que ves! Preguntame: "Que pelicula estan dando?"</div><div class="mp-input-wrap"><input class="mp-input" id="mistral-input" placeholder="Que pelicula estan dando?"><button class="mp-send" id="mistral-send"><i class="fas fa-paper-plane"></i></button></div></div></div></div></aside></div>
<div id="player-modal"><div class="player-wrap"><button class="player-close" id="player-close"><i class="fas fa-times"></i></button><video id="hls-video" muted playsinline></video><div class="player-spinner" id="player-spinner"><div class="spinner-ring"></div></div><div class="buffering-overlay" id="buffering-overlay"><div class="buffer-pulse"></div></div><div class="offline-overlay" id="offline-overlay"><i class="fas fa-signal off-icon"></i><div class="off-text">CANAL OFFLINE</div><div class="off-hint">Este canal puede estar bloqueado. Prueba otro o usa VPN.</div><button class="btn-retry" id="btn-retry"><i class="fas fa-redo"></i> Reintentar</button><button class="btn-switch" id="btn-switch"><i class="fas fa-exchange-alt"></i> Siguiente Canal</button></div><div class="player-now-playing" id="player-now-playing" style="display:none;position:relative;overflow:hidden"><div class="pnp-backdrop" id="pnp-backdrop"></div><img class="pnp-poster" id="pnp-poster" src="" alt=""><div class="pnp-info"><div class="pnp-title" id="pnp-title">-</div><div class="pnp-meta"><span class="pnp-type" id="pnp-type">-</span><span class="pnp-year" id="pnp-year"></span><span class="pnp-rating" id="pnp-rating"></span><span class="pnp-confidence" id="pnp-confidence"></span></div><div class="pnp-overview" id="pnp-overview"></div></div></div><div class="player-bar"><button id="play-pause"><i class="fas fa-play"></i></button><button id="vol-btn"><i class="fas fa-volume-mute"></i></button><input type="range" id="vol-slider" min="0" max="100" value="0" class="vol-slider"><span class="p-title" id="player-title">-</span><span class="p-quality" id="quality-indicator">HD</span><span class="p-status connecting" id="player-status">CONNECTING</span><button id="detect-btn" title="Detect content"><i class="fas fa-magic"></i></button><button id="audio-btn"><i class="fas fa-headphones"></i></button><button id="fullscreen-btn"><i class="fas fa-expand"></i></button></div></div></div>
<div class="toast" id="toast"></div>
<footer><div class="f-brand">EDGE <span>v10.0</span> &mdash; IPTV 100% Gratis</div><div class="f-stats"><div class="stat"><strong id="stat-ch">211</strong> canales</div><div class="stat"><strong id="stat-hd">211</strong> HD</div><div class="stat"><strong>5</strong> categorias</div><div class="stat"><strong id="stat-detect">0</strong> detectados</div></div></footer>
<script>
(function(){function k(){var s=document.getElementById('splash');if(s)s.classList.add('hide');}setTimeout(k,2500);setTimeout(k,3500);setTimeout(k,5000);document.addEventListener('DOMContentLoaded',function(){setTimeout(k,800);});window.addEventListener('load',function(){setTimeout(k,300);});window.onerror=function(){k();return true;};})();
<\/script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"><\/script>
<script>
(function(){
'use strict';
var CHANNELS=[
{id:1,n:"Cine adrenalina",s:"https://jmp2.uk/plu-5d8d164d92e97a5e107638d2.m3u8",c:"movies",q:"HD",src:"Movies",v:3499,d:"Cine adrenalina - En vivo",clr:"#6A1B9A",logo:"/icons/ch1.png"},
{id:2,n:"Cine comedia",s:"https://jmp2.uk/plu-5f513564e4622a0007c578c0.m3u8",c:"movies",q:"HD",src:"Movies",v:3498,d:"Cine comedia - En vivo",clr:"#6A1B9A",logo:"/icons/ch2.png"},
{id:3,n:"Cine terror",s:"https://jmp2.uk/plu-5d8d180092e97a5e107638d3.m3u8",c:"movies",q:"HD",src:"Movies",v:3497,d:"Cine terror - En vivo",clr:"#6A1B9A",logo:"/icons/ch3.png"},
{id:4,n:"Cine Premiere",s:"https://jmp2.uk/plu-5cf968040ab7d8f181e6a68b.m3u8",c:"movies",q:"HD",src:"Movies",v:3496,d:"Cine Premiere - En vivo",clr:"#6A1B9A",logo:"/icons/ch4.png"},
{id:5,n:"Cine Romantico",s:"https://d1si3n1st4nkgb.cloudfront.net/10502/88886011/hls/master.m3u8?ads.xumo_channelId=88886011",c:"movies",q:"HD",src:"Movies",v:3495,d:"Cine Romantico - En vivo",clr:"#6A1B9A",logo:"/icons/ch5.png"},
{id:6,n:"Cine Clásico",s:"https://jmp2.uk/plu-64b9671cdac71b0008f371df.m3u8",c:"movies",q:"HD",src:"Movies",v:3494,d:"Cine Clásico - En vivo",clr:"#6A1B9A",logo:"/icons/ch6.png"},
{id:7,n:"Cine Sony",s:"https://a-cdn.klowdtv.com/live1/cine_720p/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3493,d:"Cine Sony - En vivo",clr:"#6A1B9A",logo:"/icons/ch7.png"},
{id:8,n:"Adrenalina Pura TV",s:"https://jmp2.uk/plu-61b790b985706b00072cb797.m3u8",c:"movies",q:"HD",src:"Movies",v:3492,d:"Adrenalina Pura TV - En vivo",clr:"#6A1B9A",logo:"/icons/ch8.png"},
{id:9,n:"Pluto TV Action",s:"https://jmp2.uk/plu-5dbfeb961b411c00090b52b3.m3u8",c:"movies",q:"HD",src:"Movies",v:3491,d:"Pluto TV Action - En vivo",clr:"#6A1B9A",logo:"/icons/ch9.png"},
{id:10,n:"Pluto TV Cine Drama",s:"https://jmp2.uk/plu-5f1210d14ae1f80007bafb1d.m3u8",c:"movies",q:"HD",src:"Movies",v:3490,d:"Pluto TV Cine Drama - En vivo",clr:"#6A1B9A",logo:"/icons/ch10.png"},
{id:11,n:"Pluto TV Cine Família",s:"https://jmp2.uk/plu-5f171f032cd22e0007f17f3d.m3u8",c:"movies",q:"HD",src:"Movies",v:3489,d:"Pluto TV Cine Família - En vivo",clr:"#6A1B9A",logo:"/icons/ch11.png"},
{id:12,n:"Pluto TV Cine Romance",s:"https://jmp2.uk/plu-5f171f988ab9780007fa95ea.m3u8",c:"movies",q:"HD",src:"Movies",v:3488,d:"Pluto TV Cine Romance - En vivo",clr:"#6A1B9A",logo:"/icons/ch12.png"},
{id:13,n:"Pluto TV Cine Terror",s:"https://jmp2.uk/plu-5f12111c9e6c2c00078ef3bb.m3u8",c:"movies",q:"HD",src:"Movies",v:3487,d:"Pluto TV Cine Terror - En vivo",clr:"#6A1B9A",logo:"/icons/ch13.png"},
{id:14,n:"Pluto TV Horror",s:"https://jmp2.uk/plu-62ea3f8a38acc80007072d26.m3u8",c:"movies",q:"HD",src:"Movies",v:3486,d:"Pluto TV Horror - En vivo",clr:"#6A1B9A",logo:"/icons/ch14.png"},
{id:15,n:"Pluto TV Drama",s:"https://jmp2.uk/plu-5ddf91149880d60009d35d27.m3u8",c:"movies",q:"HD",src:"Movies",v:3485,d:"Pluto TV Drama - En vivo",clr:"#6A1B9A",logo:"/icons/ch15.png"},
{id:16,n:"Pluto TV Thrillers",s:"https://jmp2.uk/plu-5dbfedccc563080009b60f4a.m3u8",c:"movies",q:"HD",src:"Movies",v:3484,d:"Pluto TV Thrillers - En vivo",clr:"#6A1B9A",logo:"/icons/ch16.png"},
{id:17,n:"Pluto TV Westerns",s:"https://jmp2.uk/plu-5d4bdb635ce813b38639e6a3.m3u8",c:"movies",q:"HD",src:"Movies",v:3483,d:"Pluto TV Westerns - En vivo",clr:"#6A1B9A",logo:"/icons/ch17.png"},
{id:18,n:"Pluto TV Crime Movies",s:"https://jmp2.uk/plu-5f4d8594eb979c0007706de7.m3u8",c:"movies",q:"HD",src:"Movies",v:3482,d:"Pluto TV Crime Movies - En vivo",clr:"#6A1B9A",logo:"/icons/ch18.png"},
{id:19,n:"Pluto TV Movies",s:"https://jmp2.uk/plu-5c5c3b948002db3c3e0b262e.m3u8",c:"movies",q:"HD",src:"Movies",v:3481,d:"Pluto TV Movies - En vivo",clr:"#6A1B9A",logo:"/icons/ch19.png"},
{id:20,n:"CINDIE TV",s:"https://d20xuwbyc4yoag.cloudfront.net/v1/master/9d062541f2ff39b5c0f48b743c6411d25f62fc25/DistroTV-MuxIP-CINDIE/387.m3u8?ads.vf=grWTpG3NQNi",c:"movies",q:"HD",src:"Movies",v:3480,d:"CINDIE TV - En vivo",clr:"#6A1B9A",logo:"/icons/ch20.png"},
{id:21,n:"Gravitas Movies",s:"https://d6dg3ebeih71x.cloudfront.net/Gravitas_Movies.m3u8",c:"movies",q:"HD",src:"Movies",v:3479,d:"Gravitas Movies - En vivo",clr:"#6A1B9A",logo:"/icons/ch21.png"},
{id:22,n:"Charge!",s:"https://fast-channels.sinclairstoryline.com/CHARGE/index.m3u8",c:"movies",q:"HD",src:"Movies",v:3478,d:"Charge! - En vivo",clr:"#6A1B9A",logo:"/icons/ch22.png"},
{id:23,n:"MovieSphere by Lionsgate",s:"https://jmp2.uk/plu-64a3d96f060e830008af6745.m3u8",c:"movies",q:"HD",src:"Movies",v:3477,d:"MovieSphere by Lionsgate - En vivo",clr:"#6A1B9A",logo:"/icons/ch23.png"},
{id:24,n:"MOVIEDOME",s:"https://jmp2.uk/plu-615c1e5ce3039400070a0547.m3u8",c:"movies",q:"HD",src:"Movies",v:3476,d:"MOVIEDOME - En vivo",clr:"#6A1B9A",logo:"/icons/ch24.png"},
{id:25,n:"Movies Action",s:"https://shd-amg-fast.edgenextcdn.net/tx011/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3475,d:"Movies Action - En vivo",clr:"#6A1B9A",logo:"/icons/ch25.png"},
{id:26,n:"Movies Thriller",s:"https://shd-amg-fast.edgenextcdn.net/tx012/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3474,d:"Movies Thriller - En vivo",clr:"#6A1B9A",logo:"/icons/ch26.png"},
{id:27,n:"Aflam",s:"https://shd-amg-fast.edgenextcdn.net/tx001/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3473,d:"Aflam - En vivo",clr:"#6A1B9A",logo:"/icons/ch27.png"},
{id:28,n:"Filmax",s:"https://s3.ideationtec.live/Filmax/Filmax.m3u8",c:"movies",q:"HD",src:"Movies",v:3472,d:"Filmax - En vivo",clr:"#6A1B9A",logo:"/icons/ch28.png"},
{id:29,n:"Zylo Cine Friki",s:"https://d2mr4fu91mjx9m.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-rb0tx75ojbc5u/CineFriki_ES.m3u8",c:"movies",q:"HD",src:"Movies",v:3471,d:"Zylo Cine Friki - En vivo",clr:"#6A1B9A",logo:"/icons/ch29.png"},
{id:30,n:"Runtime Espanol",s:"https://run-rt-uh-roku.otteravision.com/run/rt_uh/rt_uh.m3u8",c:"movies",q:"HD",src:"Movies",v:3470,d:"Runtime Espanol - En vivo",clr:"#6A1B9A",logo:"/icons/ch30.png"},
{id:31,n:"BET Cinema",s:"https://jmp2.uk/plu-58af4c093a41ca9d4ecabe96.m3u8",c:"movies",q:"HD",src:"Movies",v:3469,d:"BET Cinema - En vivo",clr:"#6A1B9A",logo:"/icons/ch31.png"},
{id:32,n:"Classic Movies Channel",s:"https://jmp2.uk/plu-561c5b0dada51f8004c4d855.m3u8",c:"movies",q:"HD",src:"Movies",v:3468,d:"Classic Movies Channel - En vivo",clr:"#6A1B9A",logo:"/icons/ch32.png"},
{id:33,n:"Flicks of Fury",s:"https://jmp2.uk/plu-58e55b14ad8e9c364d55f717.m3u8",c:"movies",q:"HD",src:"Movies",v:3467,d:"Flicks of Fury - En vivo",clr:"#6A1B9A",logo:"/icons/ch33.png"},
{id:34,n:"Paramount Movie Channel",s:"https://jmp2.uk/plu-5cb0cae7a461406ffe3f5213.m3u8",c:"movies",q:"HD",src:"Movies",v:3466,d:"Paramount Movie Channel - En vivo",clr:"#6A1B9A",logo:"/icons/ch34.png"},
{id:35,n:"Paramount+ Picks",s:"https://jmp2.uk/plu-5ff8c708653d080007361b14.m3u8",c:"movies",q:"HD",src:"Movies",v:3465,d:"Paramount+ Picks - En vivo",clr:"#6A1B9A",logo:"/icons/ch35.png"},
{id:36,n:"FilmRise Westerns",s:"https://dz05z8iljgvbe.cloudfront.net/master.m3u8",c:"movies",q:"HD",src:"Movies",v:3464,d:"FilmRise Westerns - En vivo",clr:"#6A1B9A",logo:"/icons/ch36.png"},
{id:37,n:"Alien Nation by DUST",s:"https://dqi7ayt2o24fn.cloudfront.net/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3463,d:"Alien Nation by DUST - En vivo",clr:"#6A1B9A",logo:"/icons/ch37.png"},
{id:38,n:"OuterSphere",s:"https://d3o593mz1glx8d.cloudfront.net/OuterSphere_US.m3u8",c:"movies",q:"HD",src:"Movies",v:3462,d:"OuterSphere - En vivo",clr:"#6A1B9A",logo:"/icons/ch38.png"},
{id:39,n:"50 Cent Action",s:"https://jmp2.uk/plu-68487fb3f212bedacf5a53e3.m3u8",c:"movies",q:"HD",src:"Movies",v:3461,d:"50 Cent Action - En vivo",clr:"#6A1B9A",logo:"/icons/ch39.png"},
{id:40,n:"TV Land Drama",s:"https://jmp2.uk/plu-5d40bebc5e3d2750a2239d7e.m3u8",c:"movies",q:"HD",src:"Movies",v:3460,d:"TV Land Drama - En vivo",clr:"#6A1B9A",logo:"/icons/ch40.png"},
{id:41,n:"Pluto TV Cult Films",s:"https://jmp2.uk/plu-5c5c31f2f21b553c1f673fb0.m3u8",c:"movies",q:"HD",src:"Movies",v:3459,d:"Pluto TV Cult Films - En vivo",clr:"#6A1B9A",logo:"/icons/ch41.png"},
{id:42,n:"Pluto TV Spotlight",s:"https://jmp2.uk/plu-5ba3fb9c4b078e0f37ad34e8.m3u8",c:"movies",q:"HD",src:"Movies",v:3458,d:"Pluto TV Spotlight - En vivo",clr:"#6A1B9A",logo:"/icons/ch42.png"},
{id:43,n:"Pluto TV Staff Picks",s:"https://jmp2.uk/plu-5f4d863b98b41000076cd061.m3u8",c:"movies",q:"HD",src:"Movies",v:3457,d:"Pluto TV Staff Picks - En vivo",clr:"#6A1B9A",logo:"/icons/ch43.png"},
{id:44,n:"Artflix Movie Classics",s:"https://amogonetworx-artflix-1-nl.samsung.wurl.tv/playlist.m3u8",c:"movies",q:"HD",src:"Movies",v:3456,d:"Artflix Movie Classics - En vivo",clr:"#6A1B9A",logo:"/icons/ch44.png"},
{id:45,n:"France 2",s:"http://69.64.57.208/france2/mono.m3u8",c:"french",q:"HD",src:"Français",v:3455,d:"France 2 - En vivo",clr:"#1565C0",logo:"/icons/ch45.png"},
{id:46,n:"France 5",s:"http://69.64.57.208/france5/mono.m3u8",c:"french",q:"HD",src:"Français",v:3454,d:"France 5 - En vivo",clr:"#1565C0",logo:"/icons/ch46.png"},
{id:47,n:"TV5Monde Info",s:"https://ott.tv5monde.com/Content/HLS/Live/channel(info)/variant.m3u8",c:"french",q:"HD",src:"Français",v:3453,d:"TV5Monde Info - En vivo",clr:"#1565C0",logo:"/icons/ch47.png"},
{id:48,n:"TV5 Quebec Canada",s:"http://23.133.220.149/TV5/index.m3u8",c:"french",q:"HD",src:"Français",v:3452,d:"TV5 Quebec Canada - En vivo",clr:"#1565C0",logo:"/icons/ch48.png"},
{id:49,n:"ICI RDI",s:"https://rcavlive.akamaized.net/hls/live/704025/xcanrdi/master.m3u8",c:"french",q:"HD",src:"Français",v:3451,d:"ICI RDI - En vivo",clr:"#1565C0",logo:"/icons/ch49.png"},
{id:50,n:"CGTN Français",s:"https://amg01314-cgtn-amg01314c2-rakuten-us-1319.playouts.now.amagi.tv/cgtn-fr-rakuten/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3450,d:"CGTN Français - En vivo",clr:"#1565C0",logo:"/icons/ch50.png"},
{id:51,n:"Africanews French",s:"https://cdn-euronews.akamaized.net/live/eds/africanews-fr/25050/index.m3u8",c:"french",q:"HD",src:"Français",v:3449,d:"Africanews French - En vivo",clr:"#1565C0",logo:"/icons/ch51.png"},
{id:52,n:"Euronews French",s:"https://2f6c5bf4.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmxheHhUVi1ldV9FdXJvbmV3c0ZyYW5jYWlzX0hMUw/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3448,d:"Euronews French - En vivo",clr:"#1565C0",logo:"/icons/ch52.png"},
{id:53,n:"BFM2",s:"https://d1ib1gsg71oarf.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-scp7wda722jph/BFM2_FR.m3u8",c:"french",q:"HD",src:"Français",v:3447,d:"BFM2 - En vivo",clr:"#1565C0",logo:"/icons/ch53.png"},
{id:54,n:"Bel RTL",s:"https://bel-live-hls.akamaized.net/hls/live/2038650/BEL-Live-HLS/master.m3u8",c:"french",q:"HD",src:"Français",v:3446,d:"Bel RTL - En vivo",clr:"#1565C0",logo:"/icons/ch54.png"},
{id:55,n:"RTL Zwee",s:"https://live-edge.rtl.lu/channel2/smil:channel2/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3445,d:"RTL Zwee - En vivo",clr:"#1565C0",logo:"/icons/ch55.png"},
{id:56,n:"RTL-TVI",s:"https://tvi-live-hls.akamaized.net/hls/live/2038650/TVI-Live-HLS/master.m3u8",c:"french",q:"HD",src:"Français",v:3444,d:"RTL-TVI - En vivo",clr:"#1565C0",logo:"/icons/ch56.png"},
{id:57,n:"La Une",s:"https://c9851ec-rbm-hilv-fsly.cdn.redbee.live/L22/6d35e26e/1bffdaaf.isml/.m3u8",c:"french",q:"HD",src:"Français",v:3443,d:"La Une - En vivo",clr:"#1565C0",logo:"/icons/ch57.png"},
{id:58,n:"Canal 32",s:"https://event.vedge.infomaniak.com/livecast/ik:canal32_4/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3442,d:"Canal 32 - En vivo",clr:"#1565C0",logo:"/icons/ch58.png"},
{id:59,n:"DBM TV",s:"https://dbmtv.vedge.infomaniak.com/livecast/dbmtv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3441,d:"DBM TV - En vivo",clr:"#1565C0",logo:"/icons/ch59.png"},
{id:60,n:"Puissance TV",s:"https://event.vedge.infomaniak.com/livecast/ik:puissancetelevision/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3440,d:"Puissance TV - En vivo",clr:"#1565C0",logo:"/icons/ch60.png"},
{id:61,n:"Africa 24",s:"https://africa24.vedge.infomaniak.com/livecast/ik:africa24/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3439,d:"Africa 24 - En vivo",clr:"#1565C0",logo:"/icons/ch61.png"},
{id:62,n:"Africa 24 Sport",s:"https://africa24.vedge.infomaniak.com/livecast/ik:africa24sport/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3438,d:"Africa 24 Sport - En vivo",clr:"#1565C0",logo:"/icons/ch62.png"},
{id:63,n:"Medi 1 TV Maghreb",s:"https://cdn.live.easybroadcast.io/abr_corp/83_medi1tv-maghreb_jnbspmg/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3437,d:"Medi 1 TV Maghreb - En vivo",clr:"#1565C0",logo:"/icons/ch63.png"},
{id:64,n:"Medi1TV Afrique",s:"https://cdn.live.easybroadcast.io/abr_corp/83_medi1tv-afrique_tm7tu45/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3436,d:"Medi1TV Afrique - En vivo",clr:"#1565C0",logo:"/icons/ch64.png"},
{id:65,n:"TNTV",s:"https://tntv-samsung-fr.amagi.tv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3435,d:"TNTV - En vivo",clr:"#1565C0",logo:"/icons/ch65.png"},
{id:66,n:"Trace Urban (Australia)",s:"https://lightning-traceurban-samsungau.amagi.tv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3434,d:"Trace Urban (Australia) - En vivo",clr:"#1565C0",logo:"/icons/ch66.png"},
{id:67,n:"Trace Latina",s:"https://amg01131-tracetv-tracelatina-glewed-vtnk7.amagi.tv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3433,d:"Trace Latina - En vivo",clr:"#1565C0",logo:"/icons/ch67.png"},
{id:68,n:"Trace Gospel",s:"https://channels.trace.plus/Traceprod/GOSPEL_FR/.m3u8",c:"french",q:"HD",src:"Français",v:3432,d:"Trace Gospel - En vivo",clr:"#1565C0",logo:"/icons/ch68.png"},
{id:69,n:"Zylo Into Crime",s:"https://amg00711-zylo-amg00711c10-rakuten-fr-6731.playouts.now.amagi.tv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3431,d:"Zylo Into Crime - En vivo",clr:"#1565C0",logo:"/icons/ch69.png"},
{id:70,n:"Zylo ScreamIN",s:"https://rakutenaa-zylo-screamin-rakuten-p11ej.amagi.tv/playlist/rakutenAA-zylo-screamin-rakuten/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3430,d:"Zylo ScreamIN - En vivo",clr:"#1565C0",logo:"/icons/ch70.png"},
{id:71,n:"Zylo Ciné Nanar",s:"https://zylo-cinenanar-rakuten.amagi.tv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3429,d:"Zylo Ciné Nanar - En vivo",clr:"#1565C0",logo:"/icons/ch71.png"},
{id:72,n:"Clubbing TV France",s:"https://d1j2csarxnwazk.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-uze1m6xh4fiyr-ssai-prd/master.m3u8",c:"french",q:"HD",src:"Français",v:3428,d:"Clubbing TV France - En vivo",clr:"#1565C0",logo:"/icons/ch72.png"},
{id:73,n:"FashionTV Paris L\'Original",s:"https://edge-fast3.evrideo.tv/bfdbb576-83f7-11f0-9f89-0200170e3e04_1000028043_HLS/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3427,d:"FashionTV Paris L\'Original - En vivo",clr:"#1565C0",logo:"/icons/ch73.png"},
{id:74,n:"Sony One Hits Action",s:"https://5098a8b860504a3690fd2e7c0a18d68f.mediatailor.us-west-2.amazonaws.com/v1/master/ba62fe743df0fe93366eba3a257d792884136c7f/LINEAR-817-FR-SONYONEHITSACTION-LG_FR/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3426,d:"Sony One Hits Action - En vivo",clr:"#1565C0",logo:"/icons/ch74.png"},
{id:75,n:"Sony One Hits Comedie",s:"https://7aa9671895264ec9a384dfed1b992171.mediatailor.us-west-2.amazonaws.com/v1/master/ba62fe743df0fe93366eba3a257d792884136c7f/LINEAR-818-FR-SONYONEHITSCOMDIE-LG_FR/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3425,d:"Sony One Hits Comedie - En vivo",clr:"#1565C0",logo:"/icons/ch75.png"},
{id:76,n:"Sony One Favoris",s:"https://49d735318d6b4c30a24a7997ea594e1b.mediatailor.us-west-2.amazonaws.com/v1/master/ba62fe743df0fe93366eba3a257d792884136c7f/LINEAR-820-FR-SONYONEFAVORIS-LG_FR/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3424,d:"Sony One Favoris - En vivo",clr:"#1565C0",logo:"/icons/ch76.png"},
{id:77,n:"South Park",s:"https://jmp2.uk/plu-64edf6eaa7ec0d000812f58c.m3u8",c:"french",q:"HD",src:"Français",v:3423,d:"South Park - En vivo",clr:"#1565C0",logo:"/icons/ch77.png"},
{id:78,n:"One Piece",s:"https://jmp2.uk/plu-6380c94947c72b0007ee9a13.m3u8",c:"french",q:"HD",src:"Français",v:3422,d:"One Piece - En vivo",clr:"#1565C0",logo:"/icons/ch78.png"},
{id:79,n:"Caillou",s:"https://do7nccdsswstc.cloudfront.net/v1/manifest/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-1aso0bc668saa/a5233c83-f772-4a81-959a-45ec7877ef61/5.m3u8",c:"french",q:"HD",src:"Français",v:3421,d:"Caillou - En vivo",clr:"#1565C0",logo:"/icons/ch79.png"},
{id:80,n:"Nickelodeon Teen",s:"https://jmp2.uk/plu-5f0d668b872e4400073acc68.m3u8",c:"french",q:"HD",src:"Français",v:3420,d:"Nickelodeon Teen - En vivo",clr:"#1565C0",logo:"/icons/ch80.png"},
{id:81,n:"Voyages & Saveurs",s:"https://jmp2.uk/plu-680291e38e1ff89c2427aefd.m3u8",c:"french",q:"HD",src:"Français",v:3419,d:"Voyages & Saveurs - En vivo",clr:"#1565C0",logo:"/icons/ch81.png"},
{id:82,n:"Numerica TV",s:"https://tnt-television.com/NUMERICA/index.m3u8",c:"french",q:"HD",src:"Français",v:3418,d:"Numerica TV - En vivo",clr:"#1565C0",logo:"/icons/ch82.png"},
{id:83,n:"CCPV TV",s:"https://tnt-television.com/CCPV-TV/index.m3u8",c:"french",q:"HD",src:"Français",v:3417,d:"CCPV TV - En vivo",clr:"#1565C0",logo:"/icons/ch83.png"},
{id:84,n:"Equidia",s:"https://raw.githubusercontent.com/Paradise-91/ParaTV/main/streams/equidia/live2.m3u8",c:"french",q:"HD",src:"Français",v:3416,d:"Equidia - En vivo",clr:"#1565C0",logo:"/icons/ch84.png"},
{id:85,n:"Brionnais TV",s:"https://stream2.mandarine.media/brionnaistv/brionnaistv/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3415,d:"Brionnais TV - En vivo",clr:"#1565C0",logo:"/icons/ch85.png"},
{id:86,n:"TV7 Colmar",s:"https://tv7.live-kd.com/live/tv7/livestream/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3414,d:"TV7 Colmar - En vivo",clr:"#1565C0",logo:"/icons/ch86.png"},
{id:87,n:"Espace TV",s:"https://edge11.vedge.infomaniak.com/livecast/ik:espacetv/manifest.m3u8",c:"french",q:"HD",src:"Français",v:3413,d:"Espace TV - En vivo",clr:"#1565C0",logo:"/icons/ch87.png"},
{id:88,n:"Chamber TV",s:"https://media02.webtvlive.eu/chd-edge/smil:chamber_tv_hd.smil/playlist.m3u8",c:"french",q:"HD",src:"Français",v:3412,d:"Chamber TV - En vivo",clr:"#1565C0",logo:"/icons/ch88.png"},
{id:89,n:"Disney Channel",s:"http://151.80.18.177:86/Disney_Channel_HD/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3411,d:"Disney Channel - En vivo",clr:"#F57C00",logo:"/icons/ch89.png"},
{id:90,n:"Disney Jr.",s:"http://151.80.18.177:86/Disney_Junior_HD/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3410,d:"Disney Jr. - En vivo",clr:"#F57C00",logo:"/icons/ch90.png"},
{id:91,n:"Nickelodeon",s:"http://151.80.18.177:86/Nickelodeon_FR/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3409,d:"Nickelodeon - En vivo",clr:"#F57C00",logo:"/icons/ch91.png"},
{id:92,n:"Nickelodeon Junior",s:"http://151.80.18.177:86/Nickelodeon_Junior/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3408,d:"Nickelodeon Junior - En vivo",clr:"#F57C00",logo:"/icons/ch92.png"},
{id:93,n:"Nickelodeon en español",s:"https://jmp2.uk/plu-5d8d08395f39465da6fb3ec4.m3u8",c:"kids",q:"HD",src:"Kids",v:3407,d:"Nickelodeon en español - En vivo",clr:"#F57C00",logo:"/icons/ch93.png"},
{id:94,n:"PBS Kids",s:"https://livestream.pbskids.org/out/v1/14507d931bbe48a69287e4850e53443c/est.m3u8",c:"kids",q:"HD",src:"Kids",v:3406,d:"PBS Kids - En vivo",clr:"#F57C00",logo:"/icons/ch94.png"},
{id:95,n:"BabyTV Spain",s:"https://xykt-fix.github.io/iptv/streams/SP88/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3405,d:"BabyTV Spain - En vivo",clr:"#F57C00",logo:"/icons/ch95.png"},
{id:96,n:"Babyfirst",s:"https://jmp2.uk/plu-5f4fb4cf605ddf000748e16f.m3u8",c:"kids",q:"HD",src:"Kids",v:3404,d:"Babyfirst - En vivo",clr:"#F57C00",logo:"/icons/ch96.png"},
{id:97,n:"KiKA",s:"https://kikahls.akamaized.net/hls/live/2022690/livetvkika_ww/master.m3u8",c:"kids",q:"HD",src:"Kids",v:3403,d:"KiKA - En vivo",clr:"#F57C00",logo:"/icons/ch97.png"},
{id:98,n:"Clan TVE",s:"https://ztnr.rtve.es/ztnr/5466990.m3u8",c:"kids",q:"HD",src:"Kids",v:3402,d:"Clan TVE - En vivo",clr:"#F57C00",logo:"/icons/ch98.png"},
{id:99,n:"Clan Internacional Americas",s:"https://rtvelivestream-rtveplayplus.rtve.es/rtvesec/int/clan_int_main_1080.m3u8",c:"kids",q:"HD",src:"Kids",v:3401,d:"Clan Internacional Americas - En vivo",clr:"#F57C00",logo:"/icons/ch99.png"},
{id:100,n:"13 Kids",s:"https://origin.dpsgo.com/ssai/event/LhHrVtyeQkKZ-Ye_xEU75g/master.m3u8",c:"kids",q:"HD",src:"Kids",v:3400,d:"13 Kids - En vivo",clr:"#F57C00",logo:"/icons/ch100.png"},
{id:101,n:"BeJoy.kids",s:"https://64b16f23efbee.streamlock.net/bejoy/bejoy/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3399,d:"BeJoy.kids - En vivo",clr:"#F57C00",logo:"/icons/ch101.png"},
{id:102,n:"Pokémon",s:"https://jmp2.uk/plu-6683cd71a1d7ad000866ec6a.m3u8",c:"kids",q:"HD",src:"Kids",v:3398,d:"Pokémon - En vivo",clr:"#F57C00",logo:"/icons/ch102.png"},
{id:103,n:"Tom And Jerry",s:"https://live20.bozztv.com/giatvplayout7/giatv-208314/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3397,d:"Tom And Jerry - En vivo",clr:"#F57C00",logo:"/icons/ch103.png"},
{id:104,n:"Teletubbies",s:"https://dv8lsrd8fecw9.cloudfront.net/master.m3u8",c:"kids",q:"HD",src:"Kids",v:3396,d:"Teletubbies - En vivo",clr:"#F57C00",logo:"/icons/ch104.png"},
{id:105,n:"SpongeBob Schwammkopf",s:"https://jmp2.uk/plu-5d00e8adaab96b5635b2a005.m3u8",c:"kids",q:"HD",src:"Kids",v:3395,d:"SpongeBob Schwammkopf - En vivo",clr:"#F57C00",logo:"/icons/ch105.png"},
{id:106,n:"Avatar",s:"https://jmp2.uk/plu-600adbdf8c554e00072125c9.m3u8",c:"kids",q:"HD",src:"Kids",v:3394,d:"Avatar - En vivo",clr:"#F57C00",logo:"/icons/ch106.png"},
{id:107,n:"Garfield and Friends",s:"https://jmp2.uk/plu-60faf9ddfcc1f200070a5932.m3u8",c:"kids",q:"HD",src:"Kids",v:3393,d:"Garfield and Friends - En vivo",clr:"#F57C00",logo:"/icons/ch107.png"},
{id:108,n:"El Chavo TV",s:"https://live20.bozztv.com/giatvplayout7/giatv-211465/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3392,d:"El Chavo TV - En vivo",clr:"#F57C00",logo:"/icons/ch108.png"},
{id:109,n:"HappyKids",s:"https://dil9xdvretp0f.cloudfront.net/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3391,d:"HappyKids - En vivo",clr:"#F57C00",logo:"/icons/ch109.png"},
{id:110,n:"Moonbug Kids",s:"https://moonbug-rokuus.amagi.tv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3390,d:"Moonbug Kids - En vivo",clr:"#F57C00",logo:"/icons/ch110.png"},
{id:111,n:"Kartoon Channel",s:"https://lightning-fnf-samsungaus.amagi.tv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3389,d:"Kartoon Channel - En vivo",clr:"#F57C00",logo:"/icons/ch111.png"},
{id:112,n:"KidsFlix",s:"https://stream-us-east-1.getpublica.com/playlist.m3u8?network_id=50",c:"kids",q:"HD",src:"Kids",v:3388,d:"KidsFlix - En vivo",clr:"#F57C00",logo:"/icons/ch112.png"},
{id:113,n:"LEGO Kids TV",s:"https://jmp2.uk/plu-60fb01a24795a6000762fe83.m3u8",c:"kids",q:"HD",src:"Kids",v:3387,d:"LEGO Kids TV - En vivo",clr:"#F57C00",logo:"/icons/ch113.png"},
{id:114,n:"The LEGO Channel",s:"https://dltiqboxjw21d.cloudfront.net/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3386,d:"The LEGO Channel - En vivo",clr:"#F57C00",logo:"/icons/ch114.png"},
{id:115,n:"Baby Shark TV",s:"https://c0c65b821b3542c3a4dca92702f59944.mediatailor.us-east-1.amazonaws.com/v1/master/04fd913bb278d8775298c26fdca9d9841f37601f/RakutenTV-eu_BabySharkTV/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3385,d:"Baby Shark TV - En vivo",clr:"#F57C00",logo:"/icons/ch115.png"},
{id:116,n:"Brat TV",s:"https://streams2.sofast.tv/v1/master/611d79b11b77e2f571934fd80ca1413453772ac7/04072b68-dc6a-4d5e-98af-f356ba8d5063/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3384,d:"Brat TV - En vivo",clr:"#F57C00",logo:"/icons/ch116.png"},
{id:117,n:"Forever Kids",s:"https://jmp2.uk/plu-56171fafada51f8004c4b40f.m3u8",c:"kids",q:"HD",src:"Kids",v:3383,d:"Forever Kids - En vivo",clr:"#F57C00",logo:"/icons/ch117.png"},
{id:118,n:"RiC",s:"https://rictv.iptv-playoutcenter.de/rictv/rictv-web/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3382,d:"RiC - En vivo",clr:"#F57C00",logo:"/icons/ch118.png"},
{id:119,n:"TiJi",s:"https://stream8.cinerama.uz/1441/tracks-v1a1/mono.m3u8",c:"kids",q:"HD",src:"Kids",v:3381,d:"TiJi - En vivo",clr:"#F57C00",logo:"/icons/ch119.png"},
{id:120,n:"Gulli Girl",s:"https://stream8.cinerama.uz/1445/tracks-v1a1/mono.m3u8",c:"kids",q:"HD",src:"Kids",v:3380,d:"Gulli Girl - En vivo",clr:"#F57C00",logo:"/icons/ch120.png"},
{id:121,n:"Minimax",s:"https://vodzong.mjunoon.tv:8087/streamtest/disckids-157-1/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3379,d:"Minimax - En vivo",clr:"#F57C00",logo:"/icons/ch121.png"},
{id:122,n:"Carousel",s:"http://31.148.48.15/Karusel_HD/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3378,d:"Carousel - En vivo",clr:"#F57C00",logo:"/icons/ch122.png"},
{id:123,n:"TRT Çocuk",s:"https://tv-trtcocuk.medya.trt.com.tr/master.m3u8",c:"kids",q:"HD",src:"Kids",v:3377,d:"TRT Çocuk - En vivo",clr:"#F57C00",logo:"/icons/ch123.png"},
{id:124,n:"Balapan TV",s:"https://balapantv-stream.qazcdn.com/balapantv/balapantv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3376,d:"Balapan TV - En vivo",clr:"#F57C00",logo:"/icons/ch124.png"},
{id:125,n:"Chinola TV",s:"https://tv.wracanal10.com:3300/live/chinolatvlive.m3u8",c:"kids",q:"HD",src:"Kids",v:3375,d:"Chinola TV - En vivo",clr:"#F57C00",logo:"/icons/ch125.png"},
{id:126,n:"Dios Te Ve Kids",s:"https://s.emisoras.tv:8081/diostevekids/index.m3u8",c:"kids",q:"HD",src:"Kids",v:3374,d:"Dios Te Ve Kids - En vivo",clr:"#F57C00",logo:"/icons/ch126.png"},
{id:127,n:"Kuriakos Kids",s:"https://w2.manasat.com/kkids/smil:kkids.smil/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3373,d:"Kuriakos Kids - En vivo",clr:"#F57C00",logo:"/icons/ch127.png"},
{id:128,n:"Roya Kids",s:"https://playlist.fasttvcdn.com/pl/ptllxjd03j6g9oxxjdfapg/roya-kids/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3372,d:"Roya Kids - En vivo",clr:"#F57C00",logo:"/icons/ch128.png"},
{id:129,n:"Banijay Mr Bean Animé",s:"https://amg00627-amg00627c31-rakuten-fr-3991.playouts.now.amagi.tv/playlist/amg00627-banijayfast-mrbeanfrcc-rakutenfr/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3371,d:"Banijay Mr Bean Animé - En vivo",clr:"#F57C00",logo:"/icons/ch129.png"},
{id:130,n:"Mr. Bean Anime Spain",s:"https://amg00627-amg00627c30-rakuten-es-3990.playouts.now.amagi.tv/playlist/amg00627-banijayfast-mrbeanescc-rakutenes/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3370,d:"Mr. Bean Anime Spain - En vivo",clr:"#F57C00",logo:"/icons/ch130.png"},
{id:131,n:"Turma da Mônica",s:"https://jmp2.uk/plu-5f997e44949bc70007a6941e.m3u8",c:"kids",q:"HD",src:"Kids",v:3369,d:"Turma da Mônica - En vivo",clr:"#F57C00",logo:"/icons/ch131.png"},
{id:132,n:"O Reino Infantil",s:"https://jmp2.uk/plu-5f5c216df68f920007888315.m3u8",c:"kids",q:"HD",src:"Kids",v:3368,d:"O Reino Infantil - En vivo",clr:"#F57C00",logo:"/icons/ch132.png"},
{id:133,n:"Sabrina The Teenage Witch",s:"https://jmp2.uk/plu-66276091cee0d900085fe053.m3u8",c:"kids",q:"HD",src:"Kids",v:3367,d:"Sabrina The Teenage Witch - En vivo",clr:"#F57C00",logo:"/icons/ch133.png"},
{id:134,n:"Ninja Kidz",s:"https://d3868b4ny0rgdf.cloudfront.net/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3366,d:"Ninja Kidz - En vivo",clr:"#F57C00",logo:"/icons/ch134.png"},
{id:135,n:"SKWAD",s:"https://stream-us-east-1.getpublica.com/playlist.m3u8?network_id=71",c:"kids",q:"HD",src:"Kids",v:3365,d:"SKWAD - En vivo",clr:"#F57C00",logo:"/icons/ch135.png"},
{id:136,n:"Totally Turtles",s:"https://jmp2.uk/plu-5d6792bd6be2998ad0ccce30.m3u8",c:"kids",q:"HD",src:"Kids",v:3364,d:"Totally Turtles - En vivo",clr:"#F57C00",logo:"/icons/ch136.png"},
{id:137,n:"Pluto TV Kids",s:"https://jmp2.uk/plu-5ad8d54be738977e2c310940.m3u8",c:"kids",q:"HD",src:"Kids",v:3363,d:"Pluto TV Kids - En vivo",clr:"#F57C00",logo:"/icons/ch137.png"},
{id:138,n:"Pluto TV Junior",s:"https://jmp2.uk/plu-5f12141b146d760007934ea7.m3u8",c:"kids",q:"HD",src:"Kids",v:3362,d:"Pluto TV Junior - En vivo",clr:"#F57C00",logo:"/icons/ch138.png"},
{id:139,n:"Pluto TV Retro Toons",s:"https://jmp2.uk/plu-5c5c2b9d8002db3c3e0b1c6d.m3u8",c:"kids",q:"HD",src:"Kids",v:3361,d:"Pluto TV Retro Toons - En vivo",clr:"#F57C00",logo:"/icons/ch139.png"},
{id:140,n:"Super Simple Songs",s:"https://janson-supersimplesongs-1-us.roku.wurl.tv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3360,d:"Super Simple Songs - En vivo",clr:"#F57C00",logo:"/icons/ch140.png"},
{id:141,n:"Ryan and Friends",s:"https://ryanandfriends-samsungau.amagi.tv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3359,d:"Ryan and Friends - En vivo",clr:"#F57C00",logo:"/icons/ch141.png"},
{id:142,n:"Zoo Moo (Australia)",s:"https://zoomoo-samsungau.amagi.tv/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3358,d:"Zoo Moo (Australia) - En vivo",clr:"#F57C00",logo:"/icons/ch142.png"},
{id:143,n:"ToonGoggles",s:"https://amg01329-otterainc-toongoggles-samsungau-ad-4c.amagi.tv/playlist/amg01329-otterainc-toongoggles-samsungau/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3357,d:"ToonGoggles - En vivo",clr:"#F57C00",logo:"/icons/ch143.png"},
{id:144,n:"NickToons Brasil",s:"https://stmv2.srvif.com/nicktoons/nicktoons/playlist.m3u8",c:"kids",q:"HD",src:"Kids",v:3356,d:"NickToons Brasil - En vivo",clr:"#F57C00",logo:"/icons/ch144.png"},
{id:145,n:"Nickelodeon Clássico",s:"https://jmp2.uk/plu-6824ce10c5d53e1351ceb8d1.m3u8",c:"kids",q:"HD",src:"Kids",v:3355,d:"Nickelodeon Clássico - En vivo",clr:"#F57C00",logo:"/icons/ch145.png"},
{id:146,n:"Nickelodeon Pluto TV",s:"https://jmp2.uk/plu-5ca673e0d0bd6c2689c94ce3.m3u8",c:"kids",q:"HD",src:"Kids",v:3354,d:"Nickelodeon Pluto TV - En vivo",clr:"#F57C00",logo:"/icons/ch146.png"},
{id:147,n:"Deluxe Music",s:"https://sdn-global-live-streaming-packager-cache.3qsdn.com/13456/13456_264_live.m3u8",c:"music",q:"HD",src:"Music",v:3353,d:"Deluxe Music - En vivo",clr:"#AD1457",logo:"/icons/ch147.png"},
{id:148,n:"Deluxe Rap",s:"https://sdn-global-live-streaming-packager-cache.3qsdn.com/65183/65183_264_live.m3u8",c:"music",q:"HD",src:"Music",v:3352,d:"Deluxe Rap - En vivo",clr:"#AD1457",logo:"/icons/ch148.png"},
{id:149,n:"Deluxe Dance",s:"https://sdn-global-live-streaming-packager-cache.3qsdn.com/64733/64733_264_live.m3u8",c:"music",q:"HD",src:"Music",v:3351,d:"Deluxe Dance - En vivo",clr:"#AD1457",logo:"/icons/ch149.png"},
{id:150,n:"MTV Biggest Pop",s:"https://jmp2.uk/plu-6047fbdbbb776a0007e7f2ff.m3u8",c:"music",q:"HD",src:"Music",v:3350,d:"MTV Biggest Pop - En vivo",clr:"#AD1457",logo:"/icons/ch150.png"},
{id:151,n:"MTV Spankin\' New",s:"https://jmp2.uk/plu-5d14fdb8ca91eedee1633117.m3u8",c:"music",q:"HD",src:"Music",v:3349,d:"MTV Spankin\' New - En vivo",clr:"#AD1457",logo:"/icons/ch151.png"},
{id:152,n:"NOW 70s",s:"https://lightning-now70s-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-lightning-now70s-rakuten/CDN/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3348,d:"NOW 70s - En vivo",clr:"#AD1457",logo:"/icons/ch152.png"},
{id:153,n:"NOW 80s",s:"https://lightning-now80s-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-lightning-now80s-rakuten/CDN/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3347,d:"NOW 80s - En vivo",clr:"#AD1457",logo:"/icons/ch153.png"},
{id:154,n:"NOW 90s00s",s:"https://amg01076-amg01076c19-rakuten-gb-8653.playouts.now.amagi.tv/playlist/amg01076-lightning-now90s00s-rakutengb/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3346,d:"NOW 90s00s - En vivo",clr:"#AD1457",logo:"/icons/ch154.png"},
{id:155,n:"NOW Rock",s:"https://lightning-now90s-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-lightning-now90s-rakuten/CDN/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3345,d:"NOW Rock - En vivo",clr:"#AD1457",logo:"/icons/ch155.png"},
{id:156,n:"Best of Dance TV",s:"https://m1b2.worldcast.tv/dancetelevisionone/dancetelevisionone.m3u8",c:"music",q:"HD",src:"Music",v:3344,d:"Best of Dance TV - En vivo",clr:"#AD1457",logo:"/icons/ch156.png"},
{id:157,n:"DanceTV EDM Mainstage",s:"https://mbit1.worldcast.tv/dancetelevisionseven/multibit.m3u8",c:"music",q:"HD",src:"Music",v:3343,d:"DanceTV EDM Mainstage - En vivo",clr:"#AD1457",logo:"/icons/ch157.png"},
{id:158,n:"DanceTV Deep House District",s:"https://m1b2.worldcast.tv/dancetelevisiontwo/dancetelevisiontwo.m3u8",c:"music",q:"HD",src:"Music",v:3342,d:"DanceTV Deep House District - En vivo",clr:"#AD1457",logo:"/icons/ch158.png"},
{id:159,n:"DanceTV Techno Warehouse",s:"https://m2b2.worldcast.tv:7443/dancetelevisionthree/dancetelevisionthree.m3u8",c:"music",q:"HD",src:"Music",v:3341,d:"DanceTV Techno Warehouse - En vivo",clr:"#AD1457",logo:"/icons/ch159.png"},
{id:160,n:"DanceTV House Floor",s:"https://m2b2.worldcast.tv:7443/dancetelevisionfive/dancetelevisionfive.m3u8",c:"music",q:"HD",src:"Music",v:3340,d:"DanceTV House Floor - En vivo",clr:"#AD1457",logo:"/icons/ch160.png"},
{id:161,n:"Stingray Classic Rock",s:"https://lotus.stingray.com/manifest/ose-101ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3339,d:"Stingray Classic Rock - En vivo",clr:"#AD1457",logo:"/icons/ch161.png"},
{id:162,n:"Stingray Hit List",s:"https://lotus.stingray.com/manifest/ose-107ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3338,d:"Stingray Hit List - En vivo",clr:"#AD1457",logo:"/icons/ch162.png"},
{id:163,n:"Stingray Hot Country",s:"https://lotus.stingray.com/manifest/ose-108ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3337,d:"Stingray Hot Country - En vivo",clr:"#AD1457",logo:"/icons/ch163.png"},
{id:164,n:"Stingray Flashback 70s",s:"https://lotus.stingray.com/manifest/ose-115ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3336,d:"Stingray Flashback 70s - En vivo",clr:"#AD1457",logo:"/icons/ch164.png"},
{id:165,n:"Stingray Remember the 80s",s:"https://lotus.stingray.com/manifest/ose-128ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3335,d:"Stingray Remember the 80s - En vivo",clr:"#AD1457",logo:"/icons/ch165.png"},
{id:166,n:"Stingray Rock Alternative",s:"https://lotus.stingray.com/manifest/ose-102ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3334,d:"Stingray Rock Alternative - En vivo",clr:"#AD1457",logo:"/icons/ch166.png"},
{id:167,n:"Stingray Euro Hits",s:"https://lotus.stingray.com/manifest/ose-214ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3333,d:"Stingray Euro Hits - En vivo",clr:"#AD1457",logo:"/icons/ch167.png"},
{id:168,n:"Stingray Smooth Jazz",s:"https://lotus.stingray.com/manifest/ose-140ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3332,d:"Stingray Smooth Jazz - En vivo",clr:"#AD1457",logo:"/icons/ch168.png"},
{id:169,n:"Stingray Naturescape",s:"https://d39g1vxj2ef6in.cloudfront.net/v1/master/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod-rakuten-stitched/master.m3u8?ads.xumo_channelId=88883056",c:"music",q:"HD",src:"Music",v:3331,d:"Stingray Naturescape - En vivo",clr:"#AD1457",logo:"/icons/ch169.png"},
{id:170,n:"Vevo 70s",s:"https://amg00056-vevotv-vevo70saunz-samsungau-xzszd.amagi.tv/playlist/amg00056-vevotv-vevo70saunz-samsungau/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3330,d:"Vevo 70s - En vivo",clr:"#AD1457",logo:"/icons/ch170.png"},
{id:171,n:"Vevo 80s",s:"https://amg00056-vevotv-vevo80saunz-samsungau-rp5e3.amagi.tv/playlist/amg00056-vevotv-vevo80saunz-samsungau/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3329,d:"Vevo 80s - En vivo",clr:"#AD1457",logo:"/icons/ch171.png"},
{id:172,n:"Vevo 90s",s:"https://amg00056-vevotv-vevo90saunz-samsungau-n6a0d.amagi.tv/playlist/amg00056-vevotv-vevo90saunz-samsungau/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3328,d:"Vevo 90s - En vivo",clr:"#AD1457",logo:"/icons/ch172.png"},
{id:173,n:"Stingray DJAZZ",s:"https://lotus.stingray.com/manifest/djazz-djaads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3327,d:"Stingray DJAZZ - En vivo",clr:"#AD1457",logo:"/icons/ch173.png"},
{id:174,n:"Stingray Classica",s:"https://lotus.stingray.com/manifest/classica-cla008-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3326,d:"Stingray Classica - En vivo",clr:"#AD1457",logo:"/icons/ch174.png"},
{id:175,n:"Stingray CMusic",s:"https://lotus.stingray.com/manifest/cmusic-cme004-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3325,d:"Stingray CMusic - En vivo",clr:"#AD1457",logo:"/icons/ch175.png"},
{id:176,n:"Stingray Karaoke",s:"https://lotus.stingray.com/manifest/karaoke-kar000-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3324,d:"Stingray Karaoke - En vivo",clr:"#AD1457",logo:"/icons/ch176.png"},
{id:177,n:"Stingray Pop Adult",s:"https://lotus.stingray.com/manifest/ose-104ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3323,d:"Stingray Pop Adult - En vivo",clr:"#AD1457",logo:"/icons/ch177.png"},
{id:178,n:"Stingray Soul Storm",s:"https://lotus.stingray.com/manifest/ose-134ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3322,d:"Stingray Soul Storm - En vivo",clr:"#AD1457",logo:"/icons/ch178.png"},
{id:179,n:"Stingray The Spa",s:"https://lotus.stingray.com/manifest/ose-122ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3321,d:"Stingray The Spa - En vivo",clr:"#AD1457",logo:"/icons/ch179.png"},
{id:180,n:"Stingray Urban Beat",s:"https://lotus.stingray.com/manifest/ose-133ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3320,d:"Stingray Urban Beat - En vivo",clr:"#AD1457",logo:"/icons/ch180.png"},
{id:181,n:"Stingray Today\'s Latin Pop",s:"https://lotus.stingray.com/manifest/ose-190ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3319,d:"Stingray Today\'s Latin Pop - En vivo",clr:"#AD1457",logo:"/icons/ch181.png"},
{id:182,n:"Stingray Nothin\' But 90s",s:"https://lotus.stingray.com/manifest/ose-142ads-montreal/samsungtvplus/master.m3u8",c:"music",q:"HD",src:"Music",v:3318,d:"Stingray Nothin\' But 90s - En vivo",clr:"#AD1457",logo:"/icons/ch182.png"},
{id:183,n:"Stingray Greatest Hits",s:"https://d39g1vxj2ef6in.cloudfront.net/v1/master/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod-rakuten-stitched/master.m3u8?ads.xumo_channelId=88883053",c:"music",q:"HD",src:"Music",v:3317,d:"Stingray Greatest Hits - En vivo",clr:"#AD1457",logo:"/icons/ch183.png"},
{id:184,n:"13 Festival",s:"https://origin.dpsgo.com/ssai/event/Nftd0fM2SXasfDlRphvUsg/master.m3u8",c:"music",q:"HD",src:"Music",v:3316,d:"13 Festival - En vivo",clr:"#AD1457",logo:"/icons/ch184.png"},
{id:185,n:"EnerGeek Radio",s:"https://backend.energeek.cl/webtv/egradioweb/index.m3u8?token=ZZDemoIPTVGH",c:"music",q:"HD",src:"Music",v:3315,d:"EnerGeek Radio - En vivo",clr:"#AD1457",logo:"/icons/ch185.png"},
{id:186,n:"FM Mundo",s:"https://video2.makrodigital.com/fmmundo/fmmundo/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3314,d:"FM Mundo - En vivo",clr:"#AD1457",logo:"/icons/ch186.png"},
{id:187,n:"El Sol Network TV",s:"https://tv.wracanal10.com:3025/live/elsoltvlive.m3u8",c:"music",q:"HD",src:"Music",v:3313,d:"El Sol Network TV - En vivo",clr:"#AD1457",logo:"/icons/ch187.png"},
{id:188,n:"Cumbia Mix",s:"https://cloud.tvomix.com/CUMBIAMIX/index.m3u8",c:"music",q:"HD",src:"Music",v:3312,d:"Cumbia Mix - En vivo",clr:"#AD1457",logo:"/icons/ch188.png"},
{id:189,n:"La Kalle",s:"https://mdstrm.com/live-stream-playlist/58d191f07290fbb058025843.m3u8",c:"music",q:"HD",src:"Music",v:3311,d:"La Kalle - En vivo",clr:"#AD1457",logo:"/icons/ch189.png"},
{id:190,n:"Sol Música",s:"https://d2glyu450vvghm.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-21u4g5cjglv02/sm.m3u8",c:"music",q:"HD",src:"Music",v:3310,d:"Sol Música - En vivo",clr:"#AD1457",logo:"/icons/ch190.png"},
{id:191,n:"Kronehit",s:"https://bitcdn-kronehit.bitmovin.com/v2/hls/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3309,d:"Kronehit - En vivo",clr:"#AD1457",logo:"/icons/ch191.png"},
{id:192,n:"CMC TV",s:"https://stream.cmctv.hr:49998/cmc/live.m3u8",c:"music",q:"HD",src:"Music",v:3308,d:"CMC TV - En vivo",clr:"#AD1457",logo:"/icons/ch192.png"},
{id:193,n:"Óčko",s:"https://ocko-live-dash.ssl.cdn.cra.cz/cra_live2/ocko.stream.1.smil/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3307,d:"Óčko - En vivo",clr:"#AD1457",logo:"/icons/ch193.png"},
{id:194,n:"Óčko Gold",s:"https://ocko-live.ssl.cdn.cra.cz/channels/ocko_gold/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3306,d:"Óčko Gold - En vivo",clr:"#AD1457",logo:"/icons/ch194.png"},
{id:195,n:"Óčko Expres",s:"https://ocko-live.ssl.cdn.cra.cz/channels/ocko_expres/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3305,d:"Óčko Expres - En vivo",clr:"#AD1457",logo:"/icons/ch195.png"},
{id:196,n:"KRAL Pop TV",s:"https://dogus-live.daioncdn.net/kralpoptv/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3304,d:"KRAL Pop TV - En vivo",clr:"#AD1457",logo:"/icons/ch196.png"},
{id:197,n:"TRT Müzik",s:"https://tv-trtmuzik.medya.trt.com.tr/master.m3u8",c:"music",q:"HD",src:"Music",v:3303,d:"TRT Müzik - En vivo",clr:"#AD1457",logo:"/icons/ch197.png"},
{id:198,n:"Power Türk Akustik",s:"https://livetv.powerapp.com.tr/pturkakustik/akustik.smil/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3302,d:"Power Türk Akustik - En vivo",clr:"#AD1457",logo:""},
{id:199,n:"Qwest TV",s:"https://qwestjazz-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-qwestjazz-rakuten/CDN/master.m3u8",c:"music",q:"HD",src:"Music",v:3301,d:"Qwest TV - En vivo",clr:"#AD1457",logo:""},
{id:200,n:"Qello Concerts by Stingray",s:"https://d39g1vxj2ef6in.cloudfront.net/v1/master/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod-rakuten-stitched/master.m3u8?ads.xumo_channelId=88883052",c:"music",q:"HD",src:"Music",v:3300,d:"Qello Concerts by Stingray - En vivo",clr:"#AD1457",logo:""},
{id:201,n:"Retro Music Television",s:"https://stream.mediawork.cz/retrotv/retrotvHQ1/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3299,d:"Retro Music Television - En vivo",clr:"#AD1457",logo:""},
{id:202,n:"Europa Plus TV",s:"http://31.148.48.15/Europa_Plus_HD/index.m3u8",c:"music",q:"HD",src:"Music",v:3298,d:"Europa Plus TV - En vivo",clr:"#AD1457",logo:""},
{id:203,n:"RU.TV",s:"https://bl.rutube.ru/livestream/b1eb8e90d7e636677b3eb73b4fcbb717/index.m3u8?s=d-E-bxKy2v3EEJ94RQX9CA&e=2069285076&scheme=https",c:"music",q:"HD",src:"Music",v:3297,d:"RU.TV - En vivo",clr:"#AD1457",logo:""},
{id:204,n:"JooMusic",s:"https://livecdn.live247stream.com/joomusic/tv/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3296,d:"JooMusic - En vivo",clr:"#AD1457",logo:""},
{id:205,n:"Navahang TV",s:"https://hls.navahang.live/hls/stream.m3u8",c:"music",q:"HD",src:"Music",v:3295,d:"Navahang TV - En vivo",clr:"#AD1457",logo:""},
{id:206,n:"Persiana Music",s:"https://musichls.persiana.live/hls/stream.m3u8",c:"music",q:"HD",src:"Music",v:3294,d:"Persiana Music - En vivo",clr:"#AD1457",logo:""},
{id:207,n:"PMC",s:"https://pmchls.wns.live/hls/stream.m3u8",c:"music",q:"HD",src:"Music",v:3293,d:"PMC - En vivo",clr:"#AD1457",logo:""},
{id:208,n:"PMC Royale",s:"https://pmcrohls.wns.live/hls/stream.m3u8",c:"music",q:"HD",src:"Music",v:3292,d:"PMC Royale - En vivo",clr:"#AD1457",logo:""},
{id:209,n:"Radio Javan TV",s:"https://rjtvhls.wns.live/hls/stream.m3u8",c:"music",q:"HD",src:"Music",v:3291,d:"Radio Javan TV - En vivo",clr:"#AD1457",logo:""},
{id:210,n:"Aghani Aghani TV",s:"https://cdn.streamlane.tv/hls/aghanitv/index.m3u8",c:"music",q:"HD",src:"Music",v:3290,d:"Aghani Aghani TV - En vivo",clr:"#AD1457",logo:""},
{id:211,n:"Dream Türk",s:"https://live.duhnet.tv/S2/HLS_LIVE/dreamturknp/playlist.m3u8",c:"music",q:"HD",src:"Music",v:3289,d:"Dream Türk - En vivo",clr:"#AD1457",logo:""}
];
var CATS=[{id:"all",label:"Todos",icon:"fa-globe"},{id:"movies",label:"Peliculas",icon:"fa-film"},{id:"french",label:"Francais",icon:"fa-flag"},{id:"kids",label:"Ninos",icon:"fa-child"},{id:"music",label:"Musica",icon:"fa-music"}];
var CAT_GRAD={news:'linear-gradient(135deg,#1a237e 0%,#0d47a1 50%,#01579b 100%)',sports:'linear-gradient(135deg,#1b5e20 0%,#2e7d32 50%,#388e3c 100%)',movies:'linear-gradient(135deg,#311b92 0%,#4a148c 50%,#6a1b9a 100%)',entertainment:'linear-gradient(135deg,#bf360c 0%,#d84315 50%,#e65100 100%)',music:'linear-gradient(135deg,#880e4f 0%,#ad1457 50%,#c2185b 100%)',kids:'linear-gradient(135deg,#e65100 0%,#f57c00 50%,#ff9800 100%)',french:'linear-gradient(135deg,#0d47a1 0%,#1565c0 50%,#1976d2 100%)',documentary:'linear-gradient(135deg,#263238 0%,#37474f 50%,#455a64 100%)',religious:'linear-gradient(135deg,#4a148c 0%,#6a1b9a 50%,#7b1fa2 100%)',general:'linear-gradient(135deg,#004d40 0%,#00695c 50%,#00796b 100%)'};
var CAT_ICON={news:'fa-newspaper',sports:'fa-futbol',movies:'fa-film',entertainment:'fa-star',music:'fa-music',kids:'fa-child',french:'fa-flag',documentary:'fa-book-open',religious:'fa-pray',general:'fa-tv'};

var curFilter='all',curCh=null,hlsInst=null,heroIdx=0,heroIv=null;
var retryCount=0,MAX_RETRIES=3,playerRetryTimer=null;
var audioCtx=null,soundEnabled=true;
try{soundEnabled=localStorage.getItem('edge-sound')!=='off';}catch(e){}

// Smart features: Continue Watching + Stream Quality Scoring
var streamScores={};
try{streamScores=JSON.parse(localStorage.getItem('edge-scores')||'{}');}catch(e){streamScores={};}
function saveScores(){try{localStorage.setItem('edge-scores',JSON.stringify(streamScores));}catch(e){}}
function getScore(id){return streamScores[id]||{ok:0,fail:0};}
function markOk(id){var s=getScore(id);s.ok++;streamScores[id]=s;saveScores();}
function markFail(id){var s=getScore(id);s.fail++;streamScores[id]=s;saveScores();}
function scoreLabel(id){var s=getScore(id);if(s.ok===0&&s.fail===0)return'new';var r=s.ok/(s.ok+s.fail);if(r>=0.7)return'stable';if(r>=0.3)return'unstable';return'broken';}

var continueW=[];
try{continueW=JSON.parse(localStorage.getItem('edge-cw')||'[]');}catch(e){continueW=[];}
function saveCW(){try{localStorage.setItem('edge-cw',JSON.stringify(continueW.slice(0,20)));}catch(e){}}
function addToCW(ch){
  continueW=continueW.filter(function(c){return c.id!==ch.id;});
  continueW.unshift({id:ch.id,n:ch.n,c:ch.c,clr:ch.clr,ts:Date.now()});
  if(continueW.length>20)continueW=continueW.slice(0,20);
  saveCW();
  renderContinueWatching();
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtV(v){return v>=1000?(v/1000).toFixed(1)+'K':v.toString();}
function catLabel(c){for(var i=0;i<CATS.length;i++){if(CATS[i].id===c)return CATS[i].label;}return c;}
function ini(n){return n.replace(/[^A-Za-z0-9]/g,'').substring(0,2).toUpperCase();}

// Poster/Thumbnail system: real images for every channel
function getPlutoId(ch){var m=ch.s.match(/plu-([a-f0-9]+)/i);return m?m[1]:null;}
function getPosterUrl(ch){
  if(ch.poster)return ch.poster;
  // Pluto TV channels: use full poster-quality featured image instead of just logo
  var pid=getPlutoId(ch);
  if(pid)return'https://images.pluto.tv/channels/'+pid+'/featuredImage.jpg';
  return'';
}
function getLogoUrl(ch){
  if(ch.logo)return ch.logo;
  var pid=getPlutoId(ch);
  if(pid)return'https://images.pluto.tv/channels/'+pid+'/colorLogoPNG.png';
  return'';
}
function getHeroBgUrl(ch){
  if(ch.poster)return ch.poster;
  var pid=getPlutoId(ch);
  if(pid)return'https://images.pluto.tv/channels/'+pid+'/featuredImage.jpg';
  return'';
}
// Channel-specific thematic images (by channel name keywords)
var CH_POSTERS={
  'action':'https://images.unsplash.com/photo-1535016120720-40c646be5580?w=600&h=400&fit=crop',
  'adrenalina':'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&h=400&fit=crop',
  'comedia':'https://images.unsplash.com/photo-1527224857830-43a7acc85260?w=600&h=400&fit=crop',
  'terror':'https://images.unsplash.com/photo-1509248961895-40b5adb63568?w=600&h=400&fit=crop',
  'horror':'https://images.unsplash.com/photo-1509248961895-40b5adb63568?w=600&h=400&fit=crop',
  'romance':'https://images.unsplash.com/photo-1518199266791-5375a83190b7?w=600&h=400&fit=crop',
  'romantico':'https://images.unsplash.com/photo-1518199266791-5375a83190b7?w=600&h=400&fit=crop',
  'drama':'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop',
  'thriller':'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=600&h=400&fit=crop',
  'western':'https://images.unsplash.com/photo-1495312040802-a929cd14a6ab?w=600&h=400&fit=crop',
  'crime':'https://images.unsplash.com/photo-1474314005122-3c07c4df1224?w=600&h=400&fit=crop',
  'classic':'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=600&h=400&fit=crop',
  'clasico':'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=600&h=400&fit=crop',
  'premiere':'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&h=400&fit=crop',
  'cult':'https://images.unsplash.com/photo-1535016120720-40c646be5580?w=600&h=400&fit=crop',
  'spotlight':'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?w=600&h=400&fit=crop',
  'sony':'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&h=400&fit=crop',
  'paramount':'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop',
  'lionsgate':'https://images.unsplash.com/photo-1535016120720-40c646be5580?w=600&h=400&fit=crop',
  'charge':'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&h=400&fit=crop',
  'dust':'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop',
  'alien':'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop',
  'indie':'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=600&h=400&fit=crop',
  'gravitas':'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop',
  'filmax':'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&h=400&fit=crop',
  'friki':'https://images.unsplash.com/photo-1535016120720-40c646be5580?w=600&h=400&fit=crop',
  'runtime':'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop',
  'bet':'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&h=400&fit=crop',
  'flicks':'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&h=400&fit=crop',
  'sphere':'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop',
  'dome':'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&h=400&fit=crop',
  'france':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'french':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'tv5':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'bfm':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'rtl':'https://images.unsplash.com/photo-1550340499-a6c60fc8287c?w=600&h=400&fit=crop',
  'euronews':'https://images.unsplash.com/photo-1504711434969-e33886168d6c?w=600&h=400&fit=crop',
  'africanews':'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop',
  'equidia':'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?w=600&h=400&fit=crop',
  'disney':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'nickelodeon':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'nick':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'pbs':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'kids':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'baby':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'pokemon':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'tom and jerry':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'teletubbies':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'spongebob':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'avatar':'https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop',
  'garfield':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'chavo':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'lego':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'shark':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'turtle':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'ninja':'https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop',
  'sabrina':'https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop',
  'bean':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'monica':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'reino':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'kika':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'clan':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'minimax':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'carousel':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'trt':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'balapan':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'south park':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'one piece':'https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop',
  'caillou':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'cartoon':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'toon':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'retro':'https://images.unsplash.com/photo-1472162072942-cd5147eb3902?w=600&h=400&fit=crop',
  'ryan':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'zoo':'https://images.unsplash.com/photo-1474511320723-9a56873571b7?w=600&h=400&fit=crop',
  'brat':'https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop',
  'simple':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'moonbug':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'happy':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'kartoon':'https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop',
  'kidsflix':'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
  'deluxe':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'rap':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'dance':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'mtv':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'now 70':'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=400&fit=crop',
  'now 80':'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=400&fit=crop',
  'now 90':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'rock':'https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=600&h=400&fit=crop',
  'stingray':'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=600&h=400&fit=crop',
  'vevo':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'jazz':'https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=600&h=400&fit=crop',
  'classica':'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=600&h=400&fit=crop',
  'karaoke':'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=400&fit=crop',
  'concert':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'qwest':'https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=600&h=400&fit=crop',
  'festival':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'energeek':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'cumbia':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'kalle':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'sol':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'musica':'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=600&h=400&fit=crop',
  'kronehit':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'retro':'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=400&fit=crop',
  'europa':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'trace':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'fashion':'https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=600&h=400&fit=crop',
  'voyage':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'clubbing':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'zylo':'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=600&h=400&fit=crop',
  'kral':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'power':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'muzik':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'navahang':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'persiana':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'pmc':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'javan':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'aghani':'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop',
  'dream':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'tiji':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'gulli':'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop',
  'dock':'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop',
  'spain':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop',
  'africa':'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop',
  'medi':'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop'
};
function getChPoster(ch){
  var pid=getPlutoId(ch);
  if(pid)return'https://images.pluto.tv/channels/'+pid+'/featuredImage.jpg';
  var nl=ch.n.toLowerCase();
  for(var k in CH_POSTERS){if(nl.indexOf(k)>=0)return CH_POSTERS[k];}
  return'';
}
// Category-specific background images for fallback
var CAT_BG={
  movies:['https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1535016120720-40c646be5580?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1594909122845-11baa439b7bf?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=600&h=400&fit=crop'],
  french:['https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1550340499-a6c60fc8287c?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1504711434969-e33886168d6c?w=600&h=400&fit=crop'],
  kids:['https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1519457431-44ccd64a579b?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1472162072942-cd5147eb3902?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&h=400&fit=crop'],
  music:['https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=600&h=400&fit=crop','https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=600&h=400&fit=crop']
};
function getCatBg(ch){
  var arr=CAT_BG[ch.c];
  if(!arr||!arr.length)return'';
  var idx=0;for(var i=0;i<ch.n.length;i++)idx=(idx+ch.n.charCodeAt(i))%arr.length;
  return arr[idx];
}
// Build card background style: channel poster > category image > gradient
function cardBgStyle(ch){
  var poster=getPosterUrl(ch)||getChPoster(ch);
  var catBg=getCatBg(ch);
  var cg=CAT_GRAD[ch.c]||CAT_GRAD.news;
  if(poster)return'background:url('+poster+') center/cover,no-repeat,'+cg;
  if(catBg)return'background:url('+catBg+') center/cover,no-repeat,'+cg;
  return'background:'+cg;
}
// Build hero background style
function heroBgStyle(ch){
  var heroBg=getHeroBgUrl(ch)||getChPoster(ch);
  var catBg=getCatBg(ch);
  var cg=CAT_GRAD[ch.c]||CAT_GRAD.news;
  if(heroBg)return'background:url('+heroBg+') center/cover,no-repeat,'+cg;
  if(catBg)return'background:url('+catBg+') center/cover,no-repeat,'+cg;
  return'background:'+cg;
}

// Logo: img with data attrs, fix broken ones via JS after render (NO inline onerror)
function logoImg(ch,cls){var lu=getLogoUrl(ch);return lu?'<img class="'+cls+'" src="'+lu+'" alt="'+esc(ch.n)+'" data-clr="'+ch.clr+'" data-ini="'+ini(ch.n)+'">':'';}
function logoFB(ch,cls,sz){var s=sz||56,fs=Math.round(s*0.39),br=Math.round(s*0.25);return '<div class="'+cls+'" style="width:'+s+'px;height:'+s+'px;border-radius:'+br+'px;background:'+ch.clr+';color:#fff;font-size:'+fs+'px;font-weight:900;display:none;align-items:center;justify-content:center;font-family:var(--font-display);letter-spacing:1px">'+ini(ch.n)+'</div>';}

function fixLogos(){
  var imgs=document.querySelectorAll('img[data-clr]');
  for(var i=0;i<imgs.length;i++){(function(img){
    if(img.naturalWidth===0&&img.complete){swapFB(img);}
    else{img.addEventListener('error',function(){swapFB(img);},{once:true});}
  })(imgs[i]);}
}
function swapFB(img){
  var p=img.parentNode;if(!p)return;
  var fb=p.querySelector('.ch-logo-fb,.oa-logo-fb,.tr-logo-fb,.slide-logo-fb');
  if(fb){fb.style.display='flex';}
  img.style.display='none';
}

function initAudio(){try{audioCtx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}}
function playBlip(){if(!audioCtx||!soundEnabled)return;try{var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.type='sine';o.frequency.setValueAtTime(880,audioCtx.currentTime);o.frequency.exponentialRampToValueAtTime(440,audioCtx.currentTime+0.1);g.gain.setValueAtTime(0.08,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.1);o.start(audioCtx.currentTime);o.stop(audioCtx.currentTime+0.1);}catch(e){}}
function playClick(){if(!audioCtx||!soundEnabled)return;try{var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.type='sine';o.frequency.setValueAtTime(1200,audioCtx.currentTime);o.frequency.exponentialRampToValueAtTime(600,audioCtx.currentTime+0.05);g.gain.setValueAtTime(0.03,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.05);o.start(audioCtx.currentTime);o.stop(audioCtx.currentTime+0.05);}catch(e){}}
document.addEventListener('click',function fc(){if(!audioCtx)initAudio();document.removeEventListener('click',fc);},{once:true});
function killSplash(){var s=document.getElementById('splash');if(s)s.classList.add('hide');}

function renderCats(){var el=document.getElementById('cat-filter');if(!el)return;var h='';for(var i=0;i<CATS.length;i++){var c=CATS[i];var cnt=c.id==='all'?CHANNELS.length:CHANNELS.filter(function(ch){return ch.c===c.id;}).length;h+='<button data-cat="'+c.id+'" class="'+(c.id===curFilter?'active':'')+'"><i class="fas '+c.icon+'"></i> '+c.label+' ('+cnt+')</button>';}el.innerHTML=h;}

function renderSkeletons(){var g=document.getElementById('channels-grid');if(!g)return;var h='';for(var i=0;i<12;i++)h+='<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-body"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>';g.innerHTML=h;}

function renderGrid(){
  var grid=document.getElementById('channels-grid');if(!grid)return;
  var list=curFilter==='all'?CHANNELS:CHANNELS.filter(function(ch){return ch.c===curFilter;});
  var ce=document.getElementById('ch-count');if(ce)ce.textContent=list.length+' channels';
  if(!list.length){grid.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">No se encontraron canales</div>';return;}
  var h='';
  for(var i=0;i<list.length;i++){var ch=list[i],cg=CAT_GRAD[ch.c]||CAT_GRAD.news,ci=CAT_ICON[ch.c]||'fa-tv';
    var sl=scoreLabel(ch.id),sc=getScore(ch.id);
    var scoreHtml=sl==='new'?'<span class="ch-score untested"><i class="fas fa-circle" style="font-size:5px"></i> NEW</span>':sl==='stable'?'<span class="ch-score stable"><i class="fas fa-check-circle" style="font-size:7px"></i> '+Math.round(sc.ok/(sc.ok+sc.fail)*100)+'%</span>':sl==='unstable'?'<span class="ch-score unstable"><i class="fas fa-exclamation-circle" style="font-size:7px"></i> '+Math.round(sc.ok/(sc.ok+sc.fail)*100)+'%</span>':'';
    h+='<div class="ch-card" data-id="'+ch.id+'"><div class="ch-thumb"><div class="ch-thumb-img" style="'+cardBgStyle(ch)+'"></div><div class="ch-mini-preview" style="background:linear-gradient(45deg,'+ch.clr+'22,'+ch.clr+'44,'+ch.clr+'22)"></div><div class="ch-thumb-overlay"></div><i class="fas '+ci+' ch-thumb-icon"></i>'+logoImg(ch,'ch-logo')+logoFB(ch,'ch-logo-fb')+'<div class="ch-thumb-label">'+esc(ch.n)+'</div><span class="live-badge">LIVE</span>'+scoreHtml+'<span class="ch-viewers"><i class="fas fa-eye"></i> '+fmtV(ch.v)+'</span><span class="ch-cat-tag">'+catLabel(ch.c)+'</span><div class="ch-play"><i class="fas fa-play"></i></div></div><div class="ch-body"><div class="ch-name">'+esc(ch.n)+'</div><div class="ch-desc">'+esc(ch.d)+'</div></div></div>';}
  grid.innerHTML=h;setTimeout(fixLogos,100);
}

function setupLazyLoad(){
  if(!('IntersectionObserver' in window)){var cards=document.querySelectorAll('.ch-card');for(var i=0;i<cards.length;i++)cards[i].classList.add('visible');return;}
  var obs=new IntersectionObserver(function(e){for(var i=0;i<e.length;i++){if(e[i].isIntersecting){e[i].target.classList.add('visible');obs.unobserve(e[i].target);}}},{threshold:0.1,rootMargin:'50px'});
  var cards=document.querySelectorAll('.ch-card');for(var i=0;i<cards.length;i++)obs.observe(cards[i]);
}

function renderHero(){
  var feat=CHANNELS.slice().sort(function(a,b){return b.v-a.v;}).slice(0,5),se=document.getElementById('hero-slides'),de=document.getElementById('hero-dots');
  if(!se||!de)return;var sh='',dh='';
  for(var i=0;i<feat.length;i++){var ch=feat[i],ia=i===0?'active':'';
    sh+='<div class="hero-slide '+ia+'" data-idx="'+i+'"><div class="slide-bg" style="'+heroBgStyle(ch)+'"></div><div class="slide-grad"></div><div class="slide-grad2"></div><div class="slide-content"><div class="slide-label">NOW STREAMING</div>'+logoImg(ch,'slide-logo')+logoFB(ch,'slide-logo-fb',50)+'<h2 class="slide-title">'+esc(ch.n)+'</h2><p class="slide-desc">'+esc(ch.d)+'</p><div class="slide-meta"><span class="meta-badge dur"><i class="fas fa-clock" style="margin-right:3px"></i>24/7</span><span class="meta-badge qual">'+ch.q+'</span><span class="meta-badge cat">'+catLabel(ch.c)+'</span><span class="meta-badge src">'+esc(ch.src)+'</span></div><button class="btn-watch" data-id="'+ch.id+'"><i class="fas fa-play"></i> Watch Now</button></div></div>';
    dh+='<span data-idx="'+i+'" class="'+(i===0?'active':'')+'"></span>';}
  se.innerHTML=sh;de.innerHTML=dh;setTimeout(fixLogos,100);
}
function startHero(){heroIv=setInterval(function(){var sl=document.querySelectorAll('.hero-slide'),dt=document.querySelectorAll('.hero-dots span');if(!sl.length)return;sl[heroIdx].classList.remove('active');dt[heroIdx].classList.remove('active');heroIdx=(heroIdx+1)%sl.length;sl[heroIdx].classList.add('active');dt[heroIdx].classList.add('active');},6000);}
function goHero(idx){var sl=document.querySelectorAll('.hero-slide'),dt=document.querySelectorAll('.hero-dots span');if(!sl.length)return;sl[heroIdx].classList.remove('active');dt[heroIdx].classList.remove('active');heroIdx=idx%sl.length;sl[heroIdx].classList.add('active');dt[heroIdx].classList.add('active');}

function renderContinueWatching(){
  var sec=document.getElementById('continue-section'),scr=document.getElementById('cw-scroll'),cnt=document.getElementById('cw-count');
  if(!sec||!scr)return;
  // Only show channels that still exist
  continueW=continueW.filter(function(cw){return CHANNELS.find(function(ch){return ch.id===cw.id;});});
  if(!continueW.length){sec.style.display='none';return;}
  sec.style.display='block';
  if(cnt)cnt.textContent=continueW.length;
  var h='';
  for(var i=0;i<continueW.length;i++){var cw=continueW[i],ch=CHANNELS.find(function(x){return x.id===cw.id;});if(!ch)continue;
    var ci=CAT_ICON[ch.c]||'fa-tv',cg=CAT_GRAD[ch.c]||CAT_GRAD.news;
    var ago=Math.round((Date.now()-cw.ts)/60000);
    var timeStr=ago<1?'Ahora':ago<60?ago+'m':ago<1440?Math.round(ago/60)+'h':Math.round(ago/1440)+'d';
    h+='<div class="cw-card" data-id="'+ch.id+'"><div class="cw-thumb"><div class="cw-thumb-bg" style="'+cardBgStyle(ch)+'"></div><div class="cw-thumb-overlay"></div><i class="fas '+ci+' cw-icon"></i><div class="cw-play-sm"><i class="fas fa-play"></i></div></div><div class="cw-info"><div class="cw-name">'+esc(ch.n)+'</div><div class="cw-meta"><span><i class="fas fa-clock" style="font-size:8px;margin-right:3px"></i>'+timeStr+'</span><span>'+catLabel(ch.c)+'</span></div><div class="cw-progress"><div class="cw-progress-bar" style="width:'+(Math.random()*40+60)+'%"></div></div></div></div>';}
  scr.innerHTML=h;
}

function renderSidebar(){
  var ob=document.getElementById('on-air-body'),tb=document.getElementById('trending-body');
  var top=CHANNELS.slice().sort(function(a,b){return b.v-a.v;}).slice(0,6);
  if(ob){var oh='';for(var i=0;i<top.length;i++){var ch=top[i];oh+='<div class="on-air-ch" data-id="'+ch.id+'"><div class="oa-dot"></div>'+logoImg(ch,'oa-logo')+logoFB(ch,'oa-logo-fb',20)+'<span class="oa-name">'+esc(ch.n)+'</span><span class="oa-viewers">'+fmtV(ch.v)+'</span></div>';}ob.innerHTML=oh;}
  if(tb){var th='';for(var j=0;j<top.length;j++){var tc=top[j];th+='<div class="trending-item" data-id="'+tc.id+'"><span class="tr-rank">'+(j+1)+'</span>'+logoImg(tc,'tr-logo')+logoFB(tc,'tr-logo-fb',20)+'<span class="tr-name">'+esc(tc.n)+'</span><span class="tr-viewers">'+fmtV(tc.v)+'</span></div>';}tb.innerHTML=th;}
  setTimeout(fixLogos,100);
}

function renderUpcoming(){
  var el=document.getElementById('upcoming-scroll');if(!el)return;
  var cats=['news','sports','movies','entertainment','music','kids','documentary','international'],h='';
  for(var i=0;i<cats.length;i++){var chs=CHANNELS.filter(function(c){return c.c===cats[i];});if(!chs.length)continue;var pick=chs[Math.floor(Math.random()*chs.length)];var hrs=[18,19,20,21,22,23,0,1,2],hr=hrs[Math.floor(Math.random()*hrs.length)],ap=hr>=12?'PM':'AM',dp=hr===0?12:hr>12?hr-12:hr;
    h+='<div class="upcoming-card" data-id="'+pick.id+'"><div class="uc-cat">'+catLabel(pick.c)+'</div><div class="uc-name">'+esc(pick.n)+'</div><div class="uc-time">'+dp+':00 '+ap+'</div></div>';}
  el.innerHTML=h;
}

function openPlayer(ch){curCh=ch;retryCount=0;if(playerRetryTimer){clearTimeout(playerRetryTimer);playerRetryTimer=null;}var m=document.getElementById('player-modal'),v=document.getElementById('hls-video'),t=document.getElementById('player-title'),st=document.getElementById('player-status');if(t)t.textContent=ch.n;if(st){st.className='p-status connecting';st.textContent='CONNECTING';}if(m)m.classList.add('open');hideOffline();showSpinner();startStream(ch.s);document.body.style.overflow='hidden';addToCW(ch);predictivePreload(ch);var ms=document.getElementById('mistral-msg');if(ms)ms.textContent='Now playing: '+ch.n+'. Ask me for similar channels!';}

function startStream(origUrl){
  if(hlsInst){hlsInst.destroy();hlsInst=null;}
  var v=document.getElementById('hls-video');if(!v)return;v.removeAttribute('src');v.load();hideOffline();showSpinner();
  // Route through CORS proxy
  var proxyUrl=location.origin+'/proxy?url='+encodeURIComponent(origUrl);
  if(typeof Hls!=='undefined'&&Hls.isSupported()){
    hlsInst=new Hls({
      enableWorker:true,
      lowLatencyMode:false,
      maxBufferLength:30,
      maxMaxBufferLength:60,
      maxBufferSize:60*1024*1024,
      startFragPrefetch:true,
      progressive:true,
      manifestLoadingTimeOut:15000,
      manifestLoadingMaxRetry:4,
      levelLoadingTimeOut:15000,
      levelLoadingMaxRetry:4,
      fragLoadingTimeOut:15000,
      fragLoadingMaxRetry:4
    });
    hlsInst.loadSource(proxyUrl);hlsInst.attachMedia(v);
    hlsInst.on(Hls.Events.MANIFEST_PARSED,function(){v.play().catch(function(){});hideSpinner();setStatus('live');updateQuality();if(curCh)markOk(curCh.id);});
    hlsInst.on(Hls.Events.ERROR,function(ev,d){
      if(d.fatal){
        if(curCh)markFail(curCh.id);
        if(d.type===Hls.ErrorTypes.MEDIA_ERROR){
          hlsInst.recoverMediaError();
        }else if(d.type===Hls.ErrorTypes.NETWORK_ERROR){
          // Network errors get more retries before giving up
          if(retryCount<5){retryCount++;showToast('Reconnecting... ('+retryCount+')');hlsInst.startLoad();}else fatalErr(origUrl);
        }else{
          fatalErr(origUrl);
        }
      }
    });
  }else if(v.canPlayType('application/vnd.apple.mpegurl')){
    v.src=proxyUrl;v.addEventListener('loadedmetadata',function om(){v.play().catch(function(){});hideSpinner();setStatus('live');updateQuality();v.removeEventListener('loadedmetadata',om);});
  }
  v.onerror=function(){fatalErr(origUrl);};v.onwaiting=function(){showBuffer();};v.onplaying=function(){hideBuffer();hideSpinner();setStatus('live');};v.onloadedmetadata=function(){updateQuality();};
}
function fatalErr(url){if(retryCount<MAX_RETRIES){retryCount++;var d=Math.pow(2,retryCount)*1500;showToast('Reintentando en '+(d/1000)+'s...');if(playerRetryTimer)clearTimeout(playerRetryTimer);playerRetryTimer=setTimeout(function(){startStream(url);},d);}else tryNext();}
function tryNext(){if(!curCh){showOffline();return;}var same=CHANNELS.filter(function(ch){return ch.c===curCh.c&&ch.id!==curCh.id;});if(!same.length){showOffline();return;}var nx=same[0];showToast('Switching to: '+nx.n);retryCount=0;curCh=nx;var t=document.getElementById('player-title');if(t)t.textContent=nx.n;setStatus('connecting');hideOffline();showSpinner();startStream(nx.s);}
function closePlayer(){var m=document.getElementById('player-modal'),v=document.getElementById('hls-video');if(hlsInst){hlsInst.destroy();hlsInst=null;}if(v){v.pause();v.removeAttribute('src');v.load();}if(m)m.classList.remove('open');if(playerRetryTimer){clearTimeout(playerRetryTimer);playerRetryTimer=null;}document.body.style.overflow='';hideOffline();hideSpinner();hideBuffer();}
function setStatus(s){var e=document.getElementById('player-status');if(!e)return;e.className='p-status '+s;e.textContent=s==='live'?'LIVE':s==='connecting'?'CONNECTING':'OFFLINE';}
function showSpinner(){var e=document.getElementById('player-spinner');if(e)e.classList.add('show');}
function hideSpinner(){var e=document.getElementById('player-spinner');if(e)e.classList.remove('show');}
function showBuffer(){var e=document.getElementById('buffering-overlay');if(e)e.classList.add('show');}
function hideBuffer(){var e=document.getElementById('buffering-overlay');if(e)e.classList.remove('show');}
function showOffline(){var e=document.getElementById('offline-overlay');if(e)e.classList.add('show');setStatus('offline');hideSpinner();hideBuffer();}
function hideOffline(){var e=document.getElementById('offline-overlay');if(e)e.classList.remove('show');}
function updateQuality(){var v=document.getElementById('hls-video'),qi=document.getElementById('quality-indicator');if(!v||!qi)return;var w=v.videoWidth;qi.textContent=w>=2160?'4K':w>=1280?'HD':w>=720?'720p':'SD';qi.style.display='inline-block';}

var toastT=null;
function showToast(msg){var e=document.getElementById('toast');if(!e)return;e.textContent=msg;e.className='toast show';if(toastT)clearTimeout(toastT);toastT=setTimeout(function(){e.classList.remove('show');},3000);}

function toggleSound(){soundEnabled=!soundEnabled;try{localStorage.setItem('edge-sound',soundEnabled?'on':'off');}catch(e){}var b=document.getElementById('sound-toggle');if(b)b.innerHTML=soundEnabled?'<i class="fas fa-volume-up"></i>':'<i class="fas fa-volume-mute"></i>';if(soundEnabled&&!audioCtx)initAudio();showToast(soundEnabled?'Sound on':'Sound off');}

function doSearch(q){q=q.toLowerCase().trim();if(!q){curFilter='all';renderGrid();setupLazyLoad();renderCats();return;}var r=CHANNELS.filter(function(ch){return ch.n.toLowerCase().indexOf(q)>=0||ch.c.indexOf(q)>=0||ch.src.toLowerCase().indexOf(q)>=0||ch.d.toLowerCase().indexOf(q)>=0;});var g=document.getElementById('channels-grid'),ce=document.getElementById('ch-count');if(ce)ce.textContent=r.length+' results';if(!r.length){if(g)g.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">No results</div>';return;}var h='';for(var i=0;i<r.length;i++){var ch=r[i],ci=CAT_ICON[ch.c]||'fa-tv';var sl=scoreLabel(ch.id),sc=getScore(ch.id);var scoreHtml=sl==='new'?'':sl==='stable'?'<span class="ch-score stable"><i class="fas fa-check-circle" style="font-size:7px"></i> '+Math.round(sc.ok/(sc.ok+sc.fail)*100)+'%</span>':sl==='unstable'?'<span class="ch-score unstable"><i class="fas fa-exclamation-circle" style="font-size:7px"></i> '+Math.round(sc.ok/(sc.ok+sc.fail)*100)+'%</span>':'';h+='<div class="ch-card visible" data-id="'+ch.id+'"><div class="ch-thumb"><div class="ch-thumb-img" style="'+cardBgStyle(ch)+'"></div><div class="ch-mini-preview" style="background:linear-gradient(45deg,'+ch.clr+'22,'+ch.clr+'44,'+ch.clr+'22)"></div><div class="ch-thumb-overlay"></div><i class="fas '+ci+' ch-thumb-icon"></i>'+logoImg(ch,'ch-logo')+logoFB(ch,'ch-logo-fb')+'<div class="ch-thumb-label">'+esc(ch.n)+'</div><span class="live-badge">LIVE</span>'+scoreHtml+'<span class="ch-viewers"><i class="fas fa-eye"></i> '+fmtV(ch.v)+'</span><span class="ch-cat-tag">'+catLabel(ch.c)+'</span><div class="ch-play"><i class="fas fa-play"></i></div></div><div class="ch-body"><div class="ch-name">'+esc(ch.n)+'</div><div class="ch-desc">'+esc(ch.d)+'</div></div></div>';}if(g)g.innerHTML=h;setTimeout(fixLogos,100);}

function updateStats(){var c=document.getElementById('stat-ch'),h=document.getElementById('stat-hd');if(c)c.textContent=CHANNELS.length;if(h)h.textContent=CHANNELS.filter(function(ch){return ch.q==='1080p';}).length;}

function askMistral(q,ctx){
  var m=document.getElementById('mistral-msg');
  if(!m)return;
  m.innerHTML='<i class="fas fa-eye" style="margin-right:6px;color:var(--red)"></i>Analizando pantalla...';

  // Capture current video frame for vision analysis
  var video=document.getElementById('hls-video');
  var frame=null;
  if(video&&video.videoWidth>0){
    try{
      var c=document.createElement('canvas');
      var scale=0.5; // Higher quality capture (50% instead of 25%)
      c.width=Math.max(1,Math.floor(video.videoWidth*scale));
      c.height=Math.max(1,Math.floor(video.videoHeight*scale));
      var ctx2=c.getContext('2d');
      ctx2.drawImage(video,0,0,c.width,c.height);
      frame=c.toDataURL('image/jpeg',0.7).split(',')[1]; // Better JPEG quality
    }catch(e){frame=null;}
  }

  // Determine current channel context
  var channelName=curCh?curCh.n:'';
  var category=curCh?curCh.c:'default';
  var channelId=curCh?curCh.id:null;

  // Try Python Vision Engine first (has FFmpeg, pHash, Mistral Vision)
  var tryEngine=ENGINE_AVAILABLE!==false;
  if(ENGINE_AVAILABLE===false&&(Date.now()-ENGINE_CHECK_TIME>60000))tryEngine=true;
  if(tryEngine){
    try{
      var engineBody={question:q,channelName:channelName,category:category,channelId:channelId};
      if(frame)engineBody.frame=frame;
      var engineResp=await fetch(ENGINE_URL+'/api/vision-chat',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(engineBody),
        signal:AbortSignal.timeout(8000) // Reduced from 15s to 8s
      });
      if(engineResp.ok){
        var engineData=await engineResp.json();
        if(engineData&&engineData.response){
          ENGINE_AVAILABLE=true;
          var html='';
          if(engineData.source==='vision'){
            html='<i class="fas fa-eye" style="margin-right:4px;color:#ff9800;font-size:10px" title="Vision AI (Engine)"></i>';
          }else if(engineData.source==='tmdb_fallback'){
            html='<i class="fas fa-film" style="margin-right:4px;color:#2196f3;font-size:10px" title="TMDB (Engine)"></i>';
          }else{
            html='<i class="fas fa-microchip" style="margin-right:4px;color:#4caf50;font-size:10px" title="Python Engine"></i>';
          }
          html+=esc(engineData.response);
          m.innerHTML=html;
          return;
        }
      }
    }catch(e){
      ENGINE_AVAILABLE=false;
    }
  }

  // Fallback: Cloudflare Worker vision-chat
  var body={
    question:q,
    channelName:channelName,
    category:category,
    channelId:channelId
  };
  if(frame)body.frame=frame;

  fetch('/api/vision-chat',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  }).then(function(r){return r.json();}).then(function(d){
    if(d.response){
      var html='';
      if(d.source==='vision'){
        html='<i class="fas fa-eye" style="margin-right:4px;color:#ff9800;font-size:10px" title="Detectado por Vision AI"></i>';
      }else if(d.source==='tmdb_fallback'){
        html='<i class="fas fa-film" style="margin-right:4px;color:#2196f3;font-size:10px" title="Detectado por TMDB"></i>';
      }else if(d.source==='text_chat'){
        html='<i class="fas fa-comment" style="margin-right:4px;color:#4caf50;font-size:10px" title="Respuesta de texto"></i>';
      }
      html+=esc(d.response);
      m.innerHTML=html;
    }else if(d.error){
      m.innerHTML='<i class="fas fa-exclamation-triangle" style="margin-right:4px;color:#ff5722;font-size:10px"></i>'+esc(typeof d.error==='string'?d.error:JSON.stringify(d.error));
    }else{
      m.textContent='No se obtuvo respuesta.';
    }
  }).catch(function(){
    // Local fallback when API fails
    var ql=q.toLowerCase();
    var isContentQ=['que pelicula','que esta','que dan','que ponen','que serie','what movie','what playing','identifica','detecta'].some(function(k){return ql.indexOf(k)>=0;});
    if(isContentQ&&channelName){
      m.innerHTML='<i class="fas fa-film" style="margin-right:4px;color:#2196f3;font-size:10px"></i>Estas viendo: <strong>'+esc(channelName)+'</strong> ('+catLabel(category)+'). La vision AI requiere MISTRAL_API configurado.';
    }else{
      var mt=CHANNELS.filter(function(ch){return ch.n.toLowerCase().indexOf(ql)>=0||ch.c.indexOf(ql)>=0;}).slice(0,5);
      m.innerHTML=mt.length?'<i class="fas fa-search" style="margin-right:4px;color:#4caf50;font-size:10px"></i>Encontrado: '+mt.map(function(c){return '<strong>'+esc(c.n)+'</strong> ('+catLabel(c.c)+')';}).join(', '):'<i class="fas fa-times-circle" style="margin-right:4px;color:#ff5722;font-size:10px"></i>No encontrado. Prueba "terror" o "sports".';
    }
  });
}

// Predictive Preload: prefetch next channel's .m3u8 manifest
var preloaded={};
function predictivePreload(currentCh){
  var same=CHANNELS.filter(function(ch){return ch.c===currentCh.c&&ch.id!==currentCh.id;});
  if(!same.length)return;
  var next=same[0];
  if(preloaded[next.id])return;
  preloaded[next.id]=true;
  var proxyUrl=location.origin+'/proxy?url='+encodeURIComponent(next.s);
  // Just fetch the manifest to warm the cache - don't play
  fetch(proxyUrl,{method:'GET',mode:'cors'}).catch(function(){});
}

// Stream Alive Detection - quick HEAD check
function checkAlive(ch,callback){
  var proxyUrl=location.origin+'/proxy?url='+encodeURIComponent(ch.s);
  var ctrl=new AbortController();
  var timer=setTimeout(function(){ctrl.abort();callback(false);},5000);
  fetch(proxyUrl,{method:'GET',signal:ctrl.signal}).then(function(r){clearTimeout(timer);callback(r.ok);}).catch(function(){clearTimeout(timer);callback(false);});
}

function initApp(){try{renderCats();renderSkeletons();setTimeout(function(){renderGrid();setupLazyLoad();},150);renderHero();startHero();renderContinueWatching();renderSidebar();renderUpcoming();bindAll();updateStats();}catch(e){console.error('initApp:',e);}killSplash();}

function bindAll(){
  var catEl=document.getElementById('cat-filter');if(catEl)catEl.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;curFilter=b.getAttribute('data-cat');playClick();renderCats();renderGrid();setupLazyLoad();});
  var gridEl=document.getElementById('channels-grid');if(gridEl)gridEl.addEventListener('click',function(e){var c=e.target.closest('.ch-card');if(!c)return;var id=parseInt(c.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch){playClick();openPlayer(ch);}});
  var cwEl=document.getElementById('cw-scroll');if(cwEl)cwEl.addEventListener('click',function(e){var c=e.target.closest('.cw-card');if(!c)return;var id=parseInt(c.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch){playClick();openPlayer(ch);}});
  var hn=document.getElementById('hero-next'),hp=document.getElementById('hero-prev'),hd=document.getElementById('hero-dots'),hs=document.getElementById('hero-slides');
  if(hn)hn.addEventListener('click',function(){goHero(heroIdx+1);});if(hp)hp.addEventListener('click',function(){goHero(heroIdx-1<0?4:heroIdx-1);});
  if(hd)hd.addEventListener('click',function(e){var d=e.target.closest('span');if(!d)return;goHero(parseInt(d.getAttribute('data-idx')));});
  if(hs)hs.addEventListener('click',function(e){var b=e.target.closest('.btn-watch');if(!b)return;var id=parseInt(b.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch)openPlayer(ch);});
  var pc=document.getElementById('player-close'),pm=document.getElementById('player-modal');if(pc)pc.addEventListener('click',closePlayer);if(pm)pm.addEventListener('click',function(e){if(e.target===this)closePlayer();});
  var pp=document.getElementById('play-pause');if(pp)pp.addEventListener('click',function(){var v=document.getElementById('hls-video'),ic=this.querySelector('i');if(!v)return;if(v.paused){v.play().catch(function(){});ic.className='fas fa-pause';}else{v.pause();ic.className='fas fa-play';}});
  var vb=document.getElementById('vol-btn'),vs=document.getElementById('vol-slider');
  if(vb)vb.addEventListener('click',function(){var v=document.getElementById('hls-video'),ic=vb.querySelector('i');if(!v)return;if(v.muted){v.muted=false;vs.value=v.volume*100;ic.className='fas fa-volume-up';}else{v.muted=true;vs.value=0;ic.className='fas fa-volume-mute';}});
  if(vs)vs.addEventListener('input',function(){var v=document.getElementById('hls-video');if(!v)return;var val=parseInt(this.value);v.volume=val/100;v.muted=val===0;var ic=vb?vb.querySelector('i'):null;if(ic){if(val===0)ic.className='fas fa-volume-mute';else if(val<50)ic.className='fas fa-volume-down';else ic.className='fas fa-volume-up';}});
  var fsb=document.getElementById('fullscreen-btn');if(fsb)fsb.addEventListener('click',function(){var w=document.querySelector('.player-wrap');if(!w)return;if(document.fullscreenElement)document.exitFullscreen();else w.requestFullscreen().catch(function(){});});
  var ab=document.getElementById('audio-btn');if(ab)ab.addEventListener('click',function(){showToast('Audio selection coming soon');});
  var br=document.getElementById('btn-retry'),bs=document.getElementById('btn-switch');
  if(br)br.addEventListener('click',function(){if(!curCh)return;retryCount=0;hideOffline();showSpinner();setStatus('connecting');startStream(curCh.s);});
  if(bs)bs.addEventListener('click',function(){tryNext();});
  var stb=document.getElementById('search-toggle'),sb=document.getElementById('search-box'),si=document.getElementById('search-input');
  if(stb)stb.addEventListener('click',function(){if(sb){sb.classList.toggle('open');if(sb.classList.contains('open')&&si)si.focus();}});
  if(si)si.addEventListener('input',function(){doSearch(this.value);});
  var sdb=document.getElementById('sound-toggle');if(sdb)sdb.addEventListener('click',toggleSound);if(sdb&&soundEnabled)sdb.innerHTML='<i class="fas fa-volume-up"></i>';
  var tids=['on-air-toggle','trending-toggle','mistral-toggle'];for(var t=0;t<tids.length;t++){(function(tid){var el=document.getElementById(tid);if(el)el.addEventListener('click',function(){this.classList.toggle('collapsed');var bd=this.nextElementSibling;if(bd)bd.classList.toggle('collapsed');});})(tids[t]);}
  var oab=document.getElementById('on-air-body');if(oab)oab.addEventListener('click',function(e){var it=e.target.closest('.on-air-ch');if(!it)return;var id=parseInt(it.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch)openPlayer(ch);});
  var trb=document.getElementById('trending-body');if(trb)trb.addEventListener('click',function(e){var it=e.target.closest('.trending-item');if(!it)return;var id=parseInt(it.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch)openPlayer(ch);});
  var ucs=document.getElementById('upcoming-scroll');if(ucs)ucs.addEventListener('click',function(e){var c=e.target.closest('.upcoming-card');if(!c)return;var id=parseInt(c.getAttribute('data-id')),ch=CHANNELS.find(function(x){return x.id===id;});if(ch)openPlayer(ch);});
  var nls=document.querySelectorAll('header nav a');for(var n=0;n<nls.length;n++){nls[n].addEventListener('click',function(e){e.preventDefault();for(var j=0;j<nls.length;j++)nls[j].classList.remove('active');this.classList.add('active');var nv=this.getAttribute('data-nav');curFilter=nv==='sports'?'sports':nv==='news'?'news':'all';renderCats();renderGrid();setupLazyLoad();var cs=document.getElementById('channels-section');if(cs)window.scrollTo({top:cs.offsetTop-80,behavior:'smooth'});});}
  var msd=document.getElementById('mistral-send'),msi=document.getElementById('mistral-input');
  if(msd)msd.addEventListener('click',function(){if(msi&&msi.value.trim())askMistral(msi.value.trim(),curCh?curCh.n+' ('+catLabel(curCh.c)+')':'');if(msi)msi.value='';});
  if(msi)msi.addEventListener('keydown',function(e){if(e.key==='Enter'){if(this.value.trim())askMistral(this.value.trim(),curCh?curCh.n+' ('+catLabel(curCh.c)+')':'');this.value='';}});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closePlayer();});
}

try{initApp();}catch(e){console.error('BOOT:',e);killSplash();}
})();

// ============================================================
// EDGE Vision Engine v5 - Autonomous Metadata Worker
// Pipeline: Stream → FFmpeg → pHash → Mistral Vision → TMDB → DB
// Engine runs at localhost:8900 — autonomous, silent, not a chatbot
// Falls back to Cloudflare Worker when engine unavailable
// ============================================================
(function(){
'use strict';

var ENGINE_URL='http://localhost:8900'; // Python Vision Engine
var ENGINE_AVAILABLE=null; // null=unknown, true=available, false=unavailable
var ENGINE_CHECK_TIME=0; // Last engine availability check timestamp
var nowPlayingData={};
var detectInterval=null;
var currentChannel=null;
var lastFrameHash=null;
var sceneChangeCount=0;
var detectionStats={total:0,bySource:{metadata:0,epg:0,vision:0,ocr:0,clip:0}};

// Channel priority intervals (seconds) - matches backend EDGE_CONFIG
var PRIORITY_INTERVALS={
  sports:15,movies:30,series:45,news:120,music:90,kids:60,french:60,default:60
};

function computeFrameHash(frameB64){
  if(!frameB64)return null;
  var hash=0;
  var step=Math.max(1,Math.floor(frameB64.length/256));
  for(var i=0;i<frameB64.length;i+=step){
    hash=((hash<<5)-hash+frameB64.charCodeAt(i))|0;
  }
  return hash.toString(36);
}

function captureFrame(video,quality){
  if(!video||!video.videoWidth)return null;
  try{
    var c=document.createElement('canvas');
    var scale=0.5; // Improved: 50% scale for better vision accuracy
    c.width=Math.max(1,Math.floor(video.videoWidth*scale));
    c.height=Math.max(1,Math.floor(video.videoHeight*scale));
    var ctx=c.getContext('2d');
    ctx.drawImage(video,0,0,c.width,c.height);
    // Enhanced quality: minimum 0.6 JPEG quality for better OCR/vision
    var q=quality||0.6;
    if(q<0.6)q=0.6;
    return c.toDataURL('image/jpeg',q).split(',')[1];
  }catch(e){return null;}
}

async function detectChannel(ch,force){
  if(!ch)return;
  var video=document.getElementById('hls-video');
  var frame=captureFrame(video,0.6);
  var frameHash=computeFrameHash(frame);

  // Scene change detection - skip if scene hasn't changed (unless forced)
  if(!force&&lastFrameHash&&frameHash===lastFrameHash){
    return nowPlayingData[ch.id]||null;
  }

  // Update scene tracking
  if(frameHash&&frameHash!==lastFrameHash){
    sceneChangeCount++;
    lastFrameHash=frameHash;
  }

  var body={channelId:String(ch.id),category:ch.c||'default'};
  if(frame)body.frame=frame;
  body.metadata={title:ch.n,genre:[catLabel(ch.c)]};

  // Try Python Vision Engine first (has FFmpeg, pHash, Mistral Vision)
  // Only attempt if engine is known available or not yet checked
  var tryEngine=ENGINE_AVAILABLE!==false;
  // Re-check engine availability every 60 seconds
  if(ENGINE_AVAILABLE===false&&(Date.now()-ENGINE_CHECK_TIME>60000)){
    tryEngine=true;
  }
  if(tryEngine){
    try{
      var engineResp=await fetch(ENGINE_URL+'/api/channel/'+String(ch.id),{
        method:'GET',
        headers:{'Content-Type':'application/json'},
        signal:AbortSignal.timeout(2000) // Fast check - 2s timeout
      });
      if(engineResp.ok){
        var engineData=await engineResp.json();
        ENGINE_AVAILABLE=true;
        ENGINE_CHECK_TIME=Date.now();
        // Engine has metadata for this channel
        if(engineData&&engineData.success&&engineData.data&&engineData.data.currentTitle){
          var data={
            title:engineData.data.currentTitle,
            type:engineData.data.currentType||'unknown',
            year:engineData.data.currentYear,
            poster:engineData.data.currentPoster,
            backdrop:engineData.data.currentBackdrop,
            overview:engineData.data.currentOverview,
            rating:engineData.data.currentRating,
            confidence:engineData.data.confidence||0,
            source:engineData.data.source||'engine',
            tmdb_id:engineData.data.currentTmdbId
          };
          nowPlayingData[ch.id]=data;
          detectionStats.total++;
          if(data.source)detectionStats.bySource[data.source]=(detectionStats.bySource[data.source]||0)+1;
          updateNowPlayingUI(ch.id,data);
          return data;
        }
        // No metadata yet - trigger detection via engine
        var detectResp=await fetch(ENGINE_URL+'/api/detect',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(body),
          signal:AbortSignal.timeout(8000)
        });
        if(detectResp.ok){
          var detData=await detectResp.json();
          if(detData&&detData.success&&detData.data&&detData.data.currentTitle){
            var rd={
              title:detData.data.currentTitle,
              type:detData.data.currentType||'unknown',
              year:detData.data.currentYear,
              poster:detData.data.currentPoster,
              backdrop:detData.data.currentBackdrop,
              overview:detData.data.currentOverview,
              rating:detData.data.currentRating,
              confidence:detData.data.confidence||0,
              source:detData.data.source||'engine',
              tmdb_id:detData.data.currentTmdbId
            };
            nowPlayingData[ch.id]=rd;
            detectionStats.total++;
            updateNowPlayingUI(ch.id,rd);
            return rd;
          }
        }
      }
    }catch(e){
      ENGINE_AVAILABLE=false;
      ENGINE_CHECK_TIME=Date.now();
    }
  }

  // Fallback: Cloudflare Worker detection pipeline
  try{
    var resp=await fetch('/api/detect',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    var data=await resp.json();
    if(data&&data.title){
      nowPlayingData[ch.id]=data;
      detectionStats.total++;
      if(data.source)detectionStats.bySource[data.source]=(detectionStats.bySource[data.source]||0)+1;
      updateNowPlayingUI(ch.id,data);
    }
    return data;
  }catch(e){console.warn('Detect error:',e);}
  return null;
}

function updateNowPlayingUI(channelId,data){
  // Update channel card if visible
  var card=document.querySelector('.ch-card[data-id="'+channelId+'"]');
  if(card){
    var existing=card.querySelector('.ch-now-playing');
    if(existing)existing.remove();
    var np=document.createElement('div');
    np.className='ch-now-playing';
    var html='<span class="np-dot"></span>';
    if(data.poster)html+='<img class="np-poster" src="'+data.poster+'" alt="" loading="lazy">';
    html+='<span class="np-title">'+esc(data.title)+'</span>';
    if(data.type&&data.type!=='unknown')html+='<span class="np-type">'+data.type+'</span>';
    if(data.source)html+='<span class="np-source" title="Fuente: '+getSourceLabel(data.source)+'">'+getSourceIcon(data.source)+'</span>';
    np.innerHTML=html;
    var bodyEl=card.querySelector('.ch-body');
    if(bodyEl)bodyEl.appendChild(np);
  }

  // Update player now-playing with enriched data
  var pnp=document.getElementById('player-now-playing');
  if(pnp&&currentChannel&&currentChannel.id==channelId){
    pnp.style.display='flex';
    var poster=document.getElementById('pnp-poster');
    var title=document.getElementById('pnp-title');
    var type=document.getElementById('pnp-type');
    var conf=document.getElementById('pnp-confidence');
    var yearEl=document.getElementById('pnp-year');
    var ratingEl=document.getElementById('pnp-rating');
    var overviewEl=document.getElementById('pnp-overview');
    var backdropEl=document.getElementById('pnp-backdrop');

    if(poster){
      if(data.poster){poster.src=data.poster;poster.style.display='block';}
      else{poster.style.display='none';}
    }
    if(title)title.textContent=data.title||'-';
    if(type)type.textContent=(data.type||'unknown').toUpperCase();
    if(conf){
      var parts=[Math.round(data.confidence*100)+'%'];
      if(data.source)parts.push(getSourceLabel(data.source));
      conf.textContent=parts.join(' · ');
    }
    if(yearEl)yearEl.textContent=data.year||'';
    if(ratingEl){
      if(data.rating){ratingEl.innerHTML='<i class="fas fa-star"></i> '+data.rating.toFixed(1);ratingEl.style.display='flex';}
      else{ratingEl.style.display='none';}
    }
    if(overviewEl)overviewEl.textContent=data.overview||'';
    if(backdropEl){
      if(data.backdrop){backdropEl.style.backgroundImage='url('+data.backdrop+')';backdropEl.style.display='block';}
      else{backdropEl.style.display='none';}
    }
  }
}

function getSourceIcon(source){
  var icons={metadata:'<i class="fas fa-tag" style="font-size:8px;color:#4caf50"></i>',
    epg:'<i class="fas fa-calendar" style="font-size:8px;color:#2196f3"></i>',
    vision:'<i class="fas fa-eye" style="font-size:8px;color:#ff9800"></i>'};
  return icons[source]||'';
}

function getSourceLabel(source){
  var labels={metadata:'Metadata',epg:'EPG',vision:'AI Vision'};
  return labels[source]||source;
}

async function autoDetect(){
  if(!currentChannel)return;
  await detectChannel(currentChannel);
}

function getDetectInterval(ch){
  var cat=(ch.c||'default').toLowerCase();
  return (PRIORITY_INTERVALS[cat]||60)*1000;
}

// Hook into player open
var origOpenPlayer=window.openPlayer;
window.openPlayer=function(ch){
  currentChannel=ch;
  lastFrameHash=null;
  sceneChangeCount=0;
  if(origOpenPlayer)origOpenPlayer(ch);

  // Clear previous
  var pnp=document.getElementById('player-now-playing');
  if(pnp)pnp.style.display='none';
  var backdropEl=document.getElementById('pnp-backdrop');
  if(backdropEl)backdropEl.style.display='none';

  // Notify autonomous engine that user entered this channel
  if(ENGINE_AVAILABLE!==false){
    var proxyUrl=location.origin+'/proxy?url='+encodeURIComponent(ch.s);
    fetch(ENGINE_URL+'/api/channel/activate',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        channelId:String(ch.id),
        channelName:ch.n||'',
        category:ch.c||'default',
        streamUrl:proxyUrl
      }),
      signal:AbortSignal.timeout(2000)
    }).then(function(r){
      if(r.ok)ENGINE_AVAILABLE=true;
    }).catch(function(){ENGINE_AVAILABLE=false;ENGINE_CHECK_TIME=Date.now();});
  }

  // Start auto-detection with channel-specific interval
  if(detectInterval)clearInterval(detectInterval);
  setTimeout(function(){autoDetect();},6000);
  detectInterval=setInterval(function(){autoDetect();},getDetectInterval(ch));
};

// Hook into player close
var origClosePlayer=window.closePlayer;
window.closePlayer=function(){
  // Notify autonomous engine that user left the channel
  if(currentChannel&&ENGINE_AVAILABLE!==false){
    fetch(ENGINE_URL+'/api/channel/deactivate',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channelId:String(currentChannel.id)}),
      signal:AbortSignal.timeout(2000)
    }).catch(function(){});
  }
  currentChannel=null;
  lastFrameHash=null;
  if(detectInterval){clearInterval(detectInterval);detectInterval=null;}
  var pnp=document.getElementById('player-now-playing');
  if(pnp)pnp.style.display='none';
  var backdropEl=document.getElementById('pnp-backdrop');
  if(backdropEl)backdropEl.style.display='none';
  if(origClosePlayer)origClosePlayer();
};

// Manual detect button
document.addEventListener('DOMContentLoaded',function(){
  var db=document.getElementById('detect-btn');
  if(db)db.addEventListener('click',function(){
    if(currentChannel){
      showToast('Detectando contenido...');
      detectChannel(currentChannel,true).then(function(d){
        if(d&&d.title)showToast('Detectado: '+d.title+(d.source?' ('+getSourceLabel(d.source)+')':''));
        else showToast('No se pudo detectar el contenido');
      });
    }
  });
});

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function catLabel(c){var cats=[{id:'movies',label:'Peliculas'},{id:'francais',label:'Francais'},{id:'kids',label:'Ninos'},{id:'music',label:'Musica'},{id:'news',label:'Noticias'}];for(var i=0;i<cats.length;i++){if(cats[i].id===c)return cats[i].label;}return c;}

function showToast(msg){
  var t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},3000);
}

// Load now-playing for visible channel cards on scroll
var npObserver=new IntersectionObserver(function(entries){
  entries.forEach(function(entry){
    if(entry.isIntersecting){
      var card=entry.target;
      var id=parseInt(card.getAttribute('data-id'));
      if(id&&!nowPlayingData[id]){
        var ch=CHANNELS.find(function(x){return x.id===id;});
        if(ch){
          fetch('/api/now-playing?channelId='+id).then(function(r){return r.json();}).then(function(d){
            if(d&&d.title){
              nowPlayingData[id]=d;
              updateNowPlayingUI(id,d);
            }
          }).catch(function(){});
        }
      }
    }
  });
},{rootMargin:'200px'});

// Batch detection for visible cards (first load)
var batchTimer=null;
function scheduleBatchDetect(){
  if(batchTimer)clearTimeout(batchTimer);
  batchTimer=setTimeout(function(){
    var visible=[];
    var cards=document.querySelectorAll('.ch-card[data-id]');
    for(var i=0;i<Math.min(cards.length,30);i++){
      var id=parseInt(cards[i].getAttribute('data-id'));
      if(id&&!nowPlayingData[id])visible.push(String(id));
    }
    if(visible.length>0){
      fetch('/api/batch-detect',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({channelIds:visible})
      }).then(function(r){return r.json();}).then(function(results){
        if(results){
          Object.keys(results).forEach(function(id){
            var d=results[id];
            if(d&&d.title){
              nowPlayingData[id]=d;
              updateNowPlayingUI(parseInt(id),d);
            }
          });
        }
      }).catch(function(){});
    }
  },2000);
}

// Observe cards after render
var origRenderGrid=window.renderGrid;
window.renderGrid=function(){
  if(origRenderGrid)origRenderGrid();
  setTimeout(function(){
    var cards=document.querySelectorAll('.ch-card[data-id]');
    for(var i=0;i<cards.length;i++){npObserver.observe(cards[i]);}
    scheduleBatchDetect();
  },200);
};

// Expose detection stats globally
window.getDetectionStats=function(){
  return{
    nowPlaying:Object.keys(nowPlayingData).length,
    sceneChanges:sceneChangeCount,
    detections:detectionStats.total,
    bySource:detectionStats.bySource,
    currentChannel:currentChannel?currentChannel.n:null
  };
};

})();
<\/script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' }
    });
  }
};
