import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
// @ts-ignore
import worker from './src/index.js';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize Gemini client on the server as required by gemini-api skill
  const geminiApiKey = process.env.GEMINI_API_KEY;
  let ai: GoogleGenAI | null = null;
  
  if (geminiApiKey) {
    ai = new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    console.log('[Gemini] Server-side client initialized successfully');
  } else {
    console.warn('[Gemini] WARNING: GEMINI_API_KEY environment variable is not set. Chat assistant will run in smart simulated mode.');
  }

  // Server-side JSON endpoint for the Gemini assistant - defined BEFORE raw body parses
  app.post('/api/gemini-chat', express.json(), async (req, res) => {
    try {
      const { message, channelName, category, channelsList } = req.body;
      
      if (!message) {
        res.status(400).json({ error: 'Message parameter is required' });
        return;
      }

      const activeChannel = channelName || 'Ninguno';
      const activeCategory = category || 'Todos';
      const availableList = Array.isArray(channelsList) ? channelsList.slice(0, 15) : [];

      if (ai) {
        const systemPrompt = `Eres "Edge Vision IA", el asistente de inteligencia artificial para "Edge IPTV".
Tu propósito es ayudar a los espectadores con recomendaciones de canales, información de programación y preguntas generales de entretenimiento.

Canal que el usuario está sintonizando actualmente: "${activeChannel}" (Categoría: "${activeCategory}").
Canales reales disponibles en nuestra parrilla de programación para sugerir:
${availableList.map(c => `- ${c.name} (Categoría: ${c.category}, ID: ${c.id})`).join('\n')}

INSTRUCCIONES CLAVE:
1. Responde en el mismo idioma en el que te pregunta el usuario (usualmente español).
2. Sé conciso, amigable y sumamente entusiasta. Tu respuesta debe tener un máximo de 3 a 4 oraciones.
3. SIEMPRE sugiere canales de la lista anterior que coincidan con los gustos del usuario. NUNCA inventes nombres de canales o sugerencias que no estén en la lista de "Canales reales disponibles" si te piden recomendaciones de canales.
4. Resalta los nombres de canales y categorías en **negrita**.`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: message,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
          }
        });

        res.json({ response: response.text });
      } else {
        // High quality local fallback if apiKey is not registered yet
        const msgLower = message.toLowerCase();
        let fallbackText = '';
        
        if (msgLower.includes('recomienda') || msgLower.includes('similar') || msgLower.includes('pelicula') || msgLower.includes('canal')) {
          fallbackText = `¡Hola! Como estás sintonizando **${activeChannel}**, te sugiero explorar canales en la misma categoría como **Cine Premiere** o **Adrenalina Pura**. Ambos están en línea ahora mismo en **Edge IPTV**. (Nota: Configura tu clave GEMINI_API_KEY para habilitar análisis completo con IA).`;
        } else {
          fallbackText = `¡Hola! Soy tu asistente de entretenimiento. Actualmente estás viendo **${activeChannel}** (${activeCategory}). ¿Te gustaría que te recomiende otros canales parecidos de nuestra grilla de películas, música o niños?`;
        }
        res.json({ response: fallbackText });
      }
    } catch (error: any) {
      console.error('Gemini chat handler error:', error);
      res.status(500).json({ error: error.message || 'Server Gemini Exception' });
    }
  });

  // Body parser ONLY for non-Get requests targeting API or Proxy
  app.use('/proxy', express.raw({ type: '*/*', limit: '50mb' }));
  app.use('/api', express.raw({ type: '*/*', limit: '50mb' }));

  async function handleWorkerRequest(req: express.Request, res: express.Response) {
    try {
      const fullUrl = `${req.protocol}://${req.get('host') || 'localhost'}${req.originalUrl}`;
      const headers = new Headers();
      
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            val.forEach(v => headers.append(key, v));
          } else {
            headers.set(key, val);
          }
        }
      }

      const requestOptions: RequestInit = {
        method: req.method,
        headers: headers,
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length > 0) {
        requestOptions.body = req.body;
      }

      const webRequest = new Request(fullUrl, requestOptions);

      const env = {
        TMDB_API_KEY: process.env.TMDB_API_KEY || "47deb77a33325066c4710229c2481f05",
        TMDB_ACCESS_TOKEN: process.env.TMDB_ACCESS_TOKEN || "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI0N2RlYjc3YTMzMzI1MDY2YzQ3MTAyMjljMjQ4MWYwNSIsIm5iZiI6MTc3OTkwMjMyMi4wMDEsInN1YiI6IjZhMTcyNzcxNjQ3NTIwZTJkOGVhNGVlNiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.OpDUu5hHEywOpCRJk_5PMXInZAhh2oLHZSJQgKubns4",
        MISTRAL_API: process.env.MISTRAL_API || process.env.MISTRAL_API_KEY || "",
        MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || process.env.MISTRAL_API || "",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
        ...process.env
      };

      const webResponse = await worker.fetch(webRequest, env);
      res.status(webResponse.status);

      webResponse.headers.forEach((val, key) => {
        const kLower = key.toLowerCase();
        if (kLower !== 'transfer-encoding' && kLower !== 'content-encoding') {
          res.set(key, val);
        }
      });

      const arrayBuffer = await webResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.send(buffer);
    } catch (error: any) {
      console.error('Error in Express worker proxy handler:', error);
      res.status(500).send(`Server Express Worker Exception: ${error.message}`);
    }
  }

  // Forward CORS proxy and APIs to Worker
  app.all('/proxy', handleWorkerRequest);
  app.all('/api/*', handleWorkerRequest);

  // Serve static assets out of public folder directly
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Vite development middleware or production static site server
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[Express] Mounted Vite Development Server Middleware');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('[Express] Serving compiled files out of /dist');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sandbox Express Server listening at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server boot failed:', err);
});
