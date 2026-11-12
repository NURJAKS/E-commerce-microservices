const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function ensureSymlink(targetRel, linkRel) {
  const target = path.resolve(root, targetRel);
  const link = path.resolve(root, linkRel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.symlinkSync(target, link, 'dir');
}

ensureSymlink('dist/backend/libs/contracts/src', 'node_modules/@shop/contracts');
ensureSymlink('dist/backend/libs/rmq/src', 'node_modules/@shop/rmq');
ensureSymlink('dist/backend/libs/common/src', 'node_modules/@shop/common');

ensureSymlink('node_modules/.prisma/auth-client', 'node_modules/@prisma/auth-client');
ensureSymlink('node_modules/.prisma/catalog-client', 'node_modules/@prisma/catalog-client');
ensureSymlink('node_modules/.prisma/order-client', 'node_modules/@prisma/order-client');
ensureSymlink('node_modules/.prisma/payment-client', 'node_modules/@prisma/payment-client');

console.log('Linked @shop/* and @prisma/*-client packages in node_modules.');
