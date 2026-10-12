import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    cacheComponents: true,
    partialPrefetching: true,
    images: {
        remotePatterns: [
            { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com", pathname: "/**" },
        ],
    },
};

export default nextConfig;
