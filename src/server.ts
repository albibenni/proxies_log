import * as http from "http";
import * as net from "net";
import * as url from "url";
import * as fs from "fs";

interface LogEntry {
  timestamp: string;
  method: string;
  hostname: string;
  path: string;
  protocol: "HTTP" | "HTTPS";
  userAgent?: string;
}

class BrowserTrafficLogger {
  private server: http.Server;
  private logEntries: LogEntry[] = [];
  private uniqueDomains = new Set<string>();
  private port: number;

  constructor(port: number = 8888) {
    this.port = port;
    this.server = http.createServer();
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle regular HTTP requests
    this.server.on(
      "request",
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        this.handleHttpRequest(req, res);
      },
    );

    // Handle HTTPS CONNECT method (for HTTPS traffic)
    this.server.on(
      "connect",
      (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        this.handleHttpsConnect(req, clientSocket, head);
      },
    );

    // Handle server errors
    this.server.on("error", (err) => {
      console.error("Proxy server error:", err);
    });
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Enhanced debug logging to see exactly what Brave is sending
    console.log("=== DEBUG REQUEST INFO ===");
    console.log(`Method: ${req.method}`);
    console.log(`URL: ${req.url}`);
    console.log(`HTTP Version: ${req.httpVersion}`);
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("============================");

    let hostname: string;
    let path: string;
    let port: number = 80;

