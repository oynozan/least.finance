// pm2 runs the web app and the API server; start them with `npm run pm2:start` from the repo root
const path = require("node:path");

module.exports = {
    apps: [
        {
            name: "least-web",
            cwd: __dirname,
            script: "node_modules/next/dist/bin/next",
            args: "start -p 3000",
            env: { NODE_ENV: "production" },
            max_memory_restart: "1G",
        },
        {
            name: "least-server",
            cwd: path.join(__dirname, "server"),
            script: "src/index.ts",
            interpreter: "node",
            node_args: "--env-file-if-exists=.env",
            max_memory_restart: "1G",
            kill_timeout: 15000,
        },
    ],
};
