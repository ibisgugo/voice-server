const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const CHUNK_MS = 3000; // tamaño máximo chunk
const SILENCE_THRESHOLD = 200;
const SILENCE_MS = 400;

app.get('/', (_req, res) => {
  res.send('voice-server live');
});

app.post('/twiml', (_req, res) => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;

  res.type('text/xml').send(`
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
`);
});

// ===== AUDIO =====
function muLawDecode(byte) {
  byte = ~byte & 0xff;
  let sign = byte & 0x80;
  let exponent = (byte >> 4) & 0x07;
  let mantissa = byte & 0x0f;
  let sample = ((mantissa << 4) + 8) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

function mulawToPCM(buffer) {
  const out = Buffer.alloc(buffer.length * 2);
  for (let i = 0; i < buffer.length; i++) {
    out.writeInt16LE(muLawDecode(buffer[i]), i * 2);
  }
  return out;
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function calcRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const s = muLawDecode(buffer[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / (buffer.length || 1));
}

// ===== ELEVEN =====
async function transformAudio(wavBuffer) {
  const form = new FormData();

  form.append('audio', wavBuffer, {
    filename: 'audio.wav',
    contentType: 'audio/wav'
  });

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/speech-to-speech/${VOICE_ID}?output_format=ulaw_8000`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'xi-api-key': ELEVEN_API_KEY,
        Accept: 'audio/basic'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  return Buffer.from(response.data).toString('base64');
}

// ===== SERVER =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  let streamSid;
  let buffer = [];
  let processing = false;

  let lastVoice = 0;
  let lastFlush = 0;

  async function processNow() {
    if (!streamSid || processing || buffer.length === 0) return;

    processing = true;

    const audio = Buffer.concat(buffer);
    buffer = [];

    try {
      const pcm = mulawToPCM(audio);
      const wav = pcmToWav(pcm);

      const transformed = await transformAudio(wav);

      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: transformed }
      }));

    } catch (err) {
      console.error('ERROR:', err.response?.status || err.message);
    }

    processing = false;
    lastFlush = Date.now();
  }

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('Stream started');
    }

    if (data.event === 'media') {
      const chunk = Buffer.from(data.media.payload, 'base64');
      buffer.push(chunk);

      const rms = calcRMS(chunk);
      const now = Date.now();

      if (rms > SILENCE_THRESHOLD) {
        lastVoice = now;
      }

      if (lastVoice && (now - lastVoice > SILENCE_MS)) {
        await processNow();
      }
    }

    if (data.event === 'stop') {
      console.log('Stream ended');
      await processNow();
    }
  });

  // respaldo por si no detecta silencio
  setInterval(async () => {
    if (Date.now() - lastFlush > CHUNK_MS) {
      await processNow();
    }
  }, 500);
});

server.listen(process.env.PORT || 10000, () => {
  console.log('Server running');
});
