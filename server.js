const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const CHUNK_MS = 1500; // puedes bajar a 1200 luego

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

// ===== AUDIO HELPERS =====
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

// ===== ELEVENLABS =====
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
      responseType: 'arraybuffer'
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

  setInterval(async () => {
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
      console.error('ERROR:', err.message);
    }

    processing = false;

  }, CHUNK_MS);

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('Stream started');
    }

    if (data.event === 'media') {
      buffer.push(Buffer.from(data.media.payload, 'base64'));
    }

    if (data.event === 'stop') {
      console.log('Stream ended');
    }
  });
});

server.listen(process.env.PORT || 10000, () => {
  console.log('Server running');
});
