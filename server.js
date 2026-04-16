const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!ELEVEN_API_KEY) {
  console.warn('Missing ELEVENLABS_API_KEY');
}
if (!VOICE_ID) {
  console.warn('Missing ELEVENLABS_VOICE_ID');
}

app.get('/', (_req, res) => {
  res.status(200).send('voice-server alive');
});

app.post('/twiml', (_req, res) => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || _req.get('host');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

async function elevenTtsToUlawBase64(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=ulaw_8000&optimize_streaming_latency=3`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.1,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/basic'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  return Buffer.from(response.data).toString('base64');
}

async function speakOnCall(ws, streamSid, text, markName) {
  const payload = await elevenTtsToUlawBase64(text);

  ws.send(JSON.stringify({
    event: 'media',
    streamSid,
    media: {
      payload
    }
  }));

  ws.send(JSON.stringify({
    event: 'mark',
    streamSid,
    mark: {
      name: markName
    }
  }));
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('Twilio media stream connected');

  let streamSid = null;
  let greeted = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        streamSid = data.start?.streamSid;
        console.log('Stream started:', streamSid);

        if (!greeted && streamSid) {
          greeted = true;

          try {
            await speakOnCall(
              ws,
              streamSid,
              "Hello. This is Lauren with Northline. I can hear you.",
              "lauren-greeting"
            );
          } catch (err) {
            console.error('TTS send failed:', err.response?.status || err.message);
          }
        }
      } else if (data.event === 'mark') {
        console.log('Playback finished:', data.mark?.name);
      } else if (data.event === 'media') {
        // Incoming caller audio arrives here.
        // Next phase: buffer caller audio and turn it into transformed outbound audio.
      } else if (data.event === 'stop') {
        console.log('Stream stopped');
      }
    } catch (err) {
      console.error('WS parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('Twilio media stream disconnected');
  });
});
