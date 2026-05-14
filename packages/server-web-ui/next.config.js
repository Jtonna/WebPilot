/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/ui',
  assetPrefix: '/ui/',
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
};

module.exports = nextConfig;
