Put one HTTP or HTTPS proxy URL in `proxy.txt`, then restart the server:

```text
http://username:password@host:port
```

URL-encode special characters in credentials. A blank or missing file disables the proxy. The file is read relative to the repository, so starting from `server/` also works. It applies to server-side HTTP requests to `polymarket.com` and its subdomains, including the trading SDK. Other hosts connect as before.

`proxy.txt` is ignored by Git and excluded from Docker builds. For Docker, mount it read-only at `/proxy/proxy.txt`.