    // Handle different proxy request formats from browsers
    if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) {
      // Full URL in proxy mode (e.g., "http://example.com/path")
      const reqUrl = url.parse(req.url);
      hostname = reqUrl.hostname || "";
      path = reqUrl.path || "/";
      port =
        parseInt(reqUrl.port || "80") ||
        (reqUrl.protocol === "https:" ? 443 : 80);
    } else if (req.headers.host) {
      // Relative URL with Host header (common in modern browsers)
      const hostHeader = req.headers.host;
      const [hostPart, portPart] = hostHeader.split(":");
      hostname = hostPart || "";
      port = parseInt(portPart || "80") || 80;
      path = req.url || "/";
    } else {
      // Try to extract from absolute path
      const urlMatch = req.url?.match(/^https?:\/\/([^/]+)(.*)/);
      if (urlMatch) {
        const [, hostPort, urlPath] = urlMatch;
        if (hostPort) {
          const [hostPart, portPart] = hostPort.split(":");
          hostname = hostPart || "";
          port = parseInt(portPart || "80") || 80;
          path = urlPath || "/";
        } else {
          hostname = "";
          path = req.url || "/";
        }
      } else {
        hostname = "";
        path = req.url || "/";
      }
    }

    // Debug what we parsed
    console.log(
      `Parsed - Hostname: '${hostname}', Path: '${path}', Port: ${port}`,
    );

    // Validate hostname
    if (!hostname || hostname === "unknown" || hostname === "") {
      console.error("❌ Could not determine hostname for request:", req.url);
      console.error("❌ Headers:", req.headers);
      res.writeHead(400);
      res.end("Bad Request - Could not determine target hostname");
      return;
    }

    console.log(`✅ Successfully parsed request to: ${hostname}${path}`);

    // Log the request
    this.logRequest({
      timestamp: new Date().toISOString(),
      method: req.method!,
      hostname,
      path,
      protocol: "HTTP",
      userAgent: req.headers["user-agent"],
    });

    // Forward the request
    const options: http.RequestOptions = {
      hostname,
      port,
      path,
      method: req.method,
      headers: { ...req.headers },
    };

    // Remove proxy-specific headers
    if (options.headers && typeof options.headers === "object") {
      const headers = options.headers as Record<string, any>;
      delete headers["proxy-connection"];
    }

    const proxyReq = http.request(options, (proxyRes) => {
      // Copy response headers and status
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      // Pipe response back to client
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error(`HTTP proxy error for ${hostname}: ${err.message}`);
      res.writeHead(500);
      res.end("Proxy error");
    });

    // Pipe request to target server
    req.pipe(proxyReq, { end: true });
  }

  private handleHttpsConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const { hostname, port } = this.parseConnectUrl(req.url!);

    // Log the HTTPS connection
    this.logRequest({
      timestamp: new Date().toISOString(),
      method: "CONNECT",
      hostname,
      path: "/",
      protocol: "HTTPS",
      userAgent: req.headers["user-agent"],
    });

    // Create connection to target server
    const serverSocket = net.connect(parseInt(port) || 443, hostname, () => {
      // Send connection established response
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Pipe data between client and server
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", (err) => {
      console.error(`HTTPS proxy error for ${hostname}: ${err.message}`);
      clientSocket.end();
    });

    clientSocket.on("error", (err) => {
      console.error(`Client socket error: ${err.message}`);
      serverSocket.end();
    });
  }

  private parseConnectUrl(connectUrl: string): {
    hostname: string;
    port: string;
  } {
    const [hostname, port] = connectUrl.split(":");
    return { hostname: hostname || "", port: port || "443" };
  }

  private logRequest(entry: LogEntry): void {
    this.logEntries.push(entry);
    this.uniqueDomains.add(entry.hostname);

    // Console output
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    console.log(
      `[${timestamp}] ${entry.protocol} ${entry.method} ${entry.hostname}${entry.path}`,
    );

    // Optional: Write to file
    this.writeToLogFile(entry);
  }

  private writeToLogFile(entry: LogEntry): void {
    const logLine = `${entry.timestamp} | ${entry.protocol} | ${entry.method} | ${entry.hostname}${entry.path} | ${entry.userAgent || "Unknown"}\n`;
    fs.appendFileSync("browser_traffic.log", logLine);
  }

  public start(): void {
    this.server.listen(this.port, () => {
      console.log(`🚀 Browser Traffic Logger started on port ${this.port}`);
      console.log(
        `📝 Configure your browser's HTTP proxy to: localhost:${this.port}`,
      );
      console.log(`📋 Logs will be saved to: browser_traffic.log`);
      console.log("");
      this.printProxyInstructions();
    });
  }

  public stop(): void {
    this.server.close(() => {
      console.log("Proxy server stopped");
    });
  }

  private printProxyInstructions(): void {
    console.log("=== BROWSER PROXY SETUP INSTRUCTIONS ===");
    console.log("");
    console.log("Chrome/Edge:");
    console.log("  1. Go to Settings > Advanced > System");
    console.log('  2. Click "Open your computer\'s proxy settings"');
    console.log('  3. Enable "Use a proxy server"');
    console.log(`  4. Set HTTP proxy to: localhost:${this.port}`);
    console.log("");
    console.log("Firefox:");
    console.log("  1. Go to Settings > Network Settings");
    console.log('  2. Select "Manual proxy configuration"');
    console.log(`  3. Set HTTP Proxy to: localhost, Port: ${this.port}`);
    console.log('  4. Check "Use this proxy server for all protocols"');
    console.log("");
    console.log("=== MONITORING STARTED ===");
    console.log("");
  }

  // Utility methods for analysis
  public getStats(): {
    totalRequests: number;
    uniqueDomains: number;
    topDomains: Array<{ domain: string; count: number }>;
    protocolStats: { http: number; https: number };
  } {
    const domainCounts = new Map<string, number>();
    let httpCount = 0;
    let httpsCount = 0;

    this.logEntries.forEach((entry) => {
      domainCounts.set(
        entry.hostname,
        (domainCounts.get(entry.hostname) || 0) + 1,
      );
      if (entry.protocol === "HTTP") httpCount++;
      else httpsCount++;
    });

    const topDomains = Array.from(domainCounts.entries())
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalRequests: this.logEntries.length,
      uniqueDomains: this.uniqueDomains.size,
      topDomains,
      protocolStats: { http: httpCount, https: httpsCount },
    };
  }

  public printStats(): void {
    const stats = this.getStats();
    console.log("\n=== TRAFFIC STATISTICS ===");
    console.log(`Total Requests: ${stats.totalRequests}`);
    console.log(`Unique Domains: ${stats.uniqueDomains}`);
    console.log(`HTTP Requests: ${stats.protocolStats.http}`);
    console.log(`HTTPS Requests: ${stats.protocolStats.https}`);
    console.log("\nTop 10 Domains:");
    stats.topDomains.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.domain} (${item.count} requests)`);
    });
    console.log("");
  }

  public exportLogs(filename: string = "traffic_export.json"): void {
    const data = {
      exportTime: new Date().toISOString(),
      stats: this.getStats(),
      logs: this.logEntries,
    };

    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`📊 Logs exported to: ${filename}`);
  }

  public clearLogs(): void {
    this.logEntries = [];
    this.uniqueDomains.clear();
    console.log("📝 Logs cleared");
  }
}

// Usage example
const logger = new BrowserTrafficLogger(8888);

// Start the proxy
logger.start();

// Optional: Print stats every 30 seconds
setInterval(() => {
  logger.printStats();
}, 30000);

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  logger.printStats();
  logger.exportLogs();
  logger.stop();
  process.exit(0);
});

// Export for use as module
export default BrowserTrafficLogger;
