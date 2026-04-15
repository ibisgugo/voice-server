const WebSocket = require('ws');

const server = new WebSocket.Server({ port: process.env.PORT || 10000 });

server.on('connection', function connection(ws) {
  console.log('Client connected');

  ws.on('message', function incoming(message) {
    try {
      const data = JSON.parse(message);

      if (data.event === 'media') {
        ws.send(JSON.stringify({
          event: 'media',
          media: {
            payload: data.media.payload
          }
        }));
      }
    } catch (err) {
      console.log('Error:', err);
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

console.log('Server running');
