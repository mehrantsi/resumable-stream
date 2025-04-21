// CounterSession Durable Object to maintain state
export class CounterSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.counter = null;
    this.clients = new Set();
    this.intervalId = null;
  }

  // Handle HTTP requests to the Durable Object
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve the HTML page for root requests
    if (path === '/' || path === '') {
      return new Response(
        `<!DOCTYPE html>
        <html>
        <head>
          <title>Resumable Counter Stream</title>
          <style>
            body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
            #counter { font-size: 2rem; margin: 1rem 0; }
            #sessionUrl { margin: 1rem 0; word-break: break-all; }
          </style>
        </head>
        <body>
          <h1>Resumable Counter Stream</h1>
          <div id="counter">Connecting...</div>
          <div>
            <p>Share this URL to continue the session in another browser:</p>
            <div id="sessionUrl"></div>
          </div>
          <script>
            const sessionUrl = window.location.href;
            document.getElementById('sessionUrl').textContent = sessionUrl;
            
            // Use the exact same URL but add /events path for SSE
            const eventSource = new EventSource(window.location.href + '/events');
            
            eventSource.onmessage = (event) => {
              document.getElementById('counter').textContent = event.data;
            };
            
            eventSource.onerror = (error) => {
              console.error('EventSource error:', error);
              document.getElementById('counter').textContent = 'Connection error. Please refresh.';
            };
          </script>
        </body>
        </html>`,
        {
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    // Handle the SSE stream at /events endpoint
    if (path === '/events') {
      // Init counter if not loaded yet
      if (this.counter === null) {
        this.counter = await this.state.storage.get("counter") || 0;
      }

      let controller;
      // Create a stream with the ReadableStream constructor
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        }
      });
      
      // Set up the SSE response
      const response = new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });

      // Add this client to our clients set
      const client = { controller };
      this.clients.add(client);

      // Start the counter interval if it's not already running
      if (this.clients.size === 1) {
        this.startCounting();
      } else {
        // Send current value immediately
        const encoder = new TextEncoder();
        const data = encoder.encode(`data: ${this.counter}\n\n`);
        client.controller.enqueue(data);
      }

      // Remove client when connection closes
      request.signal.addEventListener('abort', () => {
        this.clients.delete(client);
        if (this.clients.size === 0) {
          this.stopCounting();
        }
      });

      return response;
    }

    return new Response("Not found", { status: 404 });
  }

  // Start the counting process
  startCounting() {
    // Don't start if already running
    if (this.intervalId) return;

    const encoder = new TextEncoder();

    this.intervalId = setInterval(async () => {
      this.counter++;
      
      // Save counter to durable storage
      await this.state.storage.put("counter", this.counter);
      
      // Send to all connected clients
      const data = encoder.encode(`data: ${this.counter}\n\n`);
      
      for (const client of this.clients) {
        try {
          client.controller.enqueue(data);
        } catch (error) {
          console.error("Error sending to client", error);
          this.clients.delete(client);
        }
      }

      // If no clients remain, stop counting
      if (this.clients.size === 0) {
        this.stopCounting();
      }
    }, 1000); // Update every second
  }

  // Stop the counting process
  stopCounting() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// Main worker entry point
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Root path - create a new session
    if (path === "/" || path === "") {
      // Generate a random session ID
      const id = crypto.randomUUID();
      return Response.redirect(`${url.origin}/${id}`, 302);
    }
    
    // Extract the session ID from the URL (first path segment)
    const parts = path.split('/').filter(p => p);
    const id = parts[0];
    
    // Create a Durable Object ID from the session ID
    const objId = env.COUNTER_SESSION.idFromName(id);
    const obj = env.COUNTER_SESSION.get(objId);
    
    // Forward to the Durable Object with a simplified path
    // Either / for root or /events for the event stream
    const newPath = parts.length > 1 ? `/${parts.slice(1).join('/')}` : '/';
    const newUrl = new URL(request.url);
    newUrl.pathname = newPath;
    
    return obj.fetch(new Request(newUrl, request));
  }
} 