import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ConfigEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {
  createSourceBuildIdentity,
  generateBuildManifest,
  parseBuildIdentity,
  type BuildIdentity,
} from '../server/src/build-identity/manifest.js';

const clientDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(clientDir, '..');

function unknownCompiledIdentity(): BuildIdentity {
  return {
    manifestSchemaVersion: 1,
    identityStatus: 'unknown',
    buildMode: 'compiled',
    buildId: 'unknown',
    buildFingerprint: 'unknown',
    revision: 'unknown',
    sourceFingerprint: 'unknown',
    configFingerprint: 'unknown',
    lockfileFingerprint: 'unknown',
    componentVersions: {},
  };
}

/** Compute the client identity independently of server/dist output. */
export function loadClientBuildIdentity(
  command: ConfigEnv['command'],
  rootDir = repositoryDir,
): BuildIdentity {
  if (command === 'serve') return createSourceBuildIdentity(rootDir);
  const generated = generateBuildManifest({ rootDir });
  // Run the same bounded projection used for compiled manifests before Vite
  // embeds the object. A malformed generator result becomes explicit unknown.
  return parseBuildIdentity(JSON.stringify(generated), 'compiled') ?? unknownCompiledIdentity();
}

export default defineConfig(({ command }) => {
  const buildIdentity = loadClientBuildIdentity(command);
  const buildIdentityJson = JSON.stringify(buildIdentity);

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_BUILD_IDENTITY': JSON.stringify(buildIdentityJson),
      // Compatibility for older bundles; this is the identity's build id, not
      // package.json or caller environment input.
      'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(buildIdentity.buildId),
    },
    server: {
      port: 3457,
      proxy: {
        '/api': {
          target: 'http://localhost:3456',
          changeOrigin: true,
        },
        '/ws': {
          target: 'http://localhost:3456',
          ws: true,
          changeOrigin: true,
          secure: false,
          // Forward cookies and auth headers
          configure: (proxy, _options) => {
            proxy.on('proxyReqWs', (proxyReq, req, _socket, _options, _head) => {
              // Forward the cookie header if present
              if (req.headers.cookie) {
                proxyReq.setHeader('Cookie', req.headers.cookie);
              }
            });
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
