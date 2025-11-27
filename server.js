// server.js
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || null;

// Basic HTTP server (so Render thinks the service is alive)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server });

wss.on('connection', (twilioWs, req) => {
  console.log('New Twilio Media Stream connection');

  // Connect to OpenAI Realtime WebSocket
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // System prompt to define the agent's behaviour
    const systemPrompt = {
      type: 'input_text',
      text: `
You are a friendly, efficient British dental receptionist.
You are speaking on the phone with patients.
Speak with a natural UK accent.
Keep responses short and conversational (1–2 sentences).
Your goals:
- Understand why the caller is contacting the practice.
- Collect: full name, date of birth, phone number, reason for visit, and preferred date/time.
- If they are in severe pain, swelling, or have difficulty breathing/swallowing,
  tell them to hang up and contact emergency services.
- Never give clinical diagnoses.
Do NOT say that you are an AI. Sound like a real person.
      `,
    };

    openaiWs.send(JSON.stringify(systemPrompt));
  });

  // Twilio -> OpenAI (audio)
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === 'media') {
        // Send audio to OpenAI (Twilio sends base64 μ-law audio)
        const audioEvent = {
          type: 'input_audio_buffer.append',
          audio: data.media.payload,
        };
        openaiWs.send(JSON.stringify(audioEvent));
      } else if (data.event === 'start') {
        console.log('Twilio stream started');
      } else if (data.event === 'stop') {
        console.log('Twilio stream stopped');
        openaiWs.close();
      }
    } catch (e) {
      console.error('Error parsing Twilio message', e);
    }
  });

  // OpenAI -> Twilio (audio)
  openaiWs.on('message', (msg) => {
    try {
      const event = JSON.parse(msg.toString());

      if (event.type === 'output_audio_buffer.append') {
        // event.audio is base64 μ-law audio at 8kHz
        const twilioMsg = {
          event: 'media',
          media: {
            payload: event.audio,
          },
        };
        twilioWs.send(JSON.stringify(twilioMsg));
      }

      // Example hook: if text contains BOOK_APPOINTMENT we notify n8n
      if (
        N8N_WEBHOOK_URL &&
        event.type === 'input_text' &&
        event.text &&
        event.text.includes('BOOK_APPOINTMENT:')
      ) {
        fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: event.text }),
        }).catch(console.error);
      }
    } catch (e) {
      console.error('Error handling OpenAI event', e);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio connection closed');
    openaiWs.close();
  });

  openaiWs.on('close', () => {
    console.log('OpenAI connection closed');
    twilioWs.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
