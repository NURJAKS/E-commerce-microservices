import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/*.integration.spec.ts', 'libs/**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@shop/contracts': path.resolve(__dirname, 'libs/contracts/src/index.ts'),
      '@shop/rmq': path.resolve(__dirname, 'libs/rmq/src/index.ts'),
      '@shop/common': path.resolve(__dirname, 'libs/common/src/index.ts'),
      '@prisma/auth-client': path.resolve(
        __dirname,
        'node_modules/.prisma/auth-client',
      ),
      '@prisma/catalog-client': path.resolve(
        __dirname,
        'node_modules/.prisma/catalog-client',
      ),
      '@prisma/order-client': path.resolve(
        __dirname,
        'node_modules/.prisma/order-client',
      ),
      '@prisma/payment-client': path.resolve(
        __dirname,
        'node_modules/.prisma/payment-client',
      ),
    },
  },
});
