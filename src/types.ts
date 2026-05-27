export interface IPTVChannel {
  id: number;
  n: string; // name
  s: string; // stream url (m3u8)
  c: string; // category
  q: string; // quality (e.g. HD/SD)
  src: string; // source
  v: number; // viewer count
  d: string; // description
  clr: string; // hex colour representative
  logo?: string; // logo path or url
  poster?: string;
}

export interface IPTVCategory {
  id: string;
  label: string;
  icon?: string;
}

export interface ChatMessage {
  sender: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}

export interface NowPlayingMetadata {
  title: string;
  type?: string;
  year?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  confidence?: number;
  source?: string;
  tmdb_id?: number;
}
