const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('Twilio media stream connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === 'start') {
        console.log('Stream started:', data.start?.streamSid);
      } else if (data.event === 'media') {
        // We are receiving audio from Twilio here.
        // Next phase will transform and send audio back.
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

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`voice-server listening on ${port}`);
});
