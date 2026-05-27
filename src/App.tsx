import React, { useState, useEffect, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import { 
  Play, Pause, Volume2, VolumeX, Maximize, Search, Sparkles, 
  RotateCcw, SkipForward, List, Tv, Flame, Activity, ChevronRight, 
  Info, X, Radio, ArrowRight, Volume1, Clock, ExternalLink, Send
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { IPTVChannel, IPTVCategory, ChatMessage, NowPlayingMetadata } from './types';
import guideData from './channels.json';

export default function App() {
  const allChannels: IPTVChannel[] = useMemo(() => guideData.channels || [], []);
  const allCategories: IPTVCategory[] = useMemo(() => guideData.cats || [], []);

  // UI & Filter States
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<IPTVChannel | null>(allChannels[0] || null);

  // Player Performance States
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [volume, setVolume] = useState<number>(80);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playerError, setPlayerError] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // AI Assistant States
  const [chatInput, setChatInput] = useState<string>('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      sender: 'assistant',
      text: '¡Hola! Soy tu asistente de Inteligencia Artificial de Edge IPTV. Puedo recomendarte canales similares, sugerirte películas o resolver dudas sobre tu transmisión actual. ¿Qué te gustaría ver hoy?',
      timestamp: new Date()
    }
  ]);
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);

  // Enriched Metadata
  const [enrichedMetadata, setEnrichedMetadata] = useState<NowPlayingMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState<boolean>(false);

  // Local History (Continue Watching)
  const [historyList, setHistoryList] = useState<IPTVChannel[]>([]);

  // Premium Splash Screen States
  const [showSplash, setShowSplash] = useState<boolean>(true);
  const [splashProgress, setSplashProgress] = useState<number>(0);
  const [splashStatus, setSplashStatus] = useState<string>('Inicializando sistemas...');

  // Splash Screen animation sequence
  useEffect(() => {
    const statusMessages = [
      'Inicializando sistemas...',
      'Cargando grilla de canales...',
      'Estableciendo enlace de satélite...',
      'Verificando certificados de reproducción...',
      'Listo'
    ];
    
    let currentMessageIdx = 0;
    const messageInterval = setInterval(() => {
      if (currentMessageIdx < statusMessages.length - 1) {
        currentMessageIdx++;
        setSplashStatus(statusMessages[currentMessageIdx]);
      }
    }, 350);

    const progressInterval = setInterval(() => {
      setSplashProgress(prev => {
        if (prev >= 100) {
          clearInterval(progressInterval);
          clearInterval(messageInterval);
          setTimeout(() => {
            setShowSplash(false);
          }, 400);
          return 100;
        }
        return prev + 5;
      });
    }, 75);

    return () => {
      clearInterval(progressInterval);
      clearInterval(messageInterval);
    };
  }, []);

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Load persistence states
  useEffect(() => {
    try {
      const storedHistory = localStorage.getItem('edge_history');
      if (storedHistory) {
        const parsedIds = JSON.parse(storedHistory) as number[];
        const filteredHistory = parsedIds
          .map(id => allChannels.find(ch => ch.id === id))
          .filter((ch): ch is IPTVChannel => !!ch);
        setHistoryList(filteredHistory);
      }
    } catch (e) {
      console.error('Failed to load continue watching history:', e);
    }
  }, [allChannels]);

  // Persist history when a channel changes
  const saveHistoryList = (channel: IPTVChannel) => {
    try {
      const updatedIds = [channel.id, ...historyList.filter(ch => ch.id !== channel.id).map(ch => ch.id)].slice(0, 8);
      localStorage.setItem('edge_history', JSON.stringify(updatedIds));
      
      const newHistory = [channel, ...historyList.filter(ch => ch.id !== channel.id)].slice(0, 8);
      setHistoryList(newHistory);
    } catch (e) {
      console.error('Failed to save continue watching history:', e);
    }
  };

  // Filter channels
  const filteredChannels = useMemo(() => {
    return allChannels.filter(channel => {
      const matchCat = activeCategory === 'all' || channel.c === activeCategory;
      const matchSearch = channel.n.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          channel.d.toLowerCase().includes(searchQuery.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [allChannels, activeCategory, searchQuery]);

  // Get most viewed channels for Hero/Trending sidebar
  const trendingChannels = useMemo(() => {
    return [...allChannels].sort((a, b) => b.v - a.v).slice(0, 6);
  }, [allChannels]);

  // Featured Channel for the Hero Section (highest viewcount item)
  const heroChannel = useMemo(() => {
    return trendingChannels[0] || allChannels[0] || null;
  }, [trendingChannels, allChannels]);

  // Sync Video playback with state changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedChannel) return;

    setPlayerError(false);
    setIsLoading(true);
    setEnrichedMetadata(null);

    // Fetch TMDB Metadata in parallel with stream init
    fetchNowPlayingMetadata(selectedChannel);

    // Save playing channel to history
    saveHistoryList(selectedChannel);

    // Handle stream proxy URL routing through server.ts proxy
    const proxiedStreamUrl = `/proxy?url=${encodeURIComponent(selectedChannel.s)}`;

    if (Hls.isSupported()) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }

      const hls = new Hls({
        maxBufferLength: 20,
        maxMaxBufferLength: 45,
        enableWorker: true,
        lowLatencyMode: true,
      });

      hlsRef.current = hls;
      hls.loadSource(proxiedStreamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLoading(false);
        if (isPlaying) {
          video.play().catch(() => {
            setIsPlaying(false);
          });
        }
      });

      let recoveryAttempts = 0;
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          if (recoveryAttempts < 3) {
            recoveryAttempts++;
            console.warn(`Encountered fatal HLS error: ${data.details || data.type}. Attempting automatic recovery ${recoveryAttempts}/3...`);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              console.error('Fatal unrecoverable HLS error:', data.type);
              setIsLoading(false);
              setPlayerError(true);
            }
          } else {
            console.error('Max HLS recovery attempts reached. Failing gracefully.');
            setIsLoading(false);
            setPlayerError(true);
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Apple device support (Safari / iOS)
      video.src = proxiedStreamUrl;
      video.addEventListener('loadedmetadata', () => {
        setIsLoading(false);
        if (isPlaying) {
          video.play().catch(() => {
            setIsPlaying(false);
          });
        }
      });
      video.addEventListener('error', () => {
        setIsLoading(false);
        setPlayerError(true);
      });
    } else {
      setIsLoading(false);
      setPlayerError(true);
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selectedChannel]);

  // Fetch TMDB program metadata
  const fetchNowPlayingMetadata = async (channel: IPTVChannel) => {
    setMetadataLoading(true);
    try {
      // Extract general name matching to help TMDB queries
      const res = await fetch(`/api/now-playing?channelId=${channel.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.title) {
          setEnrichedMetadata(data);
          setMetadataLoading(false);
          return;
        }
      }

      // If no cached metadata exists, trigger server detection pipeline
      const detectRes = await fetch(`/api/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: String(channel.id),
          category: channel.c,
          metadata: {
            title: channel.n,
            genre: [channel.c]
          }
        })
      });

      if (detectRes.ok) {
        const data = await detectRes.json();
        if (data && data.title) {
          setEnrichedMetadata(data);
        }
      }
    } catch (e) {
      console.warn('Metadata fetch failed, falling back to static guide data:', e);
    } finally {
      setMetadataLoading(false);
    }
  };

  // Sync play state
  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  // Volume operations
  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVolume / 100;
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
      video.muted = false;
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    video.muted = nextMute;
  };

  // Fullscreen implementation
  const toggleFullscreen = () => {
    const wrap = playerWrapRef.current;
    if (!wrap) return;

    if (!document.fullscreenElement) {
      wrap.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(err => {
        console.error('Fullscreen request failed:', err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      });
    }
  };

  // Track fullscreen state change
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, []);

  // Sync volume slider
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume / 100;
      video.muted = isMuted;
    }
  }, [volume, isMuted]);

  // AI Chat Submission
  const handleSendChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || isAiLoading) return;

    const userMessage = chatInput.trim();
    setChatInput('');

    // Append user bubble to state
    const userMsgObj: ChatMessage = {
      sender: 'user',
      text: userMessage,
      timestamp: new Date()
    };
    setChatMessages(prev => [...prev, userMsgObj]);
    setIsAiLoading(true);

    // Scroll chat window to bottom
    setTimeout(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    }, 50);

    try {
      const res = await fetch('/api/gemini-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          channelName: selectedChannel?.n || 'Ninguno',
          category: selectedChannel?.c || 'Todos',
          channelsList: allChannels.map(ch => ({ id: ch.id, name: ch.n, category: ch.c }))
        })
      });

      if (res.ok) {
        const data = await res.json();
        const assistantMsgObj: ChatMessage = {
          sender: 'assistant',
          text: data.response || 'No obtuve respuesta del satélite de IA.',
          timestamp: new Date()
        };
        setChatMessages(prev => [...prev, assistantMsgObj]);
      } else {
        throw new Error('Response error');
      }
    } catch (e) {
      setChatMessages(prev => [
        ...prev,
        {
          sender: 'assistant',
          text: 'Lo siento, hubo un problema para conectar con el motor de IA en el servidor. Revisa tu conexión o verifica que tu servidor esté encendido.',
          timestamp: new Date()
        }
      ]);
    } finally {
      setIsAiLoading(false);
      setTimeout(() => {
        if (chatScrollRef.current) {
          chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
        }
      }, 50);
    }
  };

  // Next channel cycling on errors or bypass request
  const handleNextChannel = () => {
    if (!selectedChannel) return;
    const currentIdx = allChannels.findIndex(ch => ch.id === selectedChannel.id);
    const nextIdx = (currentIdx + 1) % allChannels.length;
    const nextCh = allChannels[nextIdx];
    if (nextCh) {
      setSelectedChannel(nextCh);
    }
  };

  // Quick preset queries for AI
  const aiPresets = [
    '¿Qué canales son de esta misma categoría?',
    'Recomienda películas recomendadas de nuestra parrilla',
    'Dame de qué trata este canal que estoy viendo'
  ];

  return (
    <AnimatePresence mode="wait">
      {showSplash ? (
        <motion.div
          key="splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.5, ease: 'easeInOut' }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0b0b0b] text-[#f0f0f0] p-6 text-center select-none animate-fadeIn"
        >
          {/* Logo glow effect background */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full bg-gradient-to-tr from-[#e8112d]/15 to-[#ff4466]/15 blur-[80px] pointer-events-none" />

          {/* Scanning Scanline animation overlay like original design */}
          <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-[#e8112d]/30 to-transparent animate-pulse pointer-events-none" style={{ animationDuration: '3s' }} />

          <div className="relative z-10 flex flex-col items-center gap-6 max-w-sm">
            {/* Animated Logo Container */}
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, type: 'spring', stiffness: 100 }}
              className="h-20 w-20 rounded-2xl bg-gradient-to-tr from-[#e8112d] to-[#ff4466] flex items-center justify-center shadow-2xl shadow-[#e8112d]/40 relative"
            >
              <Tv className="h-10 w-10 text-white" />
              <div className="absolute inset-0 rounded-2xl border border-white/20 animate-pulse pointer-events-none" />
            </motion.div>

            {/* Brand Title */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
            >
              <h1 className="font-display font-black text-3xl tracking-widest bg-gradient-to-r from-white via-slate-100 to-[#94a3b8] bg-clip-text text-transparent uppercase">
                EDGE <span className="text-[#e8112d]">IPTV</span>
              </h1>
              <span className="block text-[10px] text-[#666666] font-display tracking-[6px] uppercase mt-2 font-bold">
                Satélite Premium de Canales
              </span>
            </motion.div>

            {/* Custom Interactive Progress Bar */}
            <motion.div 
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: '100%', opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="w-64"
            >
              <div className="h-1 w-full bg-[#1d1d1d] rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-[#e8112d] to-[#ff4466] rounded-full transition-all duration-75"
                  style={{ width: `${splashProgress}%` }}
                />
              </div>
              
              {/* Dynamic Status Label */}
              <div className="flex items-center justify-between mt-2.5 px-1 text-[10px] font-mono text-[#666666]">
                <span className="animate-pulse">{splashStatus}</span>
                <span className="text-white/60">{splashProgress}%</span>
              </div>
            </motion.div>
          </div>

          {/* Aesthetic credentials on splash screen bottom */}
          <div className="absolute bottom-8 left-0 right-0 text-center text-[10px] font-mono text-neutral-800 uppercase tracking-widest">
            Conectado de forma segura &bull; Edge-tv engine
          </div>
        </motion.div>
      ) : (
        <motion.div 
          key="app"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
          className="min-h-screen flex flex-col bg-[#0b0b0b] text-[#f0f0f0] selection:bg-[#e8112d] selection:text-white"
        >
      {/* Dynamic Aesthetic Brand Header */}
      <header className="sticky top-0 z-40 bg-[#141414]/90 backdrop-blur-md border-b border-[#1d1d1d] px-4 py-3 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          
          {/* Logo Brand */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-tr from-[#e8112d] to-[#ff4466] flex items-center justify-center shadow-lg shadow-[#e8112d]/20">
                <Tv className="h-5 w-5 text-white" />
              </div>
              <div>
                <span className="font-display font-extrabold text-xl tracking-tight bg-gradient-to-r from-white via-[#f1f5f9] to-[#94a3b8] bg-clip-text text-transparent">
                  EDGE <span className="text-[#e8112d]">IPTV</span>
                </span>
                <span className="block text-[9px] text-[#64748b] font-mono tracking-wider -mt-1 font-bold">PREMIUM WEB PLAYER</span>
              </div>
            </div>
            
            {/* Live Indicator Mobile Stats */}
            <div className="md:hidden flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#e8112d] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#e8112d]"></span>
              </span>
              <span className="text-xs font-mono font-medium text-[#e8112d] uppercase">LIVE</span>
            </div>
          </div>

          {/* Search bar inputs */}
          <div className="flex flex-1 max-w-lg md:mx-4 items-center">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#64748b]" />
              <input
                type="text"
                placeholder="Buscar canales, géneros, procedencia..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#141414] text-[#e2e8f0] pl-10 pr-9 py-2 rounded-xl text-sm border border-[#1d1d1d] focus:outline-none focus:border-[#e8112d] focus:ring-1 focus:ring-[#e8112d] transition-all placeholder-[#475569]"
              />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748b] hover:text-white transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Top Info metrics */}
          <div className="hidden md:flex items-center gap-6 text-xs text-[#94a3b8]">
            <div className="flex items-center gap-2 bg-[#1e293b]/40 px-3 py-1.5 rounded-lg border border-[#1e293b]">
              <Radio className="h-3.5 w-3.5 text-[#22c55e] animate-pulse" />
              <span><strong className="text-white font-mono">{allChannels.length}</strong> Canales</span>
            </div>
            <div className="flex items-center gap-2 bg-[#1e293b]/40 px-3 py-1.5 rounded-lg border border-[#1e293b]">
              <Sparkles className="h-3.5 w-3.5 text-[#fbbf24]" />
              <span>Smart EPG Activado</span>
            </div>
          </div>

        </div>
      </header>

      {/* Main Container Workspace Grid */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Playable Stage and Control Side (Cols 1 to 3) */}
        <div className="lg:col-span-3 flex flex-col gap-6">

          {/* Player Media Frame container */}
          {selectedChannel ? (
            <div className="flex flex-col gap-4">
              <div 
                ref={playerWrapRef}
                className="relative bg-black rounded-2xl overflow-hidden border border-[#1e293b] shadow-2xl group"
              >
                {/* 16:9 Video Canvas */}
                <div className="aspect-video w-full relative flex items-center justify-center overflow-hidden">
                  <video
                    ref={videoRef}
                    onClick={togglePlayPause}
                    className="w-full h-full object-contain"
                    playsInline
                  />

                  {/* High Polished Interactive Overlays */}
                  {/* Buffer / Loading Spinner */}
                  {isLoading && (
                    <div className="absolute inset-0 bg-[#020617]/85 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                      <div className="h-10 w-10 border-4 border-t-[#3b82f6] border-r-transparent border-b-transparent border-l-transparent animate-spin rounded-full"></div>
                      <span className="text-xs font-mono text-[#64748b] tracking-widest uppercase">Cargando Stream en Vivo...</span>
                    </div>
                  )}

                  {/* Channel Error Screen */}
                  {playerError && (
                    <div className="absolute inset-0 bg-[#020617]/95 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 gap-4">
                      <div className="h-14 w-14 rounded-full bg-[#ef4444]/10 border border-[#ef4444]/30 flex items-center justify-center">
                        <Activity className="h-7 w-7 text-[#ef4444]" />
                      </div>
                      <div>
                        <h4 className="text-lg font-bold">¿La pantalla se bloqueó o no carga el canal?</h4>
                        <p className="text-xs text-[#94a3b8] max-w-md mx-auto mt-1">
                          Esto ocurre a veces debido a restricciones geográficas o porque el emisor modificó la ruta temporalmente. ¡Prueba reintentando o ingresando al siguiente canal!
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => {
                            setSelectedChannel({ ...selectedChannel }); // Trigger force re-render
                          }}
                          className="flex items-center gap-1.5 px-4 py-2 bg-[#1e293b] hover:bg-[#334155] rounded-xl text-xs font-medium border border-[#334155] transition-all cursor-pointer"
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Reintentar Carga
                        </button>
                        <button 
                          onClick={handleNextChannel}
                          className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-[#3b82f6] to-[#2563eb] hover:from-[#2563eb] hover:to-[#1d4ed8] rounded-xl text-xs font-medium shadow-md shadow-[#3b82f6]/20 transition-all cursor-pointer"
                        >
                          <SkipForward className="h-3.5 w-3.5" /> Siguiente Canal
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Fast Volume Overlay feedback on controls */}
                  <div className="absolute top-4 right-4 flex items-center gap-2">
                    <span className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono rounded bg-black/60 backdrop-blur-md text-[#3b82f6] border border-white/5 uppercase">
                      Live
                    </span>
                    <span className="px-2.5 py-1 text-[10px] font-mono rounded bg-black/60 backdrop-blur-md text-[#94a3b8] border border-white/5">
                      {selectedChannel.q}
                    </span>
                  </div>
                </div>

                {/* Styled Professional player interaction bar */}
                <div className="bg-[#0f172a] border-t border-[#1e293b] px-4 py-3 flex flex-wrap items-center justify-between gap-3 select-none">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={togglePlayPause}
                      className="h-9 w-9 rounded-lg bg-[#3b82f6]/10 hover:bg-[#3b82f6]/20 border border-[#3b82f6]/30 flex items-center justify-center text-[#3b82f6] transition-colors"
                      title={isPlaying ? 'Pausar' : 'Reproducir'}
                    >
                      {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current text-whiteML-1" />}
                    </button>

                    {/* Mute and volume slider controls */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={toggleMute}
                        className="h-9 w-9 rounded-lg bg-[#1e293b] hover:bg-[#334155] flex items-center justify-center text-[#94a3b8] transition-colors"
                        title={isMuted ? 'Unmute' : 'Mute'}
                      >
                        {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : volume < 50 ? <Volume1 className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                      </button>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={isMuted ? 0 : volume}
                        onChange={(e) => handleVolumeChange(Number(e.target.value))}
                        className="w-20 lg:w-24 h-1 bg-[#1e293b] rounded-lg appearance-none cursor-pointer accent-[#3b82f6]"
                      />
                    </div>
                  </div>

                  {/* Channel currently active info layout */}
                  <div className="flex items-center gap-3 text-sm">
                    <span className="p-1.5 rounded-lg bg-[#1e293b]" style={{ color: selectedChannel.clr }}>
                      <Tv className="h-4 w-4" />
                    </span>
                    <div className="flex flex-col">
                      <span className="font-bold text-white tracking-wide">{selectedChannel.n}</span>
                      <span className="text-[10px] text-[#64748b] tracking-wider uppercase">{selectedChannel.src} &bull; M3U8 Directo</span>
                    </div>
                  </div>

                  {/* Stage expand operations */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20 px-2 py-1 rounded-md font-mono">
                      ONLINE
                    </span>
                    <button
                      onClick={toggleFullscreen}
                      className="h-9 w-9 rounded-lg bg-[#1e293b] hover:bg-[#334155] flex items-center justify-center text-[#94a3b8] hover:text-white transition-colors"
                      title="Fullscreen"
                    >
                      <Maximize className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Dynamic Enriched EPG / TMDB Details below the player */}
              <div className="bg-[#0f172a] rounded-2xl p-4 lg:p-6 border border-[#1e293b] relative overflow-hidden">
                {/* Visual Backdrop glowing behind details */}
                {enrichedMetadata?.backdrop && (
                  <div 
                    className="absolute inset-0 opacity-[0.04] bg-cover bg-center pointer-events-none"
                    style={{ backgroundImage: `url(${enrichedMetadata.backdrop})` }}
                  />
                )}

                <div className="flex flex-col md:flex-row gap-5 relative z-10">
                  {/* Left poster */}
                  {enrichedMetadata?.poster && (
                    <img 
                      src={enrichedMetadata.poster} 
                      alt="" 
                      className="w-24 md:w-32 aspect-[2/3] object-cover rounded-xl shadow-lg border border-[#1e293b] self-start"
                    />
                  )}

                  <div className="flex-1 flex flex-col justify-center">
                    <div className="flex items-center flex-wrap gap-2 mb-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/20">
                        {enrichedMetadata?.type ? enrichedMetadata.type : selectedChannel.c}
                      </span>
                      {enrichedMetadata?.year && (
                        <span className="text-xs text-[#94a3b8] font-mono">Año: {enrichedMetadata.year}</span>
                      )}
                      {enrichedMetadata?.rating && (
                        <span className="text-xs text-[#fbbf24] font-medium flex items-center gap-1 bg-[#fbbf24]/5 px-2 py-0.5 rounded border border-[#fbbf24]/20">
                          ⭐️ {enrichedMetadata.rating.toFixed(1)}/10
                        </span>
                      )}
                    </div>

                    <h3 className="text-lg md:text-xl font-bold font-display text-white mb-2">
                      {enrichedMetadata?.title ? enrichedMetadata.title : `Sintonizando: ${selectedChannel.n}`}
                    </h3>

                    <p className="text-sm text-[#94a3b8] leading-relaxed max-w-3xl">
                      {enrichedMetadata?.overview ? enrichedMetadata.overview : selectedChannel.d}
                    </p>

                    <span className="text-[10px] text-[#475569] font-mono mt-3 uppercase tracking-wider flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                      Fuente del Programa: {enrichedMetadata?.source ? enrichedMetadata.source.toUpperCase() : 'CANAL IPTV CONFIG'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#0f172a] rounded-2xl p-12 text-center border border-[#1e293b] flex flex-col items-center gap-4">
              <Tv className="h-12 w-12 text-[#475569]" />
              <div>
                <h3 className="text-lg font-bold">No hay canal sintonizado</h3>
                <p className="text-xs text-[#94a3b8] mt-1">Selecciona cualquier canal de la guía inferior para comenzar la reproducción.</p>
              </div>
            </div>
          )}

          {/* Featured Continue Watching component if available */}
          {historyList.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#ef4444]" />
                <h4 className="text-sm font-bold uppercase tracking-wider text-[#94a3b8]">Seguir viendo</h4>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin">
                {historyList.map(channel => (
                  <button
                    key={channel.id}
                    onClick={() => setSelectedChannel(channel)}
                    className="flex-shrink-0 flex items-center gap-3 bg-[#0f172a] hover:bg-[#1e293b] p-2.5 rounded-xl border border-[#1e293b] cursor-pointer text-left transition-all w-60 group"
                  >
                    <div 
                      className="h-11 w-11 rounded-lg bg-center bg-cover relative flex-shrink-0 flex items-center justify-center border border-[#1e293b]"
                      style={{ 
                        backgroundImage: `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url(${channel.poster || `https://images.unsplash.com/photo-1542204172-e7052809a86f?w=100&h=100&fit=crop`})` 
                      }}
                    >
                      <Play className="h-4 w-4 text-white opacity-0 group-hover:opacity-100 transition-opacity fill-current absolute" />
                      <span className="text-xs font-bold text-white group-hover:opacity-0 transition-opacity" style={{ color: channel.clr }}>{channel.n.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="overflow-hidden">
                      <h5 className="text-xs font-bold text-white truncate group-hover:text-[#3b82f6] transition-colors">{channel.n}</h5>
                      <span className="block text-[10px] text-[#64748b] capitalize mt-0.5">{channel.c} &bull; sintonizado</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Guide Filters Section & Grid */}
          <div className="flex flex-col gap-4 mt-2">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#1e293b] pb-4">
              <div className="flex items-center gap-2">
                <List className="h-4 w-4 text-[#3b82f6]" />
                <h3 className="font-display font-black text-lg text-white">Guía de Canales</h3>
              </div>

              {/* Dynamic Categories tabs */}
              <div className="flex flex-wrap gap-2">
                {allCategories.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => setActiveCategory(cat.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer capitalize ${
                      activeCategory === cat.id 
                        ? 'bg-[#3b82f6] text-white border-[#3b82f6] shadow-md shadow-[#3b82f6]/10' 
                        : 'bg-[#121824] text-[#94a3b8] border-[#1e293b] hover:border-[#334155] hover:text-white'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Channels Showcase Grid */}
            {filteredChannels.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {filteredChannels.map(channel => {
                  const isCurrent = selectedChannel?.id === channel.id;
                  return (
                    <div
                      key={channel.id}
                      onClick={() => {
                        setSelectedChannel(channel);
                        setIsPlaying(true);
                      }}
                      className={`group relative bg-[#0f172a] hover:bg-[#131d31] rounded-2xl p-3 border cursor-pointer transition-all flex items-start gap-3.5 select-none ${
                        isCurrent 
                          ? 'border-[#3b82f6] shadow-lg shadow-[#3b82f6]/5 bg-[#121c32]' 
                          : 'border-[#1e293b] hover:border-[#334155]'
                      }`}
                    >
                      {/* Interactive Visual state thumbnail */}
                      <div 
                        className="h-14 w-14 rounded-xl bg-cover bg-center flex-shrink-0 relative overflow-hidden border border-[#1e293b]"
                        style={{ 
                          backgroundImage: `linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), url(${channel.poster || `https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=120&h=120&fit=crop`})`
                        }}
                      >
                        {/* Static representative initials badge */}
                        <span 
                          className="absolute text-[11px] font-extrabold uppercase tracking-widest text-[#94a3b8] group-hover:scale-105 transition-transform"
                          style={{ color: channel.clr }}
                        >
                          {channel.n.slice(0, 2).toUpperCase()}
                        </span>

                        {/* Playing wave animations or play button */}
                        {isCurrent ? (
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <span className="flex h-2.5 w-2.5 relative">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ef4444] opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#ef4444]"></span>
                            </span>
                          </div>
                        ) : (
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                            <Play className="h-4 w-4 text-white fill-current" />
                          </div>
                        )}
                      </div>

                      {/* Info strings */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1 justify-between">
                          <span className="text-[9px] font-bold uppercase py-0.5 px-1 bg-[#1e293b] text-[#64748b] rounded">
                            {channel.q}
                          </span>
                          <span className="text-[10px] text-[#475569] font-mono flex items-center gap-1">
                            👥 {(channel.v / 1000).toFixed(1)}k
                          </span>
                        </div>
                        <h4 className={`text-sm font-bold truncate group-hover:text-[#3b82f6] transition-colors ${
                          isCurrent ? 'text-[#3b82f6]' : 'text-white'
                        }`}>
                          {channel.n}
                        </h4>
                        <p className="text-[11px] text-[#64748b] line-clamp-1 mt-0.5" title={channel.d}>
                          {channel.d}
                        </p>
                      </div>

                      {/* Accent glow corner indicator */}
                      <div 
                        className="absolute right-2.5 bottom-2.5 h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: channel.clr }}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-[#0f172a] rounded-2xl p-12 text-center border border-[#1e293b]">
                <Activity className="h-8 w-8 text-[#475569] mx-auto mb-2" />
                <h4 className="text-sm font-bold text-white">No se encontraron canales</h4>
                <p className="text-xs text-[#64748b] mt-1">Prueba reescribiendo la búsqueda o seleccionando otra categoría.</p>
              </div>
            )}
          </div>

        </div>

        {/* Sidebar and Gemini Assistant Frame (Col 4) */}
        <div className="flex flex-col gap-6">

          {/* Premium Gemini AI Chat Widget */}
          <div className="bg-[#0f172a] rounded-2xl border border-[#1e293b] flex flex-col h-[520px] shadow-xl overflow-hidden relative">
            
            {/* Widget Head */}
            <div className="p-4 bg-gradient-to-r from-[#111c30] to-[#0f172a] border-b border-[#1e293b] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-[#3b82f6] to-[#a855f7] flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-white animate-pulse" />
                </div>
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-white">Edge Vision IA</h4>
                  <span className="block text-[9px] font-mono text-[#10b981] font-bold tracking-tight">ONLINE &bull; GEMINI 3.5</span>
                </div>
              </div>
              <span className="text-[10px] text-[#64748b] bg-[#1e293b] px-2 py-0.5 rounded font-mono font-medium">INFO COMPARTIDA</span>
            </div>

            {/* Chat list viewport */}
            <div 
              ref={chatScrollRef}
              className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5 scrollbar-thin"
            >
              {chatMessages.map((msg, idx) => {
                const isAssistant = msg.sender === 'assistant';
                return (
                  <div 
                    key={idx}
                    className={`flex flex-col max-w-[85%] ${isAssistant ? 'self-start' : 'self-end'}`}
                  >
                    <div className={`p-3 rounded-2xl text-xs leading-relaxed ${
                      isAssistant 
                        ? 'bg-[#182335]/70 text-[#f1f5f9] rounded-tl-none border border-[#1e293b]' 
                        : 'bg-[#3b82f6] text-white rounded-tr-none'
                    }`}>
                      {msg.text}
                    </div>
                    <span className="text-[9px] text-[#475569] mt-1 font-mono self-end">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                );
              })}

              {isAiLoading && (
                <div className="self-start flex items-center gap-2 text-[10px] font-mono text-[#64748b] bg-[#1e293b]/30 py-2 px-3 rounded-lg border border-[#1e293b]/70 animate-pulse">
                  <div className="h-1.5 w-1.5 bg-[#ef4444] rounded-full animate-bounce" />
                  <div className="h-1.5 w-1.5 bg-[#3b82f6] rounded-full animate-bounce [animation-delay:0.2s]" />
                  <div className="h-1.5 w-1.5 bg-[#fbbf24] rounded-full animate-bounce [animation-delay:0.4s]" />
                  <span>Analizando canales con IA...</span>
                </div>
              )}
            </div>

            {/* Preset Query Tags inside conversation */}
            <div className="p-2 border-t border-[#1e293b] bg-[#090d16] flex flex-col gap-1.5">
              <span className="text-[9px] uppercase tracking-wider font-bold text-[#475569] pl-1 select-none">Sugerencias:</span>
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none scroll-smooth">
                {aiPresets.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setChatInput(preset);
                    }}
                    disabled={isAiLoading}
                    className="flex-shrink-0 text-[10px] bg-[#1a2130] text-[#94a3b8] hover:text-white px-2.5 py-1 rounded-lg border border-[#1e293b] hover:border-[#334155] text-left transition-all cursor-pointer whitespace-nowrap"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Form submit bar */}
            <form 
              onSubmit={handleSendChat}
              className="p-3 bg-[#0a0f1d] border-t border-[#1e293b] flex items-center gap-2"
            >
              <input
                type="text"
                placeholder="Pregúntale a Edge Vision IA..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={isAiLoading}
                className="flex-1 bg-[#05080e] border border-[#1e293b] focus:border-[#3b82f6] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] text-xs py-2 px-3 rounded-xl text-white transition-all placeholder-[#475569] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || isAiLoading}
                className="h-8 w-8 rounded-xl bg-[#3b82f6] hover:bg-[#2563eb] disabled:bg-[#1e293b] text-white disabled:text-[#475569] flex items-center justify-center transition-colors cursor-pointer"
              >
                <Send className="h-3.5 w-3.5 fill-current" />
              </button>
            </form>
          </div>

          {/* Trending sidebar display */}
          <div className="bg-[#0f172a] rounded-2xl border border-[#1e293b] p-4 flex flex-col gap-3.5">
            <div className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-[#ef4444]" />
              <h4 className="text-xs font-bold uppercase tracking-widest text-[#94a3b8]">Tendencias</h4>
            </div>

            <div className="flex flex-col gap-2.5">
              {trendingChannels.map((channel, idx) => (
                <div
                  key={channel.id}
                  onClick={() => setSelectedChannel(channel)}
                  className="flex items-center justify-between p-2 rounded-xl bg-[#121824]/50 hover:bg-[#121824] border border-transparent hover:border-[#1e293b] transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-black text-[#475569] group-hover:text-white transition-colors">
                      {idx + 1}
                    </span>
                    <div>
                      <h5 className="text-xs font-bold text-white group-hover:text-[#3b82f6] transition-colors truncate w-32 lg:w-36">
                        {channel.n}
                      </h5>
                      <span className="block text-[9px] text-[#64748b] capitalize">{channel.c}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="block text-[10px] font-semibold text-[#ef4444] flex items-center gap-1.5 justify-end">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />
                      LIVE
                    </span>
                    <span className="block text-[9px] text-[#475569] mt-0.5">👥 {(channel.v / 1000).toFixed(1)}k</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

      </main>

      {/* Aesthetic Footer bar */}
      <footer className="mt-auto border-t border-[#1e293b] bg-[#090d16] py-4 px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#475569]">
          <div className="flex items-center gap-2 font-display">
            <span className="font-extrabold text-white">EDGE IPTV</span>
            <span>&mdash;</span>
            <span>100% Gratuito y sin publicidad invasiva</span>
          </div>
          <div className="flex items-center gap-6 font-mono text-[10px] uppercase tracking-wider">
            <span>🔴 {allChannels.length} canales en línea</span>
            <span>📡 Servidor Activo</span>
            <span>v10.0 Stable</span>
          </div>
        </div>
      </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
