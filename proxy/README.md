Put one HTTP or HTTPS proxy URL in `proxy.txt`, then restart the server:

```text
http://username:password@host:port
```

URL-encode special characters in credentials. A blank or missing file disables the proxy. The file is read relative to the repository, so starting from `server/` also works. It applies to server-side HTTP requests to `polymarket.com` and its subdomains, including the trading SDK. Other hosts connect as before.

`proxy.txt` is ignored by Git and excluded from Docker builds. For Docker, mount it read-only at `/proxy/proxy.txt`.

To check the proxy on a PM2 server, run `node scripts/polymarket-proxy-check.ts` from `server/`, using the same OS user as PM2. It prints the expected file path, whether the proxy is enabled, direct and configured geoblock results, and read-only Gamma/CLOB checks including the SDK. It does not print credentials or place orders. The file must be copied to the server separately because Git ignores it. After adding or changing it, run `npm run pm2:restart` from `server/`.
